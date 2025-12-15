import Client from 'ssh2-sftp-client';
import * as fs from 'fs';

export interface SftpConfig {
    host: string;
    port: number;
    username: string;
    password: string;
}

export interface FileStats {
    modifyTime: number;
    size: number;
}

export class SftpClient {
    private client: Client | null = null;

    async connect(config: SftpConfig): Promise<void> {
        this.client = new Client();
        await this.client.connect({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password
        });
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }

    async stat(remotePath: string): Promise<FileStats> {
        if (!this.client) {
            throw new Error('Not connected to SFTP server. Please call connect() first with valid credentials.');
        }

        const stats = await this.client.stat(remotePath);
        return {
            modifyTime: stats.modifyTime,
            size: stats.size
        };
    }

    async downloadFile(remotePath: string, localPath: string): Promise<void> {
        if (!this.client) {
            throw new Error('Not connected to SFTP server. Please call connect() first with valid credentials.');
        }

        await this.client.get(remotePath, localPath);
    }

    async uploadFile(localPath: string, remotePath: string): Promise<void> {
        if (!this.client) {
            throw new Error('Not connected to SFTP server. Please call connect() first with valid credentials.');
        }

        await this.client.put(localPath, remotePath);
    }

    async list(remotePath: string): Promise<any[]> {
        if (!this.client) {
            throw new Error('Not connected to SFTP server. Please call connect() first with valid credentials.');
        }

        return await this.client.list(remotePath);
    }
}
