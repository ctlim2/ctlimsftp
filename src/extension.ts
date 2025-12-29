import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpClient } from './sftpClient';
import { SftpConfig, FileMetadata } from './types';
import { SftpTreeProvider, SftpDragAndDropController } from './sftpTreeProvider';

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = true;

let sftpClient: SftpClient | null = null;
let treeProvider: SftpTreeProvider;
let currentConfig: SftpConfig | null = null;
let statusBarItem: vscode.StatusBarItem;

// Cache document-config and client mapping for performance
const documentConfigCache = new WeakMap<vscode.TextDocument, { config: SftpConfig; client: SftpClient; remotePath: string }>();

export function activate(context: vscode.ExtensionContext) {
    if (DEBUG_MODE) console.log('ctlim SFTP extension is now active');

    // Register Tree View Provider (StatusBar보다 먼저 생성)
    treeProvider = new SftpTreeProvider();
    
    // Create Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'ctlimSftp.switchServer';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    // Create Drag and Drop Controller
    const dragAndDropController = new SftpDragAndDropController(treeProvider);
    
    /**
     * Create Tree View with Drag and Drop support
     */
    const treeView = vscode.window.createTreeView('ctlimSftpView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
        dragAndDropController: dragAndDropController
    });
    
    /**
     * Handle selection on tree items (servers only, files use double-click)
     */
    treeView.onDidChangeSelection(async (e) => {
        if (e.selection.length > 0) {
            const item = e.selection[0];
            
            // Only execute command for servers (single click)
            // Files require double-click (handled by TreeItem.command)
            if (item.itemType === 'server' && item.command) {
                await vscode.commands.executeCommand(
                    item.command.command,
                    ...(item.command.arguments || [])
                );
            }
        }
    });
    
    context.subscriptions.push(treeView);

    // Check and reload remote files on startup
    setTimeout(() => checkAndReloadRemoteFiles(), 2000);


