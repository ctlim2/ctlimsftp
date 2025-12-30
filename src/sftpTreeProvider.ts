import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpClient } from './sftpClient';
import { SftpConfig, RemoteFile, ServerListItem, Bookmark } from './types';
import { BookmarkManager } from './bookmarkManager';

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = true;

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

export class SftpTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'group' | 'server' | 'remoteFile' | 'remoteDirectory' | 'message' | 'bookmarkGroup' | 'bookmark',
        public readonly remotePath?: string,
        public readonly isDirectory?: boolean,
        public readonly config?: SftpConfig,
        public readonly serverItem?: ServerListItem,
        public readonly groupName?: string,
        public readonly fileSize?: number,
        public readonly modifyTime?: Date,
        public readonly connectionStatus?: 'connected' | 'disconnected' | 'error',
        public readonly bookmarkData?: Bookmark
    ) {
        super(label, collapsibleState);
        
        if (itemType === 'group') {
            this.iconPath = new vscode.ThemeIcon('folder');
            this.contextValue = 'group';
            this.tooltip = `그룹: ${label}`;
        } else if (itemType === 'server') {
            // 연결 상태별 아이콘 색상
            if (connectionStatus === 'connected') {
                this.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('testing.iconPassed'));
            } else if (connectionStatus === 'error') {
                this.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('testing.iconFailed'));
            } else {
                this.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('descriptionForeground'));
            }
            this.contextValue = 'server';
            this.tooltip = `${serverItem?.host}:${serverItem?.port}`;
            this.description = `${serverItem?.username}@${serverItem?.host}`;
        } else if (itemType === 'bookmarkGroup') {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
            this.contextValue = 'bookmarkGroup';
            this.tooltip = '저장된 북마크';
        } else if (itemType === 'bookmark') {
            const icon = isDirectory ? 'folder' : 'file';
            this.iconPath = new vscode.ThemeIcon(icon);
            this.contextValue = 'bookmark';
            
            if (bookmarkData) {
                const accessInfo = bookmarkData.accessCount > 0 
                    ? ` | ${bookmarkData.accessCount}회 사용`
                    : '';
                this.description = bookmarkData.serverName;
                this.tooltip = `${bookmarkData.name}\n경로: ${bookmarkData.remotePath}\n서버: ${bookmarkData.serverName}${accessInfo}`;
                if (bookmarkData.description) {
                    this.tooltip += `\n설명: ${bookmarkData.description}`;
                }
            }
        } else if (isDirectory) {
            this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
            this.contextValue = 'remoteDirectory';
            // 디렉토리는 크기 정보 없음
            if (modifyTime) {
                this.tooltip = `${label}\n수정: ${formatDateTime(modifyTime)}`;
            }
        } else if (itemType === 'remoteFile') {
            // Use resourceUri for Material Icon Theme support
            this.resourceUri = vscode.Uri.file(label);
            this.contextValue = 'remoteFile';
            
            // 파일 크기 표시
            if (fileSize !== undefined) {
                this.description = formatFileSize(fileSize);
            }
            
            // 툴팁에 상세 정보 표시
            if (fileSize !== undefined && modifyTime) {
                this.tooltip = `${label}\n크기: ${formatFileSize(fileSize)}\n수정: ${formatDateTime(modifyTime)}`;
            } else if (fileSize !== undefined) {
                this.tooltip = `${label}\n크기: ${formatFileSize(fileSize)}`;
            } else if (modifyTime) {
                this.tooltip = `${label}\n수정: ${formatDateTime(modifyTime)}`;
            } else {
                this.tooltip = label;
            }
        } else {
            this.contextValue = 'message';
        }
        
        // Default tooltip if not set
        if (!this.tooltip) {
            this.tooltip = remotePath || label;
        }
        
        // Double-click opens files (command property)
        // Single-click for servers is handled by onDidChangeSelection in extension.ts
        if (itemType === 'remoteFile' && remotePath) {
            this.command = {
                command: 'ctlimSftp.openRemoteFile',
                title: 'Open Remote File',
                arguments: [remotePath, config]
            };
        }
        // Server command is set in getChildren() based on connection status
    }
}

