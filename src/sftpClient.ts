import SftpClient2 from 'ssh2-sftp-client';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SftpConfig, RemoteFile, FileMetadata } from './types';
import { config } from 'process';

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = true;

export class SftpClient {
    public client: SftpClient2 | null = null;
    private connected: boolean = false;
    private outputChannel: vscode.OutputChannel | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private lastConfig: SftpConfig | null = null;
    private reconnecting: boolean = false;

    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
        if (DEBUG_MODE) console.log(message);
    }

    setOutputChannel(channel: vscode.OutputChannel): void {
        this.outputChannel = channel;
    }

//#region connection functions    
    async connect(config: SftpConfig): Promise<void> {
        this.client = new SftpClient2();
        this.lastConfig = config;
        
        const connectConfig: any = {
            host: config.host,
            port: config.port,
            username: config.username,
            // 연결 타임아웃 설정 (기본 10초)
            connectTimeout: config.connectTimeout || 10000,
            readyTimeout: config.readyTimeout || 20000,
            // Keep-Alive 설정 (기본 10초 간격)
            keepaliveInterval: config.keepaliveInterval || 10000,
            keepaliveCountMax: config.keepaliveCountMax || 3,
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
        } else {
            // Password가 설정에 없으면 사용자에게 입력 요청
            let password = config.password;
            if (!password) {
                password = await vscode.window.showInputBox({
                    prompt: `${config.host}의 비밀번호를 입력하세요`,
                    password: true,
                    placeHolder: '비밀번호',
                    ignoreFocusOut: true
                });
                
                if (!password) {
                    throw new Error('비밀번호가 입력되지 않았습니다.');
                }
            }
            connectConfig.password = password;
        }

        await this.client.connect(connectConfig);
        this.connected = true;
        
        // Keep-Alive 타이머 시작
        this.startKeepAlive(config);
        
        this.log(`서버 연결 성공: ${config.host}:${config.port}`);
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
        // Keep-Alive 타이머 정리
        this.stopKeepAlive();
        
        if (this.client) {
            await this.client.end();
            this.connected = false;
            this.client = null;
            this.lastConfig = null;
        }
    }

    /**
     * Keep-Alive 타이머 시작 - 주기적으로 연결 상태 확인
     */
    private startKeepAlive(config: SftpConfig): void {
        // 기존 타이머가 있으면 정리
        this.stopKeepAlive();
        
        const interval = config.keepaliveInterval || 10000;
        
        this.keepAliveTimer = setInterval(async () => {
            if (!this.connected || !this.client) {
                this.stopKeepAlive();
                return;
            }
            
            try {
                // 간단한 stat 명령으로 연결 확인
                await this.client.list(config.remotePath);
                if (DEBUG_MODE) console.log(`Keep-Alive: 연결 정상 - ${config.host}`);
            } catch (error) {
                this.log(`Keep-Alive 실패: ${error}`);
                // 연결 끊김 감지 - 자동 재연결 시도
                if (!this.reconnecting) {
                    await this.attemptReconnect();
                }
            }
        }, interval);
        
        if (DEBUG_MODE) console.log(`Keep-Alive 타이머 시작: ${interval}ms 간격`);
    }

    /**
     * Keep-Alive 타이머 중지
     */
    private stopKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
            if (DEBUG_MODE) console.log('Keep-Alive 타이머 중지');
        }
    }

    /**
     * 자동 재연결 시도
     */
    private async attemptReconnect(): Promise<void> {
        if (this.reconnecting || !this.lastConfig) {
            return;
        }
        
        this.reconnecting = true;
        this.connected = false;
        this.log(`자동 재연결 시도 중: ${this.lastConfig.host}...`);
        
        // Keep-Alive 타이머 중지 (재연결 시 새로 시작됨)
        this.stopKeepAlive();
        
        try {
            // 기존 연결 정리
            if (this.client) {
                try {
                    await this.client.end();
                } catch (error) {
                    // 이미 끊어진 연결이면 무시
                }
                this.client = null;
            }
            
            // 새 클라이언트 생성 및 재연결
            this.client = new SftpClient2();
            const connectConfig: any = {
                host: this.lastConfig.host,
                port: this.lastConfig.port,
                username: this.lastConfig.username,
                connectTimeout: this.lastConfig.connectTimeout || 10000,
                readyTimeout: this.lastConfig.readyTimeout || 20000,
                keepaliveInterval: this.lastConfig.keepaliveInterval || 10000,
                keepaliveCountMax: this.lastConfig.keepaliveCountMax || 3,
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

            if (this.lastConfig.privateKey) {
                connectConfig.privateKey = fs.readFileSync(this.lastConfig.privateKey);
                if (this.lastConfig.passphrase) {
                    connectConfig.passphrase = this.lastConfig.passphrase;
                }
            } else if (this.lastConfig.password) {
                connectConfig.password = this.lastConfig.password;
            }

            await this.client.connect(connectConfig);
            this.connected = true;
            
            // Keep-Alive 타이머 재시작
            this.startKeepAlive(this.lastConfig);
            
            this.log(`✅ 자동 재연결 성공: ${this.lastConfig.host}`);
            
            // 사용자에게 알림
            vscode.window.showInformationMessage(
                `🔄 SFTP 재연결 성공: ${this.lastConfig.name || this.lastConfig.host}`
            );
        } catch (error) {
            this.log(`❌ 자동 재연결 실패: ${error}`);
            this.connected = false;
            this.client = null;
            
            // 사용자에게 알림
            vscode.window.showWarningMessage(
                `⚠️ SFTP 재연결 실패: ${this.lastConfig.name || this.lastConfig.host}\n수동으로 재연결해주세요.`
            );
        } finally {
            this.reconnecting = false;
        }
    }
//#endregion

    /**
     * 폴더 동기화 - 로컬과 원격 간 파일 동기화
     * @param localFolder 로컬 폴더 경로
     * @param remotePath 원격 폴더 경로
     * @param config SFTP 설정
     * @param direction 'local-to-remote' | 'remote-to-local' | 'both'
     * @param deleteRemoved 삭제된 파일도 동기화할지 여부
     * @param progressCallback 진행 상황 콜백
     * @returns 동기화 결과
     */
    async syncFolder(
        localFolder: string,
        remotePath: string,
        config: SftpConfig,
        direction: 'local-to-remote' | 'remote-to-local' | 'both' = 'local-to-remote',
        deleteRemoved: boolean = false,
        progressCallback?: (current: number, total: number, fileName: string) => void
    ): Promise<{ uploaded: number; downloaded: number; deleted: number; failed: string[] }> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        const result = {
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            failed: [] as string[]
        };

        try {
            // 로컬 → 원격 동기화 선택한 로컬폴더 확인
            if (direction === 'local-to-remote' || direction === 'both') {
                const localFiles = this.getAllFiles(localFolder, config.ignore || []);
                const total = localFiles.length;
                
                this.log(`로컬 → 원격 동기화 시작: ${total}개 파일`);
                
                for (let i = 0; i < localFiles.length; i++) {
                    const localFile = localFiles[i];
                    const relativePath = path.relative(localFolder, localFile).replace(/\\/g, '/');
                    const remoteFilePath = path.posix.join(remotePath, relativePath);
                    
                    if (progressCallback) {
                        progressCallback(i + 1, total, path.basename(localFile));
                    }
                    
                    try {
                        // 원격 디렉토리 생성
                        const remoteDir = path.posix.dirname(remoteFilePath);
                        await this.ensureRemoteDir(remoteDir);
                        
                        // 파일 업로드
                        const success = await this.uploadFile(localFile, remoteFilePath, config);
                        if (success) {
                            result.uploaded++;
                            this.log(`업로드 성공: ${relativePath}`);
                        }
                    } catch (error) {
                        result.failed.push(localFile);
                        this.log(`업로드 실패: ${localFile} - ${error}`);
                    }
                }
            }

            // 원격 → 로컬 동기화
            if (direction === 'remote-to-local' || direction === 'both') {
                this.log(`원격 → 로컬 동기화 시작`);
                await this.downloadFolderRecursive(remotePath, localFolder, config, result, progressCallback);
            }

            // 삭제된 파일 처리
            if (deleteRemoved && this.client) {
                if (direction === 'local-to-remote' || direction === 'both') {
                    // 원격에서 로컬에 없는 파일 삭제
                    await this.deleteRemovedFilesOnRemote(localFolder, remotePath, config, result);
                }
                
                if (direction === 'remote-to-local' || direction === 'both') {
                    // 로컬에서 원격에 없는 파일 삭제
                    await this.deleteRemovedFilesOnLocal(localFolder, remotePath, config, result);
                }
            }

            this.log(`동기화 완료: 업로드=${result.uploaded}, 다운로드=${result.downloaded}, 삭제=${result.deleted}, 실패=${result.failed.length}`);
            
        } catch (error) {
            this.log(`동기화 오류: ${error}`);
            throw error;
        }

        return result;
    }

    /**
     * 원격 폴더를 재귀적으로 다운로드
     */
    private async downloadFolderRecursive(
        remotePath: string,
        localFolder: string,
        config: SftpConfig,
        result: { uploaded: number; downloaded: number; deleted: number; failed: string[] },
        progressCallback?: (current: number, total: number, fileName: string) => void
    ): Promise<void> {
        if (!this.client) return;

        try {
            const remoteFiles = await this.client.list(remotePath);
            
            for (const fileInfo of remoteFiles) {
                const remoteFilePath = path.posix.join(remotePath, fileInfo.name);
                const localFilePath = path.join(localFolder, remoteFilePath.replace(/\//g, path.sep));
                
                if (fileInfo.type === 'd') {
                    // 디렉토리 재귀 처리
                    if (!fs.existsSync(localFilePath)) {
                        fs.mkdirSync(localFilePath, { recursive: true });
                    }
                    await this.downloadFolderRecursive(remoteFilePath, localFilePath, config, result, progressCallback);
                } else {
                    // 파일 다운로드
                    try {
                        // 로컬 파일이 없거나 수정시간이 다르면 다운로드
                        let shouldDownload = false;
                        
                        if (!fs.existsSync(localFilePath)) {
                            shouldDownload = true;
                        } else {
                            const localStats = fs.statSync(localFilePath);
                            const remoteModifyTime = new Date(fileInfo.modifyTime).getTime();
                            const localModifyTime = localStats.mtime.getTime();
                            
                            // 시간 차이가 1초 이상이면 다운로드
                            if (Math.abs(remoteModifyTime - localModifyTime) > 1000) {
                                shouldDownload = true;
                            }
                        }
                        
                        if (shouldDownload) {
                            if (progressCallback) {
                                progressCallback(result.downloaded + 1, 0, fileInfo.name);
                            }
                            
                            // 로컬 디렉토리가 없으면 생성
                            const localDir = path.dirname(localFilePath);
                            if (!fs.existsSync(localDir)) {
                                fs.mkdirSync(localDir, { recursive: true });
                            }
                            
                            await this.client.get(remoteFilePath, localFilePath);
                            await this.saveRemoteFileMetadata(remoteFilePath, localFilePath, config, config.workspaceRoot);
                            result.downloaded++;
                            this.log(`다운로드 성공: ${fileInfo.name}`);
                        }
                    } catch (error) {
                        result.failed.push(remoteFilePath);
                        this.log(`다운로드 실패: ${remoteFilePath} - ${error}`);
                    }
                }
            }
        } catch (error) {
            this.log(`폴더 목록 조회 실패: ${remotePath} - ${error}`);
        }
    }

    /**
     * 원격에서 로컬에 없는 파일 삭제
     */
    private async deleteRemovedFilesOnRemote(
        localFolder: string,
        remotePath: string,
        config: SftpConfig,
        result: { uploaded: number; downloaded: number; deleted: number; failed: string[] }
    ): Promise<void> {
        if (!this.client) return;

        try {
            const remoteFiles = await this.listRemoteFilesRecursive(remotePath);
            const localFiles = this.getAllFiles(localFolder, config.ignore || []);
            
            // 로컬 파일의 상대 경로 목록 생성
            const localRelativePaths = new Set(
                localFiles.map(f => path.relative(localFolder, f).replace(/\\/g, '/'))
            );
            
            // 원격에만 있는 파일 찾기
            for (const remoteFile of remoteFiles) {
                const relativePath = remoteFile.path.substring(remotePath.length).replace(/^\//, '');
                
                if (!localRelativePaths.has(relativePath)) {
                    try {
                        await this.deleteRemoteFile(remoteFile.path, remoteFile.isDirectory);
                        result.deleted++;
                        this.log(`원격 파일 삭제: ${remoteFile.path}`);
                    } catch (error) {
                        this.log(`원격 파일 삭제 실패: ${remoteFile.path} - ${error}`);
                    }
                }
            }
        } catch (error) {
            this.log(`원격 삭제 파일 처리 실패: ${error}`);
        }
    }

    /**
     * 로컬에서 원격에 없는 파일 삭제
     */
    private async deleteRemovedFilesOnLocal(
        localFolder: string,
        remotePath: string,
        config: SftpConfig,
        result: { uploaded: number; downloaded: number; deleted: number; failed: string[] }
    ): Promise<void> {
        if (!this.client) return;

        try {
            const remoteFiles = await this.listRemoteFilesRecursive(remotePath);
            const localFiles = this.getAllFiles(localFolder, config.ignore || []);
            
            // 원격 파일의 상대 경로 목록 생성
            const remoteRelativePaths = new Set(
                remoteFiles
                    .filter(f => !f.isDirectory)
                    .map(f => f.path.substring(remotePath.length).replace(/^\//, ''))
            );
            
            // 로컬에만 있는 파일 찾기
            for (const localFile of localFiles) {
                const relativePath = path.relative(localFolder, localFile).replace(/\\/g, '/');
                
                if (!remoteRelativePaths.has(relativePath)) {
                    try {
                        fs.unlinkSync(localFile);
                        result.deleted++;
                        this.log(`로컬 파일 삭제: ${localFile}`);
                    } catch (error) {
                        this.log(`로컬 파일 삭제 실패: ${localFile} - ${error}`);
                    }
                }
            }
        } catch (error) {
            this.log(`로컬 삭제 파일 처리 실패: ${error}`);
        }
    }

    /**
     * 원격 파일 목록을 재귀적으로 가져오기
     */
    private async listRemoteFilesRecursive(remotePath: string): Promise<RemoteFile[]> {
        if (!this.client) return [];

        const result: RemoteFile[] = [];
        
        try {
            const files = await this.client.list(remotePath);
            
            for (const fileInfo of files) {
                const filePath = path.posix.join(remotePath, fileInfo.name);
                const remoteFile: RemoteFile = {
                    name: fileInfo.name,
                    path: filePath,
                    isDirectory: fileInfo.type === 'd',
                    size: fileInfo.size,
                    modifyTime: new Date(fileInfo.modifyTime)
                };
                
                result.push(remoteFile);
                
                if (fileInfo.type === 'd') {
                    const subFiles = await this.listRemoteFilesRecursive(filePath);
                    result.push(...subFiles);
                }
            }
        } catch (error) {
            this.log(`원격 파일 목록 조회 실패: ${remotePath} - ${error}`);
        }
        
        return result;
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

    /**
     * 원격에 새 파일 생성
     */
    async createRemoteFile(remotePath: string, content: string = ''): Promise<void> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        // 빈 파일 생성 (Buffer로 전송)
        await this.client.put(Buffer.from(content, 'utf-8'), remotePath);
        this.log(`파일 생성 완료: ${remotePath}`);
    }

    /**
     * 원격에 새 폴더 생성
     */
    async createRemoteFolder(remotePath: string): Promise<void> {
        if (!this.client) {
            throw new Error('SFTP 클라이언트가 연결되지 않았습니다.');
        }

        await this.client.mkdir(remotePath, false);
        this.log(`폴더 생성 완료: ${remotePath}`);
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

    /**
     * 로컬 파일 백업
     * @param localPath 백업할 로컬 파일 경로
     * @param config 서버 설정
     */
    async backupLocalFile(localPath: string, config: SftpConfig): Promise<void> {
        if (DEBUG_MODE) console.log(`백업 ${localPath}`);

        try {
            const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return;
            }

            if(config.downloadBackup == "" ) return; // 백업 비활성화
            
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
            
            if (DEBUG_MODE) console.log(`백업 완료: ${backupFilePath}`);
            
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
                    if (DEBUG_MODE) console.log(`오래된 백업 삭제: ${backupFiles[i].name}`);
                }
            }
        } catch (error) {
            console.error('백업 실패:', error);
            // Backup failure should not stop the download
        }
    }

}
