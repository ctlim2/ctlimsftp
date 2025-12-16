import SftpClient2 from 'ssh2-sftp-client';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SftpConfig, RemoteFile, FileMetadata } from './types';

export class SftpClient {
    public client: SftpClient2 | null = null;
    private connected: boolean = false;
    private outputChannel: vscode.OutputChannel | null = null;

    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
        console.log(message);
    }

    setOutputChannel(channel: vscode.OutputChannel): void {
        this.outputChannel = channel;
    }

    async connect(config: SftpConfig): Promise<void> {
        this.client = new SftpClient2();
        
        const connectConfig: any = {
            host: config.host,
            port: config.port,
            username: config.username,
            // Add algorithms for compatibility with older SSH servers
            algorithms: {
                kex: [
                    'curve25519-sha256',
                    'curve25519-sha256@libssh.org',
                    'ecdh-sha2-nistp256',
                    'ecdh-sha2-nistp384',
                    'ecdh-sha2-nistp521',
                    'diffie-hellman-group-exchange-sha256',
                    'diffie-hellman-group14-sha256',
                    'diffie-hellman-group14-sha1',
                    'diffie-hellman-group1-sha1'
                ],
                cipher: [
                    'aes128-ctr',
                    'aes192-ctr',
                    'aes256-ctr',
                    'aes128-gcm',
                    'aes128-gcm@openssh.com',
                    'aes256-gcm',
                    'aes256-gcm@openssh.com',
                    'aes256-cbc',
                    'aes192-cbc',
                    'aes128-cbc',
                    '3des-cbc'
                ],
                serverHostKey: [
                    'ssh-ed25519',
                    'ecdsa-sha2-nistp256',
                    'ecdsa-sha2-nistp384',
                    'ecdsa-sha2-nistp521',
                    'rsa-sha2-512',
                    'rsa-sha2-256',
                    'ssh-rsa',
                    'ssh-dss'
                ],
                hmac: [
                    'hmac-sha2-256',
                    'hmac-sha2-512',
                    'hmac-sha1'
                ]
            }
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
        } else {
            // Use calculated remote path
            remotePath = calculatedRemotePath;
        }

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

        this.log(`업로드 중: ${localPath} -> ${remotePath}`);
        await this.client.put(localPath, remotePath);
        this.log(`업로드 완료: ${remotePath}`);
        
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
        // Encode remote path safely: _ -> _u_, / -> __
        const safeRemotePath = remotePath
            .replace(/^\//g, '')
            .replace(/_/g, '_u_')
            .replace(/\//g, '__');
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
            const fileContent = fs.readFileSync(metadataPath, 'utf-8');
            const metadata: FileMetadata = JSON.parse(fileContent);
            return metadata;
        } catch (error) {
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
