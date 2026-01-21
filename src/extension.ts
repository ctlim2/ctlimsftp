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
import { ConnectConfigWebview } from './configWebview';
import { SftpFileDecorationProvider } from './fileDecorationProvider';
import { WatcherManager } from './watcherManager';
import { i18n } from './i18n';

// Helper to manage search history
class SearchHistoryManager {
    constructor(private context: vscode.ExtensionContext) {}

    getHistory(key: string): string[] {
        return this.context.globalState.get<string[]>(key, []);
    }

    async addHistory(key: string, value: string): Promise<void> {
        let history = this.getHistory(key);
        // Remove existing to avoid duplicates and move to top
        history = history.filter(item => item !== value);
        history.unshift(value);
        // Limit to 20 items
        if (history.length > 20) {
            history.splice(20);
        }
        await this.context.globalState.update(key, history);
    }

    async clearHistory(key: string): Promise<void> {
        await this.context.globalState.update(key, []);
    }
}

/**
 * Show a QuickPick with history that allows custom input
 */
async function showInputBoxWithHistory(
    historyManager: SearchHistoryManager,
    historyKey: string,
    prompt: string,
    placeholder: string
): Promise<string | undefined> {
    return new Promise((resolve) => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = placeholder;
        quickPick.title = prompt;
        
        const history = historyManager.getHistory(historyKey);
        
        // Add history items
        quickPick.items = history.map(label => ({ 
            label, 
            description: i18n.t('label.history') || 'History' 
        }));
        
        // Add a "Clear History" button if history exists
        if (history.length > 0) {
            quickPick.buttons = [{
                iconPath: new vscode.ThemeIcon('clear-all'),
                tooltip: i18n.t('action.clearHistory') || 'Clear History'
            }];
        }

        quickPick.onDidTriggerButton(async (button) => {
            if (button.tooltip === (i18n.t('action.clearHistory') || 'Clear History')) {
                const confirm = await vscode.window.showWarningMessage(
                    i18n.t('confirm.clearSearchHistory') || 'Clear search history?',
                    { modal: true },
                    i18n.t('action.delete') || 'Delete'
                );
                
                if (confirm === (i18n.t('action.delete') || 'Delete')) {
                    await historyManager.clearHistory(historyKey);
                    quickPick.items = [];
                    quickPick.buttons = [];
                }
            }
        });

        // Handle user input
        quickPick.onDidChangeValue((value) => {
            if (!value) {
                quickPick.items = history.map(label => ({ 
                    label, 
                    description: i18n.t('label.history') || 'History' 
                }));
                return;
            }
            
            // Show history items matching input + option to use current input
            const matchingHistory = history
                .filter(h => h.toLowerCase().includes(value.toLowerCase()))
                .map(label => ({ 
                    label, 
                    description: i18n.t('label.history') || 'History' 
                }));
            
            // Check if exact match exists
            const exactMatch = history.some(h => h === value);
            
            const newItems: vscode.QuickPickItem[] = [];
            
            // Add "Use: input" item if not exact match (optional, but good for clarity)
            // But VS Code QuickPick allows accepting value if we handle onDidAccept.
            
            // Actually, we can just let user pick from list OR press enter.
            // If they press enter and no item is selected (or active), we take value.
            
            quickPick.items = matchingHistory;
        });

        quickPick.onDidAccept(async () => {
            let result = quickPick.value;
            
            // If user selected an item from the list, use that
            if (quickPick.selectedItems.length > 0) {
                result = quickPick.selectedItems[0].label;
            }
            
            if (result) {
                // Save to history
                await historyManager.addHistory(historyKey, result);
                resolve(result);
            } else {
                resolve(undefined);
            }
            quickPick.hide();
        });

        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });

        quickPick.show();
    });
}

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = false;

// 클라이언트 타입 (SFTP 또는 FTP)
type ClientType = SftpClient | FtpClient;

let sftpClient: ClientType | null = null;
let treeProvider: SftpTreeProvider;
let decorationProvider: SftpFileDecorationProvider;
let currentConfig: SftpConfig | null = null;
let statusBarItem: vscode.StatusBarItem;
let transferHistoryManager: TransferHistoryManager | null = null;
let bookmarkManager: BookmarkManager | null = null;
let templateManager: TemplateManager | null = null;
let watcherManager: WatcherManager | null = null;
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
    
    // Register File Decoration Provider
    decorationProvider = new SftpFileDecorationProvider();
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(decorationProvider)
    );

    // Initialize Transfer History Manager
    if (workspaceFolder) {
        bookmarkManager = new BookmarkManager(workspaceFolder.uri.fsPath);
        transferHistoryManager = new TransferHistoryManager(workspaceFolder.uri.fsPath);
        templateManager = new TemplateManager(workspaceFolder.uri.fsPath);
    }
    
    // Initialize Watcher Manager
    watcherManager = new WatcherManager();
    
    // Create Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'ctlimSftp.switchServer';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    // Initialize search history manager
    const searchHistoryManager = new SearchHistoryManager(context);
    
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
            if (DEBUG_MODE) console.log('Bookmark navigation in progress: onDidChangeSelection ignored');
            return;
        }

        if (e.selection.length > 0) {
            const item = e.selection[0];
            
            if ((item.itemType === 'server' || item.itemType === 'message') && item.command) {
                await vscode.commands.executeCommand(
                    item.command.command,
                    ...(item.command.arguments || [])
                );
            }
        }
    });
    
    context.subscriptions.push(sftpTreeView);

    // Listen for configuration changes
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
        // Check if language setting changed
        if (event.affectsConfiguration('ctlimSftp.language')) {
            const config = vscode.workspace.getConfiguration('ctlimSftp');
            const language = config.get<string>('language', 'auto');
            
            if (language === 'auto') {
                // Auto-detect based on VS Code language
                const vscodeLanguage = vscode.env.language;
                i18n.setLanguage(vscodeLanguage.startsWith('ko') ? 'ko' : 'en');
            } else {
                i18n.setLanguage(language as 'ko' | 'en');
            }
            
            if (DEBUG_MODE) console.log(`Language changed to: ${i18n.getLanguage()}`);
        }
        
        // Check if showServerInfo setting changed
        if (event.affectsConfiguration('ctlimSftp.showServerInfo')) {
            // Refresh tree view to apply changes
            treeProvider.refresh();
            if (DEBUG_MODE) console.log('Server info visibility setting changed, refreshing tree...');
        }
    });
    
    context.subscriptions.push(configChangeListener);

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
                if (result === i18n.t('input.config')) {
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
                    i18n.t('action.connect')
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


            // Get workspace folderpace.workspaceFolders?.[0];
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
                    i18n.t('action.reconnect')
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
                    // SFTP 파일 다운로드
                    await connection.client.client.get(remotePath, localPath);
                    // 메타데이터 저장
                    await connection.client.saveRemoteFileMetadata(
                        remotePath,
                        localPath,
                        config,
                        config.workspaceRoot
                    );
                } else {
                    // FTP protocol - use abstracted method
                    await connection.client.downloadFile(remotePath, localPath, config);
                    // 메타데이터 저장 (FTP도 메타데이터 필요)
                    await connection.client.saveRemoteFileMetadata(remotePath, localPath, config);
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
                            if (DEBUG_MODE) console.log(`연결된 서버 없음: ${serverName}`);
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
                i18n.t('action.delete')
            );
            
            if (confirm !== i18n.t('action.delete')) {
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
                vscode.window.showErrorMessage(i18n.t('error.noActiveEditor'));
                return;
            }

            const document = editor.document;
            if (document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage(i18n.t('error.notFileScheme'));
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
                    i18n.t('error.configNotFoundSimple'),
                    i18n.t('config.createOption'),
                );
                if (result === i18n.t('config.createOption')) {
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
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect'),
//                    '취소'
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                    
                    vscode.window.showInformationMessage(i18n.t('server.connected', { serverName }));
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
                    return;
                }
            }

            // Calculate default remote path
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
                return;
            }

            const workspaceRoot = config.workspaceRoot || workspaceFolder.uri.fsPath;
            const relativePath = path.relative(workspaceRoot, localPath).replace(/\\/g, '/');
            const defaultRemotePath = path.posix.join(config.remotePath, relativePath);

            // Ask user for remote path directly
            let remotePath: string | undefined;

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
     * 서버 파일과 비교 (Diff with Remote) Command
     */
    const diffWithRemoteCommand = vscode.commands.registerCommand('ctlimSftp.diffWithRemote', async (uri?: vscode.Uri) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.diffWithRemote');
        
        try {
            // 1. 대상 파일 식별
            let localPath: string;
            if (uri && uri.fsPath) {
                localPath = uri.fsPath;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage(i18n.t('error.noActiveEditor'));
                    return;
                }
                localPath = editor.document.uri.fsPath;
            }
            
            // 2. 설정 및 원격 경로 찾기
            // 캐시 확인
            let document: vscode.TextDocument | undefined;
            try {
                document = await vscode.workspace.openTextDocument(localPath);
            } catch (e) {
                // 문서를 열 수 없는 경우 (이미지 등), 메타데이터만으로 진행 시도
            }

            let config: SftpConfig | null = null;
            let remotePath: string | null = null;
            
            if (document) {
                const cached = documentConfigCache.get(document);
                if (cached) {
                    config = cached.config;
                    remotePath = cached.remotePath;
                }
            }
            
            // 캐시에 없으면 메타데이터에서 찾기
            if (!config) {
                const found = await findConfigByMetadata(localPath);
                if (found) {
                    config = found;
                    // 메타데이터 파일 읽어서 remotePath 확인
                    const metadataPath = SftpClient.getMetadataPath(localPath, config);
                    if (fs.existsSync(metadataPath)) {
                        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                        remotePath = metadata.remotePath;
                    }
                }
            }
            
            // 그래도 없으면 Config에서 경로 매칭 시도
            if (!config) {
                config = await findConfigForFile(localPath);
                if (config) {
                    // 원격 경로 계산
                    const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (workspaceRoot) {
                        const relativePath = path.relative(workspaceRoot, localPath).replace(/\\/g, '/');
                        remotePath = path.posix.join(config.remotePath, relativePath);
                    }
                }
            }
            
            if (!config || !remotePath) {
                vscode.window.showErrorMessage(i18n.t('error.configNotFoundSimple'));
                return;
            }
            
            // 3. 서버 연결
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                // 연결 시도
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: i18n.t('progress.connecting')
                }, async () => {
                    try {
                        const client = createClient(config!);
                        await client.connect(config!);
                        treeProvider.addConnectedServer(serverName, client, config!);
                        connection = treeProvider.getConnectedServer(serverName);
                    } catch (error) {
                         // Error handled below
                         throw error;
                    }
                });
            }
            
            if (!connection) {
                vscode.window.showErrorMessage(i18n.t('error.serverConnectionFailed'));
                return;
            }
            
            // 4. 비교 실행 (임시 파일 다운로드 -> Diff)
            // showDiff 함수 재사용 (하단에 정의됨)
            // 임시 파일 다운로드 진행 표시
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.downloadingForDiff'),
                cancellable: false
            }, async () => {
                // showDiff는 내부에서 sftpClient 전역변수를 사용하는 문제가 있음.. 
                // 안전하게 여기서 직접 구현하거나 showDiff를 수정해야함.
                // 여기서는 직접 구현하여 connection을 확실히 사용
                
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceFolder) return;

                const tempDir = path.join(workspaceFolder, '.vscode', '.sftp-tmp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                const fileName = path.basename(remotePath!);
                const tempRemotePath = path.join(tempDir, `${fileName}.remote`);
                
                try {
                    // Download
                    if (connection!.client instanceof SftpClient) {
                         // @ts-ignore
                        if (connection!.client.client) {
                             // @ts-ignore
                             await connection!.client.client.get(remotePath!, tempRemotePath);
                        }
                    } else {
                        await connection!.client.downloadFile(remotePath!, tempRemotePath, config!);
                    }
                    
                    // Show Diff
                    const localUri = vscode.Uri.file(localPath);
                    const remoteUri = vscode.Uri.file(tempRemotePath);
                    
                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        remoteUri,
                        localUri,
                        `${fileName} (Server) ↔ ${fileName} (Local)`
                    );
                    
                } catch (e) {
                    vscode.window.showErrorMessage(i18n.t('error.diffFailed', { error: String(e) }));
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.unknownError', { error: String(error) }));
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
                    vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
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
                    vscode.window.showErrorMessage(i18n.t('error.configNotFoundSimple'));
                    return;
                }
                
                // 원격 경로 계산
                const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    vscode.window.showErrorMessage(i18n.t('error.workspaceRootNotFound'));
                    return;
                }
                
                const relativePath = path.relative(workspaceRoot, syncFolder).replace(/\\/g, '/');
                remotePath = path.posix.join(config.remotePath, relativePath);
            }
            // 커맨드 팔레트에서 호출된 경우
            else {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
                    return;
                }
                syncFolder = workspaceFolder.uri.fsPath;
                
                config = await loadConfigWithSelection();
                if (!config) {
                    vscode.window.showErrorMessage(i18n.t('error.configNotFoundSimple'));
                    return;
                }
                
                remotePath = config.remotePath;
            }

            // config가 null이 아닌지 최종 확인
            if (!config) {
                vscode.window.showErrorMessage(i18n.t('error.sftpConfigNotFound'));
                return;
            }

            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect'),