//#region registerCommand    
    /**
     * Connect to server command
     */
    const connectServerCommand = vscode.commands.registerCommand('ctlimSftp.connectServer', async (serverItem) => {
        await treeProvider.connectToServer(serverItem);
        updateStatusBar();
    });

    /**
     * Disconnect server command
     */
    const disconnectServerCommand = vscode.commands.registerCommand('ctlimSftp.disconnectServer', async (item) => {
        if (item && item.serverItem) {
            treeProvider.disconnectServer(item.serverItem.name);
            updateStatusBar();
        }
    });

    /**
     * Refresh command
     */
    const refreshCommand = vscode.commands.registerCommand('ctlimSftp.refresh', () => {
        treeProvider.refresh();
        updateStatusBar();
    });

    /**
     * Switch server command - Status Bar 클릭 시 실행
     */
    const switchServerCommand = vscode.commands.registerCommand('ctlimSftp.switchServer', async () => {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스가 열려있지 않습니다.');
                return;
            }

            const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
            if (!fs.existsSync(configPath)) {
                const result = await vscode.window.showErrorMessage(
                    'SFTP 설정 파일이 없습니다. 생성하시겠습니까?',
                    '설정'
                );
                if (result === '설정') {
                    await vscode.commands.executeCommand('ctlimSftp.config');
                }
                return;
            }

            // Load server list
            const configContent = fs.readFileSync(configPath, 'utf-8');
            const configData = JSON.parse(configContent);
            const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
            
            if (configs.length === 0) {
                vscode.window.showErrorMessage('설정 파일에 서버 정보가 없습니다.');
                return;
            }

            // Get connected servers
            const connectedServers = treeProvider.getConnectedServerNames();

            // Create QuickPick items
            interface ServerQuickPickItem extends vscode.QuickPickItem {
                config: SftpConfig;
                isConnected: boolean;
            }

            const items: ServerQuickPickItem[] = configs.map(config => {
                const serverName = config.name || `${config.username}@${config.host}`;
                const isConnected = connectedServers.includes(serverName);
                
                return {
                    label: isConnected ? `$(check) ${serverName}` : `$(circle-outline) ${serverName}`,
                    description: `${config.host}:${config.port}`,
                    detail: isConnected ? '연결됨 - 클릭하여 연결 해제' : '연결 안 됨 - 클릭하여 연결',
                    config: config,
                    isConnected: isConnected
                };
            });

            // Show QuickPick
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '서버를 선택하여 연결/해제하세요',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selected) {
                return;
            }

            const serverName = selected.config.name || `${selected.config.username}@${selected.config.host}`;
            
            if (selected.isConnected) {
                // Disconnect
                treeProvider.disconnectServer(serverName);
                vscode.window.showInformationMessage(`🔌 서버 연결 해제: ${serverName}`);
            } else {
                // Connect
                const contextPath = selected.config.context || './';
                const workspaceRoot = path.isAbsolute(contextPath) 
                    ? contextPath 
                    : path.join(workspaceFolder.uri.fsPath, contextPath);
                selected.config.workspaceRoot = workspaceRoot;

                const serverItem = {
                    name: serverName,
                    host: selected.config.host,
                    port: selected.config.port || 22,
                    username: selected.config.username,
                    remotePath: selected.config.remotePath || '/',
                    configPath: configPath
                };

                await treeProvider.connectToServer(serverItem);
                vscode.window.showInformationMessage(`✅ 서버 연결 성공: ${serverName}`);
            }
            
            updateStatusBar();
            
        } catch (error) {
            vscode.window.showErrorMessage(`서버 전환 실패: ${error}`);
            console.error('switchServer error:', error);
        }
    });

    /**
     * 원격 파일 열기 Command
     */
    const openRemoteFileCommand = vscode.commands.registerCommand('ctlimSftp.openRemoteFile', async (remotePath: string, config: SftpConfig) => {
        try {
            if (DEBUG_MODE) console.log('> ctlimSftp.openRemoteFile');

            if (!remotePath || !config) {
                vscode.window.showErrorMessage('원격 파일 정보가 없습니다.');
                return;
            }

            if (DEBUG_MODE) console.log(`Opening remote file: ${remotePath}`);
            if (DEBUG_MODE) console.log(`Config: ${config.name || `${config.username}@${config.host}`}, remotePath: ${config.remotePath}`);

            // Find the connected server for this config
            let connection = treeProvider.getConnectedServer(config.name || `${config.username}@${config.host}`);
            if (!connection) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 다시 연결하시겠습니까?',
                    '연결',
//                    '취소'
                );
                if (reconnect === '연결') {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                        return;
                    }
                    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
                    const serverItem = {
                        name: config.name || `${config.username}@${config.host}`,
                        host: config.host,
                        port: config.port || 22,
                        username: config.username,
                        remotePath: config.remotePath,
                        configPath: configPath
                    };
                    await treeProvider.connectToServer(serverItem);
                    connection = treeProvider.getConnectedServer(config.name || `${config.username}@${config.host}`);
                    if (!connection) {
                        vscode.window.showErrorMessage('서버 연결에 실패했습니다.');
                        return;
                    }
                } else {
                    return;
                }
            }


            // 워크스페이스 폴더 가져오기 (workspaceRoot 아님)
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                return;
            }
            
            const WorkspaceMetadataDir = SftpClient.getWorkspaceMetadataDir(connection.config);
            if (!WorkspaceMetadataDir) {
                vscode.window.showErrorMessage('메타데이터 디렉토리를 찾을 수 없습니다.');
                return;
            }

            // 다운로드할 로컬 경로 설정
            const localPath = SftpClient.getDownloadFolder(remotePath, workspaceFolder.uri.fsPath, config, true, false);
            if (!localPath) {
                vscode.window.showErrorMessage('다운로드 경로를 계산할 수 없습니다.');
                return;
            }

            // Ensure local directory exists
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }

            // Backup existing file if downloadBackup is enabled
            if (config.downloadBackup && fs.existsSync(localPath)) {
                await backupLocalFile(localPath, config);
            }

            // Download to local path with metadata
            if (!connection.client.client) {
                vscode.window.showErrorMessage('SFTP 클라이언트가 초기화되지 않았습니다.');
                return;
            }

            // Check connection status
            if (!connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버 연결이 끊어졌습니다. 다시 연결하시겠습니까?',
                    '연결',
//                    '취소'
                );
                if (reconnect === '연결') {
                    try {
                        await connection.client.connect(config);
                        vscode.window.showInformationMessage('서버에 다시 연결되었습니다.');
                    } catch (error) {
                        vscode.window.showErrorMessage(`재연결 실패: ${error}`);
                        return;
                    }
                } else {
                    return;
                }
            }

            try {
                // 리모트 파일의 정보를 구한다.
                const remoteStats = await connection.client.client.stat(remotePath);
                const remoteModifyTime = new Date(remoteStats.modifyTime).getTime();
                
                // Download file
                await connection.client.client.get(remotePath, localPath);
                
                // Save metadata after successful download
                await connection.client.saveRemoteFileMetadata(remotePath, localPath, config, config.workspaceRoot);
                
                const doc = await vscode.workspace.openTextDocument(localPath);
                documentConfigCache.set(doc, { config, client: connection.client, remotePath });
                await vscode.window.showTextDocument(doc);
            } catch (statError: any) {
                // Handle specific stat errors
                if (statError.message && statError.message.includes('No such file')) {
                    vscode.window.showErrorMessage(`파일을 찾을 수 없습니다: ${remotePath}`);
                } else if (statError.message && statError.message.includes('No response from server')) {
                    vscode.window.showErrorMessage(`서버 응답 없음: ${remotePath}\n서버 연결 상태를 확인하세요.`);
                } else if (statError.message && statError.message.includes('Permission denied')) {
                    vscode.window.showErrorMessage(`권한 거부: ${remotePath}\n파일 접근 권한을 확인하세요.`);
                } else {
                    throw statError; // Re-throw to outer catch
                }
                return;
            }
        } catch (error) {
            console.error('openRemoteFile error:', error);
            vscode.window.showErrorMessage(`파일 열기 실패: ${error}`);
        }
    });



    /**
     * 리모트에 다른 이름으로 저장 Command
     */
    const saveAsCommand = vscode.commands.registerCommand('ctlimSftp.saveAs', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.saveAs');        
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('활성 편집기가 없습니다.');
                return;
            }

            const document = editor.document;
            if (document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('파일 시스템의 파일만 업로드할 수 있습니다.');
                return;
            }

            const localPath = document.uri.fsPath;

            // Check cache first for opened files
            const cached = documentConfigCache.get(document);
            let config: SftpConfig | null = cached?.config || null;
            let cachedClient: SftpClient | null = cached?.client || null;
            
            // Fallback: find config by metadata or file path
            if (!config) {
                config = await findConfigByMetadata(localPath);
            }
            if (!config) {
                config = await findConfigForFile(localPath);
            }
            if (!config) {
                const result = await vscode.window.showErrorMessage(
                    'SFTP 설정을 찾을 수 없습니다. 설정 파일을 생성하시겠습니까?',
                    '설정',
//                    '취소'
                );
                if (result === '설정') {
                    await vscode.commands.executeCommand('ctlimSftp.config');
                }
                return;
            }

            // Use cached client if available and connected
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection: { client: SftpClient; config: SftpConfig } | undefined;
            
            if (cachedClient && cachedClient.isConnected()) {
                connection = { client: cachedClient, config };
            } else {
                connection = treeProvider.getConnectedServer(serverName);
            }
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결',
//                    '취소'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = new SftpClient();
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage('서버 연결 정보를 가져올 수 없습니다.');
                        return;
                    }
                    
                    vscode.window.showInformationMessage(`서버에 연결되었습니다: ${serverName}`);
                } catch (connectError) {
                    vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                    return;
                }
            }

            // Calculate default remote path
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                return;
            }

            const workspaceRoot = config.workspaceRoot || workspaceFolder.uri.fsPath;
            const relativePath = path.relative(workspaceRoot, localPath).replace(/\\/g, '/');
            const defaultRemotePath = path.posix.join(config.remotePath, relativePath);

            // Ask user to choose input method
            const inputMethod = await vscode.window.showQuickPick([
                { label: '$(edit) 직접 입력', method: 'input' },
                { label: '$(folder-opened) 트리에서 선택', method: 'tree' }
            ], {
                placeHolder: '원격 경로 입력 방법을 선택하세요'
            });

            if (!inputMethod) {
                return; // User cancelled
            }

            let remotePath: string | undefined;

            if (inputMethod.method === 'input') {
                // Direct input
                remotePath = await vscode.window.showInputBox({
                    prompt: '원격 저장 경로를 입력하세요',
                    value: defaultRemotePath,
                    placeHolder: '/var/www/html/file.php',
                    validateInput: (value) => {
                        if (!value || value.trim() === '') {
                            return '경로를 입력해주세요';
                        }
                        if (!value.startsWith('/')) {
                            return '절대 경로로 입력해주세요 (예: /var/www/...)';
                        }
                        return null;
                    }
                });
            } else {
                // Tree selection
                remotePath = await selectRemotePathFromTree(connection.client, config.remotePath, path.basename(localPath));
            }

            if (!remotePath) {
                return; // User cancelled
            }

            // Save document if modified
            if (document.isDirty) {
                await document.save();
            }

            // Upload to new path
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `업로드 중: ${path.basename(remotePath)}`,
                cancellable: false
            }, async (progress) => {
                const success = await connection!.client.uploadFile(localPath, remotePath, config!);
                if (success) {
                    vscode.window.showInformationMessage(`✅ 업로드 완료: ${remotePath}`);
                    
                    // Calculate new local path for the remote file
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        return;
                    }
                    
                    const newLocalPath = SftpClient.getDownloadFolder(
                        remotePath, 
                        workspaceFolder.uri.fsPath, 
                        config!, 
                        true, 
                        false
                    );
                    
                    if (!newLocalPath) {
                        return;
                    }
                    
                    // Download the uploaded file from remote
                    if (connection!.client.client) {
                        await connection!.client.client.get(remotePath, newLocalPath);
                        
                        // Save metadata
                        await connection!.client.saveRemoteFileMetadata(
                            remotePath,
                            newLocalPath,
                            config!,
                            config!.workspaceRoot
                        );
                        
                        // Open the downloaded file
                        const newDoc = await vscode.workspace.openTextDocument(newLocalPath);
                        await vscode.window.showTextDocument(newDoc);
                        
                        // Update cache with new document
                        documentConfigCache.set(newDoc, {
                            config: config!,
                            client: connection!.client,
                            remotePath: remotePath
                        });
                    }
                } else {
                    vscode.window.showErrorMessage(`❌ 업로드 실패: ${remotePath}`);
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(`업로드 실패: ${error}`);
            console.error('saveAs error:', error);
        }
    });

    /**
     * 공통 동기화 로직
     */
    async function performSync(uriOrItem: vscode.Uri | any | undefined, direction: 'local-to-remote' | 'remote-to-local' | 'both', commandName: string) {
        if (DEBUG_MODE) console.log(`> ${commandName}`);
        
        try {
            let syncFolder: string;
            let remotePath: string;
            let config: SftpConfig | null = null;

            // TreeView에서 호출된 경우 (SftpTreeItem)
            if (uriOrItem && uriOrItem.config && (uriOrItem.itemType === 'server' || uriOrItem.itemType === 'remoteDirectory')) {
                config = uriOrItem.config;
                remotePath = uriOrItem.remotePath || config!.remotePath;
                
                // 로컬 경로는 config의 context 사용
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                    return;
                }
                
//                syncFolder = config!.workspaceRoot || workspaceFolder.uri.fsPath;
                syncFolder = path.join(uriOrItem.config.workspaceRoot,remotePath);

                if (DEBUG_MODE) console.log(`TreeView 동기화: ${remotePath} <-> ${syncFolder}`);
            }
            // Explorer 컨텍스트 메뉴에서 호출된 경우 (Uri)
            else if (uriOrItem && uriOrItem.fsPath) {
                const stats = fs.statSync(uriOrItem.fsPath);
                syncFolder = stats.isDirectory() ? uriOrItem.fsPath : path.dirname(uriOrItem.fsPath);
                
                // Config 찾기
                config = await findConfigForFile(syncFolder);
                if (!config) {
                    config = await loadConfigWithSelection();
                }
                if (!config) {
                    vscode.window.showErrorMessage('SFTP 설정을 찾을 수 없습니다.');
                    return;
                }
                
                // 원격 경로 계산
                const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showErrorMessage('워크스페이스 루트를 찾을 수 없습니다.');
                    return;
                }
                
                const relativePath = path.relative(workspaceRoot, syncFolder).replace(/\\/g, '/');
                remotePath = path.posix.join(config.remotePath, relativePath);
            }
            // 커맨드 팔레트에서 호출된 경우
            else {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                    return;
                }
                syncFolder = workspaceFolder.uri.fsPath;
                
                config = await loadConfigWithSelection();
                if (!config) {
                    vscode.window.showErrorMessage('SFTP 설정을 찾을 수 없습니다.');
                    return;
                }
                
                remotePath = config.remotePath;
            }

            // config가 null이 아닌지 최종 확인
            if (!config) {
                vscode.window.showErrorMessage('SFTP 설정을 찾을 수 없습니다.');
                return;
            }

            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결',
