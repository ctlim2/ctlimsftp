import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpClient } from './sftpClient';
import { SftpConfig, RemoteFile, ServerListItem } from './types';

export class SftpTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'server' | 'remoteFile' | 'remoteDirectory' | 'message',
        public readonly remotePath?: string,
        public readonly isDirectory?: boolean,
        public readonly config?: SftpConfig,
        public readonly serverItem?: ServerListItem
    ) {
        super(label, collapsibleState);
        
        if (itemType === 'server') {
            this.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.blue'));
            this.contextValue = 'server';
            this.tooltip = `${serverItem?.host}:${serverItem?.port}`;
            this.description = `${serverItem?.username}@${serverItem?.host}`;
        } else if (isDirectory) {
            this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
            this.contextValue = 'remoteDirectory';
        } else if (itemType === 'remoteFile') {
            // Use resourceUri for Material Icon Theme support
            this.resourceUri = vscode.Uri.file(label);
            this.contextValue = 'remoteFile';
        } else {
            this.contextValue = 'message';
        }
        
        this.tooltip = remotePath || label;
        
        // Single click is handled by onDidChangeSelection in extension.ts
        // Command is set for files and disconnected servers only
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

    constructor() {
        this.loadServerList();
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
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SftpTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SftpTreeItem): Promise<SftpTreeItem[]> {
        if (!element) {
            // Root level - show server list
            if (this.serverList.length === 0) {
                return [
                    new SftpTreeItem('No ctlim SFTP servers configured', vscode.TreeItemCollapsibleState.None, 'message'),
                    new SftpTreeItem('Run "ctlim SFTP: Config" to setup', vscode.TreeItemCollapsibleState.None, 'message')
                ];
            }

            return this.serverList.map(server => {
                const isConnected = this.connectedServers.has(server.name);
                const collapsibleState = isConnected 
                    ? vscode.TreeItemCollapsibleState.Collapsed 
                    : vscode.TreeItemCollapsibleState.None;
                
                const item = new SftpTreeItem(
                    server.name,
                    collapsibleState,
                    'server',
                    undefined,
                    undefined,
                    undefined,
                    server
                );
                
                // Change icon color based on connection status
                if (isConnected) {
                    item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.blue'));
                } else {
                    item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('foreground'));
                }
                
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
                    connection.config
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
                    connection.config
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
