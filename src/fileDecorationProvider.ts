import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpClient } from './sftpClient';
import { SftpConfig } from './types';

export class SftpFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;

    private configCache = new Map<string, SftpConfig[]>();

    constructor() {
        // Watch for file changes
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        watcher.onDidChange(uri => this.updateDecoration(uri));
        watcher.onDidCreate(uri => this.updateDecoration(uri));
        watcher.onDidDelete(uri => this.updateDecoration(uri));
        
        // Watch for metadata changes
        const metaWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/.sftp-metadata/*.json');
        metaWatcher.onDidChange(uri => this.updateMetadataDecoration(uri));
        metaWatcher.onDidCreate(uri => this.updateMetadataDecoration(uri));
        metaWatcher.onDidDelete(uri => this.updateMetadataDecoration(uri));
    }

    private updateDecoration(uri: vscode.Uri) {
        if (uri.scheme === 'file') {
            this._onDidChangeFileDecorations.fire(uri);
        }
    }
    
    private updateMetadataDecoration(uri: vscode.Uri) {
        // When metadata changes, we need to find the original file and update it
        // The filename of metadata is encoded local path
        // This is hard to reverse properly without full scan, but we can fire for all visible editors maybe?
        // Or just let it be lazy.
        // Actually, we can assume the active files might be affected.
        // For now, let's just trigger update for all visible editors to be safe, or just ignore live update from metadata change for now.
        // More aggressively, we could try to decode if we knew the workspace root.
        
        // Let's just fire all for now as simple refresh
        // this._onDidChangeFileDecorations.fire(undefined); 
        // -> undefined fires for all.
        this._onDidChangeFileDecorations.fire(undefined);
    }
    
    // Config loading helper
    private getConfigs(rootPath: string): SftpConfig[] {
        if (this.configCache.has(rootPath)) {
            return this.configCache.get(rootPath)!;
        }

        const configPath = path.join(rootPath, '.vscode', 'ctlim-sftp.json');
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf-8');
                const configData = JSON.parse(content);
                const configs = Array.isArray(configData) ? configData : [configData];
                this.configCache.set(rootPath, configs);
                return configs;
            } catch (e) {
                return [];
            }
        }
        return [];
    }
    
    public clearCache() {
        this.configCache.clear();
        this._onDidChangeFileDecorations.fire(undefined);
    }

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        if (uri.scheme !== 'file') {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return undefined;
        }

        // Encode current file path to find metadata
        const safeLocalPath = SftpClient.makeMetafileName(uri.fsPath);
        
        // Look for metadata file
        const metadataDir = path.join(workspaceFolder.uri.fsPath, '.vscode', '.sftp-metadata');
        const metadataPath = path.join(metadataDir, `${safeLocalPath}.json`);
        
        if (!fs.existsSync(metadataPath)) {
            return undefined;
        }

        try {
            const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
            const metadata = JSON.parse(metadataContent);
            
            // Check file stats
            const stats = fs.statSync(uri.fsPath);
            const localModifyTime = stats.mtime.getTime();
            
            // If local file is significantly newer than download time (1s buffer)
            // metadata.downloadTime is the time when sync happened (download or upload)
            
            // Note: When uploading, we should update downloadTime/remoteModifyTime.
            // Assuming sftpClient updates metadata correctly.
            
            // Compare local modify time with metadata record time
            // If local file has been modified AFTER the last sync
            if (localModifyTime > metadata.downloadTime + 2000) {
                 return {
                    badge: 'M',
                    tooltip: 'SFTP: Locally Modified',
                    color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
                };
            }
            
            // If synced, show checkmark? Or nothing?
            // Usually nothing means clean.
            // Let's show a small dot or check for tracked files
            return {
                badge: '✓',
                tooltip: 'SFTP: Synced',
                color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground') // green-ish usually
            };
            
        } catch (error) {
            return undefined;
        }
    }
}