//                    '취소'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = new SftpClient();
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage('서버 연결 정보를 가져올 수 없습니다.');
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                    return;
                }
            }

            // 삭제 옵션
            const deleteChoice = await vscode.window.showQuickPick([
                { label: '삭제하지 않음', value: false },
                { label: '⚠️ 삭제된 파일도 동기화', value: true }
            ], {
                placeHolder: '삭제된 파일 처리 방법을 선택하세요'
            });

            if (!deleteChoice) {
                return;
            }

            // 방향에 따른 라벨
            const directionLabel = direction === 'local-to-remote' ? '로컬 → 원격' :
                                   direction === 'remote-to-local' ? '원격 → 로컬' :
                                   '양방향 동기화';

            // 확인 대화상자
            const confirmMessage = `동기화 설정:\n\n` +
                `로컬: ${syncFolder}\n` +
                `원격: ${remotePath}\n` +
                `방향: ${directionLabel}\n` +
                `삭제: ${deleteChoice.value ? '예' : '아니오'}\n\n` +
                `계속하시겠습니까?`;

            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                '동기화 시작',
//                '취소'
            );

            if (confirm !== '동기화 시작') {
                return;
            }

            // 동기화 실행
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '폴더 동기화 중...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: '동기화 준비 중...' });

                const result = await connection!.client.syncFolder(
                    syncFolder,
                    remotePath,
                    config!,
                    direction,
                    deleteChoice.value,
                    (current, total, fileName) => {
                        if (total > 0) {
                            progress.report({
                                message: `${fileName} (${current}/${total})`,
                                increment: (1 / total) * 100
                            });
                        } else {
                            progress.report({ message: `${fileName} 처리 중...` });
                        }
                    }
                );

                const summary = [
                    `✅ 동기화 완료!`,
                    ``,
                    `📤 업로드: ${result.uploaded}개`,
                    `📥 다운로드: ${result.downloaded}개`,
                    `🗑️ 삭제: ${result.deleted}개`,
                    result.failed.length > 0 ? `❌ 실패: ${result.failed.length}개` : ''
                ].filter(line => line).join('\n');

                if (result.failed.length > 0) {
                    const viewDetails = await vscode.window.showWarningMessage(
                        summary,
                        '실패 목록 보기'
                    );
                    
                    if (viewDetails) {
                        const failedList = result.failed.join('\n');
                        vscode.window.showInformationMessage(
                            `실패한 파일:\n\n${failedList}`,
                            { modal: true }
                        );
                    }
                } else {
                    vscode.window.showInformationMessage(summary);
                }

                // TreeView 새로고침
                treeProvider.refresh();
            });

        } catch (error) {
            vscode.window.showErrorMessage(`동기화 실패: ${error}`);
            console.error('sync error:', error);
        }
    }

    /**
     * 폴더 동기화 Command - 로컬 → 원격
     */
    const syncUploadCommand = vscode.commands.registerCommand('ctlimSftp.syncUpload', async (uri?: vscode.Uri) => {
        await performSync(uri, 'local-to-remote', 'ctlimSftp.syncUpload');
    });

    /**
     * 폴더 동기화 Command - 원격 → 로컬
     */
    const syncDownloadCommand = vscode.commands.registerCommand('ctlimSftp.syncDownload', async (uri?: vscode.Uri) => {
        await performSync(uri, 'remote-to-local', 'ctlimSftp.syncDownload');
    });

    /**
     * 폴더 동기화 Command - 양방향
     */
    const syncBothCommand = vscode.commands.registerCommand('ctlimSftp.syncBoth', async (uri?: vscode.Uri) => {
        await performSync(uri, 'both', 'ctlimSftp.syncBoth');
    });

    /**
     * 원격에 새 파일 생성 Command
     */
    const newFileCommand = vscode.commands.registerCommand('ctlimSftp.newFile', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.newFile');
        
        try {
            // TreeView item에서 서버 정보 가져오기
            let remotePath: string;
            let config: SftpConfig;
            
            if (item && item.config) {
                config = item.config;
                remotePath = item.remotePath || config.remotePath;
            } else {
                vscode.window.showErrorMessage('서버 정보를 찾을 수 없습니다.');
                return;
            }
            
            // 파일명 입력 받기
            const fileName = await vscode.window.showInputBox({
                prompt: '생성할 파일 이름을 입력하세요',
                placeHolder: 'example.txt',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '파일 이름을 입력해주세요';
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return '파일 이름에 경로 구분자를 포함할 수 없습니다';
                    }
                    return null;
                }
            });
            
            if (!fileName) {
                return; // User cancelled
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결',
//                    '취소'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = new SftpClient();
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage('서버 연결 정보를 가져올 수 없습니다.');
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                    return;
                }
            }
            
            // 파일 생성
            const newFilePath = path.posix.join(remotePath, fileName);
            await connection.client.createRemoteFile(newFilePath);
            
            vscode.window.showInformationMessage(`✅ 파일 생성 완료: ${fileName}`);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(`파일 생성 실패: ${error}`);
            console.error('newFile error:', error);
        }
    });

    /**
     * 원격에 새 폴더 생성 Command
     */
    const newFolderCommand = vscode.commands.registerCommand('ctlimSftp.newFolder', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.newFolder');
        
        try {
            // TreeView item에서 서버 정보 가져오기
            let remotePath: string;
            let config: SftpConfig;
            
            if (item && item.config) {
                config = item.config;
                remotePath = item.remotePath || config.remotePath;
            } else {
                vscode.window.showErrorMessage('서버 정보를 찾을 수 없습니다.');
                return;
            }
            
            // 폴더명 입력 받기
            const folderName = await vscode.window.showInputBox({
                prompt: '생성할 폴더 이름을 입력하세요',
                placeHolder: 'newfolder',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '폴더 이름을 입력해주세요';
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return '폴더 이름에 경로 구분자를 포함할 수 없습니다';
                    }
                    return null;
                }
            });
            
            if (!folderName) {
                return; // User cancelled
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결',
//                    '취소'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = new SftpClient();
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage('서버 연결 정보를 가져올 수 없습니다.');
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                    return;
                }
            }
            
            // 폴더 생성
            const newFolderPath = path.posix.join(remotePath, folderName);
            await connection.client.createRemoteFolder(newFolderPath);
            
            vscode.window.showInformationMessage(`✅ 폴더 생성 완료: ${folderName}`);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(`폴더 생성 실패: ${error}`);
            console.error('newFolder error:', error);
        }
    });

    /**
     * 원격 파일/폴더 삭제 Command
     */
    const deleteRemoteFileCommand = vscode.commands.registerCommand('ctlimSftp.deleteRemoteFile', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.deleteRemoteFile');
        
        try {
            // TreeView item에서 정보 가져오기
            let remotePath: string;
            let isDirectory: boolean;
            let config: SftpConfig;
            
            if (item && item.config && item.remotePath) {
                config = item.config;
                remotePath = item.remotePath;
                isDirectory = item.isDirectory || false;
            } else {
                vscode.window.showErrorMessage('파일 정보를 찾을 수 없습니다.');
                return;
            }
            
            // 삭제 확인
            const fileName = path.basename(remotePath);
            const confirmMessage = isDirectory 
                ? `폴더 "${fileName}"와 모든 하위 항목을 삭제하시겠습니까?`
                : `파일 "${fileName}"을 삭제하시겠습니까?`;
            
            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                '삭제',
//                '취소'
            );
            
            if (confirm !== '삭제') {
                return;
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결',
                    '취소'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = new SftpClient();
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage('서버 연결 정보를 가져올 수 없습니다.');
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                    return;
                }
            }
            
            // 삭제 실행
            await connection.client.deleteRemoteFile(remotePath, isDirectory);
            
            const successMessage = isDirectory 
                ? `✅ 폴더 삭제 완료: ${fileName}`
                : `✅ 파일 삭제 완료: ${fileName}`;
            vscode.window.showInformationMessage(successMessage);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(`삭제 실패: ${error}`);
            console.error('deleteRemoteFile error:', error);
        }
    });

    /**
     * 설정 파일 열기 Command
     */
    const configCommand = vscode.commands.registerCommand('ctlimSftp.config', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('워크스페이스가 열려있지 않습니다.');
            return;
        }

        const vscodeFolder = path.join(workspaceFolder.uri.fsPath, '.vscode');
        const configPath = path.join(vscodeFolder, 'ctlim-sftp.json');

        if (!fs.existsSync(vscodeFolder)) {
            fs.mkdirSync(vscodeFolder, { recursive: true });
        }

        if (!fs.existsSync(configPath)) {
            const defaultConfig = {
                name: "My Server",
                context: "./",
                host: "example.com",
                port: 22,
                username: "username",
                password: "password",
                remotePath: "/remote/path",
                uploadOnSave: true,
                downloadOnOpen: false,
                downloadBackup: ".vscode/.sftp-backup",
                connectTimeout: 10000,
                readyTimeout: 20000,
                keepaliveInterval: 10000,
                keepaliveCountMax: 3,
                watcher: {
                    files: "**/*.{js,ts,css,html}",
                    autoUpload: false,
                    autoDelete: false
                },
                ignore: [
                    ".vscode",
                    ".git",
                    "node_modules"
                ]
            };
            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4));
        }

        const doc = await vscode.workspace.openTextDocument(configPath);
        await vscode.window.showTextDocument(doc);

        // Load config and connect
        const config = await loadConfigWithSelection();
        if (config) {
            await ensureClient(config);
            if (sftpClient && currentConfig) {
                treeProvider.refresh();
            }
        }
    });
