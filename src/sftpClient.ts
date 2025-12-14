import SftpClient2 from 'ssh2-sftp-client';
import * as path from 'path';
import * as fs from 'fs';
import { SftpConfig, RemoteFile, FileMetadata } from './types';

export class SftpClient {
    public client: SftpClient2 | null = null;
    private connected: boolean = false;

    async connect(config: SftpConfig): Promise<void> {
        this.client = new SftpClient2();
        
        const connectConfig: any = {
            host: config.host,
            port: config.port,
            username: config.username,
        };

        if (config.privateKey) {
            connectConfig.privateKey = fs.readFileSync(config.privateKey);
            if (config.passphrase) {
                connectConfig.passphrase = config.passphrase;
            }
        } else if (config.password) {
            connectConfig.password = config.password;
        }

        await this.client.connect(connectConfig);
        this.connected = true;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.end();
            this.connected = false;
            this.client = null;
        }
    }

    async uploadFile(localPath: string, config: SftpConfig, skipConflictCheck: boolean = false, workspaceFolder?: string): Promise<{ uploaded: boolean; conflict: boolean; remotePath: string }> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        console.log('=== uploadFile Debug ===');
        console.log('localPath:', localPath);
        console.log('workspaceFolder:', workspaceFolder);
        console.log('config.remotePath:', config.remotePath);

        // First calculate what the remote path would be
        const relativePath = workspaceFolder 
            ? path.relative(workspaceFolder, localPath)
            : path.basename(localPath);
        
        const calculatedRemotePath = path.posix.join(
            config.remotePath,
            relativePath.replace(/\\/g, '/')
        );

        // Check if metadata exists to get original remote path
        const metadata = this.getFileMetadata(localPath, calculatedRemotePath, config);
        let remotePath: string;
        
        if (metadata && metadata.remotePath) {
            // Use the original remote path from metadata
            remotePath = metadata.remotePath;
            console.log('Using remotePath from metadata:', remotePath);
        } else {
            // Use calculated remote path
            remotePath = calculatedRemotePath;
            console.log('Calculated relativePath:', relativePath);
            console.log('Calculated remotePath:', remotePath);
        }
        console.log('Final remotePath:', remotePath);
        console.log('=======================');

        // Check for conflicts if metadata exists
        if (!skipConflictCheck && metadata) {
            try {
                const remoteStats = await this.client.stat(remotePath);
                const remoteModifyTime = new Date(remoteStats.modifyTime).getTime();
                
                if (remoteModifyTime !== metadata.remoteModifyTime) {
                    return { uploaded: false, conflict: true, remotePath };
                }
            } catch (error) {
                // File doesn't exist on remote, proceed with upload
            }
        }

        // 원격 디렉토리 생성
        const remoteDir = path.posix.dirname(remotePath);
        await this.ensureRemoteDir(remoteDir);

        await this.client.put(localPath, remotePath);
        
        // Update metadata after successful upload
        try {
            const remoteStats = await this.client.stat(remotePath);
            this.saveFileMetadata(localPath, remotePath, new Date(remoteStats.modifyTime).getTime(), config);
        } catch (error) {
            console.error('Failed to update metadata:', error);
        }
        
        return { uploaded: true, conflict: false, remotePath };
    }

    async downloadFile(localPath: string, config: SftpConfig, workspaceFolder?: string): Promise<void> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        const relativePath = workspaceFolder 
            ? path.relative(workspaceFolder, localPath)
            : path.basename(localPath);
        
        const remotePath = path.posix.join(
            config.remotePath,
            relativePath.replace(/\\/g, '/')
        );

        // Get remote file stats before download
        const remoteStats = await this.client.stat(remotePath);
        const remoteModifyTime = new Date(remoteStats.modifyTime).getTime();

        // 로컬 디렉토리 생성
        const localDir = path.dirname(localPath);
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
        }

        await this.client.get(remotePath, localPath);
        
        // Save metadata after successful download
        this.saveFileMetadata(localPath, remotePath, remoteModifyTime, config);
    }

    async syncFolder(localFolder: string, config: SftpConfig): Promise<void> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        const files = this.getAllFiles(localFolder, config.ignore || []);
        
        for (const file of files) {
            try {
                await this.uploadFile(file, config);
            } catch (error) {
                console.error(`업로드 실패: ${file}`, error);
            }
        }
    }

    private async ensureRemoteDir(remotePath: string): Promise<void> {
        if (!this.client) {
            return;
        }

        try {
            await this.client.mkdir(remotePath, true);
        } catch (error) {
            // 디렉토리가 이미 존재하면 무시
        }
    }

    private getAllFiles(dir: string, ignore: string[]): string[] {
        const files: string[] = [];
        
        const walk = (currentPath: string) => {
            const items = fs.readdirSync(currentPath);
            
            for (const item of items) {
                const fullPath = path.join(currentPath, item);
                const relativePath = path.relative(dir, fullPath);
                
                // 무시할 파일/폴더 체크
                const shouldIgnore = ignore.some(pattern => {
                    return relativePath.includes(pattern) || item === pattern;
                });
                
                if (shouldIgnore) {
                    continue;
                }
                
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    walk(fullPath);
                } else if (stat.isFile()) {
                    files.push(fullPath);
                }
            }
        };
        
        walk(dir);
        return files;
    }

    async listRemoteFiles(remotePath: string): Promise<RemoteFile[]> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            const list = await this.client.list(remotePath);
            return list.map(item => ({
                name: item.name,
                path: path.posix.join(remotePath, item.name),
                isDirectory: item.type === 'd',
                size: item.size,
                modifyTime: new Date(item.modifyTime)
            }));
        } catch (error) {
            console.error(`원격 파일 목록 조회 실패: ${remotePath}`, error);
            return [];
        }
    }

    async deleteRemoteFile(remotePath: string, isDirectory: boolean = false): Promise<void> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        if (isDirectory) {
            await this.client.rmdir(remotePath, true);
        } else {
            await this.client.delete(remotePath);
        }
    }

    private getMetadataDir(config: SftpConfig): string {
        const workspaceRoot = config.workspaceRoot || '';
        return path.join(workspaceRoot, '.vscode', '.sftp-metadata');
    }

    private getMetadataPath(localPath: string, remotePath: string, config: SftpConfig): string {
        const metadataDir = this.getMetadataDir(config);
        // Use remote path as filename (replace slashes with safe characters)
        const safeRemotePath = remotePath.replace(/^\//g, '').replace(/\//g, '_');
        return path.join(metadataDir, `${safeRemotePath}.json`);
    }

    private saveFileMetadata(localPath: string, remotePath: string, remoteModifyTime: number, config: SftpConfig): void {
        const metadataDir = this.getMetadataDir(config);
        
        if (!fs.existsSync(metadataDir)) {
            fs.mkdirSync(metadataDir, { recursive: true });
        }

        const metadataPath = this.getMetadataPath(localPath, remotePath, config);
        const metadata: FileMetadata = {
            remotePath,
            remoteModifyTime,
            localPath,
            downloadTime: Date.now()
        };

        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    }

    private getFileMetadata(localPath: string, remotePath: string, config: SftpConfig): FileMetadata | null {
        const metadataPath = this.getMetadataPath(localPath, remotePath, config);
        
        if (!fs.existsSync(metadataPath)) {
            return null;
        }

        try {
            const metadata: FileMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            return metadata;
        } catch (error) {
            console.error('Failed to read metadata:', error);
            return null;
        }
    }

    async getRemoteFileStats(remotePath: string): Promise<{ modifyTime: number } | null> {
        if (!this.client) {
            return null;
        }
        
        try {
            const stats = await this.client.stat(remotePath);
            return { modifyTime: new Date(stats.modifyTime).getTime() };
        } catch (error) {
            return null;
        }
    }
}