//                    '취소'
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
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
            const directionLabel = direction === 'local-to-remote' ? i18n.t('sync.directionLocalToRemote') :
                                   direction === 'remote-to-local' ? i18n.t('sync.directionRemoteToLocal') :
                                   i18n.t('sync.bidirectional');

            // 확인 대화상자
            const confirmMessage = `${i18n.t('sync.settings')}` +
                `${i18n.t('sync.label.local')} ${syncFolder}\n` +
                `${i18n.t('sync.label.remote')} ${remotePath}\n` +
                `${i18n.t('sync.label.direction')} ${directionLabel}\n` +
                `${i18n.t('sync.deleteChoice', { value: deleteChoice.value ? i18n.t('action.yes') : i18n.t('action.no') })}\n\n` +
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
                            progress.report({ message: i18n.t('progress.processingFile', { fileName }) });
                        }
                    }
                );

                const summary = [
                    i18n.t('success.syncComplete'),
                    ``,
                    i18n.t('success.syncStats', { uploaded: result.uploaded.toString(), downloaded: result.downloaded.toString(), deleted: result.deleted.toString() }),
                    result.failed.length > 0 ? i18n.t('sync.failedCount', { count: result.failed.length }) : ''
                ].filter(line => line).join('\n');

                if (result.failed.length > 0) {
                    const viewDetails = await vscode.window.showWarningMessage(
                        summary,
                        i18n.t('action.viewFailedList')
                    );
                    
                    if (viewDetails) {
                        const failedList = result.failed.join('\n');
                        vscode.window.showInformationMessage(
                            i18n.t('sync.failedFileList', { list: failedList }),
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
                vscode.window.showErrorMessage(i18n.t('error.serverInfoNotFound'));
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
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect'),
//                    i18n.t('action.cancel')
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
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
                vscode.window.showErrorMessage(i18n.t('error.serverInfoNotFound'));
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
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect'),
//                    i18n.t('action.cancel')
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
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
                vscode.window.showErrorMessage(i18n.t('error.fileInfoNotFound'));
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
            );
            
            if (confirm !== i18n.t('action.delete')) {
                return;
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect'),
                    i18n.t('action.cancel')
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
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
     * 사용자 정의 원격 명령 실행 Command
     */
    const executeCustomCommand = vscode.commands.registerCommand('ctlimSftp.executeCustomCommand', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.executeCustomCommand');
        
        try {
            let config: SftpConfig | undefined;
            let serverName = '';

            // 1. TreeView에서 호출된 경우 (Server item)
            if (item && item.itemType === 'server' && item.serverItem) {
                // serverItem에서 서버 이름 가져오기
                serverName = item.serverItem.name;
                
                // treeProvider에서 연결된 서버의 config 가져오기
                const connection = treeProvider.getConnectedServer(serverName);
                if (connection) {
                    config = connection.config;
                } else {
                    // 연결되지 않은 서버면 config 파일에서 로드
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (workspaceFolder && item.serverItem.configPath) {
                        try {
                            const configContent = fs.readFileSync(item.serverItem.configPath, 'utf-8');
                            const configData = JSON.parse(configContent);
                            const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
                            config = configs.find(c => {
                                const name = c.name || `${c.username}@${c.host}`;
                                return name === serverName;
                            });
                            
                            if (config) {
                                const contextPath = config.context || './';
                                const workspaceRoot = path.isAbsolute(contextPath) 
                                    ? contextPath 
                                    : path.join(workspaceFolder.uri.fsPath, contextPath);
                                config.workspaceRoot = workspaceRoot;
                            }
                        } catch (error) {
                            if (DEBUG_MODE) console.error('Failed to load config from file:', error);
                        }
                    }
                }
            } 
            // 2. item.config가 있는 경우 (직접 config 전달)
            else if (item && item.config) {
                config = item.config;
                serverName = config!.name || `${config!.username}@${config!.host}`;
            } 
            // 3. Command Palette에서 호출된 경우
            else if (!item) {
                const connectedServers = treeProvider.getConnectedServerNames();
                
                if (connectedServers.length === 0) {
                    vscode.window.showErrorMessage(i18n.t('error.connectedServersNotFound'));
                    return;
                }
                
                let selected: string | undefined;
                if (connectedServers.length === 1) {
                    selected = connectedServers[0];
                } else {
                    selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: i18n.t('prompt.selectServerToExecuteCommand')
                    });
                }
                
                if (!selected) {
                    return;
                }
                serverName = selected;
                const connection = treeProvider.getConnectedServer(serverName);
                if (connection) {
                    config = connection.config;
                } else {
                    vscode.window.showErrorMessage(i18n.t('error.serverConfigNotFound', { serverName }));
                    return;
                }
            }

            if (!config) {
                vscode.window.showErrorMessage(i18n.t('error.serverConfigNotFound', { serverName }));
                return;
            }


            // 명령어 목록 및 직접 입력 옵션 구성
            interface CommandQuickPickItem extends vscode.QuickPickItem {
                commandType: 'defined' | 'custom';
                cmd?: { name: string; command: string };
            }

            const commandItems: CommandQuickPickItem[] = [];

            // 1. 직접 입력 옵션 추가
            commandItems.push({
                label: i18n.t('input.directCommandInput'),
                description: 'Execute arbitrary command',
                commandType: 'custom'
            });

            // 2. 정의된 명령어 추가
            if (config.commands && config.commands.length > 0) {
                commandItems.push({
                    label: 'Defined Commands',
                    kind: vscode.QuickPickItemKind.Separator,
                    commandType: 'defined'
                });

                config.commands.forEach(cmd => {
                    commandItems.push({
                        label: `$(terminal) ${cmd.name}`,
                        description: cmd.command,
                        commandType: 'defined',
                        cmd: cmd
                    });
                });
            }

            // 명령어 선택 UI 표시
            const selectedItem = await vscode.window.showQuickPick(commandItems, {
                placeHolder: i18n.t('prompt.selectCommandToExecute')
            });

            if (!selectedItem) {
                return;
            }

            let commandToExecute = '';
            let commandName = '';

            if (selectedItem.commandType === 'custom') {
                // 직접 입력
                const inputCommand = await showInputBoxWithHistory(
                    searchHistoryManager,
                    'executeCustomCommandHistory',
                    i18n.t('prompt.enterRemoteCommand'),
                    i18n.t('placeholder.remoteCommand')
                );

                if (!inputCommand) {
                    return;
                }
                commandToExecute = inputCommand;
                commandName = 'Custom Command';
            } else {
                // 정의된 명령어
                commandToExecute = selectedItem.cmd!.command;
                commandName = selectedItem.cmd!.name;
            }

            // 변수 치환 (${file}, ${fileDir}, ${fileName})
            // 현재 컨텍스트(선택된 파일/폴더) 정보 확인
            let targetPath = '';
            let isDirectory = false;

            if (item && (item.remotePath)) {
                targetPath = item.remotePath;
                isDirectory = item.isDirectory;
            }

            // targetPath가 없으면(서버 아이템 등) 루트 경로 사용 또는 빈 값
            if (!targetPath && config.remotePath) {
                targetPath = config.remotePath;
                isDirectory = true;
            }

            if (targetPath) {
                // ${file}: 전체 경로
                commandToExecute = commandToExecute.replace(/\$\{file\}/g, targetPath);
                
                // ${fileDir}: 디렉토리 경로 (파일인 경우 dir, 폴더인 경우 자신)
                const dirPath = isDirectory ? targetPath : path.posix.dirname(targetPath);
                commandToExecute = commandToExecute.replace(/\$\{fileDir\}/g, dirPath);
                
                // ${fileName}: 파일 이름
                const name = path.posix.basename(targetPath);
                commandToExecute = commandToExecute.replace(/\$\{fileName\}/g, name);
            }

            // ${input:variable} 처리
            // 예: echo "${input:Message}"
            const inputRegex = /\$\{input:([^}]+)\}/g;
            let match;
            while ((match = inputRegex.exec(commandToExecute)) !== null) {
                const prompt = match[1];
                const userInput = await vscode.window.showInputBox({
                    prompt: prompt,
                    placeHolder: `Value for ${prompt}`
                });
                
                if (userInput === undefined) {
                    return; // 취소
                }
                
                // replaceAll과 유사하게 동작하도록 모든 발생 변경
                commandToExecute = commandToExecute.split(match[0]).join(userInput);
            }

            // 터미널에서 실행할지 여부 확인 (옵션 제공)
            const executeInTerminal = await vscode.window.showQuickPick(
                [
                    { label: i18n.t('option.outputChannel'), description: i18n.t('description.outputChannel'), value: false },
                    { label: i18n.t('option.terminal'), description: i18n.t('description.terminal'), value: true }
                ],
                { placeHolder: i18n.t('prompt.selectExecutionMethod') }
            );

            if (!executeInTerminal) {
                return; // 취소
            }

            // 서버 연결 확인
            let connection = treeProvider.getConnectedServer(serverName);
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('warning.serverNotConnected'),
                    i18n.t('action.connect')
                );
                
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                } catch (error) {
                    vscode.window.showErrorMessage(i18n.t('error.connectionFailed', { error: String(error) }));
                    return;
                }
            }

            if (!connection) {
                return;
            }

            if (executeInTerminal.value) {
                // 터미널에서 실행
                const terminalName = `SFTP: ${serverName}`;
                let terminal = vscode.window.terminals.find(t => t.name === terminalName);
                
                if (!terminal) {
                    terminal = vscode.window.createTerminal(terminalName);
                    
                    // SSH 접속 명령 실행
                    let sshCommand = '';
                    if (config.privateKey) {
                        sshCommand = `ssh -i "${config.privateKey}" -p ${config.port || 22} ${config.username}@${config.host}`;
                    } else {
                        sshCommand = `ssh -p ${config.port || 22} ${config.username}@${config.host}`;
                    }
                    terminal.sendText(sshCommand);
                    
                    // 접속 대기 (간단한 지연) - 실제로는 프롬프트 대기가 필요하지만 단순화
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
                terminal.show();
                terminal.sendText(commandToExecute);
                
            } else {
                // 기존 방식: Output Channel에서 실행
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: i18n.t('progress.executingCommand', { command: commandName }),
                    cancellable: false
                }, async (progress) => {
                    try {
                        const result = await connection!.client.executeCommand(commandToExecute);
                        
                        // 결과 표시
                        const outputChannel = vscode.window.createOutputChannel(`SFTP Command: ${commandName}`);
                        outputChannel.clear();
                        outputChannel.appendLine(`Command: ${commandToExecute}`);
                        outputChannel.appendLine('-'.repeat(50));
                        outputChannel.appendLine(result);
                        outputChannel.show();
                        
                        vscode.window.showInformationMessage(i18n.t('success.commandExecuted', { command: commandName }));
                    } catch (error) {
                        vscode.window.showErrorMessage(i18n.t('error.commandExecutionFailed', { error: String(error) }));
                    }
                });
            }

        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.unknownError', { error: String(error) }));
            if (DEBUG_MODE) console.error('executeCustomCommand error:', error);
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
                vscode.window.showErrorMessage(i18n.t('error.onlyFilesAllowed'));
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
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect')
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                    
                    vscode.window.showInformationMessage(i18n.t('info.serverConnected', { serverName }));
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
                    return;
                }
            }
            
            // 파일명 입력 받기
            const remoteDir = path.posix.dirname(sourceRemotePath);
            const fileExt = path.extname(fileName);
            const baseName = path.basename(fileName, fileExt);
            const defaultFileName = `${baseName}.copy${fileExt}`;
            
            const newFileName = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.copyFileName'),
                value: defaultFileName,
                placeHolder: 'file.copy.php',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('error.fileNameRequired');
                    }
                    if (value === fileName) {
                        return i18n.t('error.diffFileNameRequired');
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return i18n.t('error.fileNameInvalidChars');
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
                title: i18n.t('progress.copyingFile', { fileName: path.basename(targetRemotePath) }),
                cancellable: false
            }, async (progress) => {
                progress.report({ message: i18n.t('progress.downloadingOriginal') });
                
                // 임시 파일 경로
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
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
                            
                            progress.report({ message: i18n.t('progress.uploadingToNewLocation') });
                            
                            // 업로드
                            await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                            
                            vscode.window.showInformationMessage(i18n.t('success.copyComplete', { fileName: path.basename(targetRemotePath) }));
                            
                            // TreeView 새로고침
                            treeProvider.refresh();
                        }
                    } else {
                        // FTP protocol
                        await connection!.client.downloadFile(sourceRemotePath, tempFile, config);
                        
                        progress.report({ message: i18n.t('progress.uploadingToNewLocation') });
                        
                        // 업로드
                        await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                        
                        vscode.window.showInformationMessage(i18n.t('success.copyComplete', { fileName: path.basename(targetRemotePath) }));
                        
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
            vscode.window.showErrorMessage(i18n.t('error.copyFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.onlyFilesForRename'));
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
                    i18n.t('error.serverConnectionAttempt'),
                    i18n.t('action.connect')
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                    
                    vscode.window.showInformationMessage(i18n.t('info.serverConnected', { serverName }));
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('server.connectionFailed', { error: String(connectError) }));
                    return;
                }
            }
            
            // 새 파일명 입력 받기
            const remoteDir = path.posix.dirname(sourceRemotePath);
            
            const newFileName = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.renameFileName'),
                value: fileName,
                placeHolder: 'newfile.php',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('error.fileNameRequired');
                    }
                    if (value === fileName) {
                        return i18n.t('error.diffFileNameRequired');
                    }
                    if (value.includes('/') || value.includes('\\')) {
                        return i18n.t('error.fileNameInvalidChars');
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
                i18n.t('confirm.renameFile', { oldName: fileName, newName: newFileName }),
                { modal: true },
                i18n.t('action.rename')
            );
            
            if (confirm !== i18n.t('action.rename')) {
                return;
            }

            // 임시 파일로 다운로드 후 새 이름으로 업로드, 원본 삭제
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.renamingFile', { fileName: newFileName }),
                cancellable: false
            }, async (progress) => {
                progress.report({ message: i18n.t('progress.downloadingOriginal') });
                
                // 임시 파일 경로
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
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
                            
                            progress.report({ message: i18n.t('progress.uploadingToNewName') });
                            
                            // 새 이름으로 업로드
                            await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                            
                            progress.report({ message: i18n.t('progress.deletingOriginal') });
                            
                            // 원본 삭제
                            await connection!.client.deleteRemoteFile(sourceRemotePath, false);
                            
                            vscode.window.showInformationMessage(i18n.t('success.renameComplete', { fileName: newFileName }));
                            
                            // TreeView 새로고침
                            treeProvider.refresh();
                        }
                    } else {
                        // FTP protocol
                        await connection!.client.downloadFile(sourceRemotePath, tempFile, config);
                        
                        progress.report({ message: i18n.t('progress.uploadingToNewName') });
                        
                        // 새 이름으로 업로드
                        await connection!.client.uploadFile(tempFile, targetRemotePath, config);
                        
                        progress.report({ message: i18n.t('progress.deletingOriginal') });
                        
                        // 원본 삭제
                        await connection!.client.deleteRemoteFile(sourceRemotePath, false);
                        
                        vscode.window.showInformationMessage(i18n.t('success.renameComplete', { fileName: newFileName }));
                        
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
            vscode.window.showErrorMessage(i18n.t('error.renameFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('renameRemoteFile error:', error);
        }
    });

    /**
     * 원격 파일 실시간 감시 Command (tail -f)
     */
    const watchLogCommand = vscode.commands.registerCommand('ctlimSftp.watchLog', async (item?: any) => {
        if (DEBUG_MODE) console.log('> ctlimSftp.watchLog');
        
        try {
            // TreeView item에서 정보 가져오기
            if (!item || !item.config || !item.remotePath || item.isDirectory) {
                vscode.window.showErrorMessage(i18n.t('error.onlyFilesAllowed'));
                return;
            }
            
            const config = item.config;
            const remotePath = item.remotePath;
            const fileName = path.basename(remotePath);
            const serverName = config.name || `${config.username}@${config.host}`;
            
            // 서버 연결 확인
            let connection = treeProvider.getConnectedServer(serverName);
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('warning.serverNotConnected'),
                    i18n.t('action.connect')
                );
                
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                } catch (error) {
                    vscode.window.showErrorMessage(i18n.t('error.connectionFailed', { error: String(error) }));
                    return;
                }
            }
            
            if (!connection) return;
            
            // FTP는 지원하지 않음
            if (!(connection.client instanceof SftpClient)) {
                vscode.window.showErrorMessage('FTP does not support log watching. Only available for SFTP/SSH.');
                return;
            }
            
            // 고유 식별자 생성 (serverName + remotePath)
            const watcherKey = `${serverName}:${remotePath}`;
            
            // 이미 감시 중인지 확인
            if (watcherManager && watcherManager.hasActiveWatch(watcherKey)) {
                const replace = await vscode.window.showWarningMessage(
                    i18n.t('warning.alreadyWatching', { fileName }),
                    i18n.t('action.stopAndRestart'),
                    i18n.t('action.cancel')
                );
                
                if (replace !== i18n.t('action.stopAndRestart')) {
                    return;
                }
                
                // 기존 감시 중지
                watcherManager.stopWatch(watcherKey);
            }
            
            // Output Channel 생성
            const channelName = `Log: ${fileName} (${serverName})`;
            const outputChannel = vscode.window.createOutputChannel(channelName);
            outputChannel.show();
            outputChannel.appendLine(`Starting watch on ${remotePath}...`);
            outputChannel.appendLine('-'.repeat(50));
            
            try {
                const watcher = await connection.client.watchRemoteFile(remotePath, (data) => {
                    outputChannel.append(data);
                });
                
                // WatcherManager에 등록
                if (watcherManager) {
                    watcherManager.startWatch(watcherKey, remotePath, serverName, watcher, outputChannel);
                }
                
                // 감시 중지 버튼 제공 (알림 메시지로)
                const stopAction = await vscode.window.showInformationMessage(
                    i18n.t('info.watchingLog', { fileName }), 
                    i18n.t('action.stop')
                );
                
                if (stopAction === i18n.t('action.stop')) {
                    // WatcherManager를 통해 중지
                    if (watcherManager) {
                        watcherManager.stopWatch(watcherKey);
                    } else {
                        // Fallback: 직접 중지
                        watcher.stop();
                        outputChannel.appendLine('\n' + '-'.repeat(50));
                        outputChannel.appendLine('Log watch stopped by user.');
                    }
                }
                
            } catch (error) {
                outputChannel.appendLine(`Error: ${error}`);
                vscode.window.showErrorMessage(`Failed to watch log: ${error}`);
            }

        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.unknownError', { error: String(error) }));
            if (DEBUG_MODE) console.error('watchLog error:', error);
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
                    vscode.window.showErrorMessage(i18n.t('error.connectedServersNotFound'));
                    return;
                }
                
                let serverName: string;
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: i18n.t('prompt.selectServerToSearch')
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                    return;
                }
                
                config = connection.config;
                remotePath = config.remotePath;
            }
            
            // 검색 패턴 입력
            const searchPattern = await showInputBoxWithHistory(
                searchHistoryManager,
                'searchRemoteFilesHistory',
                i18n.t('prompt.enterSearchPattern'),
                i18n.t('placeholder.searchPattern')
            );
            
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
                vscode.window.showErrorMessage(i18n.t('error.serverNotConnected'));
                return;
            }
            
            // 검색 실행
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.searchingRemoteFiles'),
                cancellable: false
            }, async (progress) => {
                progress.report({ message: i18n.t('progress.searching', { pattern }) });
                
                const results = await connection!.client.searchRemoteFilesByName(
                    remotePath,
                    pattern,
                    isRegex,
                    100
                );
                
                if (results.length === 0) {
                    vscode.window.showInformationMessage(i18n.t('info.noSearchResults', { pattern: searchPattern }));
                    return;
                }
                
                // 결과를 QuickPick으로 표시
                interface FileQuickPickItem extends vscode.QuickPickItem {
                    file: RemoteFile;
                }
                
                const items: FileQuickPickItem[] = results.map(file => ({
                    label: `$(file) ${file.name}`,
                    description: file.path,
                    detail: i18n.t('detail.fileInfo', { size: formatFileSize(file.size || 0), time: file.modifyTime ? formatDateTime(file.modifyTime) : 'N/A' }),
                    file: file
                }));
                
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: i18n.t('prompt.selectFileToOpen', { count: results.length }),
                    matchOnDescription: true,
                    matchOnDetail: true
                });
                
                if (selected) {
                    // 선택한 파일 열기
                    await vscode.commands.executeCommand('ctlimSftp.openRemoteFile', selected.file.path, config);
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.searchFailed', { error: String(error) }));
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
                    vscode.window.showErrorMessage(i18n.t('error.connectedServersNotFound'));
                    return;
                }
                
                let serverName: string;
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: i18n.t('prompt.selectServerToSearch')
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                    return;
                }
                
                config = connection.config;
                remotePath = config.remotePath;
            }
            
            // 검색 텍스트 입력
            const searchText = await showInputBoxWithHistory(
                searchHistoryManager,
                'searchInRemoteFilesHistory',
                i18n.t('prompt.enterSearchText'),
                i18n.t('placeholder.searchText')
            );
            
            if (!searchText) {
                return;
            }
            
            // 파일 패턴 입력
            const filePattern = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.enterFilePattern'),
                value: '*',
                placeHolder: i18n.t('placeholder.filePattern')
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
                vscode.window.showErrorMessage(i18n.t('error.serverNotConnected'));
                return;
            }
            
            // 검색 실행
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('progress.searchingFileContent'),
                cancellable: false
            }, async (progress) => {
                progress.report({ message: i18n.t('progress.searchingInFile', { pattern, filePattern }) });
                
                const results = await connection!.client.searchInRemoteFiles(
                    remotePath,
                    pattern,
                    isRegex,
                    filePattern,
                    50
                );
                
                if (results.length === 0) {
                    vscode.window.showInformationMessage(i18n.t('info.noSearchResults', { pattern: searchText }));
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
                        detail: i18n.t('detail.matchCount', { count: result.matches.length }),
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
                    placeHolder: i18n.t('prompt.selectFileToOpenFromResults', { count: results.length }),
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
            vscode.window.showErrorMessage(i18n.t('error.contentSearchFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.fileInfoNotFound'));
                return;
            }
            
            // 서버 연결 확인
            const serverName = config.name || `${config.username}@${config.host}`;
            let connection = treeProvider.getConnectedServer(serverName);
            
            if (!connection || !connection.client.isConnected()) {
                const reconnect = await vscode.window.showWarningMessage(
                    i18n.t('warning.serverNotConnected'),
                    i18n.t('action.connect')
                );
                if (reconnect !== i18n.t('action.connect')) {
                    return;
                }
                
                try {
                    const client = createClient(config);
                    await client.connect(config);
                    treeProvider.addConnectedServer(serverName, client, config);
                    connection = treeProvider.getConnectedServer(serverName);
                    
                    if (!connection) {
                        vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                        return;
                    }
                } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionFailed', { error: String(connectError) }));
                    return;
                }
            }
            
            // 현재 권한 조회
            let currentMode = '';
            try {
                currentMode = await connection.client.getFilePermissions(remotePath);
                if (DEBUG_MODE) console.log(`now Permissions: ${currentMode}`);
            } catch (error) {
                if (DEBUG_MODE) console.error('error Permissions:', error);
            }
            
            // 권한 선택 QuickPick
            interface PermissionQuickPickItem extends vscode.QuickPickItem {
                mode: string;
            }
            
            const fileName = path.basename(remotePath);
            const items: PermissionQuickPickItem[] = [
                {
                    label: '$(file-code) 755',
                    description: i18n.t('permission.755.description'),
                    detail: isDirectory ? i18n.t('permission.directory.recommended') : i18n.t('permission.executable.recommended'),
                    mode: '755'
                },
                {
                    label: '$(file) 644',
                    description: i18n.t('permission.644.description'),
                    detail: isDirectory ? '' : i18n.t('permission.file.recommended'),
                    mode: '644'
                },
                {
                    label: '$(lock) 600',
                    description: i18n.t('permission.600.description'),
                    detail: i18n.t('permission.secret.recommended'),
                    mode: '600'
                },
                {
                    label: '$(warning) 777',
                    description: i18n.t('permission.777.description'),
                    detail: i18n.t('permission.777.detail'),
                    mode: '777'
                },
                {
                    label: '$(file-directory) 700',
                    description: i18n.t('permission.700.description'),
                    detail: isDirectory ? i18n.t('permission.privateDirectory.recommended') : '',
                    mode: '700'
                },
                {
                    label: i18n.t('permission.custom.label'),
                    description: i18n.t('permission.custom.description'),
                    mode: 'custom'
                }
            ];
            
            const placeHolder = currentMode 
                ? i18n.t('prompt.changePermissionCurrent', { fileName, currentMode })
                : i18n.t('prompt.setPermission', { fileName });
            
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
                    prompt: i18n.t('prompt.enterPermissionMode'),
                    value: currentMode || '644',
                    placeHolder: i18n.t('placeholder.permissionMode'),
                    validateInput: (value) => {
                        if (!/^[0-7]{3}$/.test(value)) {
                            return i18n.t('validation.invalidPermissionMode');
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
                    i18n.t('warning.permission777', { fileName }),
                    { modal: true },
                    i18n.t('action.change'),
                    i18n.t('action.cancel')
                );
                
                if (confirm !== i18n.t('action.change')) {
                    return;
                }
            }
            
            // 권한 변경 실행
            await connection.client.changeFilePermissions(remotePath, mode);
            
            vscode.window.showInformationMessage(i18n.t('info.permissionChanged', { fileName, mode }));
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.changePermissionFailed', { error: String(error) }));
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
                    vscode.window.showErrorMessage(i18n.t('error.serverConfigNotFound', { serverName }));
                    return;
                }
                
                config = foundConfig;
            } else {
                // Command Palette에서 호출된 경우
                const connectedServers = treeProvider.getConnectedServerNames();
                
                if (connectedServers.length === 0) {
                    vscode.window.showErrorMessage(i18n.t('error.connectedServersNotFound'));
                    return;
                }
                
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: i18n.t('prompt.selectServerForTerminal')
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
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
            
            vscode.window.showInformationMessage(i18n.t('info.sshTerminalStarted', { serverName }));
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.openTerminalFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('openSSHTerminal error:', error);
        }
    });

    /**
     * 전송 히스토리 보기 Command
     */
    const viewTransferHistoryCommand = vscode.commands.registerCommand('ctlimSftp.viewTransferHistory', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.viewTransferHistory');
        
        if (!transferHistoryManager) {
            vscode.window.showErrorMessage(i18n.t('error.transferHistoryNotAvailable'));
            return;
        }
        
        try {
            const histories = transferHistoryManager.loadHistories();
            
            if (histories.length === 0) {
                vscode.window.showInformationMessage(i18n.t('info.noTransferHistory'));
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
                let statusText = i18n.t('status.success');
                if (h.status === 'failed') {
                    icon = '$(error)';
                    statusText = i18n.t('status.failed');
                } else if (h.status === 'cancelled') {
                    icon = '$(circle-slash)';
                    statusText = i18n.t('status.cancelled');
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
                placeHolder: i18n.t('prompt.selectHistoryToRetry', { count: histories.length }),
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (selected && selected.history.status === 'failed') {
                // 실패한 전송 재시도 옵션
                const action = await vscode.window.showWarningMessage(
                    i18n.t('warning.retryFailedTransfer', { fileName: path.basename(selected.history.localPath), error: selected.history.errorMessage || i18n.t('error.unknown') }),
                    { modal: true },
                    i18n.t('action.retry'),
                    i18n.t('action.cancel')
                );
                
                if (action === i18n.t('action.retry')) {
                    await retryFailedTransfer(selected.history);
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.historyLoadFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('viewTransferHistory error:', error);
        }
    });

    /**
     * 전송 통계 보기 Command
     */
    const viewTransferStatisticsCommand = vscode.commands.registerCommand('ctlimSftp.viewTransferStatistics', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.viewTransferStatistics');
        
        if (!transferHistoryManager) {
            vscode.window.showErrorMessage(i18n.t('error.transferStatisticsNotAvailable'));
            return;
        }
        
        try {
            // 서버 선택
            const connectedServers = treeProvider.getConnectedServerNames();
            const allOption = i18n.t('option.allServers');
            const serverOptions = [allOption, ...connectedServers];
            
            const selectedServer = await vscode.window.showQuickPick(serverOptions, {
                placeHolder: i18n.t('prompt.selectServerForStats')
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
                `📊 ${i18n.t('title.transferStatistics')} ${selectedServer !== allOption ? `(${selectedServer})` : ''}`,
                ``,
                `📤 ${i18n.t('stats.uploads')}: ${stats.totalUploads}`,
                `📥 ${i18n.t('stats.downloads')}: ${stats.totalDownloads}`,
                `✅ ${i18n.t('stats.success')}: ${stats.successCount}`,
                `❌ ${i18n.t('stats.failed')}: ${stats.failedCount}`,
                `📈 ${i18n.t('stats.successRate')}: ${successRate}%`,
                `💾 ${i18n.t('stats.totalTransfer')}: ${formatFileSize(stats.totalBytes)}`,
                `⚡ ${i18n.t('stats.averageSpeed')}: ${stats.averageSpeed > 0 ? formatFileSize(stats.averageSpeed) + '/s' : 'N/A'}`
            ].join('\n');
            
            vscode.window.showInformationMessage(message, { modal: true });
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.statsLoadFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('viewTransferStatistics error:', error);
        }
    });

    /**
     * 전송 히스토리 삭제 Command
     */
    const clearTransferHistoryCommand = vscode.commands.registerCommand('ctlimSftp.clearTransferHistory', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.clearTransferHistory');
        
        if (!transferHistoryManager) {
            vscode.window.showErrorMessage(i18n.t('error.transferHistoryNotAvailable'));
            return;
        }
        
        try {
            const confirm = await vscode.window.showWarningMessage(
                i18n.t('warning.clearTransferHistory'),
                { modal: true },
                i18n.t('action.delete'),
                i18n.t('action.cancel')
            );
            
            if (confirm === i18n.t('action.delete')) {
                transferHistoryManager.clearHistory();
                vscode.window.showInformationMessage(i18n.t('info.transferHistoryCleared'));
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.historyClearFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.remotePathNotFound'));
                return;
            }
            
            // 클립보드에 복사
            await vscode.env.clipboard.writeText(item.remotePath);
            vscode.window.showInformationMessage(i18n.t('info.pathCopied', { path: item.remotePath }));
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.pathCopyFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.fileInfoNotFound'));
                return;
            }
            
            // 설정에서 웹 URL 확인
            let webUrl = item.config.webUrl;
            
            if (!webUrl) {
                // 웹 URL이 없으면 입력 요청
                webUrl = await vscode.window.showInputBox({
                    prompt: i18n.t('prompt.enterWebUrl'),
                    placeHolder: 'http://example.com',
                    validateInput: (value) => {
                        if (!value || value.trim() === '') {
                            return i18n.t('validation.urlRequired');
                        }
                        if (!value.startsWith('http://') && !value.startsWith('https://')) {
                            return i18n.t('validation.urlProtocol');
                        }
                        return null;
                    }
                });
                
                if (!webUrl) {
                    return;
                }
                
                // 설정에 저장할지 물어보기
                const save = await vscode.window.showInformationMessage(
                    i18n.t('prompt.saveWebUrl', webUrl),
                    i18n.t('action.save'),
                    i18n.t('action.useOnce')
                );
                
                if (save === i18n.t('action.save')) {
                    // TODO: 설정 파일 업데이트
                    vscode.window.showInformationMessage(i18n.t('info.autoSaveFeatureComingSoon'));
                }
            }
            
            // 원격 경로를 웹 URL로 변환
            const relativePath = item.remotePath.startsWith(item.config.remotePath)
                ? item.remotePath.substring(item.config.remotePath.length)
                : item.remotePath;
            
            const fullUrl = webUrl.replace(/\/$/, '') + relativePath;
            
            // 브라우저에서 열기
            await vscode.env.openExternal(vscode.Uri.parse(fullUrl));
            vscode.window.showInformationMessage(i18n.t('info.openingInBrowser', { url: fullUrl }));
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.browserOpenFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.bookmarkManagerInitFailed'));
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
                vscode.window.showErrorMessage(i18n.t('error.bookmarkInfoNotFound'));
                return;
            }
            
            // 이미 북마크에 있는지 확인
            if (bookmarkManager.hasBookmark(serverName, remotePath)) {
                vscode.window.showWarningMessage(i18n.t('warning.bookmarkExists'));
                return;
            }
            
            // 북마크 이름 입력
            const fileName = path.basename(remotePath);
            const defaultName = `${serverName}-${fileName}`;
            const bookmarkName = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.enterBookmarkName'),
                value: defaultName,
                placeHolder: i18n.t('placeholder.bookmarkName'),
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('validation.nameRequired');
                    }
                    return null;
                }
            });
            
            if (!bookmarkName) {
                return;
            }
            
            // 설명 입력 (선택사항)
            const description = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.bookmarkDescription'),
                placeHolder: i18n.t('placeholder.bookmarkDescription'),
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
            
            vscode.window.showInformationMessage(i18n.t('info.bookmarkAdded', { name: bookmarkName }));
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.bookmarkAddFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.bookmarkManagerInitFailed'));
                return;
            }
            
            const bookmarks = bookmarkManager.getAllBookmarks();
            
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage(i18n.t('info.noBookmarks'));
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
                    ? ` | ${i18n.t('detail.usageCount', { count: b.accessCount })}`
                    : '';
                
                return {
                    label: `⭐ ${b.name}`,
                    description: `${b.serverName} | ${b.remotePath}`,
                    detail: `${typeIcon} ${b.description || i18n.t('detail.noDescription')}${accessInfo}`,
                    bookmark: b
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: i18n.t('prompt.selectBookmarkToOpen', { count: bookmarks.length }),
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (selected) {
                // 북마크 열기
                await openBookmark(selected.bookmark);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.bookmarkLoadFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.bookmarkManagerInitFailed'));
                return;
            }
            
            const bookmarks = bookmarkManager.getAllBookmarks();
            
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage(i18n.t('info.noBookmarksToDelete'));
                return;
            }
            
            interface BookmarkQuickPickItem extends vscode.QuickPickItem {
                bookmark: Bookmark;
            }
            
            const items: BookmarkQuickPickItem[] = bookmarks.map(b => ({
                label: `⭐ ${b.name}`,
                description: `${b.serverName} | ${b.remotePath}`,
                detail: b.description || i18n.t('detail.noDescription'),
                bookmark: b
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: i18n.t('prompt.selectBookmarkToDelete'),
                matchOnDescription: true
            });
            
            if (!selected) {
                return;
            }
            
            // 확인 대화상자
            const confirm = await vscode.window.showWarningMessage(
                i18n.t('warning.deleteBookmark', { name: selected.bookmark.name }),
                { modal: true },
                i18n.t('action.delete')
            );
            
            if (confirm === i18n.t('action.delete')) {
                const success = bookmarkManager.removeBookmark(selected.bookmark.id);
                if (success) {
                    vscode.window.showInformationMessage(i18n.t('info.bookmarkDeleted', { name: selected.bookmark.name }));
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.bookmarkDeleteFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.bookmarkManagerInitFailed'));
                return;
            }
            
            // TreeView에서 호출된 경우
            if (item && item.itemType === 'bookmark' && item.bookmarkData) {
                const bookmark = item.bookmarkData;
                
                // 확인 대화상자
                const confirm = await vscode.window.showWarningMessage(
                    i18n.t('warning.deleteBookmark', { name: bookmark.name }),
                    { modal: true },
                    i18n.t('action.delete')
                );
                
                if (confirm === i18n.t('action.delete')) {
                    const success = bookmarkManager.removeBookmark(bookmark.id);
                    if (success) {
                        vscode.window.showInformationMessage(i18n.t('info.bookmarkDeleted', { name: bookmark.name }));
                        treeProvider.refresh();
                    }
                }
            } else {
                // 다른 경로로 호출된 경우 - QuickPick으로 선택
                await vscode.commands.executeCommand('ctlimSftp.removeBookmark');
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.bookmarkDeleteFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.bookmarkManagerInitFailed'));
                return;
            }
            
            const bookmarks = bookmarkManager.getFrequentBookmarks(10);
            
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage(i18n.t('info.noFrequentBookmarks'));
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
                    detail: `${typeIcon} ${i18n.t('detail.usageCount', { count: b.accessCount })} | ${b.description || ''}`,
                    bookmark: b
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: i18n.t('prompt.selectFrequentBookmark'),
                matchOnDescription: true
            });
            
            if (selected) {
                await openBookmark(selected.bookmark);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.bookmarkLoadFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.templateManagerInitFailed'));
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
                    vscode.window.showErrorMessage(i18n.t('error.connectedServersNotFound'));
                    return;
                }
                
                let serverName: string;
                if (connectedServers.length === 1) {
                    serverName = connectedServers[0];
                } else {
                    const selected = await vscode.window.showQuickPick(connectedServers, {
                        placeHolder: i18n.t('prompt.selectServerToSaveTemplate')
                    });
                    
                    if (!selected) {
                        return;
                    }
                    serverName = selected;
                }
                
                const connection = treeProvider.getConnectedServer(serverName);
                if (!connection) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                    return;
                }
                
                config = connection.config;
            }
            
            if (!config) {
                vscode.window.showErrorMessage(i18n.t('error.serverConfigNotFound'));
                return;
            }
            
            // 템플릿 이름 입력
            const templateName = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.enterTemplateName'),
                value: config.name || `${config.username}@${config.host}`,
                placeHolder: i18n.t('placeholder.templateName'),
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('validation.nameRequired');
                    }
                    return null;
                }
            });
            
            if (!templateName) {
                return;
            }
            
            // 설명 입력 (선택사항)
            const description = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.templateDescription'),
                placeHolder: i18n.t('placeholder.templateDescription')
            });
            
            // 템플릿 저장
            const template = templateManager.addTemplate(templateName, config, description);
            
            vscode.window.showInformationMessage(i18n.t('info.templateSaved', { templateName }));
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.templateSaveFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.templateManagerInitFailed'));
                return;
            }
            
            const templates = templateManager.getAllTemplates();
            
            if (templates.length === 0) {
                vscode.window.showInformationMessage(i18n.t('info.noSavedTemplates'));
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
                        return i18n.t('validation.hostRequired');
                    }
                    return null;
                }
            });
            
            if (!host) {
                return;
            }
            
            const username = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.enterUsername'),
                placeHolder: 'username',
                validateInput: (value) => {
                    if (!value || value.trim() === '') {
                        return i18n.t('validation.usernameRequired');
                    }
                    return null;
                }
            });
            
            if (!username) {
                return;
            }
            
            const password = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.enterPasswordOptional'),
                password: true,
                placeHolder: i18n.t('placeholder.password')
            });
            
            const serverName = await vscode.window.showInputBox({
                prompt: i18n.t('prompt.enterServerNameOptional'),
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
                vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
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
            
            vscode.window.showInformationMessage(i18n.t('info.serverAddedFromTemplate', { serverName: newConfig.name || 'Unknown', templateName: template.name }));
            
            // TreeView 새로고침
            treeProvider.refresh();
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.serverAddFailed', { error: String(error) }));
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
                vscode.window.showErrorMessage(i18n.t('error.templateManagerInitFailed'));
                return;
            }
            
            const templates = templateManager.getAllTemplates();
            
            if (templates.length === 0) {
                vscode.window.showInformationMessage(i18n.t('info.noSavedTemplates'));
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
                    description: i18n.t('label.templateDetails', { port: t.config.port || 22, usage: t.usageCount }),
                    detail: `${t.description || i18n.t('label.noDescription')} | ${i18n.t('label.created', { date: dateStr })}`,
                    template: t
                };
            });
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: i18n.t('prompt.selectTemplateToDelete', { count: templates.length }),
                matchOnDescription: true,
                matchOnDetail: true
            });
            
            if (!selected) {
                return;
            }
            
            const template = selected.template;
            
            // 삭제 확인
            const confirm = await vscode.window.showWarningMessage(
                i18n.t('confirm.deleteTemplate', { name: template.name }),
                { modal: true },
                i18n.t('action.delete')
            );
            
            if (confirm === i18n.t('action.delete')) {
                const success = templateManager.removeTemplate(template.id);
                if (success) {
                    vscode.window.showInformationMessage(i18n.t('info.templateDeleted', { name: template.name }));
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.templateManageFailed', { error: String(error) }));
            if (DEBUG_MODE) console.error('manageTemplates error:', error);
        }
    });


    /**
     * 설정 파일 열기 Command
     */
    const configCommand = vscode.commands.registerCommand('ctlimSftp.config', async () => {

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            const result = await vscode.window.showWarningMessage(
                i18n.t('error.noWorkspaceMsg'),
                { modal: true },
                i18n.t('action.openFolder')
            );
            
            if (result === i18n.t('action.openFolder')) {

                // 폴더 선택 대화상자 표시
                const selectedUri = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    title: i18n.t('prompt.selectWorkspaceFolder'),
                    openLabel: i18n.t('action.selectFolder')
                });
                if(!selectedUri || selectedUri.length === 0) {
                    return; // 사용자가 폴더 선택을 취소함
                }
                // .code-workspace 파일 생성
                const workspacePath = selectedUri[0].fsPath;
                const workspaceName = path.basename(selectedUri[0].fsPath);
                const workspaceFileName = `${workspaceName.replace(/\s+/g, '-')}.code-workspace`;
                const workspaceFilePath = path.join(workspacePath, workspaceFileName);
                
                if(fs.existsSync(workspaceFilePath)){
                    // 이미 .code-workspace 파일이 존재하는 경우
                    vscode.window.showInformationMessage(i18n.t('info.workspaceFileExists'));
                    // 워크스페이스 폴더를 현재 창에 추가
                    vscode.workspace.updateWorkspaceFolders(
                        vscode.workspace.workspaceFolders?.length ?? 0,
                        null,
                        { uri: vscode.Uri.file(workspacePath), name: workspaceName }
                    );
                    return;
                }
                // Workspace 파일 구조
                const workspaceContent = {
                    folders: [
                        {
                            path: ".",
                            name: workspaceName
                        }
                    ],
                    settings: {}
                };
                    
                try {
                    fs.writeFileSync(workspaceFilePath, JSON.stringify(workspaceContent, null, 2));
                        
                    // 워크스페이스 폴더를 현재 창에 추가
                    vscode.workspace.updateWorkspaceFolders(
                        vscode.workspace.workspaceFolders?.length ?? 0,
                        null,
                        { uri: vscode.Uri.file(workspacePath), name: workspaceName }
                    );
                        
                } catch (error) {
                    vscode.window.showErrorMessage(i18n.t('error.failedToAddWorkspaceFolder'));
                    return;
                }                
            }
            return;
        }


        // 편집 방식 선택
        const method = await vscode.window.showQuickPick([
            { label: i18n.t('config.method.gui.label'), description: i18n.t('config.method.gui.description'), type: 'gui' },
            { label: i18n.t('config.method.json.label'), description: i18n.t('config.method.json.description'), type: 'json' }
        ], {
            placeHolder: i18n.t('config.method.placeholder')
        });

        if (!method) {
            return;
        }

        if (method.type === 'gui') {
            ConnectConfigWebview.createOrShow(context.extensionUri);
        } 
        else {
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
                    vscode.window.showErrorMessage(i18n.t('error.sftpConnectionFailed'));
                    return;
                }
            }

            // 리모트 파일정보와 로칼에 있는 파일의 정보를 비교 한다.
            const fSameMetadata = await sftpClient.isSameMetadata(document.uri.fsPath, cachedRemotePath, config);

            // 리모트와 로칼이 다를 때
            if(!fSameMetadata){ 
                const choice = await vscode.window.showWarningMessage(
                    i18n.t('conflict.detect', { fileName: path.basename(document.uri.fsPath) }),
                    { modal: true },
                    i18n.t('conflict.overwrite'),
                    i18n.t('conflict.download'),
                    i18n.t('conflict.compare'),
                );
                
                if (choice === i18n.t('conflict.overwrite')) {
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
                            vscode.window.showInformationMessage(i18n.t('file.overwriteComplete', { fileName: path.basename(document.uri.fsPath) }));
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
                else if (choice === i18n.t('conflict.download')) {
                    // 서버 파일로 로컬 덮어쓰기
                    const confirmed = await vscode.window.showWarningMessage(
                        i18n.t('conflict.lossWarning'),
                        { modal: true },
                        i18n.t('action.confirm'),
                    );
                    
                    if (confirmed === i18n.t('action.confirm')) {
                        await downloadAndReloadFile(cachedRemotePath, document.uri.fsPath, config, document, false);
                        vscode.window.showInformationMessage(i18n.t('file.downloadSuccess', { fileName: path.basename(document.uri.fsPath) }));
                    }
                }
                else if (choice === i18n.t('conflict.compare')) {
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
                            
                            vscode.window.showInformationMessage(i18n.t('info.uploadSuccessAfterReconnect', { fileName: path.basename(document.uri.fsPath) }));
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
                vscode.window.showErrorMessage(i18n.t('error.reconnectFailed', { path: document.uri.fsPath, error: String(retryError) }));
            }

        }
    });


    /**
     * SSH Private Key 선택 Command
     */
    const selectPrivateKeyCommand = vscode.commands.registerCommand('ctlimSftp.selectPrivateKey', async () => {
        if (DEBUG_MODE) console.log('> ctlimSftp.selectPrivateKey');

        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: i18n.t('prompt.selectPrivateKeyFile'),
                filters: { // 옵션: 키 파일 필터
                    'SSH Keys': ['pem', 'key', 'ppk', 'cer'],
                    'All Files': ['*']
                }
            });

            if (uris && uris.length > 0) {
                const keyPath = uris[0].fsPath.replace(/\\/g, '/');
                
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit(editBuilder => {
                        if (editor.selection.isEmpty) {
                            editBuilder.insert(editor.selection.active, keyPath);
                        } else {
                            editBuilder.replace(editor.selection, keyPath);
                        }
                    });
                } else {
                    await vscode.env.clipboard.writeText(keyPath);
                    vscode.window.showInformationMessage(i18n.t('info.keyPathCopied'));
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.unknownError', { error: String(error) }));
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
        diffWithRemoteCommand,
        syncUploadCommand,
        syncDownloadCommand,
        syncBothCommand,
        newFileCommand,
        newFolderCommand,
        deleteRemoteFileCommand,
        executeCustomCommand,
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
        selectPrivateKeyCommand,
        watchLogCommand,
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
            vscode.window.showErrorMessage(i18n.t('error.serverConfigNotFoundWithName', { name: history.serverName }));
            return;
        }
        
        // 서버 연결 확인
        let connection = treeProvider.getConnectedServer(history.serverName);
        if (!connection || !connection.client.isConnected()) {
            const reconnect = await vscode.window.showWarningMessage(
                i18n.t('confirm.connectToServer'),
                i18n.t('action.connect')
            );
            if (reconnect !== i18n.t('action.connect')) {
                return;
            }
            
            try {
                const client = createClient(config);
                await client.connect(config);
                treeProvider.addConnectedServer(history.serverName, client, config);
                connection = treeProvider.getConnectedServer(history.serverName);
                
                if (!connection) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionInfoNotFound'));
                    return;
                }
            } catch (connectError) {
                    vscode.window.showErrorMessage(i18n.t('error.serverConnectionFailed', { error: String(connectError) }));
                    return;
            }
        }
        
        const startTime = Date.now();
        
        try {
            if (history.type === 'upload') {
                // 재업로드
                if (!fs.existsSync(history.localPath)) {
                    vscode.window.showErrorMessage(i18n.t('error.localFileNotFound', { path: history.localPath }));
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
                    vscode.window.showInformationMessage(i18n.t('info.reuploadSuccess', { fileName: path.basename(history.localPath) }));
                }
            } else if (history.type === 'download') {
                // 재다운로드
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(i18n.t('error.workspaceNotFound'));
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
                        vscode.window.showInformationMessage(i18n.t('info.redownloadSuccess', { fileName: path.basename(history.localPath) }));
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
                    vscode.window.showInformationMessage(i18n.t('info.redownloadSuccess', { fileName: path.basename(history.localPath) }));
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
            vscode.window.showErrorMessage(i18n.t('error.retryFailed', { error: String(retryError) }));
        }
        
    } catch (error) {
        if (DEBUG_MODE) console.error('retryFailedTransfer error:', error);
        vscode.window.showErrorMessage(i18n.t('error.retryFailed', { error: String(error) }));
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
        vscode.window.showErrorMessage(i18n.t('error.noWorkspace'));
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        const result = await vscode.window.showErrorMessage(
            i18n.t('confirm.createConfigFile'),
            i18n.t('action.create'),
        );
        if (result === i18n.t('action.create')) {
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
        vscode.window.showErrorMessage(i18n.t('error.configLoadFailed', { error: String(error) }));
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
        vscode.window.showErrorMessage(i18n.t('error.noWorkspace'));
        return null;
    }

    const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
    if (!fs.existsSync(configPath)) {
        const result = await vscode.window.showErrorMessage(
            i18n.t('confirm.createConfigFile'),
            i18n.t('action.create'),
        );
        if (result === i18n.t('action.create')) {
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
            vscode.window.showErrorMessage(i18n.t('error.noServerInConfig'));
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
                placeHolder: i18n.t('prompt.selectServerToConnect')
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
        vscode.window.showErrorMessage(i18n.t('error.configLoadFailed', { error: String(error) }));
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
        
        if (DEBUG_MODE) console.log(`Connected disconnected detected, attempting reconnect: ${serverName}`);
        await client.connect(config);

        // treeProvider에 없을 때만 추가 (기존 연결은 보존)
        const existingConnection = treeProvider.getConnectedServer(serverName);
        if (!existingConnection) {
            treeProvider.addConnectedServer(serverName, client, config);
        }
        if (DEBUG_MODE) console.log(`Reconnection successful: ${serverName}`);
        return true;
    } catch (error) {
        if (DEBUG_MODE) console.error(`Reconnection failed (ensureConnected): ${serverName}`, error);
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
        
        if (DEBUG_MODE) console.error(`Download failed: ${localPath}`, error);
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
                    description: i18n.t('label.goUp'),
                    path: path.posix.dirname(currentPath),
                    isDirectory: true,
                    isSpecial: true
                });
            }
            
            // 현재 위치에 저장 옵션
            items.push({
                label: `$(file) ${fileName}`,
                description: i18n.t('label.saveHere'),
                path: path.posix.join(currentPath, fileName),
                isDirectory: false,
                isSpecial: true
            });
            
            // 디렉토리 먼저
            const directories = files.filter(f => f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
            for (const dir of directories) {
                items.push({
                    label: `$(folder) ${dir.name}`,
                    description: i18n.t('label.directory'),
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
                placeHolder: i18n.t('prompt.selectSaveLocation', { path: currentPath }),
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
                i18n.t('confirm.saveAs', { dir: dir, fileName: fileName }),
                i18n.t('action.save'),
            );
            
            if (confirm === i18n.t('action.save')) {
                return newPath;
            }
            // 취소 시 계속 탐색
            
        } catch (error) {
            vscode.window.showErrorMessage(i18n.t('error.remoteDirExploreFailed', { error: String(error) }));
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
            vscode.window.showErrorMessage(i18n.t('error.notConnected'));
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
            i18n.t('prompt.diffAction', { fileName }),
            { modal: false },
            i18n.t('action.keepLocal'),
            i18n.t('action.useRemote'),
            i18n.t('action.manualMerge'),
            i18n.t('action.cancel')
        );

        if (action === i18n.t('action.keepLocal')) {
            // 로컬 파일로 서버 덮어쓰기
            if (connection.client) {
                await connection.client.uploadFile(localPath, remotePath, config);
                vscode.window.showInformationMessage(i18n.t('info.uploadSuccess', { fileName }));
            }
        } else if (action === i18n.t('action.useRemote')) {
            // 서버 파일로 로컬 덮어쓰기
            await downloadAndReloadFile(remotePath, localPath, config, document, false);
            vscode.window.showInformationMessage(i18n.t('info.downloadSuccess', { fileName }));
        } else if (action === i18n.t('action.manualMerge')) {
            // 사용자에게 안내
            vscode.window.showInformationMessage(
                i18n.t('info.mergeGuide'),
                i18n.t('action.ok')
            );
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(i18n.t('error.diffFailed', { error: String(error) }));
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
            vscode.window.showErrorMessage(i18n.t('error.notConnected'));
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
        vscode.window.showErrorMessage(i18n.t('error.diffFailed', { error: String(error) }));
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
                ? i18n.t('conflict.detectedSingle', { fileName: changedFiles[0].fileName })
                : i18n.t('conflict.detectedMultiple', { count: changedFiles.length });

            const choice = await vscode.window.showInformationMessage(
                message,
                { modal: true },
                i18n.t('action.downloadAll'),
                i18n.t('action.selectIndividually'),
                i18n.t('action.ignore')
            );

            if (choice === i18n.t('action.downloadAll')) {
                // 모든 파일 다운로드
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: i18n.t('status.downloadingRemoteFiles'),
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

                vscode.window.showInformationMessage(i18n.t('info.downloadedMultipleFiles', { count: changedFiles.length }));

            } else if (choice === i18n.t('action.selectIndividually')) {
                // 개별 파일 선택
                for (const fileInfo of changedFiles) {
                    const fileName = fileInfo.fileName;
                    const fileChoice = await vscode.window.showWarningMessage(
                        i18n.t('conflict.fileChanged', { fileName: fileName }),
                        { modal: true },
                        i18n.t('action.download'),
                        i18n.t('action.compare')
                    );

                    if (fileChoice === i18n.t('action.download')) {
                        const success = await downloadAndReloadFile(
                            fileInfo.remotePath,
                            fileInfo.localPath,
                            fileInfo.config,
                            fileInfo.document,
                            false  // preserveFocus - 개별 다운로드는 포커스 이동
                        );
                        
                        if (success) {
                            vscode.window.showInformationMessage(i18n.t('info.downloadSuccess', { fileName: fileName }));
                        } else {
                            vscode.window.showErrorMessage(i18n.t('error.downloadFailed', { fileName: fileName }));
                        }
                    } else if (fileChoice === i18n.t('action.compare')) {
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
            vscode.window.showWarningMessage(i18n.t('error.treeViewInitFailed'));
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
        vscode.window.showWarningMessage(i18n.t('error.bookmarkNavFailed', { error: String(error) }));
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
            vscode.window.showErrorMessage(i18n.t('error.bookmarkManagerInitFailed'));
            return;
        }
        
        // 서버 연결 확인
        let connection = treeProvider.getConnectedServer(bookmark.serverName);
        
        if (!connection || !connection.client.isConnected()) {
            const reconnect = await vscode.window.showWarningMessage(
                i18n.t('status.serverNotConnected', { serverName: bookmark.serverName }) + '\n' + i18n.t('action.connectQuery'),
                i18n.t('action.connect')
            );
            if (reconnect !== i18n.t('action.connect')) {
                return;
            }
            
            try {
                const serverItem = await treeProvider.getServerItem(bookmark.serverName);
                if (!serverItem) {
                    vscode.window.showErrorMessage(i18n.t('error.configNotFound', { serverName: bookmark.serverName }));
                    return;
                }
                await treeProvider.connectToServer(serverItem);
                connection = treeProvider.getConnectedServer(bookmark.serverName);
            } catch (connectError) {
                vscode.window.showErrorMessage(i18n.t('error.serverConnectionFailed'));
                return;
            }
        }
        
        if (!connection) {
            vscode.window.showErrorMessage(i18n.t('error.cannotGetServerInfo'));
            return;
        }
        
        // 접근 통계 업데이트
        bookmarkManager.recordAccess(bookmark.id);
        
        // TreeView에서 북마크 위치로 이동
        await findServerTreeItem(bookmark);
        
    } catch (error) {
        vscode.window.showErrorMessage(i18n.t('error.openBookmarkFailed', { error: String(error) }));
        if (DEBUG_MODE) console.error('openBookmark error:', error);
    }
}


/**
 * Backup local file
 * @param localPath Local file path to backup
 * @param config Server configuration
 */
async function backupLocalFile(localPath: string, config: SftpConfig): Promise<void> {
    if (DEBUG_MODE) console.log(`Backing up ${localPath}`);

    try {
        const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return;
        }

        if(config.downloadBackup == "" ) return; // Backup disabled
        
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
        
        if (DEBUG_MODE) console.log(`Backup completed: ${backupFilePath}`);
        
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
                if (DEBUG_MODE) console.log(`Deleted old backup: ${backupFiles[i].name}`);
            }
        }
    } catch (error) {
        if (DEBUG_MODE) console.error('Backup failed:', error);
        // Backup failure should not stop the download
    }
}

/**
 * StatusBar 업데이트
 */
function updateStatusBar(): void {
    const connectedServers = treeProvider.getConnectedServerNames();
    
    if (connectedServers.length === 0) {
        statusBarItem.text = i18n.t('status.disconnected');
        statusBarItem.tooltip = i18n.t('action.clickToSelect');
        statusBarItem.backgroundColor = undefined;
    } else if (connectedServers.length === 1) {
        statusBarItem.text = i18n.t('status.connected', { serverName: connectedServers[0] });
        statusBarItem.tooltip = i18n.t('status.connectedDetailed', { serverName: connectedServers[0] }) + '\n' + i18n.t('action.clickToManage');
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
        statusBarItem.text = i18n.t('status.connectedCount', { count: connectedServers.length });
        statusBarItem.tooltip = i18n.t('status.connectedServersList', { list: connectedServers.join('\n') }) + '\n\n' + i18n.t('action.clickToManage');
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    }
}

/**
 * 
 */
export function deactivate() {
    // 모든 Watcher 정리
    if (watcherManager) {
        watcherManager.dispose();
    }
    
    // SFTP 클라이언트 연결 종료
    if (sftpClient) {
        sftpClient.disconnect();
    }
}

//#endregion