//#endregion    

//#region watchers
    /**
     * 파일 저장시 자동 업로드
     */
    const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (DEBUG_MODE) console.log('> onDidSaveTextDocument');
        if (document.uri.scheme !== 'file') {
            return; // 파일이 아니면 무시
        }
        // Skip config file
        if (document.uri.fsPath.endsWith('ctlim-sftp.json')) {
            // Reload config
            const newConfig = await loadConfig();
            if (newConfig) {
                await ensureClient(newConfig);
                treeProvider.refresh();
            }
            return;
        }

        // Check if file is in workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }
        
        // "ctlimSftp.openRemoteFile" 에서 저장한 document의 config와 client, remotePath를 구한다.
        const cached = documentConfigCache.get(document);
        let config: SftpConfig | null = cached?.config || null;
        let cachedClient: SftpClient | null = cached?.client || null;
        let cachedRemotePath: string | null = cached?.remotePath || "";
        
        // Fallback: find config by file path
        if (!config) {
            config = await findConfigForFile(document.uri.fsPath);
        }
        
        if (!config) {
            return;
        }
        
        if (!config.uploadOnSave) {
            return;
        }

        // Check if file should be ignored
        const relativePath = vscode.workspace.asRelativePath(document.uri);
        const shouldIgnore = config.ignore?.some(pattern => {
            return relativePath.includes(pattern);
        });

        if (shouldIgnore) {
            return;
        }

        try {
            // Use cached client if available, otherwise ensure client
            if (cachedClient && cachedClient.isConnected()) {
                sftpClient = cachedClient;
            } else {
                await ensureClient(config);
                if (!sftpClient) {
                    vscode.window.showErrorMessage('SFTP 클라이언트 연결 실패');
                    return;
                }
            }

            // 리모트 파일정보와 로칼에 있는 파일의 정보를 비교 한다.
            const fSameMetadata = await sftpClient.isSameMetadata(document.uri.fsPath, cachedRemotePath, config);

            // 리모트와 로칼이 다를 때
            if(!fSameMetadata){ 
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ 충돌 감지!\n\n파일이 서버에서 수정되었습니다: ${path.basename(document.uri.fsPath)}\n\n로컬 변경사항으로 덮어쓰시겠습니까?`,
                    { modal: true },
                    '덮어쓰기',
                    '비교'
                );
                
                if (choice === '덮어쓰기') {
                    const forceResult = await sftpClient.uploadFile(document.uri.fsPath, cachedRemotePath, config);
                } 
                else if (choice === '비교') {
// 확인 요망
                    let metadataDirTemp = workspaceFolder.uri.fsPath;
                    if(config.workspaceRoot){
                        metadataDirTemp = config.workspaceRoot;
                    }
                    await showDiff(document.uri.fsPath, cachedRemotePath, config, metadataDirTemp);
                }
            }
            // 리모트와 로칼이 같을 때
            else {
                const forceResult = await sftpClient.uploadFile(document.uri.fsPath, cachedRemotePath, config);
            }
        } catch (error: any) {
            // 연결이 끊어졌습니다
            try {
                // Clear cached client
                documentConfigCache.delete(document);
                
                // Reconnect
                await ensureClient(config);
                if (sftpClient) {
                    // Retry upload
                    const retryResult = await sftpClient.uploadFile(document.uri.fsPath, cachedRemotePath, config);
                    if (retryResult) {
                        if (DEBUG_MODE) console.log('재연결 후 업로드 성공');                        
                        vscode.window.showInformationMessage(`✅ 재연결 후 업로드 성공: ${path.basename(document.uri.fsPath)}`);
                        // Update cache with new client
                        documentConfigCache.set(document, { config, client: sftpClient, remotePath: cachedRemotePath });
                    }
                }
            } 
            catch (retryError) {
                vscode.window.showErrorMessage(`❌ 재연결 실패: ${retryError}`);
            }

        }
    });


    context.subscriptions.push(
        connectServerCommand,
        disconnectServerCommand,
        configCommand,
        refreshCommand,
        switchServerCommand,
        openRemoteFileCommand,
        saveAsCommand,
        syncUploadCommand,
        syncDownloadCommand,
        syncBothCommand,
        newFileCommand,
        newFolderCommand,
        deleteRemoteFileCommand,
        saveWatcher
        
//        uploadCommand,
//        downloadCommand,
//        openWatcher   // 나중에 추가 할 것
    );
}
//#region 




//#region functions
/**
 *      
 * @returns 
 */
async function loadConfig(): Promise<SftpConfig | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('워크스페이스가 열려있지 않습니다.');
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        const result = await vscode.window.showErrorMessage(
            'ctlim SFTP 설정 파일이 없습니다. 생성하시겠습니까?',
            '생성',
//            '취소'
        );
        if (result === '생성') {
            await vscode.commands.executeCommand('ctlimSftp.config');
        }
        return null;
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        
        // Support both single config object and array of configs
        const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
        
        // Return the first config with uploadOnSave enabled, or the first config, or default profile
        let config = configs.find(c => c.uploadOnSave) || 
                     configs.find(c => c.defaultProfile) ||
                     configs[0];
        
        if (!config) {
            return null;
        }
        
        // Use context to determine workspace root
        const contextPath = config.context || './';
        const workspaceRoot = path.isAbsolute(contextPath) 
            ? contextPath 
            : path.join(workspaceFolder.uri.fsPath, contextPath);
        
        config.workspaceRoot = workspaceRoot;
        currentConfig = config;
        return config;
    } catch (error) {
        vscode.window.showErrorMessage(`설정 파일 로드 실패: ${error}`);
        return null;
    }
}

/**
 * 
 * @returns 
 */
async function loadConfigWithSelection(): Promise<SftpConfig | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('워크스페이스가 열려있지 않습니다.');
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        const result = await vscode.window.showErrorMessage(
            'ctlim SFTP 설정 파일이 없습니다. 생성하시겠습니까?',
            '생성',
//            '취소'
        );
        if (result === '생성') {
            await vscode.commands.executeCommand('ctlimSftp.config');
        }
        return null;
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        
        // Support both single config object and array of configs
        const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
        
        let config: SftpConfig | undefined;
        
        if (configs.length === 0) {
            vscode.window.showErrorMessage('설정 파일에 서버 정보가 없습니다.');
            return null;
        } else if (configs.length === 1) {
            // 하나만 있으면 자동 선택
            config = configs[0];
        } else {
            // 여러 개 있으면 사용자가 선택
            const items = configs.map(c => ({
                label: c.name || `${c.username}@${c.host}`,
                description: `${c.host}:${c.port} → ${c.remotePath}`,
                config: c
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '연결할 서버를 선택하세요'
            });
            
            if (!selected) {
                return null;
            }
            
            config = selected.config;
        }
        
        if (!config) {
            return null;
        }
        
        // Use context to determine workspace root
        const contextPath = config.context || './';
        const workspaceRoot = path.isAbsolute(contextPath) 
            ? contextPath 
            : path.join(workspaceFolder.uri.fsPath, contextPath);
        
        config.workspaceRoot = workspaceRoot;
        currentConfig = config;
        return config;
    } catch (error) {
        vscode.window.showErrorMessage(`설정 파일 로드 실패: ${error}`);
        return null;
    }
}

/**
 * 
 * @param configName 
 * @returns 
 */
async function findConfigByName(configName: string): Promise<SftpConfig | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        
        // Support both single config object and array of configs
        const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
        
        // Find config by name
        for (const config of configs) {
            if (config.name === configName) {
                const contextPath = config.context || './';
                const workspaceRoot = path.isAbsolute(contextPath) 
                    ? contextPath 
                    : path.join(workspaceFolder.uri.fsPath, contextPath);
                
                config.workspaceRoot = workspaceRoot;
                currentConfig = config;
                return config;
            }
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * 
 * @param filePath 
 * @returns 
 */
async function findConfigByMetadata(filePath: string): Promise<SftpConfig | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        
        const configs = Array.isArray(configData) ? configData : [configData];
        
        // Encode filePath to safe metadata filename
        const safeLocalPath = SftpClient.makeMetafileName(filePath);
        
        // Check each config for matching metadata
        for (const config of configs) {
            const workspaceRoot = config.context 
                ? path.isAbsolute(config.context)
                    ? config.context
                    : path.join(workspaceFolder.uri.fsPath, config.context)
                : workspaceFolder.uri.fsPath;
            
            const metadataPath = path.join(workspaceRoot, '.vscode', '.sftp-metadata', `${safeLocalPath}.json`);
            
            if (fs.existsSync(metadataPath)) {
                config.workspaceRoot = workspaceRoot;
                return config;
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error finding config by metadata:', error);
        return null;
    }
}

/**
 * 
 * @param filePath 
 * @returns 
 */
async function findConfigForFile(filePath: string): Promise<SftpConfig | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        
        // Support both single config object and array of configs
        const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
        
        // Find config whose workspaceRoot contains the file
        for (const config of configs) {
            const contextPath = config.context || './';
            const workspaceRoot = path.isAbsolute(contextPath) 
                ? contextPath 
                : path.join(workspaceFolder.uri.fsPath, contextPath);
            
            config.workspaceRoot = workspaceRoot;
            
            // Check if file is within this config's workspace root
            if (filePath.startsWith(workspaceRoot)) {
                currentConfig = config;
                return config;
            }
        }
        
        // If no match found, return first config with uploadOnSave
        const fallbackConfig = configs.find(c => c.uploadOnSave) || configs[0];
        if (fallbackConfig) {
            const contextPath = fallbackConfig.context || './';
            const workspaceRoot = path.isAbsolute(contextPath) 
                ? contextPath 
                : path.join(workspaceFolder.uri.fsPath, contextPath);
            fallbackConfig.workspaceRoot = workspaceRoot;
            currentConfig = fallbackConfig;
        }
        return fallbackConfig || null;
    } catch (error) {
        return null;
    }
}

/**
 * 
 * @param config 
 */
async function ensureClient(config: SftpConfig): Promise<void> {
    if (!sftpClient) {
        sftpClient = new SftpClient();
    }
    
    if (!sftpClient.isConnected()) {
        await sftpClient.connect(config);
        currentConfig = config;
    }
}

/**
 * SFTP 연결 상태 확인 및 재연결
 * @param client SFTP 클라이언트
 * @param config 서버 설정
 * @param serverName 서버 이름
 * @returns 연결 성공 여부
 */
async function ensureConnected(client: SftpClient, config: SftpConfig, serverName: string): Promise<boolean> {
    try {
        if (client.isConnected()) {
            return true;
        }
        
        if (DEBUG_MODE) console.log(`연결 끊김 감지, 재연결 시도: ${serverName}`);
        await client.connect(config);

        // treeProvider에 없을 때만 추가 (기존 연결은 보존)
        const existingConnection = treeProvider.getConnectedServer(serverName);
        if (!existingConnection) {
            treeProvider.addConnectedServer(serverName, client, config);
        }
        if (DEBUG_MODE) console.log(`재연결 성공: ${serverName}`);
        return true;
    } catch (error) {
console.error(`재연결 실패: ${serverName}`, error);
        return false;
    }
}

/**
 * 원격 파일 다운로드 후 에디터에서 새로고침
 * @param remotePath 원격 파일 경로
 * @param localPath 로컬 파일 경로
 * @param config 서버 설정
 * @param document 열려있는 문서 (옵션)
 * @param preserveFocus 포커스 유지 여부
 */
async function downloadAndReloadFile(
    remotePath: string,
    localPath: string,
    config: SftpConfig,
    document?: vscode.TextDocument,
    preserveFocus: boolean = true
): Promise<boolean> {
    try {
        const connection = treeProvider.getConnectedServer(
            config.name || `${config.username}@${config.host}`
        );
        
        if (!connection || !connection.client.client) {
            return false;
        }

        // 열려있는 문서면 먼저 닫기
        if (document) {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.fsPath === document.uri.fsPath
            );
            if (editor) {
                await vscode.window.showTextDocument(document, { preview: false });
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }
        }

        // Backup existing file if downloadBackup is enabled
        if (config.downloadBackup && fs.existsSync(localPath)) {
            await backupLocalFile(localPath, config);
        }

        // 파일 다운로드
        await connection.client.client.get(remotePath, localPath);
        await connection.client.saveRemoteFileMetadata(
            remotePath,
            localPath,
            config,
            config.workspaceRoot
        );

        // 다시 열기
        if (document) {
            const newDoc = await vscode.workspace.openTextDocument(localPath);
            await vscode.window.showTextDocument(newDoc, { 
                preview: false, 
                preserveFocus: preserveFocus
            });
        }

        return true;
    } catch (error) {
console.error(`다운로드 실패: ${localPath}`, error);
        return false;
    }
}

/**
 * 트리 탐색으로 원격 경로 선택
 * @param client SFTP 클라이언트
 * @param startPath 시작 경로
 * @param fileName 저장할 파일 이름
 * @returns 선택한 원격 경로 또는 undefined
 */
async function selectRemotePathFromTree(client: SftpClient, startPath: string, fileName: string): Promise<string | undefined> {
    let currentPath = startPath;
    
    while (true) {
        try {
            // 현재 디렉토리의 파일 목록 가져오기
            const files = await client.listRemoteFiles(currentPath);
            
            // QuickPick 아이템 생성
            const items: Array<{ label: string; description: string; path: string; isDirectory: boolean; isSpecial?: boolean }> = [];
            
            // 상위 디렉토리 이동 옵션
            if (currentPath !== '/') {
                items.push({
                    label: '$(arrow-up) ..',
                    description: '상위 디렉토리로 이동',
                    path: path.posix.dirname(currentPath),
                    isDirectory: true,
                    isSpecial: true
                });
            }
            
            // 현재 위치에 저장 옵션
            items.push({
                label: `$(file) ${fileName}`,
                description: '현재 디렉토리에 저장',
                path: path.posix.join(currentPath, fileName),
                isDirectory: false,
                isSpecial: true
            });
            
            // 디렉토리 먼저
            const directories = files.filter(f => f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
            for (const dir of directories) {
                items.push({
                    label: `$(folder) ${dir.name}`,
                    description: '디렉토리',
                    path: dir.path,
                    isDirectory: true
                });
            }
            
            // 파일들 (참고용)
            const regularFiles = files.filter(f => !f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
            for (const file of regularFiles) {
                items.push({
                    label: `$(file) ${file.name}`,
                    description: `${(file.size || 0)} bytes`,
                    path: file.path,
                    isDirectory: false
                });
            }
            
            // QuickPick 표시
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `현재 위치: ${currentPath} - 저장 위치를 선택하세요`,
                matchOnDescription: true
            });
            
            if (!selected) {
                return undefined; // 취소
            }
            
            // 특수 항목 처리
            if (selected.isSpecial) {
                if (selected.label.startsWith('$(arrow-up)')) {
                    // 상위 디렉토리로 이동
                    currentPath = selected.path;
                    continue;
                } else if (selected.label.startsWith('$(file)')) {
                    // 현재 위치에 저장
                    return selected.path;
                }
            }
            
            // 디렉토리 선택 시 하위로 이동
            if (selected.isDirectory) {
                currentPath = selected.path;
                continue;
            }
            
            // 파일 선택 시 - 같은 디렉토리에 새 파일명으로 저장
            const dir = path.posix.dirname(selected.path);
            const newPath = path.posix.join(dir, fileName);
            
            const confirm = await vscode.window.showWarningMessage(
                `${dir}/ 디렉토리에 ${fileName}로 저장하시겠습니까?`,
                '저장',
//                '취소'
            );
            
            if (confirm === '저장') {
                return newPath;
            }
            // 취소 시 계속 탐색
            
        } catch (error) {
            vscode.window.showErrorMessage(`원격 디렉토리 탐색 실패: ${error}`);
            return undefined;
        }
    }
}

/**
 * 
 * @param localPath 
 * @param remotePath 
 * @param config 
 * @param workspaceFolder 
 * @returns 
 */
async function showDiff(localPath: string, remotePath: string, config: SftpConfig, workspaceFolder: string): Promise<void> {
    try {
        if (!sftpClient || !sftpClient.isConnected()) {
            vscode.window.showErrorMessage('서버에 연결되어 있지 않습니다.');
            return;
        }

        // Create temp directory for remote file
        const tempDir = path.join(workspaceFolder, '.vscode', '.sftp-tmp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Download remote file to temp location
        const fileName = path.basename(remotePath);
        const tempRemotePath = path.join(tempDir, `${fileName}.remote`);
        
        if (sftpClient.client) {
            await sftpClient.client.get(remotePath, tempRemotePath);

            // Open diff view
            const localUri = vscode.Uri.file(localPath);
            const remoteUri = vscode.Uri.file(tempRemotePath);
            
            await vscode.commands.executeCommand(
                'vscode.diff',
                remoteUri,
                localUri,
                `${fileName} (서버) ↔ ${fileName} (로컬)`
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Diff 표시 실패: ${error}`);
    }
}

