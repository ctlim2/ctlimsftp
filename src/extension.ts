import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpClient } from './sftpClient';
import { FtpClient } from './ftpClient';
import { SftpConfig, FileMetadata, RemoteFile, TransferHistory, Bookmark } from './types';
import { SftpTreeProvider, SftpDragAndDropController, SftpTreeItem } from './sftpTreeProvider';
import { TransferHistoryManager, createTransferHistory } from './transferHistory';
import { BookmarkManager } from './bookmarkManager';
import { TemplateManager } from './templateManager';
import { i18n } from './i18n';

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = true;

// 클라이언트 타입 (SFTP 또는 FTP)
type ClientType = SftpClient | FtpClient;

let sftpClient: ClientType | null = null;
let treeProvider: SftpTreeProvider;
let currentConfig: SftpConfig | null = null;
let statusBarItem: vscode.StatusBarItem;
let transferHistoryManager: TransferHistoryManager | null = null;
let bookmarkManager: BookmarkManager | null = null;
let templateManager: TemplateManager | null = null;
let sftpTreeView: vscode.TreeView<SftpTreeItem> | null = null;

// 북마크 네비게이션 중 onDidChangeSelection 자동 실행 방지
let isNavigatingBookmark: boolean = false;

// Cache document-config and client mapping for performance
const documentConfigCache = new WeakMap<vscode.TextDocument, { config: SftpConfig; client: ClientType; remotePath: string }>();

/**
 * 프로토콜에 따라 적절한 클라이언트 생성
 */
function createClient(config: SftpConfig): ClientType {
    const protocol = config.protocol || 'sftp';
    
    if (protocol === 'ftp' || protocol === 'ftps') {
        if (DEBUG_MODE) console.log(i18n.t('ext.ftpClientCreating', { host: config.host }));
        return new FtpClient();
    }
    
    if (DEBUG_MODE) console.log(i18n.t('ext.sftpClientCreating', { host: config.host }));
    return new SftpClient();
}

