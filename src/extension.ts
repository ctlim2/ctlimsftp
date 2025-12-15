import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpClient } from './sftpClient';
import { SftpConfig } from './types';
import { SftpTreeProvider } from './sftpTreeProvider';

let sftpClient: SftpClient | null = null;
let treeProvider: SftpTreeProvider;
let currentConfig: SftpConfig | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('ctlim SFTP extension is now active');

    // Register Tree View Provider
    treeProvider = new SftpTreeProvider();
    const treeView = vscode.window.createTreeView('ctlimSftpView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });
    
    // Handle single click on tree items
    treeView.onDidChangeSelection(async (e) => {
        if (e.selection.length > 0) {
            const item = e.selection[0];
            
            // Execute command if item has one
            if (item.command) {
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

    // Connect to server command
    const connectServerCommand = vscode.commands.registerCommand('ctlimSftp.connectServer', async (serverItem) => {
        await treeProvider.connectToServer(serverItem);
    });

    // Disconnect server command
    const disconnectServerCommand = vscode.commands.registerCommand('ctlimSftp.disconnectServer', async (item) => {
        if (item && item.serverItem) {
            treeProvider.disconnectServer(item.serverItem.name);
        }
    });

    // Refresh tree view command
    const refreshCommand = vscode.commands.registerCommand('ctlimSftp.refresh', () => {
        treeProvider.refresh();
    });

    // Open remote file command
    const openRemoteFileCommand = vscode.commands.registerCommand('ctlimSftp.openRemoteFile', async (remotePath: string, config: SftpConfig) => {
        try {
            if (!remotePath || !config) {
                vscode.window.showErrorMessage('원격 파일 정보가 없습니다.');
                return;
            }

            // Find the connected server for this config
            const connection = treeProvider.getConnectedServer(config.name || `${config.username}@${config.host}`);
            if (!connection) {
                vscode.window.showErrorMessage('서버에 연결되어 있지 않습니다.');
                return;
            }

            // Get workspace folder (not workspaceRoot)
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
                return;
            }

            // Download to workspace preserving remote path structure relative to remotePath
            // Calculate path relative to config.remotePath
            const relativeToRemotePath = remotePath.startsWith(config.remotePath)
                ? remotePath.substring(config.remotePath.length).replace(/^\/+/, '')
                : path.basename(remotePath);
            const tempLocalPath = path.join(workspaceFolder.uri.fsPath, relativeToRemotePath);
            const tempDir = path.dirname(tempLocalPath);
            
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Download to temp location
            if (connection.client.client) {
                // Get remote file stats for metadata
                const remoteStats = await connection.client.client.stat(remotePath);
                const remoteModifyTime = new Date(remoteStats.modifyTime).getTime();
                
                await connection.client.client.get(remotePath, tempLocalPath);
                
                // Save metadata to individual file
                const metadataDir = path.join(workspaceFolder.uri.fsPath, '.vscode', '.sftp-metadata');
                if (!fs.existsSync(metadataDir)) {
                    fs.mkdirSync(metadataDir, { recursive: true });
                }
                
                // Encode remote path safely: _ -> _u_, / -> __
                const safeRemotePath = remotePath
                    .replace(/^\//g, '')
                    .replace(/_/g, '_u_')
                    .replace(/\//g, '__');
                const metadataPath = path.join(metadataDir, `${safeRemotePath}.json`);
                const metadata = {
                    remotePath,
                    remoteModifyTime,
                    localPath: tempLocalPath,
                    downloadTime: Date.now()
                };
                
                fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
                
                const doc = await vscode.workspace.openTextDocument(tempLocalPath);
                await vscode.window.showTextDocument(doc);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`파일 열기 실패: ${error}`);
        }
    });


    // Upload command
    const uploadCommand = vscode.commands.registerCommand('ctlimSftp.upload', async (uri: vscode.Uri) => {
        try {
            const config = await loadConfig();
            if (!config) {
                return;
            }

            const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!filePath) {
                vscode.window.showErrorMessage('파일을 선택해주세요.');
                return;
            }

            // Skip temp files
            if (filePath.includes('.sftp-tmp')) {
                return;
            }

            await ensureClient(config);
            if (!sftpClient) {
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            await sftpClient.uploadFile(filePath, config, false, workspaceFolder?.uri.fsPath);
            vscode.window.showInformationMessage(`파일 업로드 완료: ${path.basename(filePath)}`);
        } catch (error) {
            vscode.window.showErrorMessage(`업로드 실패: ${error}`);
        }
    });

    // Download command
    const downloadCommand = vscode.commands.registerCommand('ctlimSftp.download', async (uri: vscode.Uri) => {
        try {
            const config = await loadConfig();
            if (!config) {
                return;
            }

            const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!filePath) {
                vscode.window.showErrorMessage('파일을 선택해주세요.');
                return;
            }

            await ensureClient(config);
            if (!sftpClient) {
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            await sftpClient.downloadFile(filePath, config, workspaceFolder?.uri.fsPath);
            vscode.window.showInformationMessage(`파일 다운로드 완료: ${path.basename(filePath)}`);
        } catch (error) {
            vscode.window.showErrorMessage(`다운로드 실패: ${error}`);
        }
    });

    // Sync command
    const syncCommand = vscode.commands.registerCommand('ctlimSftp.sync', async () => {
        try {
            const config = await loadConfig();
            if (!config) {
                return;
            }

            await ensureClient(config);
            if (!sftpClient) {
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스가 열려있지 않습니다.');
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "동기화 중...",
                cancellable: false
            }, async () => {
                await sftpClient!.syncFolder(workspaceFolder.uri.fsPath, config);
            });

            vscode.window.showInformationMessage('동기화 완료');
        } catch (error) {
            vscode.window.showErrorMessage(`동기화 실패: ${error}`);
        }
    });

    // Config command
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
        const config = await loadConfig();
        if (config) {
            await ensureClient(config);
            if (sftpClient && currentConfig) {
                treeProvider.refresh();
            }
        }
    });

    // File save watcher for uploadOnSave
    const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (document) => {
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

        const config = await loadConfig();
        if (!config) {
            return;
        }
        
        if (!config.uploadOnSave) {
            return;
        }

        // Check if file is in workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
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
            await ensureClient(config);
            if (!sftpClient) {
                vscode.window.showErrorMessage('SFTP 클라이언트 연결 실패');
                return;
            }

            const result = await sftpClient.uploadFile(document.uri.fsPath, config, false, workspaceFolder.uri.fsPath);
            
            if (result.conflict) {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ 충돌 감지!\n\n파일이 서버에서 수정되었습니다: ${path.basename(document.uri.fsPath)}\n\n로컬 변경사항으로 덮어쓰시겠습니까?`,
                    { modal: true },
                    '덕어쓰기',
                    '취소',
                    '비교'
                );
                
                if (choice === '덕어쓰기') {
                    const forceResult = await sftpClient.uploadFile(document.uri.fsPath, config, true, workspaceFolder.uri.fsPath);
                    if (forceResult.uploaded) {
                        vscode.window.showInformationMessage(`✅ 자동 업로드 (강제): ${path.basename(document.uri.fsPath)}`);
                        // Refresh metadata after successful upload
                        const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
                        const calculatedRemotePath = path.posix.join(
                            config.remotePath,
                            relativePath.replace(/\\/g, '/')
                        );
                        await refreshFileMetadata(document.uri.fsPath, calculatedRemotePath, config, workspaceFolder.uri.fsPath);
                    }
                } else if (choice === '비교') {
                    // Show diff between local and remote
                    await showDiff(document.uri.fsPath, result.remotePath, config, workspaceFolder.uri.fsPath);
                }
            } else if (result.uploaded) {
                vscode.window.showInformationMessage(`✅ 자동 업로드: ${path.basename(document.uri.fsPath)}`);
                // Refresh metadata after successful upload
                const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
                const calculatedRemotePath = path.posix.join(
                    config.remotePath,
                    relativePath.replace(/\\/g, '/')
                );
                await refreshFileMetadata(document.uri.fsPath, calculatedRemotePath, config, workspaceFolder.uri.fsPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`❌ 자동 업로드 실패: ${error}`);
            console.error('uploadOnSave error:', error);
        }
    });

    // File open watcher for downloadOnOpen and metadata refresh
    const openWatcher = vscode.workspace.onDidOpenTextDocument(async (document) => {
        const config = await loadConfig();
        if (!config) {
            return;
        }

        // Skip config file
        if (document.uri.fsPath.endsWith('ctlim-sftp.json')) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || !document.uri.fsPath.startsWith(workspaceFolder.uri.fsPath)) {
            return;
        }

        // Check if metadata exists for this file
        const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
        const calculatedRemotePath = path.posix.join(
            config.remotePath,
            relativePath.replace(/\\/g, '/')
        );
        
        try {
            await ensureClient(config);
            if (!sftpClient) {
                return;
            }

            // Refresh metadata when file is opened
            await refreshFileMetadata(document.uri.fsPath, calculatedRemotePath, config, workspaceFolder.uri.fsPath);

            // Handle downloadOnOpen if enabled
            if (config.downloadOnOpen) {
                if (config.downloadOnOpen === 'confirm') {
                    const result = await vscode.window.showInformationMessage(
                        '이 파일을 서버에서 다운로드하시겠습니까?',
                        '다운로드',
                        '취소'
                    );
                    if (result !== '다운로드') {
                        return;
                    }
                }

                await sftpClient.downloadFile(document.uri.fsPath, config, workspaceFolder.uri.fsPath);
                vscode.window.showInformationMessage(`자동 다운로드: ${path.basename(document.uri.fsPath)}`);
            }
        } catch (error) {
            // Ignore if file doesn't exist on remote
        }
    });

    context.subscriptions.push(
        connectServerCommand,
        disconnectServerCommand,
        uploadCommand,
        downloadCommand,
        syncCommand,
        configCommand,
        refreshCommand,
        openRemoteFileCommand,
        saveWatcher,
        openWatcher
    );
}

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
            '취소'
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

async function ensureClient(config: SftpConfig): Promise<void> {
    if (!sftpClient) {
        sftpClient = new SftpClient();
    }
    
    if (!sftpClient.isConnected()) {
        await sftpClient.connect(config);
        currentConfig = config;
    }
}

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

async function refreshFileMetadata(localPath: string, remotePath: string, config: SftpConfig, workspaceFolder: string): Promise<boolean> {
    try {
        if (!sftpClient || !sftpClient.isConnected()) {
            return false;
        }

        const remoteStats = await sftpClient.getRemoteFileStats(remotePath);
        if (!remoteStats) {
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
            remoteModifyTime: remoteStats.modifyTime,
            localPath,
            downloadTime: Date.now()
        };

        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

async function checkAndReloadRemoteFiles() {
    try {
        const config = await loadConfig();
        if (!config) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        // Get all open text documents
        const openDocuments = vscode.workspace.textDocuments.filter(doc => 
            !doc.uri.fsPath.endsWith('ctlim-sftp.json') &&
            doc.uri.fsPath.startsWith(workspaceFolder.uri.fsPath)
        );

        if (openDocuments.length === 0) {
            return;
        }

        await ensureClient(config);
        if (!sftpClient) {
            return;
        }

        const metadataDir = path.join(workspaceFolder.uri.fsPath, '.vscode', '.sftp-metadata');
        if (!fs.existsSync(metadataDir)) {
            return;
        }

        for (const document of openDocuments) {
            try {
                const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
                const calculatedRemotePath = path.posix.join(
                    config.remotePath,
                    relativePath.replace(/\\/g, '/')
                );

                // Check if metadata exists
                const safeRemotePath = calculatedRemotePath
                    .replace(/^\//g, '')
                    .replace(/_/g, '_u_')
                    .replace(/\//g, '__');
                const metadataPath = path.join(metadataDir, `${safeRemotePath}.json`);

                if (!fs.existsSync(metadataPath)) {
                    continue;
                }

                // Read metadata
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                
                // Check remote file
                const remoteStats = await sftpClient.getRemoteFileStats(calculatedRemotePath);
                if (!remoteStats) {
                    continue;
                }

                // If remote file is newer, ask user
                if (remoteStats.modifyTime !== metadata.remoteModifyTime) {
                    const fileName = path.basename(document.uri.fsPath);
                    const choice = await vscode.window.showWarningMessage(
                        `⚠️ 서버 파일 변경 감지!\n\n파일: ${fileName}\n서버의 파일이 수정되었습니다.\n\n로컬 파일을 서버 버전으로 업데이트하시겠습니까?`,
                        { modal: true },
                        '다운로드',
                        '무시',
                        '비교'
                    );

                    if (choice === '다운로드') {
                        await sftpClient.downloadFile(document.uri.fsPath, config, workspaceFolder.uri.fsPath);
                        vscode.window.showInformationMessage(`✅ 다운로드 완료: ${fileName}`);
                        
                        // Reload the document
                        const newDoc = await vscode.workspace.openTextDocument(document.uri);
                        await vscode.window.showTextDocument(newDoc, { preview: false, preserveFocus: true });
                    } else if (choice === '비교') {
                        // Show diff between local and remote
                        await showDiff(document.uri.fsPath, calculatedRemotePath, config, workspaceFolder.uri.fsPath);
                    }
                }
            } catch (error) {
                // Ignore file check errors
            }
        }
    } catch (error) {
        // Ignore remote file check errors
    }
}

export function deactivate() {
    if (sftpClient) {
        sftpClient.disconnect();
    }
}
