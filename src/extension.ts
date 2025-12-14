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
        treeDataProvider: treeProvider
    });
    context.subscriptions.push(treeView);

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

            // Use the config's workspaceRoot for temp folder
            const workspaceRoot = connection.config.workspaceRoot;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('워크스페이스 경로를 찾을 수 없습니다.');
                return;
            }

            // Download to workspace preserving remote path structure relative to remotePath
            // Calculate path relative to config.remotePath
            const relativeToRemotePath = remotePath.startsWith(config.remotePath)
                ? remotePath.substring(config.remotePath.length).replace(/^\/+/, '')
                : path.basename(remotePath);
            const tempLocalPath = path.join(workspaceRoot, relativeToRemotePath);
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
                const metadataDir = path.join(workspaceRoot, '.vscode', '.sftp-metadata');
                if (!fs.existsSync(metadataDir)) {
                    fs.mkdirSync(metadataDir, { recursive: true });
                }
                
                const safeRemotePath = remotePath.replace(/^\//g, '').replace(/\//g, '_');
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
            console.log('uploadOnSave: 설정 파일이 없습니다.');
            return;
        }
        
        if (!config.uploadOnSave) {
            console.log('uploadOnSave: uploadOnSave가 비활성화되어 있습니다.');
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
            console.log(`uploadOnSave: 무시 패턴에 해당됨 (${relativePath})`);
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
                    `파일이 서버에서 수정되었습니다: ${path.basename(document.uri.fsPath)}\n로컬 변경사항으로 덮어쓰시겠습니까?`,
                    '덮어쓰기',
                    '취소',
                    '비교'
                );
                
                if (choice === '덮어쓰기') {
                    const forceResult = await sftpClient.uploadFile(document.uri.fsPath, config, true, workspaceFolder.uri.fsPath);
                    if (forceResult.uploaded) {
                        vscode.window.showInformationMessage(`✅ 자동 업로드 (강제): ${path.basename(document.uri.fsPath)}`);
                    }
                } else if (choice === '비교') {
                    // TODO: Implement diff functionality
                    vscode.window.showInformationMessage('Diff 기능은 아직 구현되지 않았습니다.');
                }
            } else if (result.uploaded) {
                vscode.window.showInformationMessage(`✅ 자동 업로드: ${path.basename(document.uri.fsPath)}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`❌ 자동 업로드 실패: ${error}`);
            console.error('uploadOnSave error:', error);
        }
    });

    // File open watcher for downloadOnOpen
    const openWatcher = vscode.workspace.onDidOpenTextDocument(async (document) => {
        const config = await loadConfig();
        if (!config || !config.downloadOnOpen) {
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

        try {
            await ensureClient(config);
            if (!sftpClient) {
                return;
            }

            await sftpClient.downloadFile(document.uri.fsPath, config, workspaceFolder.uri.fsPath);
            vscode.window.showInformationMessage(`자동 다운로드: ${path.basename(document.uri.fsPath)}`);
        } catch (error) {
            // Ignore if file doesn't exist on remote
            console.log(`다운로드 실패 (무시됨): ${error}`);
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

export function deactivate() {
    if (sftpClient) {
        sftpClient.disconnect();
    }
}