/**
 * 
 * @param localPath 
 * @param remotePath 
 * @param config 
 * @param workspaceFolder 
 * @returns 
 */
async function refreshFileMetadata(localPath: string, remotePath: string, config: SftpConfig, workspaceFolder: string): Promise<boolean> {
    try {
        if (!sftpClient || !sftpClient.isConnected()) {
            return false;
        }

        const remoteMetadata = await sftpClient.getRemoteFileInfo(remotePath);
        if (remoteMetadata == null) {
            return false;
        }

        // Save updated metadata
        const metadataDir = path.join(workspaceFolder, '.vscode', '.sftp-metadata');
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }

        const safeRemotePath = remotePath
            .replace(/^\//g, '')
            .replace(/_/g, '_u_')
            .replace(/\//g, '__');
        const metadataPath = path.join(metadataDir, `${safeRemotePath}.json`);
        
        const metadata = {
            remotePath,
            remoteModifyTime: remoteMetadata.remoteModifyTime,
            remoteFileSize: remoteMetadata.remoteFileSize,
            localPath,
            downloadTime: Date.now()
        };

        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * VSCode 시작 시 이전에 열었던 파일들을 원격 서버와 동기화
 * 메타데이터가 있는 모든 파일을 확인하고 변경사항이 있으면 사용자에게 알림
 */
async function checkAndReloadRemoteFiles() {
if (DEBUG_MODE) console.log('> checkAndReloadRemoteFiles');    
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        // 설정 파일 로드
        const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
        if (!fs.existsSync(configPath)) {
            return;
        }

        const configContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
        
        if (configs.length === 0) {
            return;
        }

        // workspaceRoot 계산 (모든 config에 대해)
        for (const config of configs) {
            const contextPath = config.context || './';
            const workspaceRoot = path.isAbsolute(contextPath) 
                ? contextPath 
                : path.join(workspaceFolder.uri.fsPath, contextPath);
            config.workspaceRoot = workspaceRoot;
        }

        // 1단계: 열려있는 문서들 수집
        const openDocuments: vscode.TextDocument[] = [];
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === 'file' && !doc.uri.fsPath.endsWith('ctlim-sftp.json')) {
                openDocuments.push(doc);
            }
        }

        if (openDocuments.length === 0) {
            if (DEBUG_MODE) console.log('열려있는 문서가 없습니다.');
            return;
        }

        if (DEBUG_MODE) console.log(`${openDocuments.length}개의 열린 문서 발견`);  
        // 2단계: 각 열린 문서에 대해 메타데이터 확인 및 서버별 그룹화
        const serverFileMap = new Map<string, Array<{
            document: vscode.TextDocument;
            metadata: FileMetadata;
            config: SftpConfig;
        }>>();

        for (const document of openDocuments) {
            const localPath = document.uri.fsPath;
            
            // Check cache first
            const cached = documentConfigCache.get(document);
            if (cached) {
                // Use cached config and remotePath
                const config = cached.config;
                const serverName = config.name || `${config.username}@${config.host}`;
                
                // Create metadata from cache
                const metadata: FileMetadata = {
                    remotePath: cached.remotePath,
                    remoteModifyTime: 0, // Will be checked later
                    remoteFileSize: 0,   // Will be checked later
                    localPath: localPath,
                    downloadTime: Date.now(),
                    configName: config.name
                };
                
                if (!serverFileMap.has(serverName)) {
                    serverFileMap.set(serverName, []);
                }
                
                serverFileMap.get(serverName)!.push({
                    document,
                    metadata,
                    config
                });
                
                if (DEBUG_MODE) console.log(`캐시에서 발견: ${path.basename(localPath)} -> ${serverName}`);
                continue; // Skip metadata file search
            }
            
            // Fallback: 메타데이터 파일명 인코딩
            const safeLocalPath = SftpClient.makeMetafileName(localPath);
            
            // 각 config의 workspaceRoot에서 메타데이터 찾기
            for (const config of configs) {
                const metadataPath = path.join(
                    config.workspaceRoot || '', 
                    '.vscode', 
                    '.sftp-metadata', 
                    `${safeLocalPath}`
                );
                
                if (fs.existsSync(metadataPath)) {
                    try {
                        const metadata: FileMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                        
                        // 서버 이름으로 그룹화
                        const serverName = config.name || `${config.username}@${config.host}`;
                        
                        if (!serverFileMap.has(serverName)) {
                            serverFileMap.set(serverName, []);
                        }
                        
                        serverFileMap.get(serverName)!.push({
                            document,
                            metadata,
                            config
                        });
                        
                        if (DEBUG_MODE) console.log(`메타데이터 발견: ${path.basename(localPath)} -> ${serverName}`);
                        break; // 메타데이터 찾았으면 다음 문서로
                    } catch (error) {
                        console.error(`메타데이터 읽기 실패: ${metadataPath}`, error);
                    }
                }
            }
        }

        if (serverFileMap.size === 0) {
            if (DEBUG_MODE) console.log('메타데이터가 있는 열린 문서가 없습니다.');
            return;
        }

        if (DEBUG_MODE) console.log(`${serverFileMap.size}개 서버의 파일 확인 필요`);

        // 3단계: 변경된 파일 목록 수집
        const changedFiles: Array<{
            localPath: string;
            remotePath: string;
            fileName: string;
            config: SftpConfig;
            document?: vscode.TextDocument;
        }> = [];

        // 4단계: 필요한 서버만 연결하고 파일 확인
        for (const [serverName, fileInfos] of serverFileMap.entries()) {
            if (fileInfos.length === 0) {
                continue;
            }

            const config = fileInfos[0].config;
            
            // 서버 연결 확인: 캐시 → treeProvider → 새 연결
            let client: SftpClient | null = null;
            
            // 1. 캐시된 client가 있으면 우선 사용
            for (const fileInfo of fileInfos) {
                const cached = documentConfigCache.get(fileInfo.document);
                if (cached && cached.client) {
                    if (cached.client.isConnected()) {
                        client = cached.client;
                        if (DEBUG_MODE) console.log(`캐시된 연결 사용: ${serverName}`);
                        break;
                    } 
                    else {
                        if (DEBUG_MODE) console.log(`캐시된 연결이 끊어짐, 재연결 시도: ${serverName}`);
                        // 재연결 시도
                        const reconnected = await ensureConnected(cached.client, config, serverName);
                        if (reconnected) {
                            client = cached.client;
                            if (DEBUG_MODE) console.log(`캐시된 클라이언트 재연결 성공: ${serverName}`);
                            break;
                        }
                    }
                }
            }
            
            // 2. treeProvider에서 찾기
            if (!client) {
                const connection = treeProvider.getConnectedServer(serverName);
                if (connection && connection.client.isConnected()) {
                    client = connection.client;
                    if (DEBUG_MODE) console.log(`treeProvider 연결 사용: ${serverName}`);
                }
            }
            
            // 3. 새 연결 생성
            if (!client) {
                client = new SftpClient();
                try {
                    if (DEBUG_MODE) console.log(`서버 연결 시작: ${serverName}`);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    if (DEBUG_MODE) console.log(`서버 연결 성공: ${serverName}`);
                } catch (connectError) {
                    console.error(`서버 연결 실패: ${serverName}`, connectError);
                    continue;
                }
            }

            // 이 서버의 파일들 확인
            if (DEBUG_MODE) console.log(`${serverName}: ${fileInfos.length}개 파일 확인 중`);
            
            for (const fileInfo of fileInfos) {
                try {
                    const remoteMetadata = await client.getRemoteFileInfo(fileInfo.metadata.remotePath);
                    
                    // documentConfigCache 업데이트 (없으면 추가, 있으면 갱신)
                    documentConfigCache.set(fileInfo.document, {
                        config: fileInfo.config,
                        client: client,
                        remotePath: fileInfo.metadata.remotePath
                    });
                    
                    // 변경사항 확인 (시간 또는 크기 변경)
                    if (fileInfo.metadata.remoteModifyTime !== remoteMetadata.remoteModifyTime || 
                        fileInfo.metadata.remoteFileSize !== remoteMetadata.remoteFileSize) {
                        
                        const fileName = path.basename(fileInfo.document.uri.fsPath);
                        
                        changedFiles.push({
                            localPath: fileInfo.document.uri.fsPath,
                            remotePath: fileInfo.metadata.remotePath,
                            fileName: fileName,
                            config: fileInfo.config,
                            document: fileInfo.document
                        });
                        
                        if (DEBUG_MODE) console.log(`변경 감지: ${fileName}`);
                    }
                } catch (remoteError: any) {
                    // 연결이 끊어진 경우 재연결 시도
                    if (remoteError.message && (
                        remoteError.message.includes('Not connected') ||
                        remoteError.message.includes('No response from server') ||
                        remoteError.message.includes('ECONNRESET') ||
                        remoteError.message.includes('ETIMEDOUT')
                    )) {
                        // ensureConnected 함수로 재연결
                        const reconnected = await ensureConnected(client, config, serverName);
                        
                        if (reconnected) {
                            try {
                                // 작업 재시도
                                const remoteMetadata = await client.getRemoteFileInfo(fileInfo.metadata.remotePath);
                                
                                // documentConfigCache 업데이트
                                documentConfigCache.set(fileInfo.document, {
                                    config: fileInfo.config,
                                    client: client,
                                    remotePath: fileInfo.metadata.remotePath
                                });
                                
                                if (fileInfo.metadata.remoteModifyTime !== remoteMetadata.remoteModifyTime || 
                                    fileInfo.metadata.remoteFileSize !== remoteMetadata.remoteFileSize) {
                                    
                                    const fileName = path.basename(fileInfo.document.uri.fsPath);
                                    
                                    changedFiles.push({
                                        localPath: fileInfo.document.uri.fsPath,
                                        remotePath: fileInfo.metadata.remotePath,
                                        fileName: fileName,
                                        config: fileInfo.config,
                                        document: fileInfo.document
                                    });
                                    
                                    if (DEBUG_MODE) console.log(`재연결 후 변경 감지: ${fileName}`);
                                }
                            } catch (retryError) {
console.error(`재시도 실패: ${fileInfo.metadata.remotePath}`, retryError);
                            }
                        }
                    } else {
                        // 원격 파일이 없거나 기타 오류
console.error(`원격 파일 확인 실패: ${fileInfo.metadata.remotePath}`, remoteError);
                    }
                }
            }
        }

        // 변경된 파일이 있으면 사용자에게 알림
        if (changedFiles.length > 0) {
            const message = changedFiles.length === 1
                ? `🔄 서버 파일 변경 감지!\n\n파일: ${changedFiles[0].fileName}\n서버의 파일이 수정되었습니다.`
                : `🔄 서버 파일 변경 감지!\n\n${changedFiles.length}개의 파일이 서버에서 수정되었습니다.`;

            const choice = await vscode.window.showInformationMessage(
                message,
                { modal: true },
                '모두 다운로드',
                '개별 선택',
                '무시'
            );

            if (choice === '모두 다운로드') {
                // 모든 파일 다운로드
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "원격 파일 다운로드 중...",
                    cancellable: false
                }, async (progress) => {
                    let completed = 0;
                    for (const fileInfo of changedFiles) {
                        progress.report({
                            message: `${fileInfo.fileName} (${completed + 1}/${changedFiles.length})`,
                            increment: (1 / changedFiles.length) * 100
                        });

                        await downloadAndReloadFile(
                            fileInfo.remotePath,
                            fileInfo.localPath,
                            fileInfo.config,
                            fileInfo.document,
                            true  // preserveFocus
                        );
                        
                        completed++;
                    }
                });

                vscode.window.showInformationMessage(`✅ ${changedFiles.length}개 파일 다운로드 완료`);

            } else if (choice === '개별 선택') {
                // 개별 파일 선택
                for (const fileInfo of changedFiles) {
                    const fileName = fileInfo.fileName;
                    const fileChoice = await vscode.window.showWarningMessage(
                        `⚠️ 파일: ${fileName}\n서버에서 수정되었습니다.`,
                        { modal: true },
                        '다운로드',
                        '비교'
                    );

                    if (fileChoice === '다운로드') {
                        const success = await downloadAndReloadFile(
                            fileInfo.remotePath,
                            fileInfo.localPath,
                            fileInfo.config,
                            fileInfo.document,
                            false  // preserveFocus - 개별 다운로드는 포커스 이동
                        );
                        
                        if (success) {
                            vscode.window.showInformationMessage(`✅ 다운로드 완료: ${fileName}`);
                        } else {
                            vscode.window.showErrorMessage(`❌ 다운로드 실패: ${fileName}`);
                        }
                    } else if (fileChoice === '비교') {
                        await showDiff(
                            fileInfo.localPath, 
                            fileInfo.remotePath, 
                            fileInfo.config, 
                            fileInfo.config.workspaceRoot || workspaceFolder.uri.fsPath
                        );
                    }
                }
            }
        }
    } catch (error) {
console.error('원격 파일 확인 중 오류:', error);
    }
}