export class SftpTreeProvider implements vscode.TreeDataProvider<SftpTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SftpTreeItem | undefined | null | void> = new vscode.EventEmitter<SftpTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SftpTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private serverList: ServerListItem[] = [];
    private connectedServers: Map<string, { client: SftpClient, config: SftpConfig }> = new Map();
    private bookmarkManager: BookmarkManager | null = null;

    constructor(workspaceRoot?: string) {
        this.loadServerList();
        if (workspaceRoot) {
            this.bookmarkManager = new BookmarkManager(workspaceRoot);
        }
    }

    private loadServerList(): void {
        this.serverList = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (!workspaceFolders) {
            return;
        }

        for (const folder of workspaceFolders) {
            const configPath = path.join(folder.uri.fsPath, '.vscode', 'ctlim-sftp.json');
            if (fs.existsSync(configPath)) {
                try {
                    const configContent = fs.readFileSync(configPath, 'utf-8');
                    const configData = JSON.parse(configContent);
                    
                    // Support both single config object and array of configs
                    const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
                    
                    for (const config of configs) {
                        // Ensure required fields exist
                        if (!config.host || !config.username) {
                            console.error(`Invalid config at ${configPath}: missing host or username`);
                            continue;
                        }
                        
                        // Use context to determine workspace root
                        const contextPath = config.context || './';
                        const workspaceRoot = path.isAbsolute(contextPath) 
                            ? contextPath 
                            : path.join(folder.uri.fsPath, contextPath);
                        
                        // Set workspaceRoot in config object
                        config.workspaceRoot = workspaceRoot;
                        
                        const serverName = config.name || `${config.username}@${config.host}`;
                        this.serverList.push({
                            name: serverName,
                            group: config.group,
                            host: config.host,
                            port: config.port || 22,
                            username: config.username,
                            remotePath: config.remotePath || '/',
                            configPath: configPath
                        });
                    }
                } catch (error) {
                    console.error(`Failed to load config from ${configPath}`, error);
                }
            }
        }
        
        // Sort server list by name
        this.serverList.sort((a, b) => a.name.localeCompare(b.name));
    }

    async connectToServer(serverItem: ServerListItem): Promise<void> {
        try {
            const configContent = fs.readFileSync(serverItem.configPath, 'utf-8');
            const configData = JSON.parse(configContent);
            
            // Support both single config object and array of configs
            const configs: SftpConfig[] = Array.isArray(configData) ? configData : [configData];
            
            // Find the matching config by name or host/username
            let config = configs.find(c => {
                const name = c.name || `${c.username}@${c.host}`;
                return name === serverItem.name;
            });
            
            if (!config) {
                vscode.window.showErrorMessage(`서버 설정을 찾을 수 없습니다: ${serverItem.name}`);
                return;
            }
            
            // Use context to determine workspace root
            const configDir = path.dirname(path.dirname(serverItem.configPath));
            const contextPath = config.context || './';
            const workspaceRoot = path.isAbsolute(contextPath) 
                ? contextPath 
                : path.join(configDir, contextPath);
            
            config.workspaceRoot = workspaceRoot;
            config.name = serverItem.name;

            const client = new SftpClient();
            await client.connect(config);

            this.connectedServers.set(serverItem.name, { client, config });
            this.refresh();

            vscode.window.showInformationMessage(`서버 연결 성공: ${serverItem.name}`);
        } catch (error) {
            vscode.window.showErrorMessage(`서버 연결 실패: ${error}`);
        }
    }

    disconnectServer(serverName: string): void {
        const connection = this.connectedServers.get(serverName);
        if (connection) {
            connection.client.disconnect();
            this.connectedServers.delete(serverName);
            this.refresh();
            vscode.window.showInformationMessage(`서버 연결 해제: ${serverName}`);
        }
    }

    getConnectedServer(serverName: string): { client: SftpClient, config: SftpConfig } | undefined {
        return this.connectedServers.get(serverName);
    }

    /**
     * 연결된 서버 이름 목록 반환
     * @returns 연결된 서버 이름 배열
     */
    getConnectedServerNames(): string[] {
        return Array.from(this.connectedServers.keys());
    }

    /**
     * 서버 연결을 connectedServers에 추가
     * @param serverName 서버 이름
     * @param client SFTP 클라이언트
     * @param config 서버 설정
     */
    addConnectedServer(serverName: string, client: SftpClient, config: SftpConfig): void {
        this.connectedServers.set(serverName, { client, config });
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this.loadServerList();
        if (this.bookmarkManager) {
            this.bookmarkManager.reload();
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SftpTreeItem): vscode.TreeItem {
        return element;
    }

    getParent(element: SftpTreeItem): SftpTreeItem | undefined {
        // Bookmark items - parent is bookmarkGroup
        if (element.itemType === 'bookmark') {
            // Find bookmark group in root
            return undefined; // Bookmarks have no parent tracking yet
        }
        
        // Server items
        if (element.itemType === 'server' && element.groupName) {
            // Server in a group - find the group item
            // We need to return the group TreeItem, but we don't have reference
            // For now, return undefined (will be improved later)
            return undefined;
        }
        
        // Remote files/directories
        if ((element.itemType === 'remoteFile' || element.itemType === 'remoteDirectory') && element.remotePath && element.config) {
            const serverName = element.config.name || `${element.config.username}@${element.config.host}`;
            const connection = this.connectedServers.get(serverName);
            
            if (!connection) {
                return undefined;
            }
            
            // Get parent directory path
            const parentPath = element.remotePath === connection.config.remotePath 
                ? null 
                : element.remotePath.substring(0, element.remotePath.lastIndexOf('/'));
            
            if (!parentPath || parentPath === connection.config.remotePath) {
                // Parent is the server item
                const serverItem = this.serverList.find(s => s.name === serverName);
                if (!serverItem) {
                    return undefined;
                }
                
                return new SftpTreeItem(
                    serverItem.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'server',
                    undefined,
                    undefined,
                    connection.config,
                    serverItem,
                    undefined,
                    undefined,
                    undefined,
                    'connected'
                );
            }
            
            // Parent is another remote directory
            const parentName = parentPath.substring(parentPath.lastIndexOf('/') + 1);
            return new SftpTreeItem(
                parentName,
                vscode.TreeItemCollapsibleState.Collapsed,
                'remoteDirectory',
                parentPath,
                true,
                element.config,
                undefined,
                undefined,
                undefined,
                undefined
            );
        }
        
        return undefined;
    }

    async getChildren(element?: SftpTreeItem): Promise<SftpTreeItem[]> {
        if (!element) {
            // Root level - show groups or servers
            if (this.serverList.length === 0) {
                return [
                    new SftpTreeItem('No ctlim SFTP servers configured', vscode.TreeItemCollapsibleState.None, 'message'),
                    new SftpTreeItem('Run "ctlim SFTP: Config" to setup', vscode.TreeItemCollapsibleState.None, 'message')
                ];
            }

            // Group servers by group name
            const groupedServers = new Map<string, ServerListItem[]>();
            const ungroupedServers: ServerListItem[] = [];

            for (const server of this.serverList) {
                if (server.group) {
                    if (!groupedServers.has(server.group)) {
                        groupedServers.set(server.group, []);
                    }
                    groupedServers.get(server.group)!.push(server);
                } else {
                    ungroupedServers.push(server);
                }
            }

            const items: SftpTreeItem[] = [];

            // Add bookmark group at the top
            if (this.bookmarkManager) {
                const bookmarks = this.bookmarkManager.getAllBookmarks();
                if (bookmarks.length > 0) {
                    items.push(new SftpTreeItem(
                        `⭐ 북마크 (${bookmarks.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'bookmarkGroup'
                    ));
                }
            }

            // Add grouped servers
            for (const [groupName, servers] of groupedServers.entries()) {
                items.push(new SftpTreeItem(
                    groupName,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'group',
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    groupName
                ));
            }

            // Add ungrouped servers
            for (const server of ungroupedServers) {
                const isConnected = this.connectedServers.has(server.name);
                const collapsibleState = isConnected 
                    ? vscode.TreeItemCollapsibleState.Collapsed 
                    : vscode.TreeItemCollapsibleState.None;
                
                const connectionStatus = isConnected ? 'connected' : 'disconnected';
                
                const item = new SftpTreeItem(
                    server.name,
                    collapsibleState,
                    'server',
                    undefined,
                    undefined,
                    undefined,
                    server,
                    undefined,
                    undefined,
                    undefined,
                    connectionStatus as 'connected' | 'disconnected'
                );
                
                // Only add command if not connected (to avoid double execution)
                if (!isConnected) {
                    item.command = {
                        command: 'ctlimSftp.connectServer',
                        title: 'Connect to Server',
                        arguments: [server]
                    };
                }
                
                items.push(item);
            }

            return items;
        } else if (element.itemType === 'bookmarkGroup') {
            // Show bookmarks
            if (!this.bookmarkManager) {
                return [];
            }
            
            const bookmarks = this.bookmarkManager.getAllBookmarks();
            
            return bookmarks.map(bookmark => {
                const item = new SftpTreeItem(
                    bookmark.name,
                    vscode.TreeItemCollapsibleState.None,
                    'bookmark',
                    bookmark.remotePath,
                    bookmark.isDirectory,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    bookmark
                );
                
                // Set command to open bookmark
                item.command = {
                    command: 'ctlimSftp.openBookmark',
                    title: 'Open Bookmark',
                    arguments: [bookmark]
                };
                
                return item;
            });
        } else if (element.itemType === 'group' && element.groupName) {
            // Show servers in this group
            const serversInGroup = this.serverList.filter(s => s.group === element.groupName);
            
            return serversInGroup.map(server => {
                const isConnected = this.connectedServers.has(server.name);
                const collapsibleState = isConnected 
                    ? vscode.TreeItemCollapsibleState.Collapsed 
                    : vscode.TreeItemCollapsibleState.None;
                
                const connectionStatus = isConnected ? 'connected' : 'disconnected';
                
                const item = new SftpTreeItem(
                    server.name,
                    collapsibleState,
                    'server',
                    undefined,
                    undefined,
                    undefined,
                    server,
                    undefined,
                    undefined,
                    undefined,
                    connectionStatus as 'connected' | 'disconnected'
                );
                
                // Only add command if not connected (to avoid double execution)
                if (!isConnected) {
                    item.command = {
                        command: 'ctlimSftp.connectServer',
                        title: 'Connect to Server',
                        arguments: [server]
                    };
                }
                
                return item;
            });
        } else if (element.itemType === 'server' && element.serverItem) {
            // Show remote files for connected server
            const connection = this.connectedServers.get(element.serverItem.name);
            if (!connection) {
                return [];
            }

            try {
                const files = await connection.client.listRemoteFiles(connection.config.remotePath);
                // Sort files: directories first, then alphabetically
                files.sort((a, b) => {
                    if (a.isDirectory && !b.isDirectory) return -1;
                    if (!a.isDirectory && b.isDirectory) return 1;
                    return a.name.localeCompare(b.name);
                });
                
                return files.map(file => new SftpTreeItem(
                    file.name,
                    file.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    file.isDirectory ? 'remoteDirectory' : 'remoteFile',
                    file.path,
                    file.isDirectory,
                    connection.config,
                    undefined,
                    undefined,
                    file.size,
                    file.modifyTime
                ));
            } catch (error) {
                return [
                    new SftpTreeItem('Error loading remote files', vscode.TreeItemCollapsibleState.None, 'message')
                ];
            }
        } else if (element.itemType === 'remoteDirectory' && element.remotePath) {
            // Show subdirectory contents
            const serverItem = this.findServerByRemotePath(element.remotePath);
            if (!serverItem) {
                return [];
            }

            const connection = this.connectedServers.get(serverItem.name);
            if (!connection) {
                return [];
            }

            try {
                const files = await connection.client.listRemoteFiles(element.remotePath);
                // Sort files: directories first, then alphabetically
                files.sort((a, b) => {
                    if (a.isDirectory && !b.isDirectory) return -1;
                    if (!a.isDirectory && b.isDirectory) return 1;
                    return a.name.localeCompare(b.name);
                });
                
                return files.map(file => new SftpTreeItem(
                    file.name,
                    file.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    file.isDirectory ? 'remoteDirectory' : 'remoteFile',
                    file.path,
                    file.isDirectory,
                    connection.config,
                    undefined,
                    undefined,
                    file.size,
                    file.modifyTime
                ));
            } catch (error) {
                return [];
            }
        }
        
        return [];
    }

    private findServerByRemotePath(remotePath: string): ServerListItem | undefined {
        for (const [serverName, connection] of this.connectedServers.entries()) {
            if (remotePath.startsWith(connection.config.remotePath)) {
                return this.serverList.find(s => s.name === serverName);
            }
        }
        return undefined;
    }
}

/**
 * Drag and Drop Controller for SFTP TreeView
 * Enables dragging files from Explorer to remote directories
 */
export class SftpDragAndDropController implements vscode.TreeDragAndDropController<SftpTreeItem> {
    dropMimeTypes = ['text/uri-list'];
    dragMimeTypes = ['application/vnd.code.tree.ctlimSftpView'];

    constructor(
        private treeProvider: SftpTreeProvider,
        private outputChannel?: vscode.OutputChannel
    ) {}

    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
        if (DEBUG_MODE) console.log(`[DragDrop] ${message}`);
    }

    async handleDrop(
        target: SftpTreeItem | undefined,
        sources: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<void> {
        this.log('handleDrop called');
        
        // Target must be a server or directory
        if (!target || (target.itemType !== 'server' && target.itemType !== 'remoteDirectory')) {
            vscode.window.showWarningMessage('파일은 서버 또는 폴더로만 드래그할 수 있습니다.');
            return;
        }

        // Get target remote path
        const targetRemotePath = target.remotePath || target.config?.remotePath;
        if (!targetRemotePath || !target.config) {
            vscode.window.showErrorMessage('대상 경로를 찾을 수 없습니다.');
            return;
        }

        // Get dropped files
        const uriListData = sources.get('text/uri-list');
        if (!uriListData) {
            this.log('No uri-list data found');
            return;
        }

        const uriListText = uriListData.value;
        const uris = uriListText
            .split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0)
            .map((line: string) => vscode.Uri.parse(line));

        if (uris.length === 0) {
            return;
        }

        this.log(`Dropping ${uris.length} item(s) to ${targetRemotePath}`);

        // Get server connection
        const serverName = target.config.name || `${target.config.username}@${target.config.host}`;
        const connection = this.treeProvider.getConnectedServer(serverName);

        if (!connection || !connection.client.isConnected()) {
            vscode.window.showErrorMessage('서버에 연결되어 있지 않습니다.');
            return;
        }

        // Process each dropped file/folder
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '파일 업로드 중...',
            cancellable: false
        }, async (progress) => {
            let completed = 0;
            const total = uris.length;

            for (const uri of uris) {
                if (token.isCancellationRequested) {
                    break;
                }

                const localPath = uri.fsPath;
                const fileName = path.basename(localPath);
                
                progress.report({
                    message: `${fileName} (${completed + 1}/${total})`,
                    increment: (1 / total) * 100
                });

                try {
                    const stats = fs.statSync(localPath);
                    
                    if (stats.isDirectory()) {
                        // Upload folder
                        this.log(`Uploading folder: ${localPath}`);
                        const remoteFolderPath = path.posix.join(targetRemotePath, fileName);
                        
                        await connection.client.syncFolder(
                            localPath,
                            remoteFolderPath,
                            target.config!,
                            'local-to-remote',
                            false
                        );
                    } else {
                        // Upload file
                        this.log(`Uploading file: ${localPath}`);
                        const remoteFilePath = path.posix.join(targetRemotePath, fileName);
                        
                        await connection.client.uploadFile(
                            localPath,
                            remoteFilePath,
                            target.config!
                        );
                    }
                    
                    completed++;
                } catch (error) {
                    this.log(`Upload failed: ${localPath} - ${error}`);
                    vscode.window.showErrorMessage(`업로드 실패: ${fileName} - ${error}`);
                }
            }

            if (completed > 0) {
                vscode.window.showInformationMessage(`✅ ${completed}개 항목 업로드 완료`);
                this.treeProvider.refresh();
            }
        });
    }

    async handleDrag(
        source: readonly SftpTreeItem[],
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<void> {
        this.log(`handleDrag called with ${source.length} item(s)`);
        
        // Filter only files and directories (not servers or messages)
        const validItems = source.filter(item => 
            (item.itemType === 'remoteFile' || item.itemType === 'remoteDirectory') && 
            item.remotePath && 
            item.config
        );

        if (validItems.length === 0) {
            this.log('No valid items to drag');
            return;
        }

        // Get server connection
        const firstItem = validItems[0];
        const serverName = firstItem.config!.name || `${firstItem.config!.username}@${firstItem.config!.host}`;
        const connection = this.treeProvider.getConnectedServer(serverName);

        if (!connection || !connection.client.isConnected()) {
            vscode.window.showWarningMessage('서버에 연결되어 있지 않습니다.');
            return;
        }

        // Get workspace folder
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('워크스페이스를 찾을 수 없습니다.');
            return;
        }

        const uris: vscode.Uri[] = [];

        try {
            for (const item of validItems) {
                if (token.isCancellationRequested) {
                    break;
                }

                try {
                    if (item.isDirectory) {
                        // For directories, prepare folder structure
                        this.log(`Preparing directory drag: ${item.remotePath}`);
                        const localPath = SftpClient.getDownloadFolder(
                            item.remotePath!,
                            workspaceFolder.uri.fsPath,
                            item.config!,
                            true,
                            true
                        );
                        if (localPath) {
                            uris.push(vscode.Uri.file(localPath));
                        }
                    } else {
                        // Download file with metadata (same as openRemoteFile)
                        this.log(`Downloading for drag: ${item.remotePath}`);
                        
                        // Calculate proper local path based on config.context
                        const localPath = SftpClient.getDownloadFolder(
                            item.remotePath!,
                            workspaceFolder.uri.fsPath,
                            item.config!,
                            true,
                            false
                        );
                        
                        if (!localPath) {
                            this.log(`Failed to calculate local path for ${item.remotePath}`);
                            continue;
                        }

                        // Ensure directory exists
                        const localDir = path.dirname(localPath);
                        if (!fs.existsSync(localDir)) {
                            fs.mkdirSync(localDir, { recursive: true });
                        }

                        // Download file
                        if (connection.client.client) {
                            await connection.client.client.get(item.remotePath!, localPath);
                            
                            // Save metadata (same as openRemoteFile)
                            await connection.client.saveRemoteFileMetadata(
                                item.remotePath!,
                                localPath,
                                item.config!,
                                item.config!.workspaceRoot
                            );
                            
                            // Backup existing file if downloadBackup is enabled
                            if (item.config!.downloadBackup && fs.existsSync(localPath)) {
                                await connection.client.backupLocalFile(localPath, item.config!);
                            }

                            uris.push(vscode.Uri.file(localPath));
                            this.log(`Downloaded and saved metadata: ${localPath}`);
                        }
                    }
                } catch (error) {
                    this.log(`Failed to prepare drag for ${item.remotePath}: ${error}`);
                }
            }

            if (uris.length > 0) {
                // Set URIs in DataTransfer
                const uriList = uris.map(uri => uri.toString()).join('\n');
                dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriList));
                this.log(`Drag prepared with ${uris.length} file(s)`);
            }
        } catch (error) {
            this.log(`Drag preparation error: ${error}`);
        }
    }
}