export function activate(context: vscode.ExtensionContext) {
    if (DEBUG_MODE) console.log(i18n.t('ext.activated'));

    // Create Output Channel for logging
    const outputChannel = vscode.window.createOutputChannel('ctlim SFTP');
    context.subscriptions.push(outputChannel);
    outputChannel.show(); // F5 디버깅 시 자동으로 Output 창 표시

    // Register Tree View Provider (StatusBar보다 먼저 생성)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    treeProvider = new SftpTreeProvider(workspaceFolder?.uri.fsPath);
    
    // Initialize Transfer History Manager
    if (workspaceFolder) {
        bookmarkManager = new BookmarkManager(workspaceFolder.uri.fsPath);
        transferHistoryManager = new TransferHistoryManager(workspaceFolder.uri.fsPath);
        templateManager = new TemplateManager(workspaceFolder.uri.fsPath);
    }
    
    // Create Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'ctlimSftp.switchServer';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    // Create Drag and Drop Controller
    const dragAndDropController = new SftpDragAndDropController(treeProvider, outputChannel);
    
    /**
     * Create Tree View with Drag and Drop support
     */
    sftpTreeView = vscode.window.createTreeView('ctlimSftpView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
        canSelectMany: true,
        dragAndDropController: dragAndDropController
    });
    
    /**
     * Handle selection on tree items (servers only, files use double-click)
     */
    sftpTreeView.onDidChangeSelection(async (e) => {
        // 북마크 네비게이션 중에는 자동 실행 건너뛰기
        if (isNavigatingBookmark) {
            if (DEBUG_MODE) console.log('북마크 네비게이션 중: onDidChangeSelection 무시됨');
            return;
        }

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
    
    context.subscriptions.push(sftpTreeView);

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
                vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
                return;
            }

            const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
            if (!fs.existsSync(configPath)) {
                const result = await vscode.window.showErrorMessage(
                    i18n.t('error.configFileNotFound'),
                    i18n.t('input.config')
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
                vscode.window.showErrorMessage(i18n.t('error.noServerInConfig'));
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
                    detail: isConnected ? i18n.t('status.connectedDisconnect') : i18n.t('status.disconnectedConnect'),
                    config: config,
                    isConnected: isConnected
                };
            });

            // Show QuickPick
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: i18n.t('input.selectServer'),
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
                vscode.window.showInformationMessage(i18n.t('info.serverDisconnected', { serverName }));
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
                vscode.window.showInformationMessage(i18n.t('info.serverConnected', { serverName }));
            }
            
            updateStatusBar();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.switchServerFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('switchServer error:', error);
        }
    });

    /**
     * 원격 파일 열기 Command
     */
    const openRemoteFileCommand = vscode.commands.registerCommand('ctlimSftp.openRemoteFile', async (remotePath: string, config: SftpConfig) => {
        try {
            if (DEBUG_MODE) console.log('> ctlimSftp.openRemoteFile');

            if (!remotePath || !config) {
                vscode.window.showErrorMessage(i18n.t('error.remoteFileInfoNotFound'));
                return;
            }

            if (DEBUG_MODE) console.log(`Opening remote file: ${remotePath}`);
            if (DEBUG_MODE) console.log(`Config: ${config.name || `${config.username}@${config.host}`}, remotePath: ${config.remotePath}`);

            // Find the connected server for this config
            let connection = treeProvider.getConnectedServer(config.name || `${config.username}@${config.host}`);
            if (!connection) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('error.serverReconnectionAttempt'),
                    i18n.t('action.connect'),
//                    '취소'
                );
                if (reconnect === i18n.t('action.connect')) {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
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
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionFailed'));
                        return;
                    }
                } else {
                    return;
                }
            }


            // 워크스페이스 폴더 가져오기 (workspaceRoot 아님)
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
                return;
            }
            
            const WorkspaceMetadataDir = SftpClient.getWorkspaceMetadataDir(connection.config);
            if (!WorkspaceMetadataDir) {
                vscode.window.showErrorMessage(i18n.t('error.metadataDirectoryNotFound'));
                return;
            }

            // 다운로드할 로컬 경로 설정
            const localPath = SftpClient.getDownloadFolder(remotePath, workspaceFolder.uri.fsPath, config, true, false);
            if (!localPath) {
                vscode.window.showErrorMessage(i18n.t('error.cannotCalculateDownloadPath'));
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

            // Check connection status
            if (!connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('error.serverConnectionLostAttempt'),
                    i18n.t('action.reconnect'),
//                    '취소'
                );
                if (reconnect === i18n.t('action.reconnect')) {
                    try {
                        await connection.client.connect(config);
                        vscode.window.showInformationMessage(i18n.t('info.serverReconnected'));
                    } catch (error) {
                        vscode.window.showErrorMessage(i18n.t('error.serverReconnectionFailed', { remotePath, error: String(error) }));
                        return;
                    }
                } else {
                    return;
                }
            }

            try {
                // Protocol-aware file download
                if (connection.client instanceof SftpClient) {
                    // SFTP protocol - use direct access
                    if (!connection.client.client) {
                        vscode.window.showErrorMessage(i18n.t('error.notImplemented'));
                        return;
                    }
                    
                    // 리모트 파일의 정보를 구한다.
                    const remoteStats = await connection.client.client.stat(remotePath);
                    const remoteModifyTime = new Date(remoteStats.modifyTime).getTime();
                    
                    // Download file
                    await connection.client.client.get(remotePath, localPath);
                    
                    // Save metadata after successful download
                    await connection.client.saveRemoteFileMetadata(remotePath, localPath, config, config.workspaceRoot);
                } else {
                    // FTP protocol - use abstracted method
                    await connection.client.downloadFile(remotePath, localPath, config);
                }
                
                const doc = await vscode.workspace.openTextDocument(localPath);
                documentConfigCache.set(doc, { config, client: connection.client, remotePath });
                await vscode.window.showTextDocument(doc);
            } catch (statError: any) {
                // Handle specific stat errors
                if (statError.message && statError.message.includes('No such file')) {
                    vscode.window.showErrorMessage(i18n.t('error.fileNotFound', { path: remotePath }));
                } else if (statError.message && statError.message.includes('No response from server')) {
                    vscode.window.showErrorMessage(i18n.t('error.connectionTimeout'));
                } else if (statError.message && statError.message.includes('Permission denied')) {
                    vscode.window.showErrorMessage(i18n.t('error.permissionDenied', { path: remotePath }));
                } else {
                    throw statError; // Re-throw to outer catch
                }
                return;
            }
        } catch (error) {
            if (DEBUG_MODE) console.error('openRemoteFile error:', error);
            vscode.window.showErrorMessage(i18n.t('error.unknownError', { error: String(error) }));
        }
    });

    /**
     * 다중 선택 파일 다운로드 Command
     */
    const downloadMultipleFilesCommand = vscode.commands.registerCommand('ctlimSftp.downloadMultipleFiles', async (item?: any, selectedItems?: any[]) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.downloadMultipleFiles');
        
        try {
            // Get selected items (if called from context menu, use selectedItems array)
            const items = selectedItems && selectedItems.length > 0 ? selectedItems : (item ? [item] : []);
            
            if (items.length === 0) {
                vscode.window.showErrorMessage(i18n.t('error.selectFilesToDownload'));
                return;
            }
            
            // Filter only files (not directories or servers)
            const fileItems = items.filter((i: any) => 
                i.itemType === 'remoteFile' && i.remotePath && i.config
            );
            
            if (fileItems.length === 0) {
                vscode.window.showErrorMessage(i18n.t('error.noDownloadableFiles'));
                return;
            }
            
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
                return;
            }
            
            // Download files with progress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.downloadingFiles', { count: fileItems.length.toString() }),
                cancellable: false
            }, async (progress) => {
                let completed = 0;
                let succeeded = 0;
                let failed = 0;
                
                for (const fileItem of fileItems) {
                    const fileName = path.basename(fileItem.remotePath);
                    progress.report({
                        message: i18n.t('progress.downloadingFile', { 
                            fileName: fileName,
                            current: (completed + 1).toString(),
                            total: fileItems.length.toString()
                        }),
                        increment: (1 / fileItems.length) * 100
                    });
                    
                    try {
                        const serverName = fileItem.config.name || `${fileItem.config.username}@${fileItem.config.host}`;
                        let connection = treeProvider.getConnectedServer(serverName);
                        
                        if (!connection || !connection.client.isConnected()) {
                            if (DEBUG_MODE) console.log(`서버 연결 안 됨: ${serverName}`);
                            failed++;
                            completed++;
                            continue;
                        }
                        
                        const localPath = SftpClient.getDownloadFolder(
                            fileItem.remotePath,
                            workspaceFolder.uri.fsPath,
                            fileItem.config,
                            true,
                            false
                        );
                        
                        if (!localPath) {
                            failed++;
                            completed++;
                            continue;
                        }
                        
                        // Ensure directory exists
                        const localDir = path.dirname(localPath);
                        if (!fs.existsSync(localDir)) {
                            fs.mkdirSync(localDir, { recursive: true });
                        }
                        
                        // Backup existing file if downloadBackup is enabled
                        if (fileItem.config.downloadBackup && fs.existsSync(localPath)) {
                            await connection.client.backupLocalFile(localPath, fileItem.config);
                        }
                        
                        // Download file - protocol aware
                        if (connection.client instanceof SftpClient) {
                            if (connection.client.client) {
                                await connection.client.client.get(fileItem.remotePath, localPath);
                                
                                // Save metadata
                                await connection.client.saveRemoteFileMetadata(
                                    fileItem.remotePath,
                                    localPath,
                                    fileItem.config,
                                    fileItem.config.workspaceRoot
                                );
                                
                                succeeded++;
                            }
                        } else {
                            // FTP protocol
                            await connection.client.downloadFile(
                                fileItem.remotePath,
                                localPath,
                                fileItem.config
                            );
                            succeeded++;
                        }
                    } catch (error) {
                        if (DEBUG_MODE) console.error(`다운로드 실패: ${fileItem.remotePath}`, error);
                        failed++;
                    }
                    
                    completed++;
                }
                
                // Show summary
                if (failed === 0) {
                    vscode.window.showInformationMessage(i18n.t('success.filesDownloaded', { count: succeeded.toString() }));
                } else {
                    vscode.window.showWarningMessage(i18n.t('warning.downloadCompleted', { 
                        success: succeeded.toString(),
                        failed: failed.toString()
                    }));
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`❌ ${i18n.t('error.downloadFailed', { error: String(error) })}`);
            if (DEBUG_MODE) console.error('downloadMultipleFiles error:', error);
        }
    });

    /**
     * 다중 선택 파일 삭제 Command
     */
    const deleteMultipleFilesCommand = vscode.commands.registerCommand('ctlimSftp.deleteMultipleFiles', async (item?: any, selectedItems?: any[]) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.deleteMultipleFiles');
        
        try {
            // Get selected items
            const items = selectedItems && selectedItems.length > 0 ? selectedItems : (item ? [item] : []);
            
            if (items.length === 0) {
                vscode.window.showErrorMessage(i18n.t('error.selectFilesToDelete'));
                return;
            }
            
            // Filter valid items
            const validItems = items.filter((i: any) => 
                (i.itemType === 'remoteFile' || i.itemType === 'remoteDirectory') && i.remotePath && i.config
            );
            
            if (validItems.length === 0) {
                vscode.window.showErrorMessage(i18n.t('error.noDeletableFiles'));
                return;
            }
            
            // Confirmation
            const confirm = await vscode.window.showWarningMessage(
                i18n.t('confirm.deleteItems', { count: validItems.length.toString() }),
                { modal: true },
                '삭제'
            );
            
            if (confirm !== '삭제') {
                return;
            }
            
            // Delete files with progress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.deletingFiles', { count: validItems.length.toString() }),
                cancellable: false
            }, async (progress) => {
                let completed = 0;
                let succeeded = 0;
                let failed = 0;
                
                for (const validItem of validItems) {
                    const fileName = path.basename(validItem.remotePath);
                    progress.report({
                        message: i18n.t('progress.deletingFile', { 
                            fileName: fileName,
                            current: (completed + 1).toString(),
                            total: validItems.length.toString()
                        }),
                        increment: (1 / validItems.length) * 100
                    });
                    
                    try {
                        const serverName = validItem.config.name || `${validItem.config.username}@${validItem.config.host}`;
                        let connection = treeProvider.getConnectedServer(serverName);
                        
                        if (!connection || !connection.client.isConnected()) {
                            failed++;
                            completed++;
                            continue;
                        }
                        
                        await connection.client.deleteRemoteFile(
                            validItem.remotePath,
                            validItem.isDirectory || false
                        );
                        
                        succeeded++;
                    } catch (error) {
                        if (DEBUG_MODE) console.error(`삭제 실패: ${validItem.remotePath}`, error);
                        failed++;
                    }
                    
                    completed++;
                }
                
                // Show summary
                if (failed === 0) {
                    vscode.window.showInformationMessage(i18n.t('success.itemsDeleted', { count: succeeded.toString() }));
                } else {
                    vscode.window.showWarningMessage(i18n.t('warning.deleteCompleted', { 
                        success: succeeded.toString(),
                        failed: failed.toString()
                    }));
                }
                
                // Refresh TreeView
                treeProvider.refresh();
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`❌ ${i18n.t('error.deleteFailed', { error: String(error) })}`);
            if (DEBUG_MODE) console.error('deleteMultipleFiles error:', error);
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
            let cachedClient: ClientType | null = cached?.client || null;
            
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
            let connection: { client: ClientType; config: SftpConfig } | undefined;
            
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
                    const client = createClient(config);
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
                { label: i18n.t('input.directInput'), method: 'input' },
                { label: i18n.t('input.treeSelect'), method: 'tree' }
            ], {
                placeHolder: i18n.t('input.selectInputMethod')
            });

            if (!inputMethod) {
                return; // User cancelled
            }

            let remotePath: string | undefined;

            if (inputMethod.method === 'input') {
                // Direct input
                remotePath = await vscode.window.showInputBox({
                    prompt: i18n.t('prompt.remotePathInput'),
                    value: defaultRemotePath,
                    placeHolder: i18n.t('placeholder.remotePath'),
                    validateInput: (value) => {
                        if (!value || value.trim() === '') {
                            return i18n.t('error.pathRequired');
                        }
                        if (!value.startsWith('/')) {
                            return i18n.t('error.absolutePath');
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
                title: i18n.t('progress.uploading', { fileName: path.basename(remotePath) }),
                cancellable: false
            }, async (progress) => {
                const success = await connection!.client.uploadFile(localPath, remotePath, config!);
                if (success) {
                    vscode.window.showInformationMessage(i18n.t('success.uploadComplete', { remotePath }));
                    
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
                    
                    // Download the uploaded file from remote - protocol aware
                    if (connection!.client instanceof SftpClient) {
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
                        // FTP protocol
                        await connection!.client.downloadFile(remotePath, newLocalPath, config!);
                        
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
                    vscode.window.showErrorMessage(i18n.t('error.uploadFailed', { remotePath }));
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.uploadFailedGeneral', { error: String(error) }));
            if (DEBUG_MODE) console.error('saveAs error:', error);
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
                    const client = createClient(config);
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
                { label: i18n.t('sync.dontDelete'), value: false },
                { label: i18n.t('sync.deleteDeletedFiles'), value: true }
            ], {
                placeHolder: i18n.t('sync.selectDeleteHandling')
            });

            if (!deleteChoice) {
                return;
            }

            // 방향에 따른 라벨
            const directionLabel = direction === 'local-to-remote' ? '로컬 → 원격' :
                                   direction === 'remote-to-local' ? '원격 → 로컬' :
                                   i18n.t('sync.bidirectional');

            // 확인 대화상자
            const confirmMessage = `${i18n.t('sync.settings')}` +
                `로컬: ${syncFolder}\n` +
                `원격: ${remotePath}\n` +
                `방향: ${directionLabel}\n` +
                `${i18n.t('sync.deleteChoice', { value: deleteChoice.value ? '예' : '아니오' })}\n\n` +
                `${i18n.t('sync.confirmStart')}`;

            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                i18n.t('sync.startButton')
            );

            if (confirm !== i18n.t('sync.startButton')) {
                return;
            }

            // 동기화 실행
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.syncingFolder'),
                cancellable: false
            }, async (progress) => {
                progress.report({ message: i18n.t('progress.syncPreparing') });

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
                    i18n.t('success.syncComplete'),
                    ``,
                    i18n.t('success.syncStats', { uploaded: result.uploaded.toString(), downloaded: result.downloaded.toString(), deleted: result.deleted.toString() }),
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
            vscode.window.showErrorMessage(i18n.t('error.syncFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('sync error:', error);
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
                prompt: i18n.t('prompt.fileNameInput'),
                placeHolder: i18n.t('placeholder.exampleFileName'),
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('error.fileNameRequired');
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return i18n.t('error.fileNameInvalidChars');
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
                    const client = createClient(config);
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
            
            vscode.window.showInformationMessage(i18n.t('success.fileCreated', { fileName }));
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.fileCreateFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('newFile error:', error);
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
                prompt: i18n.t('prompt.folderNameInput'),
                placeHolder: i18n.t('placeholder.exampleFolderName'),
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('error.folderNameRequired');
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return i18n.t('error.folderNameInvalidChars');
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
                    const client = createClient(config);
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
            
            vscode.window.showInformationMessage(i18n.t('success.folderCreated', { folderName }));
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.folderCreateFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('newFolder error:', error);
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
                ? i18n.t('confirm.deleteFolderMessage', { fileName })
                : i18n.t('confirm.deleteFileMessage', { fileName });
            
            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                i18n.t('action.delete'),
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
                    const client = createClient(config);
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
                ? i18n.t('success.folderDeleted', { fileName })
                : i18n.t('success.fileDeleted', { fileName });
            vscode.window.showInformationMessage(successMessage);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.deleteFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('deleteRemoteFile error:', error);
        }
    });

    /**
     * 원격 파일 복사 (다른 이름으로 저장) Command
     */
    const copyRemoteFileCommand = vscode.commands.registerCommand('ctlimSftp.copyRemoteFile', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.copyRemoteFile');
        
        try {
            // TreeView item에서 정보 가져오기
            if (!item || !item.config || !item.remotePath || item.isDirectory) {
                vscode.window.showErrorMessage('파일만 복사할 수 있습니다.');
                return;
            }
            
            const config = item.config;
            const sourceRemotePath = item.remotePath;
            const fileName = path.basename(sourceRemotePath);
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = createClient(config);
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
            
            // 파일명 입력 받기
            const remoteDir = path.posix.dirname(sourceRemotePath);
            const fileExt = path.extname(fileName);
            const baseName = path.basename(fileName, fileExt);
            const defaultFileName = `${baseName}.copy${fileExt}`;
            
            const newFileName = await vscode.window.showInputBox({
                prompt: '복사할 파일 이름을 입력하세요',
                value: defaultFileName,
                placeHolder: 'file.copy.php',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '파일 이름을 입력해주세요';
                    }
                    if (value === fileName) {
                        return '원본과 다른 이름을 입력해주세요';
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return '파일 이름에 경로 구분자를 포함할 수 없습니다';
                    }
                    return null;
                }
            });

            if (!newFileName) {
                return;
            }
            
            const targetRemotePath = path.posix.join(remoteDir, newFileName);

            // 임시 파일로 다운로드 후 새 경로로 업로드
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `파일 복사 중: ${path.basename(targetRemotePath)}`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: '원본 다운로드 중...' });
                
                // 임시 파일 경로
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                    return;
                }
                
                const tempDir = path.join(workspaceFolder.uri.fsPath, '.vscode', '.sftp-tmp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                const tempFile = path.join(tempDir, `copy_${Date.now()}_${fileName}`);
                
                try {
                    // 다운로드 - protocol aware
                    if (connection!.client instanceof SftpClient) {
                        if (connection!.client.client) {
                            await connection!.client.client.get(sourceRemotePath, tempFile);
                            
                            progress.report({ message: '새 위치에 업로드 중...' });
                            
                            // 업로드
                            await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                            
                            vscode.window.showInformationMessage(`✅ 파일 복사 완료: ${path.basename(targetRemotePath)}`);
                            
                            // TreeView 새로고침
                            treeProvider.refresh();
                        }
                    } else {
                        // FTP protocol
                        await connection!.client.downloadFile(sourceRemotePath, tempFile, config);
                        
                        progress.report({ message: '새 위치에 업로드 중...' });
                        
                        // 업로드
                        await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                        
                        vscode.window.showInformationMessage(`✅ 파일 복사 완료: ${path.basename(targetRemotePath)}`);
                        
                        // TreeView 새로고침
                        treeProvider.refresh();
                    }
                } finally {
                    // 임시 파일 삭제
                    if (fs.existsSync(tempFile)) {
                        fs.unlinkSync(tempFile);
                    }
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`파일 복사 실패: ${error}`);
            if (DEBUG_MODE) console.error('copyRemoteFile error:', error);
        }
    });

    /**
     * 원격 파일 이름 변경 Command
     */
    const renameRemoteFileCommand = vscode.commands.registerCommand('ctlimSftp.renameRemoteFile', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.renameRemoteFile');
        
        try {
            // TreeView item에서 정보 가져오기
            if (!item || !item.config || !item.remotePath || item.isDirectory) {
                vscode.window.showErrorMessage('파일만 이름 변경할 수 있습니다.');
                return;
            }
            
            const config = item.config;
            const sourceRemotePath = item.remotePath;
            const fileName = path.basename(sourceRemotePath);
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = createClient(config);
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
            
            // 새 파일명 입력 받기
            const remoteDir = path.posix.dirname(sourceRemotePath);
            
            const newFileName = await vscode.window.showInputBox({
                prompt: '새 파일 이름을 입력하세요',
                value: fileName,
                placeHolder: 'newfile.php',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '파일 이름을 입력해주세요';
                    }
                    if (value === fileName) {
                        return '원본과 다른 이름을 입력해주세요';
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return '파일 이름에 경로 구분자를 포함할 수 없습니다';
                    }
                    return null;
                }
            });

            if (!newFileName) {
                return;
            }
            
            const targetRemotePath = path.posix.join(remoteDir, newFileName);

            // 확인 대화상자
            const confirm = await vscode.window.showWarningMessage(
                `파일 이름을 변경하시겠습니까?\n\n${fileName} → ${newFileName}`,
                { modal: true },
                '변경'
            );
            
            if (confirm !== '변경') {
                return;
            }

            // 임시 파일로 다운로드 후 새 이름으로 업로드, 원본 삭제
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `파일 이름 변경 중: ${newFileName}`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: '원본 다운로드 중...' });
                
                // 임시 파일 경로
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                    return;
                }
                
                const tempDir = path.join(workspaceFolder.uri.fsPath, '.vscode', '.sftp-tmp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                const tempFile = path.join(tempDir, `rename_${Date.now()}_${fileName}`);
                
                try {
                    // 다운로드 - protocol aware
                    if (connection!.client instanceof SftpClient) {
                        if (connection!.client.client) {
                            await connection!.client.client.get(sourceRemotePath, tempFile);
                            
                            progress.report({ message: '새 이름으로 업로드 중...' });
                            
                            // 새 이름으로 업로드
                            await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                            
                            progress.report({ message: '원본 파일 삭제 중...' });
                            
                            // 원본 삭제
                            await connection!.client.deleteRemoteFile(sourceRemotePath, false);
                            
                            vscode.window.showInformationMessage(`✅ 파일 이름 변경 완료: ${newFileName}`);
                            
                            // TreeView 새로고침
                            treeProvider.refresh();
                        }
                    } else {
                        // FTP protocol
                        await connection!.client.downloadFile(sourceRemotePath, tempFile, config);
                        
                        progress.report({ message: '새 이름으로 업로드 중...' });
                        
                        // 새 이름으로 업로드
                        await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                        
                        progress.report({ message: '원본 파일 삭제 중...' });
                        
                        // 원본 삭제
                        await connection!.client.deleteRemoteFile(sourceRemotePath, false);
                        
                        vscode.window.showInformationMessage(`✅ 파일 이름 변경 완료: ${newFileName}`);
                        
                        // TreeView 새로고침
                        treeProvider.refresh();
                    }
                } finally {
                    // 임시 파일 삭제
                    if (fs.existsSync(tempFile)) {
                        fs.unlinkSync(tempFile);
                    }
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`파일 이름 변경 실패: ${error}`);
            if (DEBUG_MODE) console.error('renameRemoteFile error:', error);
        }
    });

    /**
     * 원격 파일명 검색 Command
     */
    const searchRemoteFilesCommand = vscode.commands.registerCommand('ctlimSftp.searchRemoteFiles', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.searchRemoteFiles');
        
        try {
            // TreeView item에서 서버 정보 가져오기
            let remotePath: string;
            let config: SftpConfig;
            
            if (item && item.config) {
                config = item.config;
                remotePath = item.remotePath || config.remotePath;
            } else {
                // 연결된 서버 선택
                const connectedServers = treeProvider.getConnectedServerNames();
                
                if (connectedServers.length === 0) {
                    vscode.window.showErrorMessage('연결된 서버가 없습니다.');
                    return;
                }
                
                let serverName: string;
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: '검색할 서버를 선택하세요'
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage('서버 연결 정보를 찾을 수 없습니다.');
                    return;
                }
                
                config = connection.config;
                remotePath = config.remotePath;
            }
            
            // 검색 패턴 입력
            const searchPattern = await vscode.window.showInputBox({
                prompt: '검색할 파일명을 입력하세요 (정규식 지원: /pattern/)',
                placeHolder: '예: test.php 또는 /\\.php$/',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '검색 패턴을 입력해주세요';
                    }
                    return null;
                }
            });
            
            if (!searchPattern) {
                return;
            }
            
            // 정규식 패턴 확인
            let pattern = searchPattern;
            let isRegex = false;
            
            if (searchPattern.startsWith('/') && searchPattern.lastIndexOf('/') > 0) {
                // 정규식 형식: /pattern/
                pattern = searchPattern.substring(1, searchPattern.lastIndexOf('/'));
                isRegex = true;
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                vscode.window.showErrorMessage('서버에 연결되어 있지 않습니다.');
                return;
            }
            
            // 검색 실행
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '원격 파일 검색 중...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `"${pattern}" 검색 중...` });
                
                const results = await connection!.client.searchRemoteFilesByName(
                    remotePath,
                    pattern,
                    isRegex,
                    100
                );
                
                if (results.length === 0) {
                    vscode.window.showInformationMessage(`검색 결과 없음: "${searchPattern}"`);
                    return;
                }
                
                // 결과를 QuickPick으로 표시
                interface FileQuickPickItem extends vscode.QuickPickItem {
                    file: RemoteFile;
                }
                
                const items: FileQuickPickItem[] = results.map(file => ({
                    label: `$(file) ${file.name}`,
                    description: file.path,
                    detail: `크기: ${formatFileSize(file.size || 0)} | 수정: ${file.modifyTime ? formatDateTime(file.modifyTime) : 'N/A'}`,
                    file: file
                }));
                
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `${results.length}개 파일 발견 - 열 파일을 선택하세요`,
                    matchOnDescription: true,
                    matchOnDetail: true
                });
                
                if (selected) {
                    // 선택한 파일 열기
                    await vscode.commands.executeCommand('ctlimSftp.openRemoteFile', selected.file.path, config);
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`파일 검색 실패: ${error}`);
            if (DEBUG_MODE) console.error('searchRemoteFiles error:', error);
        }
    });

    /**
     * 원격 파일 내용 검색 Command
     */
    const searchInRemoteFilesCommand = vscode.commands.registerCommand('ctlimSftp.searchInRemoteFiles', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.searchInRemoteFiles');
        
        try {
            // TreeView item에서 서버 정보 가져오기
            let remotePath: string;
            let config: SftpConfig;
            
            if (item && item.config) {
                config = item.config;
                remotePath = item.remotePath || config.remotePath;
            } else {
                // 연결된 서버 선택
                const connectedServers = treeProvider.getConnectedServerNames();
                
                if (connectedServers.length === 0) {
                    vscode.window.showErrorMessage('연결된 서버가 없습니다.');
                    return;
                }
                
                let serverName: string;
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: '검색할 서버를 선택하세요'
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage('서버 연결 정보를 찾을 수 없습니다.');
                    return;
                }
                
                config = connection.config;
                remotePath = config.remotePath;
            }
            
            // 검색 텍스트 입력
            const searchText = await vscode.window.showInputBox({
                prompt: '검색할 텍스트를 입력하세요 (정규식 지원: /pattern/)',
                placeHolder: '예: function test 또는 /function\\s+\\w+/',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '검색 텍스트를 입력해주세요';
                    }
                    return null;
                }
            });
            
            if (!searchText) {
                return;
            }
            
            // 파일 패턴 입력
            const filePattern = await vscode.window.showInputBox({
                prompt: '검색할 파일 패턴을 입력하세요 (* = 모든 파일)',
                value: '*',
                placeHolder: '예: *.php, *.js, config.*'
            });
            
            if (!filePattern) {
                return;
            }
            
            // 정규식 패턴 확인
            let pattern = searchText;
            let isRegex = false;
            
            if (searchText.startsWith('/') && searchText.lastIndexOf('/') > 0) {
                // 정규식 형식: /pattern/
                pattern = searchText.substring(1, searchText.lastIndexOf('/'));
                isRegex = true;
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                vscode.window.showErrorMessage('서버에 연결되어 있지 않습니다.');
                return;
            }
            
            // 검색 실행
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '파일 내용 검색 중...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `"${pattern}" 검색 중 (${filePattern})...` });
                
                const results = await connection!.client.searchInRemoteFiles(
                    remotePath,
                    pattern,
                    isRegex,
                    filePattern,
                    50
                );
                
                if (results.length === 0) {
                    vscode.window.showInformationMessage(`검색 결과 없음: "${searchText}"`);
                    return;
                }
                
                // 결과를 QuickPick으로 표시
                interface ContentQuickPickItem extends vscode.QuickPickItem {
                    file: RemoteFile;
                    line?: number;
                }
                
                const items: ContentQuickPickItem[] = [];
                
                for (const result of results) {
                    // 파일 헤더
                    items.push({
                        label: `$(file) ${result.file.name}`,
                        description: result.file.path,
                        detail: `${result.matches.length}개 일치`,
                        file: result.file,
                        kind: vscode.QuickPickItemKind.Separator
                    } as any);
                    
                    // 각 매칭 줄
                    for (const match of result.matches) {
                        items.push({
                            label: `  Line ${match.line}`,
                            description: match.text.substring(0, 80),
                            file: result.file,
                            line: match.line
                        });
                    }
                }
                
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `${results.length}개 파일에서 발견 - 열 파일을 선택하세요`,
                    matchOnDescription: true
                });
                
                if (selected && selected.file) {
                    // 선택한 파일 열기
                    await vscode.commands.executeCommand('ctlimSftp.openRemoteFile', selected.file.path, config);
                    
                    // 특정 줄로 이동
                    if (selected.line) {
                        setTimeout(() => {
                            const editor = vscode.window.activeTextEditor;
                            if (editor) {
                                const position = new vscode.Position(selected.line! - 1, 0);
                                editor.selection = new vscode.Selection(position, position);
                                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                            }
                        }, 500);
                    }
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`내용 검색 실패: ${error}`);
            if (DEBUG_MODE) console.error('searchInRemoteFiles error:', error);
        }
    });

    /**
     * 파일 권한 변경 Command
     */
    const changePermissionsCommand = vscode.commands.registerCommand('ctlimSftp.changePermissions', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.changePermissions');
        
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
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                    '연결'
                );
                if (reconnect !== '연결') {
                    return;
                }
                
                try {
                    const client = createClient(config);
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
            
            // 현재 권한 조회
            let currentMode = '';
            try {
                currentMode = await connection.client.getFilePermissions(remotePath);
                if (DEBUG_MODE) console.log(`현재 권한: ${currentMode}`);
            } catch (error) {
                if (DEBUG_MODE) console.error('권한 조회 실패:', error);
            }
            
            // 권한 선택 QuickPick
            interface PermissionQuickPickItem extends vscode.QuickPickItem {
                mode: string;
            }
            
            const fileName = path.basename(remotePath);
            const items: PermissionQuickPickItem[] = [
                {
                    label: '$(file-code) 755',
                    description: 'rwxr-xr-x - 실행 파일, 디렉토리 (소유자:모든권한, 그룹/기타:읽기+실행)',
                    detail: isDirectory ? '디렉토리 권장 권한' : '실행 파일 권장 권한',
                    mode: '755'
                },
                {
                    label: '$(file) 644',
                    description: 'rw-r--r-- - 일반 파일 (소유자:읽기+쓰기, 그룹/기타:읽기만)',
                    detail: isDirectory ? '' : '일반 파일 권장 권한',
                    mode: '644'
                },
                {
                    label: '$(lock) 600',
                    description: 'rw------- - 개인 파일 (소유자만 읽기+쓰기)',
                    detail: '비밀 파일 권장 권한 (SSH key 등)',
                    mode: '600'
                },
                {
                    label: '$(warning) 777',
                    description: 'rwxrwxrwx - 모든 권한 (보안 위험!)',
                    detail: '⚠️ 보안상 권장하지 않음',
                    mode: '777'
                },
                {
                    label: '$(file-directory) 700',
                    description: 'rwx------ - 개인 디렉토리 (소유자만 모든 권한)',
                    detail: isDirectory ? '개인 디렉토리 권장 권한' : '',
                    mode: '700'
                },
                {
                    label: '$(edit) 커스텀 입력',
                    description: '직접 권한 코드 입력 (예: 754)',
                    mode: 'custom'
                }
            ];
            
            const placeHolder = currentMode 
                ? `${fileName}의 권한 변경 (현재: ${currentMode})`
                : `${fileName}의 권한 설정`;
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: placeHolder,
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (!selected) {
                return;
            }
            
            let mode = selected.mode;
            
            // 커스텀 입력
            if (mode === 'custom') {
                const customMode = await vscode.window.showInputBox({
                    prompt: '권한 모드를 입력하세요 (8진수 3자리)',
                    value: currentMode || '644',
                    placeHolder: '예: 755, 644, 600',
                    validateInput: (value) => {
                        if (!/^[0-7]{3}$/.test(value)) {
                            return '올바른 권한 모드를 입력하세요 (000-777)';
                        }
                        return null;
                    }
                });
                
                if (!customMode) {
                    return;
                }
                
                mode = customMode;
            }
            
            // 777 경고
            if (mode === '777') {
                const confirm = await vscode.window.showWarningMessage(
                    `⚠️ 보안 경고\n\n777 권한은 모든 사용자에게 모든 권한을 부여합니다.\n파일: ${fileName}\n\n정말 변경하시겠습니까?`,
                    { modal: true },
                    '변경',
                    '취소'
                );
                
                if (confirm !== '변경') {
                    return;
                }
            }
            
            // 권한 변경 실행
            await connection.client.changeFilePermissions(remotePath, mode);
            
            vscode.window.showInformationMessage(`✅ 권한 변경 완료: ${fileName} -> ${mode}`);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(`권한 변경 실패: ${error}`);
            if (DEBUG_MODE) console.error('changePermissions error:', error);
        }
    });

    /**
     * SSH 터미널 열기 Command
     */
    const openSSHTerminalCommand = vscode.commands.registerCommand('ctlimSftp.openSSHTerminal', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.openSSHTerminal');
        
        try {
            let config: SftpConfig;
            let serverName: string;
            
            // TreeView item에서 서버 정보 가져오기
            if (item && item.serverItem) {
                // Server item
                const serverItem = item.serverItem;
                serverName = serverItem.name;
                
                // Config 파일에서 정보 로드
                const configContent = fs.readFileSync(serverItem.configPath, 'utf-8');
                const configData = JSON.parse(configContent);
                const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
                
                const foundConfig = configs.find(c => {
                    const name = c.name || `${c.username}@${c.host}`;
                    return name === serverName;
                });
                
                if (!foundConfig) {
                    vscode.window.showErrorMessage(`서버 설정을 찾을 수 없습니다: ${serverName}`);
                    return;
                }
                
                config = foundConfig;
            } else {
                // Command Palette에서 호출된 경우
                const connectedServers = treeProvider.getConnectedServerNames();
                
                if (connectedServers.length === 0) {
                    vscode.window.showErrorMessage('연결된 서버가 없습니다.');
                    return;
                }
                
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: 'SSH 터미널을 열 서버를 선택하세요'
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage('서버 연결 정보를 찾을 수 없습니다.');
                    return;
                }
                
                config = connection.config;
            }
            
            // SSH 명령 생성
            let sshCommand: string;
            
            if (config.privateKey) {
                // Private key 인증
                sshCommand = `ssh -i "${config.privateKey}" -p ${config.port || 22} ${config.username}@${config.host}`;
            } else {
                // Password 인증 (터미널에서 수동 입력)
                sshCommand = `ssh -p ${config.port || 22} ${config.username}@${config.host}`;
            }
            
            // 터미널 생성 및 명령 실행
            const terminal = vscode.window.createTerminal({
                name: `SSH: ${serverName}`,
                iconPath: new vscode.ThemeIcon('terminal'),
            });
            
            terminal.show();
            terminal.sendText(sshCommand);
            
            vscode.window.showInformationMessage(`🔌 SSH 터미널 시작: ${serverName}`);
            
        } catch (error) {
            vscode.window.showErrorMessage(`SSH 터미널 열기 실패: ${error}`);
            if (DEBUG_MODE) console.error('openSSHTerminal error:', error);
        }
    });

    /**
     * 전송 히스토리 보기 Command
     */
    const viewTransferHistoryCommand = vscode.commands.registerCommand('ctlimSftp.viewTransferHistory', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.viewTransferHistory');
        
        if (!transferHistoryManager) {
            vscode.window.showErrorMessage('전송 히스토리를 사용할 수 없습니다.');
            return;
        }
        
        try {
            const histories = transferHistoryManager.loadHistories();
            
            if (histories.length === 0) {
                vscode.window.showInformationMessage('📋 전송 기록이 없습니다.');
                return;
            }
            
            // QuickPick 아이템 생성
            interface HistoryQuickPickItem extends vscode.QuickPickItem {
                history: typeof histories[0];
            }
            
            const items: HistoryQuickPickItem[] = histories.map(h => {
                const date = new Date(h.timestamp);
                const timeStr = date.toLocaleString('ko-KR');
                const fileName = path.basename(h.localPath);
                const sizeStr = formatFileSize(h.fileSize);
                const speedStr = h.transferSpeed ? `${formatFileSize(h.transferSpeed)}/s` : 'N/A';
                
                let icon = '$(check)';
                let statusText = '성공';
                if (h.status === 'failed') {
                    icon = '$(error)';
                    statusText = '실패';
                } else if (h.status === 'cancelled') {
                    icon = '$(circle-slash)';
                    statusText = '취소';
                }
                
                const typeIcon = h.type === 'upload' ? '$(cloud-upload)' : '$(cloud-download)';
                
                return {
                    label: `${icon} ${typeIcon} ${fileName}`,
                    description: `${h.serverName} | ${sizeStr} | ${speedStr}`,
                    detail: `${statusText} | ${timeStr}${h.errorMessage ? ` | ❌ ${h.errorMessage}` : ''}`,
                    history: h
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `전송 기록 (${histories.length}개) - 선택하여 재시도하거나 통계 확인`,
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (selected && selected.history.status === 'failed') {
                // 실패한 전송 재시도 옵션
                const action = await vscode.window.showWarningMessage(
                    `실패한 전송을 재시도하시겠습니까?\n\n파일: ${path.basename(selected.history.localPath)}\n에러: ${selected.history.errorMessage || '알 수 없음'}`,
                    { modal: true },
                    '재시도',
                    '취소'
                );
                
                if (action === '재시도') {
                    await retryFailedTransfer(selected.history);
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`히스토리 조회 실패: ${error}`);
            if (DEBUG_MODE) console.error('viewTransferHistory error:', error);
        }
    });

    /**
     * 전송 통계 보기 Command
     */
    const viewTransferStatisticsCommand = vscode.commands.registerCommand('ctlimSftp.viewTransferStatistics', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.viewTransferStatistics');
        
        if (!transferHistoryManager) {
            vscode.window.showErrorMessage('전송 통계를 사용할 수 없습니다.');
            return;
        }
        
        try {
            // 서버 선택
            const connectedServers = treeProvider.getConnectedServerNames();
            const allOption = '전체 서버';
            const serverOptions = [allOption, ...connectedServers];
            
            const selectedServer = await vscode.window.showQuickPick(serverOptions, {
                placeHolder: '통계를 볼 서버를 선택하세요'
            });
            
            if (!selectedServer) {
                return;
            }
            
            const stats = selectedServer === allOption 
                ? transferHistoryManager.getStatistics()
                : transferHistoryManager.getStatistics(selectedServer);
            
            const totalTransfers = stats.totalUploads + stats.totalDownloads;
            const successRate = totalTransfers > 0 
                ? ((stats.successCount / totalTransfers) * 100).toFixed(1)
                : '0';
            
            const message = [
                `📊 전송 통계 ${selectedServer !== allOption ? `(${selectedServer})` : ''}`,
                ``,
                `📤 업로드: ${stats.totalUploads}개`,
                `📥 다운로드: ${stats.totalDownloads}개`,
                `✅ 성공: ${stats.successCount}개`,
                `❌ 실패: ${stats.failedCount}개`,
                `📈 성공률: ${successRate}%`,
                `💾 총 전송량: ${formatFileSize(stats.totalBytes)}`,
                `⚡ 평균 속도: ${stats.averageSpeed > 0 ? formatFileSize(stats.averageSpeed) + '/s' : 'N/A'}`
            ].join('\n');
            
            vscode.window.showInformationMessage(message, { modal: true });
            
        } catch (error) {
            vscode.window.showErrorMessage(`통계 조회 실패: ${error}`);
            if (DEBUG_MODE) console.error('viewTransferStatistics error:', error);
        }
    });

    /**
     * 전송 히스토리 삭제 Command
     */
    const clearTransferHistoryCommand = vscode.commands.registerCommand('ctlimSftp.clearTransferHistory', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.clearTransferHistory');
        
        if (!transferHistoryManager) {
            vscode.window.showErrorMessage('전송 히스토리를 사용할 수 없습니다.');
            return;
        }
        
        try {
            const confirm = await vscode.window.showWarningMessage(
                '모든 전송 히스토리를 삭제하시겠습니까?',
                { modal: true },
                '삭제',
                '취소'
            );
            
            if (confirm === '삭제') {
                transferHistoryManager.clearHistory();
                vscode.window.showInformationMessage('✅ 전송 히스토리가 삭제되었습니다.');
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`히스토리 삭제 실패: ${error}`);
            if (DEBUG_MODE) console.error('clearTransferHistory error:', error);
        }
    });

    /**
     * 원격 경로 복사 Command
     */
    const copyRemotePathCommand = vscode.commands.registerCommand('ctlimSftp.copyRemotePath', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.copyRemotePath');
        
        try {
            if (!item || !item.remotePath) {
                vscode.window.showErrorMessage('원격 경로를 찾을 수 없습니다.');
                return;
            }
            
            // 클립보드에 복사
            await vscode.env.clipboard.writeText(item.remotePath);
            vscode.window.showInformationMessage(`📋 경로 복사됨: ${item.remotePath}`);
            
        } catch (error) {
            vscode.window.showErrorMessage(`경로 복사 실패: ${error}`);
            if (DEBUG_MODE) console.error('copyRemotePath error:', error);
        }
    });

    /**
     * 브라우저에서 열기 Command
     */
    const openInBrowserCommand = vscode.commands.registerCommand('ctlimSftp.openInBrowser', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.openInBrowser');
        
        try {
            if (!item || !item.remotePath || !item.config) {
                vscode.window.showErrorMessage('파일 정보를 찾을 수 없습니다.');
                return;
            }
            
            // 설정에서 웹 URL 확인
            let webUrl = item.config.webUrl;
            
            if (!webUrl) {
                // 웹 URL이 없으면 입력 요청
                webUrl = await vscode.window.showInputBox({
                    prompt: '웹 서버 기본 URL을 입력하세요 (예: http://example.com)',
                    placeHolder: 'http://example.com',
                    validateInput: (value) => {
                        if (!value || value.trim() === '') {
                            return 'URL을 입력해주세요';
                        }
                        if (!value.startsWith('http://') && !value.startsWith('https://')) {
                            return 'http:// 또는 https://로 시작해야 합니다';
                        }
                        return null;
                    }
                });
                
                if (!webUrl) {
                    return;
                }
                
                // 설정에 저장할지 물어보기
                const save = await vscode.window.showInformationMessage(
                    `이 URL을 서버 설정에 저장하시겠습니까?\n${webUrl}`,
                    '저장',
                    '이번만 사용'
                );
                
                if (save === '저장') {
                    // TODO: 설정 파일 업데이트
                    vscode.window.showInformationMessage('💡 다음 버전에서 자동 저장 기능이 추가됩니다.');
                }
            }
            
            // 원격 경로를 웹 URL로 변환
            const relativePath = item.remotePath.startsWith(item.config.remotePath)
                ? item.remotePath.substring(item.config.remotePath.length)
                : item.remotePath;
            
            const fullUrl = webUrl.replace(/\/$/, '') + relativePath;
            
            // 브라우저에서 열기
            await vscode.env.openExternal(vscode.Uri.parse(fullUrl));
            vscode.window.showInformationMessage(`🌐 브라우저 열기: ${fullUrl}`);
            
        } catch (error) {
            vscode.window.showErrorMessage(`브라우저 열기 실패: ${error}`);
            if (DEBUG_MODE) console.error('openInBrowser error:', error);
        }
    });

    /**
     * 북마크 열기 Command (트리에서 북마크 클릭 시)
     */
    const openBookmarkCommand = vscode.commands.registerCommand('ctlimSftp.openBookmark', async (bookmark: Bookmark) => {
        await openBookmark(bookmark);
    });

    /**
     * 북마크 추가 Command
     */
    const addBookmarkCommand = vscode.commands.registerCommand('ctlimSftp.addBookmark', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.addBookmark');
        
        try {
            if (!bookmarkManager) {
                vscode.window.showErrorMessage('북마크 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            let remotePath: string;
            let serverName: string;
            let isDirectory: boolean;
            let config: SftpConfig;
            
            // TreeView item에서 정보 가져오기
            if (item && item.config && item.remotePath) {
                config = item.config;
                remotePath = item.remotePath;
                isDirectory = item.isDirectory || false;
                serverName = config.name || `${config.username}@${config.host}`;
            } else {
                vscode.window.showErrorMessage('북마크 정보를 찾을 수 없습니다.');
                return;
            }
            
            // 이미 북마크에 있는지 확인
            if (bookmarkManager.hasBookmark(serverName, remotePath)) {
                vscode.window.showWarningMessage('이미 북마크에 추가된 경로입니다.');
                return;
            }
            
            // 북마크 이름 입력
            const fileName = path.basename(remotePath);
            const defaultName = `${serverName}-${fileName}`;
            const bookmarkName = await vscode.window.showInputBox({
                prompt: '북마크 이름을 입력하세요',
                value: defaultName,
                placeHolder: '예: 설정 파일, 로그 디렉토리',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '이름을 입력해주세요';
                    }
                    return null;
                }
            });
            
            if (!bookmarkName) {
                return;
            }
            
            // 설명 입력 (선택사항)
            const description = await vscode.window.showInputBox({
                prompt: '북마크 설명 (선택사항)',
                placeHolder: '예: 개발 서버 설정 파일',
            });
            
            // 북마크 추가
            const bookmark = bookmarkManager.addBookmark(
                bookmarkName,
                serverName,
                remotePath,
                isDirectory,
                description,
                config.group,  // 그룹 정보 추가
                config.protocol || 'sftp'  // 프로토콜 정보 추가
            );
            
            vscode.window.showInformationMessage(`⭐ 북마크 추가: ${bookmarkName}`);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(`북마크 추가 실패: ${error}`);
            if (DEBUG_MODE) console.error('addBookmark error:', error);
        }
    });

    /**
     * 북마크 보기 Command
     */
    const viewBookmarksCommand = vscode.commands.registerCommand('ctlimSftp.viewBookmarks', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.viewBookmarks');
        
        try {
            if (!bookmarkManager) {
                vscode.window.showErrorMessage('북마크 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            const bookmarks = bookmarkManager.getAllBookmarks();
            
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage('⭐ 저장된 북마크가 없습니다.');
                return;
            }
            
            // QuickPick 아이템 생성
            interface BookmarkQuickPickItem extends vscode.QuickPickItem {
                bookmark: Bookmark;
                action?: 'open' | 'delete' | 'edit';
            }
            
            const items: BookmarkQuickPickItem[] = bookmarks.map(b => {
                const typeIcon = b.isDirectory ? '📁' : '📄';
                const accessInfo = b.accessCount > 0 
                    ? ` | 사용횟수: ${b.accessCount}회`
                    : '';
                
                return {
                    label: `⭐ ${b.name}`,
                    description: `${b.serverName} | ${b.remotePath}`,
                    detail: `${typeIcon} ${b.description || '설명 없음'}${accessInfo}`,
                    bookmark: b
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `${bookmarks.length}개의 북마크 - 선택하여 열기`,
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (selected) {
                // 북마크 열기
                await openBookmark(selected.bookmark);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`북마크 조회 실패: ${error}`);
            if (DEBUG_MODE) console.error('viewBookmarks error:', error);
        }
    });

    /**
     * 북마크 삭제 Command (Command Palette용)
     */
    const removeBookmarkCommand = vscode.commands.registerCommand('ctlimSftp.removeBookmark', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.removeBookmark');
        
        try {
            if (!bookmarkManager) {
                vscode.window.showErrorMessage('북마크 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            const bookmarks = bookmarkManager.getAllBookmarks();
            
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage('삭제할 북마크가 없습니다.');
                return;
            }
            
            interface BookmarkQuickPickItem extends vscode.QuickPickItem {
                bookmark: Bookmark;
            }
            
            const items: BookmarkQuickPickItem[] = bookmarks.map(b => ({
                label: `⭐ ${b.name}`,
                description: `${b.serverName} | ${b.remotePath}`,
                detail: b.description || '설명 없음',
                bookmark: b
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '삭제할 북마크 선택',
                matchOnDescription: true
            });
            
            if (!selected) {
                return;
            }
            
            // 확인 대화상자
            const confirm = await vscode.window.showWarningMessage(
                `북마크를 삭제하시겠습니까?\n\n${selected.bookmark.name}`,
                { modal: true },
                '삭제'
            );
            
            if (confirm === '삭제') {
                const success = bookmarkManager.removeBookmark(selected.bookmark.id);
                if (success) {
                    vscode.window.showInformationMessage(`🗑️ 북마크 삭제: ${selected.bookmark.name}`);
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`북마크 삭제 실패: ${error}`);
            if (DEBUG_MODE) console.error('removeBookmark error:', error);
        }
    });

    /**
     * 북마크 삭제 Command (TreeView 우클릭용)
     */
    const deleteBookmarkCommand = vscode.commands.registerCommand('ctlimSftp.deleteBookmark', async (item?: SftpTreeItem) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.deleteBookmark');
        
        try {
            if (!bookmarkManager) {
                vscode.window.showErrorMessage('북마크 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            // TreeView에서 호출된 경우
            if (item && item.itemType === 'bookmark' && item.bookmarkData) {
                const bookmark = item.bookmarkData;
                
                // 확인 대화상자
                const confirm = await vscode.window.showWarningMessage(
                    `북마크를 삭제하시겠습니까?\n\n${bookmark.name}`,
                    { modal: true },
                    '삭제'
                );
                
                if (confirm === '삭제') {
                    const success = bookmarkManager.removeBookmark(bookmark.id);
                    if (success) {
                        vscode.window.showInformationMessage(`🗑️ 북마크 삭제: ${bookmark.name}`);
                        treeProvider.refresh();
                    }
                }
            } else {
                // 다른 경로로 호출된 경우 - QuickPick으로 선택
                await vscode.commands.executeCommand('ctlimSftp.removeBookmark');
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`북마크 삭제 실패: ${error}`);
            if (DEBUG_MODE) console.error('deleteBookmark error:', error);
        }
    });

    /**
     * 자주 사용하는 북마크 Command
     */
    const frequentBookmarksCommand = vscode.commands.registerCommand('ctlimSftp.frequentBookmarks', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.frequentBookmarks');
        
        try {
            if (!bookmarkManager) {
                vscode.window.showErrorMessage('북마크 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            const bookmarks = bookmarkManager.getFrequentBookmarks(10);
            
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage('⭐ 자주 사용하는 북마크가 없습니다.');
                return;
            }
            
            interface BookmarkQuickPickItem extends vscode.QuickPickItem {
                bookmark: Bookmark;
            }
            
            const items: BookmarkQuickPickItem[] = bookmarks.map((b, index) => {
                const typeIcon = b.isDirectory ? '📁' : '📄';
                const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : '⭐';
                
                return {
                    label: `${medal} ${b.name}`,
                    description: `${b.serverName} | ${b.remotePath}`,
                    detail: `${typeIcon} 사용횟수: ${b.accessCount}회 | ${b.description || ''}`,
                    bookmark: b
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '자주 사용하는 북마크 - 선택하여 열기',
                matchOnDescription: true
            });
            
            if (selected) {
                await openBookmark(selected.bookmark);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`북마크 조회 실패: ${error}`);
            if (DEBUG_MODE) console.error('frequentBookmarks error:', error);
        }
    });

    /**
     * 현재 서버를 템플릿으로 저장 Command
     */
    const saveAsTemplateCommand = vscode.commands.registerCommand('ctlimSftp.saveAsTemplate', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.saveAsTemplate');
        
        try {
            if (!templateManager) {
                vscode.window.showErrorMessage('템플릿 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            let config: SftpConfig | undefined;
            
            // TreeView에서 호출된 경우
            if (item && item.itemType === 'server' && item.config) {
                config = item.config;
            } else {
                // Command Palette에서 호출된 경우 - 서버 선택
                const connectedServers = treeProvider.getConnectedServerNames();
                
                if (connectedServers.length === 0) {
                    vscode.window.showErrorMessage('연결된 서버가 없습니다.');
                    return;
                }
                
                let serverName: string;
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: '템플릿으로 저장할 서버를 선택하세요'
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage('서버 연결 정보를 찾을 수 없습니다.');
                    return;
                }
                
                config = connection.config;
            }
            
            if (!config) {
                vscode.window.showErrorMessage('서버 설정을 찾을 수 없습니다.');
                return;
            }
            
            // 템플릿 이름 입력
            const templateName = await vscode.window.showInputBox({
                prompt: '템플릿 이름을 입력하세요',
                value: config.name || `${config.username}@${config.host}`,
                placeHolder: '예: Web Server Config',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '이름을 입력해주세요';
                    }
                    return null;
                }
            });
            
            if (!templateName) {
                return;
            }
            
            // 설명 입력 (선택사항)
            const description = await vscode.window.showInputBox({
                prompt: '템플릿 설명 (선택사항)',
                placeHolder: '예: LAMP 서버 기본 설정'
            });
            
            // 템플릿 저장
            const template = templateManager.addTemplate(templateName, config, description);
            
            vscode.window.showInformationMessage(`💾 템플릿 저장: ${templateName}`);
            
        } catch (error) {
            vscode.window.showErrorMessage(`템플릿 저장 실패: ${error}`);
            if (DEBUG_MODE) console.error('saveAsTemplate error:', error);
        }
    });

    /**
     * 템플릿에서 서버 추가 Command
     */
    const addServerFromTemplateCommand = vscode.commands.registerCommand('ctlimSftp.addServerFromTemplate', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.addServerFromTemplate');
        
        try {
            if (!templateManager) {
                vscode.window.showErrorMessage('템플릿 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            const templates = templateManager.getAllTemplates();
            
            if (templates.length === 0) {
                vscode.window.showInformationMessage('💾 저장된 템플릿이 없습니다.\n먼저 서버를 템플릿으로 저장하세요.');
                return;
            }
            
            // 템플릿 선택
            interface TemplateQuickPickItem extends vscode.QuickPickItem {
                template: typeof templates[0];
            }
            
            const items: TemplateQuickPickItem[] = templates.map(t => ({
                label: `📋 ${t.name}`,
                description: `사용횟수: ${t.usageCount}회`,
                detail: t.description || '설명 없음',
                template: t
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `${templates.length}개의 템플릿 - 선택하여 서버 추가`,
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (!selected) {
                return;
            }
            
            const template = selected.template;
            
            // 서버 정보 입력
            const host = await vscode.window.showInputBox({
                prompt: '서버 호스트를 입력하세요',
                placeHolder: 'example.com',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '호스트를 입력해주세요';
                    }
                    return null;
                }
            });
            
            if (!host) {
                return;
            }
            
            const username = await vscode.window.showInputBox({
                prompt: '사용자명을 입력하세요',
                placeHolder: 'username',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return '사용자명을 입력해주세요';
                    }
                    return null;
                }
            });
            
            if (!username) {
                return;
            }
            
            const password = await vscode.window.showInputBox({
                prompt: '비밀번호를 입력하세요 (선택사항 - 입력하지 않으면 연결 시 입력)',
                password: true,
                placeHolder: '비밀번호'
            });
            
            const serverName = await vscode.window.showInputBox({
                prompt: '서버 이름을 입력하세요 (선택사항)',
                value: `${username}@${host}`,
                placeHolder: 'My Server'
            });
            
            // 템플릿으로 설정 생성
            const newConfig = templateManager.createConfigFromTemplate(
                template,
                host,
                username,
                password,
                serverName
            );
            
            // 설정 파일에 추가
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                return;
            }
            
            const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
            
            let configs: SftpConfig[] = [];
            
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                const configData = JSON.parse(content);
                configs = Array.isArray(configData) ? configData : [configData];
            }
            
            configs.push(newConfig);
            
            // 설정 파일 저장
            const vscodeFolder = path.dirname(configPath);
            if (!fs.existsSync(vscodeFolder)) {
                fs.mkdirSync(vscodeFolder, { recursive: true });
            }
            
            fs.writeFileSync(configPath, JSON.stringify(configs, null, 2));
            
            vscode.window.showInformationMessage(`✅ 서버 추가 완료: ${newConfig.name}\n템플릿: ${template.name}`);
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(`서버 추가 실패: ${error}`);
            if (DEBUG_MODE) console.error('addServerFromTemplate error:', error);
        }
    });

    /**
     * 템플릿 관리 Command
     */
    const manageTemplatesCommand = vscode.commands.registerCommand('ctlimSftp.manageTemplates', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.manageTemplates');
        
        try {
            if (!templateManager) {
                vscode.window.showErrorMessage('템플릿 관리자를 초기화할 수 없습니다.');
                return;
            }
            
            const templates = templateManager.getAllTemplates();
            
            if (templates.length === 0) {
                vscode.window.showInformationMessage('💾 저장된 템플릿이 없습니다.');
                return;
            }
            
            // 템플릿 목록 표시
            interface TemplateQuickPickItem extends vscode.QuickPickItem {
                template: typeof templates[0];
            }
            
            const items: TemplateQuickPickItem[] = templates.map(t => {
                const createdDate = new Date(t.createdAt);
                const dateStr = createdDate.toLocaleDateString('ko-KR');
                
                return {
                    label: `📋 ${t.name}`,
                    description: `Port: ${t.config.port || 22} | 사용: ${t.usageCount}회`,
                    detail: `${t.description || '설명 없음'} | 생성: ${dateStr}`,
                    template: t
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `${templates.length}개의 템플릿 - 선택하여 삭제`,
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (!selected) {
                return;
            }
            
            const template = selected.template;
            
            // 삭제 확인
            const confirm = await vscode.window.showWarningMessage(
                `템플릿을 삭제하시겠습니까?\n\n${template.name}`,
                { modal: true },
                '삭제'
            );
            
            if (confirm === '삭제') {
                const success = templateManager.removeTemplate(template.id);
                if (success) {
                    vscode.window.showInformationMessage(`🗑️ 템플릿 삭제: ${template.name}`);
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`템플릿 관리 실패: ${error}`);
            if (DEBUG_MODE) console.error('manageTemplates error:', error);
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
        let cachedClient: ClientType | null = cached?.client || null;
        let cachedRemotePath: string | null = cached?.remotePath || "";
        
        // 캐시에 없으면 메타데이터로 확인 (원격에서 다운로드한 파일만 메타데이터 존재)
        if (!config) {
            config = await findConfigByMetadata(document.uri.fsPath);
        }
        
        // 메타데이터도 없으면 일반 로컬 파일이므로 무시
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
                    `⚠️ 충돌 감지!\n\n파일이 서버에서 수정되었습니다: ${path.basename(document.uri.fsPath)}\n\n어떻게 처리하시겠습니까?`,
                    { modal: true },
                    '덮어쓰기 (로컬 → 서버)',
                    '다운로드 (서버 → 로컬)',
                    '비교 및 병합',
//                    '취소'
                );
                
                if (choice === '덮어쓰기 (로컬 → 서버)') {
                    // 로컬 파일로 서버 덮어쓰기
                    const startTime = Date.now();
                    const fileSize = fs.statSync(document.uri.fsPath).size;
                    
                    try {
                        const forceResult = await sftpClient.uploadFile(document.uri.fsPath, cachedRemotePath, config);
                        const duration = Date.now() - startTime;
                        
                        if (forceResult && transferHistoryManager) {
                            const serverName = config.name || `${config.username}@${config.host}`;
                            const history = createTransferHistory(
                                'upload',
                                'success',
                                document.uri.fsPath,
                                cachedRemotePath,
                                fileSize,
                                duration,
                                serverName
                            );
                            transferHistoryManager.addHistory(history);
                            vscode.window.showInformationMessage(`✅ 서버 파일 덮어쓰기 완료: ${path.basename(document.uri.fsPath)}`);
                        }
                    } catch (uploadError: any) {
                        const duration = Date.now() - startTime;
                        if (transferHistoryManager) {
                            const serverName = config.name || `${config.username}@${config.host}`;
                            const history = createTransferHistory(
                                'upload',
                                'failed',
                                document.uri.fsPath,
                                cachedRemotePath,
                                fileSize,
                                duration,
                                serverName,
                                uploadError.message || String(uploadError)
                            );
                            transferHistoryManager.addHistory(history);
                        }
                        throw uploadError;
                    }
                } 
                else if (choice === '다운로드 (서버 → 로컬)') {
                    // 서버 파일로 로컬 덮어쓰기
                    const confirmed = await vscode.window.showWarningMessage(
                        `⚠️ 로컬 변경사항이 손실됩니다!\n\n서버 파일로 덮어쓰시겠습니까?`,
                        { modal: true },
                        '확인',
//                        '취소'
                    );
                    
                    if (confirmed === '확인') {
                        await downloadAndReloadFile(cachedRemotePath, document.uri.fsPath, config, document, false);
                        vscode.window.showInformationMessage(`✅ 서버 파일 다운로드 완료: ${path.basename(document.uri.fsPath)}`);
                    }
                }
                else if (choice === '비교 및 병합') {
                    // Diff 뷰 열기 및 병합 옵션 제공
                    let metadataDirTemp = workspaceFolder.uri.fsPath;
                    if(config.workspaceRoot){
                        metadataDirTemp = config.workspaceRoot;
                    }
                    await showDiffWithMergeOptions(document.uri.fsPath, cachedRemotePath, config, metadataDirTemp, document);
                }
            }
            // 리모트와 로칼이 같을 때
            else {
                const startTime = Date.now();
                const fileSize = fs.statSync(document.uri.fsPath).size;
                
                try {
                    const forceResult = await sftpClient.uploadFile(document.uri.fsPath, cachedRemotePath, config);
                    const duration = Date.now() - startTime;
                    
                    if (forceResult && transferHistoryManager) {
                        const serverName = config.name || `${config.username}@${config.host}`;
                        const history = createTransferHistory(
                            'upload',
                            'success',
                            document.uri.fsPath,
                            cachedRemotePath,
                            fileSize,
                            duration,
                            serverName
                        );
                        transferHistoryManager.addHistory(history);
                    }
                } catch (uploadError: any) {
                    const duration = Date.now() - startTime;
                    if (transferHistoryManager) {
                        const serverName = config.name || `${config.username}@${config.host}`;
                        const history = createTransferHistory(
                            'upload',
                            'failed',
                            document.uri.fsPath,
                            cachedRemotePath,
                            fileSize,
                            duration,
                            serverName,
                            uploadError.message || String(uploadError)
                        );
                        transferHistoryManager.addHistory(history);
                    }
                    throw uploadError;
                }
            }
        } catch (error: any) {
            
            // 연결이 끊어졌습니다. 다시 연결 해야 할지 등을 확인 해야 함. 디버깅 필여
            try {
                // Clear cached client
                documentConfigCache.delete(document);
                
                // Reconnect
                await ensureClient(config);
                if (sftpClient) {
                    const startTime = Date.now();
                    const fileSize = fs.statSync(document.uri.fsPath).size;
                    const serverName = config.name || `${config.username}@${config.host}`;
                    
                    try {
                        // Retry upload
                        const retryResult = await sftpClient.uploadFile(document.uri.fsPath, cachedRemotePath, config);
                        const duration = Date.now() - startTime;
                        
                        if (retryResult) {
                            if (DEBUG_MODE) console.log('재연결 후 업로드 성공');
                            
                            // 전송 히스토리 기록
                            if (transferHistoryManager) {
                                const history = createTransferHistory(
                                    'upload',
                                    'success',
                                    document.uri.fsPath,
                                    cachedRemotePath,
                                    fileSize,
                                    duration,
                                    serverName
                                );
                                transferHistoryManager.addHistory(history);
                            }
                            
                            vscode.window.showInformationMessage(`✅ 재연결 후 업로드 성공: ${path.basename(document.uri.fsPath)}`);
                            // Update cache with new client
                            documentConfigCache.set(document, { config, client: sftpClient, remotePath: cachedRemotePath });
                        }
                    } catch (retryError: any) {
                        const duration = Date.now() - startTime;
                        
                        // 전송 히스토리 기록
                        if (transferHistoryManager) {
                            const history = createTransferHistory(
                                'upload',
                                'failed',
                                document.uri.fsPath,
                                cachedRemotePath,
                                fileSize,
                                duration,
                                serverName,
                                retryError.message || String(retryError)
                            );
                            transferHistoryManager.addHistory(history);
                        }
                        
                        throw retryError;
                    }
                }
            } 
            catch (retryError) {
                vscode.window.showErrorMessage(`❌ 재연결 실패(onDidSaveTextDocument : ${document.uri.fsPath}): ${retryError}`);
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
        downloadMultipleFilesCommand,
        deleteMultipleFilesCommand,
        saveAsCommand,
        syncUploadCommand,
        syncDownloadCommand,
        syncBothCommand,
        newFileCommand,
        newFolderCommand,
        deleteRemoteFileCommand,
        copyRemoteFileCommand,
        renameRemoteFileCommand,
        searchRemoteFilesCommand,
        searchInRemoteFilesCommand,
        openSSHTerminalCommand,
        changePermissionsCommand,
        viewTransferHistoryCommand,
        viewTransferStatisticsCommand,
        clearTransferHistoryCommand,
        copyRemotePathCommand,
        openInBrowserCommand,
        openBookmarkCommand,
        addBookmarkCommand,
        viewBookmarksCommand,
        removeBookmarkCommand,
        deleteBookmarkCommand,
        frequentBookmarksCommand,
        saveAsTemplateCommand,
        addServerFromTemplateCommand,
        manageTemplatesCommand,
        saveWatcher
        
//        uploadCommand,
//        downloadCommand,
//        openWatcher   // 나중에 추가 할 것
    );
}
//#region 




//#region functions
/**
 * 실패한 전송 재시도
 * @param history 실패한 전송 기록
 */
async function retryFailedTransfer(history: TransferHistory): Promise<void> {
    try {
        if (!transferHistoryManager) {
            return;
        }
        
        const config = await findConfigByName(history.serverName);
        if (!config) {
            vscode.window.showErrorMessage(`서버 설정을 찾을 수 없습니다: ${history.serverName}`);
            return;
        }
        
        // 서버 연결 확인
        let connection = treeProvider.getConnectedServer(history.serverName);
        if (!connection || !connection.client.isConnected()) {
            const reconnect = await vscode.window.showWarningMessage(
                '서버에 연결되어 있지 않습니다. 연결하시겠습니까?',
                '연결'
            );
            if (reconnect !== '연결') {
                return;
            }
            
            try {
                const client = createClient(config);
                await client.connect(config);
                treeProvider.addConnectedServer(history.serverName, client, config);
                connection = treeProvider.getConnectedServer(history.serverName);
                
                if (!connection) {
                    vscode.window.showErrorMessage('서버 연결 정보를 가져올 수 없습니다.');
                    return;
                }
            } catch (connectError) {
                vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                return;
            }
        }
        
        const startTime = Date.now();
        
        try {
            if (history.type === 'upload') {
                // 재업로드
                if (!fs.existsSync(history.localPath)) {
                    vscode.window.showErrorMessage(`로컬 파일을 찾을 수 없습니다: ${history.localPath}`);
                    return;
                }
                
                const fileSize = fs.statSync(history.localPath).size;
                const success = await connection.client.uploadFile(history.localPath, history.remotePath, config);
                const duration = Date.now() - startTime;
                
                if (success) {
                    const newHistory = createTransferHistory(
                        'upload',
                        'success',
                        history.localPath,
                        history.remotePath,
                        fileSize,
                        duration,
                        history.serverName
                    );
                    transferHistoryManager.addHistory(newHistory);
                    vscode.window.showInformationMessage(`✅ 재업로드 성공: ${path.basename(history.localPath)}`);
                }
            } else if (history.type === 'download') {
                // 재다운로드
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                    return;
                }
                
                // 재다운로드 - protocol aware
                if (connection.client instanceof SftpClient) {
                    if (connection.client.client) {
                        await connection.client.client.get(history.remotePath, history.localPath);
                        await connection.client.saveRemoteFileMetadata(
                            history.remotePath,
                            history.localPath,
                            config,
                            config.workspaceRoot
                        );
                        
                        const duration = Date.now() - startTime;
                        const fileSize = fs.existsSync(history.localPath) ? fs.statSync(history.localPath).size : 0;
                        
                        const newHistory = createTransferHistory(
                            'download',
                            'success',
                            history.localPath,
                            history.remotePath,
                            fileSize,
                            duration,
                            history.serverName
                        );
                        transferHistoryManager.addHistory(newHistory);
                        vscode.window.showInformationMessage(`✅ 재다운로드 성공: ${path.basename(history.localPath)}`);
                    }
                } else {
                    // FTP protocol
                    await connection.client.downloadFile(history.remotePath, history.localPath, config);
                    
                    const duration = Date.now() - startTime;
                    const fileSize = fs.existsSync(history.localPath) ? fs.statSync(history.localPath).size : 0;
                    
                    const newHistory = createTransferHistory(
                        'download',
                        'success',
                        history.localPath,
                        history.remotePath,
                        fileSize,
                        duration,
                        history.serverName
                    );
                    transferHistoryManager.addHistory(newHistory);
                    vscode.window.showInformationMessage(`✅ 재다운로드 성공: ${path.basename(history.localPath)}`);
                }
            }
        } catch (retryError: any) {
            const duration = Date.now() - startTime;
            const newHistory = createTransferHistory(
                history.type,
                'failed',
                history.localPath,
                history.remotePath,
                history.fileSize,
                duration,
                history.serverName,
                retryError.message || String(retryError)
            );
            transferHistoryManager.addHistory(newHistory);
            vscode.window.showErrorMessage(`재시도 실패: ${retryError}`);
        }
        
    } catch (error) {
        if (DEBUG_MODE) console.error('retryFailedTransfer error:', error);
        vscode.window.showErrorMessage(`재시도 실패: ${error}`);
    }
}

/**
 * 파일 크기를 사람이 읽기 쉬운 형식으로 변환
 */
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * 날짜를 로컬 시간으로 포맷
 */
function formatDateTime(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

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
        if (DEBUG_MODE) console.error('Error finding config by metadata:', error);
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
        sftpClient = createClient(config);
        const outputChannel = vscode.window.createOutputChannel('ctlim SFTP');
        sftpClient.setOutputChannel(outputChannel);
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
async function ensureConnected(client: ClientType, config: SftpConfig, serverName: string): Promise<boolean> {
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
        if (DEBUG_MODE) console.error(`재연결 실패(ensureConnected): ${serverName}`, error);
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
    const serverName = config.name || `${config.username}@${config.host}`;
    const startTime = Date.now();
    
    try {
        const connection = treeProvider.getConnectedServer(serverName);
        
        if (!connection) {
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

        // Protocol-aware download and reload
        if (connection.client instanceof SftpClient) {
            if (connection.client.client) {
                await connection.client.client.get(remotePath, localPath);
                await connection.client.saveRemoteFileMetadata(
                    remotePath,
                    localPath,
                    config,
                    config.workspaceRoot
                );
            }
        } else {
            await connection.client.downloadFile(remotePath, localPath, config);
        }

        // 다운로드 성공 - 전송 히스토리 기록
        const duration = Date.now() - startTime;
        const fileSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
        
        if (transferHistoryManager) {
            const history = createTransferHistory(
                'download',
                'success',
                localPath,
                remotePath,
                fileSize,
                duration,
                serverName
            );
            transferHistoryManager.addHistory(history);
        }

        // 다시 열기
        if (document) {
            const newDoc = await vscode.workspace.openTextDocument(localPath);
            await vscode.window.showTextDocument(newDoc, { 
                preview: false, 
                preserveFocus: preserveFocus
            });
        }

        return true;
    } catch (error: any) {
        // 다운로드 실패 - 전송 히스토리 기록
        const duration = Date.now() - startTime;
        
        if (transferHistoryManager) {
            const history = createTransferHistory(
                'download',
                'failed',
                localPath,
                remotePath,
                0,
                duration,
                serverName,
                error.message || String(error)
            );
            transferHistoryManager.addHistory(history);
        }
        
        if (DEBUG_MODE) console.error(`다운로드 실패: ${localPath}`, error);
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
async function selectRemotePathFromTree(client: ClientType, startPath: string, fileName: string): Promise<string | undefined> {
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
 * Diff 뷰와 함께 병합 옵션 제공
 * @param localPath 로컬 파일 경로
 * @param remotePath 원격 파일 경로
 * @param config 서버 설정
 * @param workspaceFolder 워크스페이스 폴더
 * @param document 현재 문서
 */
async function showDiffWithMergeOptions(
    localPath: string, 
    remotePath: string, 
    config: SftpConfig, 
    workspaceFolder: string,
    document?: vscode.TextDocument
): Promise<void> {
    try {
        const connection = treeProvider.getConnectedServer(
            config.name || `${config.username}@${config.host}`
        );
        
        if (!connection || !connection.client.isConnected()) {
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
        
        // Protocol-aware diff file download
        if (connection.client instanceof SftpClient) {
            if (connection.client.client) {
                await connection.client.client.get(remotePath, tempRemotePath);
            }
        } else {
            // FTP protocol
            await connection.client.downloadFile(remotePath, tempRemotePath, config);
        }

        // Open diff view
        const localUri = vscode.Uri.file(localPath);
        const remoteUri = vscode.Uri.file(tempRemotePath);
        
        await vscode.commands.executeCommand(
            'vscode.diff',
            remoteUri,
            localUri,
            `${fileName} (서버) ↔ ${fileName} (로컬)`
        );

        // Show merge action options
        const action = await vscode.window.showInformationMessage(
            `📊 변경사항을 확인하세요\n\n파일: ${fileName}\n\n병합 후 어떻게 처리하시겠습니까?`,
            { modal: false },
            '로컬 파일 유지',
            '서버 파일 사용',
            '수동 병합 후 업로드',
            '나중에'
        );

        if (action === '로컬 파일 유지') {
            // 로컬 파일로 서버 덮어쓰기
            if (connection.client) {
                await connection.client.uploadFile(localPath, remotePath, config);
                vscode.window.showInformationMessage(`✅ 로컬 변경사항 업로드 완료: ${fileName}`);
            }
        } else if (action === '서버 파일 사용') {
            // 서버 파일로 로컬 덮어쓰기
            await downloadAndReloadFile(remotePath, localPath, config, document, false);
            vscode.window.showInformationMessage(`✅ 서버 파일 다운로드 완료: ${fileName}`);
        } else if (action === '수동 병합 후 업로드') {
            // 사용자에게 안내
            vscode.window.showInformationMessage(
                `📝 병합 안내\n\n1. Diff 뷰에서 변경사항을 확인하세요\n2. 로컬 파일을 직접 편집하여 병합하세요\n3. 저장(Ctrl+S)하면 자동 업로드됩니다`,
                '확인'
            );
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Diff 표시 실패: ${error}`);
        if (DEBUG_MODE) console.error('showDiffWithMergeOptions error:', error);
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
        
        // Protocol-aware simple diff download
        if (sftpClient instanceof SftpClient) {
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
        } else {
            // FTP protocol
            await sftpClient.downloadFile(remotePath, tempRemotePath, config);
            
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
                        if (DEBUG_MODE) console.error(`메타데이터 읽기 실패: ${metadataPath}`, error);
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
            let client: ClientType | null = null;
            
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
                client = createClient(config);
                try {
                    if (DEBUG_MODE) console.log(`서버 연결 시작: ${serverName}`);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    if (DEBUG_MODE) console.log(`서버 연결 성공: ${serverName}`);
                } catch (connectError) {
                    if (DEBUG_MODE) console.error(`서버 연결 실패: ${serverName}`, connectError);
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
                                if (DEBUG_MODE) console.error(`재시도 실패: ${fileInfo.metadata.remotePath}`, retryError);
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
        if (DEBUG_MODE) console.error('원격 파일 확인 중 오류:', error);
    }
}


/**
 * TreeView에서 북마크 위치로 네비게이션
 * @param bookmark 열 북마크
 */
async function findServerTreeItem(bookmark: Bookmark): Promise<void> {
    isNavigatingBookmark = true;
    let serverItem: SftpTreeItem | undefined;
    
    try {
        if (!sftpTreeView) {
            vscode.window.showWarningMessage('TreeView를 초기화할 수 없습니다.');
            return;
        }

        try {
            await vscode.commands.executeCommand('ctlimSftpView.focus');
        } 
        catch (e) {
            // focus 명령어 실패해도 계속 진행
        }
        
        // 1단계: 루트 아이템 가져오기
        const rootItems = await treeProvider.getChildren();

        // 2단계: 그룹 처리
        let groupItem: SftpTreeItem | undefined;
        
        if (bookmark.groupName) {
            groupItem = rootItems.find((item: SftpTreeItem) => item.label === bookmark.groupName);
            
            if (groupItem) {
                try {
                    await sftpTreeView.reveal(groupItem, { expand: true });
//                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (e) {
                    if (DEBUG_MODE) console.log(`그룹 reveal 실패: ${e}`);
                }
            }
            else {
                if (DEBUG_MODE) console.log(`그룹을 찾을 수 없음: ${bookmark.groupName}`);
                return;
            }
        }

        // 3단계: 서버 아이템 찾기
        // A. 루트 레벨에서 검색
        for (const item of rootItems) {
            if (item.itemType === 'server' && item.label === bookmark.serverName) {
                serverItem = item;
                break;
            }
        }
        
        // B. 그룹 내에서 검색
        if (!serverItem && bookmark.groupName && groupItem) {
            // 그룹이 이미 펼쳐졌으므로 API를 통해 자식을 다시 가져옴
            const groupChildren = await treeProvider.getChildren(groupItem);
            serverItem = groupChildren.find((child: SftpTreeItem) => 
                child.itemType === 'server' && child.label === bookmark.serverName
            );
        }
        
        if (!serverItem) {
            if (DEBUG_MODE) console.log(`서버를 찾을 수 없음: ${bookmark.serverName}`);
            return;
        }

        // 4단계: 서버 아이템 Reveal (ID 기반)
        try {
             await sftpTreeView.reveal(serverItem, { 
                 expand: true,
                 select: false, // 파일/폴더를 찾아갈 것이므로 서버 선택은 비활성화
                 focus: false 
             });
//             await new Promise(resolve => setTimeout(resolve, 500));
        } catch (revealError) {
             if (DEBUG_MODE) console.log(`서버 reveal 실패: ${revealError}`);
        }

        // 5단계: 원격 경로를 따라가며 폴더 열기 (Deep Navigation)
        const connection = treeProvider.getConnectedServer(bookmark.serverName);
        if (!connection) {
            return;
        }

        const serverRemotePath = connection.config.remotePath;
        let relativePath = '';
        
        // bookmark.remotePath가 server remotePath로 시작하는지 확인
        if (bookmark.remotePath.startsWith(serverRemotePath)) {
            relativePath = bookmark.remotePath.substring(serverRemotePath.length);
            if (relativePath.startsWith('/')) {
                relativePath = relativePath.substring(1);
            }
        } else {
            // 다른 경로면 전체 경로 사용? 보통은 server root 아래에 있음.
            relativePath = bookmark.remotePath; 
        }

        // 경로가 없으면(루트) 서버만 선택하고 종료
        if (!relativePath) {
            await sftpTreeView.reveal(serverItem, { select: true, focus: true });
            return;
        }

        const pathParts = relativePath.split('/').filter(p => p.length > 0);
        let currentPath = serverRemotePath; // 시작 경로

        // 경로를 순차적으로 따라감
        for (let i = 0; i < pathParts.length; i++) {
            currentPath = path.posix.join(currentPath, pathParts[i]);
            
            // 마지막 아이템(파일 또는 최종 폴더)인지 확인
            const isLast = i === pathParts.length - 1;
            
            // ID 생성 규칙 재사용 (SftpTreeProvider와 일치)
            const serverId = connection.config.name || `${connection.config.username}@${connection.config.host}`;
            
            // 중간 경로는 무조건 디렉토리임. 마지막 경로는 bookmark.isDirectory 값으로 판단.
            let isDir = true;
            if (isLast) {
                isDir = bookmark.isDirectory;
            }
            
            // 가상의 TreeItem 생성 (ID는 생성자에서 자동 설정됨)
            const tempItem = new SftpTreeItem(
                pathParts[i],
                isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                isDir ? 'remoteDirectory' : 'remoteFile',
                currentPath,
                isDir,
                connection.config,
                undefined,
                undefined,
                undefined,
                undefined
            );
            
            try {
                // select: 마지막 아이템인 경우만 true
                // expand: 디렉토리인 경우 true 
                const shouldExpand = isDir && (isLast ? true : true); 
                const shouldSelect = isLast;
                const shouldFocus = isLast;

                await sftpTreeView.reveal(tempItem, { 
                    select: shouldSelect,
                    focus: shouldFocus,
                    expand: shouldExpand
                });
                
                // 로딩 대기
                if (shouldExpand) {
//                    await new Promise(resolve => setTimeout(resolve, 400));
                }
            } catch (e) {
                if (DEBUG_MODE) console.log(`경로 reveal 실패 (${currentPath}): ${e}`);
                // 실패하면 멈춤
                break;
            }
        }

    } 
    catch (error) {
        if (DEBUG_MODE) console.error('findServerTreeItem error:', error);
        vscode.window.showWarningMessage(`북마크 네비게이션 실패: ${error}`);
    } finally {
        isNavigatingBookmark = false;
    }
}

/**
 * 북마크 열기
 * @param bookmark 열 북마크
 */
async function openBookmark(bookmark: Bookmark): Promise<void> {
    try {
        if (!bookmarkManager) {
            vscode.window.showErrorMessage('북마크 관리자를 초기화할 수 없습니다.');
            return;
        }
        
        // 서버 연결 확인
        let connection = treeProvider.getConnectedServer(bookmark.serverName);
        
        if (!connection || !connection.client.isConnected()) {
            const reconnect = await vscode.window.showWarningMessage(
                `서버에 연결되어 있지 않습니다: ${bookmark.serverName}\n연결하시겠습니까?`,
                '연결'
            );
            if (reconnect !== '연결') {
                return;
            }
            
            try {
                const serverItem = await treeProvider.getServerItem(bookmark.serverName);
                if (!serverItem) {
                    vscode.window.showErrorMessage(`서버 설정을 찾을 수 없습니다: ${bookmark.serverName}`);
                    return;
                }
                await treeProvider.connectToServer(serverItem);
                connection = treeProvider.getConnectedServer(bookmark.serverName);
            } catch (connectError) {
                vscode.window.showErrorMessage(`서버 연결 실패: ${connectError}`);
                return;
            }
        }
        
        if (!connection) {
            vscode.window.showErrorMessage('서버 연결을 가져올 수 없습니다.');
            return;
        }
        
        // 접근 통계 업데이트
        bookmarkManager.recordAccess(bookmark.id);
        
        // TreeView에서 북마크 위치로 이동
        await findServerTreeItem(bookmark);
        
    } catch (error) {
        vscode.window.showErrorMessage(`북마크 열기 실패: ${error}`);
        if (DEBUG_MODE) console.error('openBookmark error:', error);
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
        if (DEBUG_MODE) console.error('백업 실패:', error);
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