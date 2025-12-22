import SftpClient2 from 'ssh2-sftp-client';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SftpConfig, RemoteFile, FileMetadata } from './types';
import { config } from 'process';

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

//#region connection functions    
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
        // Check both flag and actual SFTP client connection
        if (!this.connected || !this.client) {
            return false;
        }
        // Try to check if the client's SFTP connection is valid
        try {
            // @ts-ignore - accessing internal property
            return this.client.client !== undefined && this.client.sftp !== null;
        } catch {
            return false;
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.end();
            this.connected = false;
            this.client = null;
        }
    }
//#endregion


/*
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
*/
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

// #region metadata functions    
    static makeMetafileName(localPath: string): string {
        const safeLocalPath = localPath
            .replace(/:/g, '_c_')
            .replace(/_/g, '_u_')
            .replace(/[\\\/]/g, '__');
        return `${safeLocalPath}.json`;
    }

    static getMetadataPath(localPath: string, config: SftpConfig): string {
        const workspaceRoot = config.workspaceRoot || '';
        const metadataDir = path.join(workspaceRoot, '.vscode', '.sftp-metadata');
        const safeLocalPath = SftpClient.makeMetafileName(localPath);
        return path.join(metadataDir, safeLocalPath);
    }

    private getFileMetadata(localPath: string, config: SftpConfig): FileMetadata | null {
        const metadataPath = SftpClient.getMetadataPath(localPath, config);
        
        if (!fs.existsSync(metadataPath)) {
            return null;
        }

        try {
            const fileContent = fs.readFileSync(metadataPath, 'utf-8');
            const metadata: FileMetadata = JSON.parse(fileContent);
this.log(`read metadate info ${metadataPath}\n ${metadata.remotePath} : mtime=${metadata.remoteModifyTime}, size=${metadata.remoteFileSize}`);
            return metadata;
        } catch (error) {
            return null;
        }
    }


    async isSameMetadata(local: string, remote: string, config: SftpConfig): Promise<boolean> {
        // Read metadata
        const localMetadata = await this.getLocalFileInfo(local, config);
        if (!localMetadata) {
            return false;
        }
        // Check remote file
        const remoteMetadata = await this.getRemoteFileInfo(remote);
        if (!remoteMetadata) {
            return false;
        }

this.log(`compare metadata \nlocal mtime=${localMetadata.remoteModifyTime}, size=${localMetadata.remoteFileSize}\nremote mtime=${remoteMetadata.remoteModifyTime}, size=${remoteMetadata.remoteFileSize}`);        

        if(localMetadata.remoteModifyTime == remoteMetadata.remoteModifyTime && localMetadata.remoteFileSize == remoteMetadata.remoteFileSize) return true;
        else return false;
    }
//#endregion

//#region save metadata
    async saveRemoteFileMetadata(remotePath:string, localPath: string, config: SftpConfig, workspaceFolder?: string): Promise<void> {
        
        // Get remote file stats before download
        const remoteMetadata = await this.getRemoteFileInfo(remotePath);

        // Save metadata after successful download
        this.saveFileMetadata(localPath, remotePath, remoteMetadata.remoteModifyTime, remoteMetadata.remoteFileSize, config);
    }

    public saveFileMetadata(localPath: string, remotePath: string, remoteModifyTime: number, remoteFileSize: number, config: SftpConfig): void {
        const metadataPath = SftpClient.getMetadataPath(localPath, config);

        
        const metadata: FileMetadata = {
            remotePath,
            remoteModifyTime,
            remoteFileSize,
            localPath,
            downloadTime: Date.now(),
            configName: config.name  // 서버 config 이름 저장
        };

        config.metadataPath = metadataPath;
        
        try {
            // Ensure metadata directory exists
            const metadataDir = path.dirname(metadataPath);
            if (!fs.existsSync(metadataDir)) {
                fs.mkdirSync(metadataDir, { recursive: true });
            }
            
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            this.log(`save metadate info ${metadata.remotePath} : mtime=${metadata.remoteModifyTime}, size=${metadata.remoteFileSize}`);
            this.log(`save metadate file ${metadataPath}`);
        } catch (error) {
            console.error('Failed to save metadata:', error);
            this.log(`메타데이터 저장 실패: ${metadataPath}`);
        }
    }