/**
 * 로컬 파일 백업
 * @param localPath 백업할 로컬 파일 경로
 * @param config 서버 설정
 */
async function backupLocalFile(localPath: string, config: SftpConfig): Promise<void> {
    if (DEBUG_MODE) console.log(`백업 ${localPath}`);

    try {
        const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return;
        }

        if(config.downloadBackup == "" ) return; // 백업 비활성화
        
        // Get remote path from metadata
        let remotePath = '';
        try {
            const metadataPath = SftpClient.getMetadataPath(localPath, config);
            if (fs.existsSync(metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                remotePath = metadata.remotePath || '';
            }
        } catch (error) {
            // Metadata not found or invalid, use local path instead
        }

        // Create backup directory from config or default
        const backupConfigPath = config.downloadBackup || '.vscode/.sftp-backup';
        const backupRootDir = path.isAbsolute(backupConfigPath) 
            ? backupConfigPath 
            : path.join(workspaceRoot, backupConfigPath);
        
        // Create backup directory structure matching remote path
        let backupDir = backupRootDir;
        if (remotePath) {
            // Use remote path structure (remove leading slash)
            const remoteDir = path.dirname(remotePath).replace(/^\/+/, '');
            backupDir = path.join(backupRootDir, remoteDir);
        }
        
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Generate backup filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
        const fileName = path.basename(localPath);
        const backupFileName = `${fileName}.${timestamp}.backup`;
        const backupFilePath = path.join(backupDir, backupFileName);

        // Copy file to backup
        fs.copyFileSync(localPath, backupFilePath);
        
        if (DEBUG_MODE) console.log(`백업 완료: ${backupFilePath}`);
        
        // Optional: Clean old backups (keep last 5)
        const backupPattern = new RegExp(`^${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\..*\\.backup$`);
        const backupFiles = fs.readdirSync(backupDir)
            .filter(f => backupPattern.test(f))
            .map(f => ({
                name: f,
                path: path.join(backupDir, f),
                mtime: fs.statSync(path.join(backupDir, f)).mtime.getTime()
            }))
            .sort((a, b) => b.mtime - a.mtime);
        
        // Keep only last 5 backups
        if (backupFiles.length > 5) {
            for (let i = 5; i < backupFiles.length; i++) {
                fs.unlinkSync(backupFiles[i].path);
                if (DEBUG_MODE) console.log(`오래된 백업 삭제: ${backupFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error('백업 실패:', error);
        // Backup failure should not stop the download
    }
}

/**
 * StatusBar 업데이트
 */
function updateStatusBar(): void {
    const connectedServers = treeProvider.getConnectedServerNames();
    
    if (connectedServers.length === 0) {
        statusBarItem.text = '$(cloud-upload) SFTP: 연결 안 됨';
        statusBarItem.tooltip = '클릭하여 서버 선택';
        statusBarItem.backgroundColor = undefined;
    } else if (connectedServers.length === 1) {
        statusBarItem.text = `$(cloud) SFTP: ${connectedServers[0]}`;
        statusBarItem.tooltip = `연결됨: ${connectedServers[0]}\n클릭하여 전환/해제`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
        statusBarItem.text = `$(cloud) SFTP: ${connectedServers.length}개 서버`;
        statusBarItem.tooltip = `연결된 서버:\n${connectedServers.join('\n')}\n\n클릭하여 관리`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    }
}

/**
 * 
 */
export function deactivate() {
    if (sftpClient) {
        sftpClient.disconnect();
    }
}

//#endregion