//#endregion

//#region get metadata
    async getLocalFileInfo(remotePath: string, config: SftpConfig): Promise<{ remoteModifyTime: number; remoteFileSize: number }> {
        let localInfo = this.getFileMetadata(remotePath, config);
        return { remoteModifyTime: localInfo?.remoteModifyTime || 0, remoteFileSize: localInfo?.remoteFileSize || 0 };
    }
    
    async getRemoteFileInfo(remotePath: string): Promise<{ remoteModifyTime: number; remoteFileSize: number }> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }
        
        const remoteStats = await this.client.stat(remotePath);
        const remoteModifyTime = new Date(remoteStats.modifyTime).getTime();
        const remoteFileSize = remoteStats.size;
        this.log(`retmote file : ${remotePath}`)
        this.log(`get remote file info ${remotePath} : mtime=${remoteModifyTime}, size=${remoteFileSize}`);
        return { remoteModifyTime: remoteModifyTime, remoteFileSize: remoteFileSize };
    }
//#endregion

    /**
     * @return 워크스페이스 메타데이터 디렉토리 경로 또는 null
     */
    static getWorkspaceMetadataDir(in_config:SftpConfig): string | null{
        const workspaceFolder = in_config.workspaceRoot;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('워크스페이스를 찾을 수 없습니다.');
            return null;
        }
        return path.join(workspaceFolder, '.vscode', '.sftp-metadata');
    }




    /**
     * 
     * @param remotePath 
     * @param workspaceFolder 
     * @param config 
     * @param folderMake 
     * @returns 
     */
    static getDownloadFolder(remotePath:string, workspaceFolder:string , config:SftpConfig, folderMake:boolean=true, isDir:boolean=true):string | null {
        const relativeToRemotePath = remotePath.startsWith(config.remotePath || '')
            ? remotePath.substring(config.remotePath.length).replace(/^\/+/, '')
            : path.basename(remotePath);
        
        // config.context 폴더 + 원격 상대 경로
        const contextPath = config.context || './';
        const fullContextPath = path.isAbsolute(contextPath) 
            ? contextPath 
            : path.join(workspaceFolder, contextPath);
        
        const tempLocalPath = path.join(fullContextPath, relativeToRemotePath);
        const tempDir = path.dirname(tempLocalPath);
        
        if (folderMake==true &&!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        if(isDir) {
            return tempDir;
        }
        return tempLocalPath;
    }


    
    /**
     * 
     * @param localPath 
     * @param config 
     * @param skipConflictCheck 
     * @param workspaceFolder 
     * @returns 
     */
//    async uploadFile(localPath: string, remotePath: string, skipConflictCheck: boolean = false, config: SftpConfig): Promise<{ uploaded: boolean; conflict: boolean; remotePath: string }> {
    async uploadFile(localPath: string, remotePath: string, config: SftpConfig): Promise<boolean> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        // Check if connection is still alive
        if (!this.isConnected()) {
            throw new Error('SFTP 연결이 끊어졌습니다. 다시 연결해주세요.');
        }
/*
        // upload 할 리모트의 경로 계산
        const fSameMetadata = await this.isSameMetadata(localPath, remotePath, config);

        // Check for conflicts if metadata exists
        if (!skipConflictCheck && !fSameMetadata) {
            return { uploaded: false, conflict: true, remotePath: remotePath };
        }

        // 원격 디렉토리 생성
  */  
        this.log(`업로드 중: ${localPath} -> ${remotePath}`);
        await this.client.put(localPath, remotePath);
        this.log(`업로드 완료: '${remotePath}`);
        
        // Update metadata after successful upload
        const remoteMetadata = await this.getRemoteFileInfo(remotePath);
        this.saveFileMetadata(localPath, remotePath, remoteMetadata.remoteModifyTime, remoteMetadata.remoteFileSize, config);
        
        return true;
    }



}
