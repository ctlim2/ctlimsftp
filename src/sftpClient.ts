import SftpClient2 from 'ssh2-sftp-client';
import { Client } from 'ssh2';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SftpConfig, RemoteFile, FileMetadata } from './types';
import { config } from 'process';
import { i18n } from './i18n';

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = false;

export class SftpClient {
    public client: SftpClient2 | null = null;
    private connected: boolean = false;
    private outputChannel: vscode.OutputChannel | null = null;
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
            readyTimeout: 20000,  // 연결 준비 타임아웃 (20초)
            strictVendor: false,  // 엄격한 벤더 체크 비활성화
            debug: DEBUG_MODE ? (info: string) => this.log(`[SSH2] ${info}`) : undefined,
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
            // Check for hop configuration (Jump Host)
            if (config.hop) {
                try {
                    this.log(i18n.t('server.connectingToHop', { host: config.hop.host }));
                    
                    const hopClient = new Client();
                    const hopConfig: any = {
                        host: config.hop.host,
                        port: config.hop.port || 22,
                        username: config.hop.username,
                        readyTimeout: 20000
                    };
                    
                    if (config.hop.privateKey) {
                        hopConfig.privateKey = fs.readFileSync(config.hop.privateKey);
                        if (config.hop.passphrase) {
                            hopConfig.passphrase = config.hop.passphrase;
                        }
                    } else if (config.hop.password) {
                        hopConfig.password = config.hop.password;
                    }
                    
                    const stream = await new Promise<any>((resolve, reject) => {
                        hopClient.on('ready', () => {
                            this.log(i18n.t('server.hopConnected'));
                            hopClient.forwardOut(
                                '127.0.0.1', 
                                12345, 
                                config.host, 
                                config.port, 
                                (err, stream) => {
                                    if (err) reject(err);
                                    else resolve(stream);
                                }
                            );
                        }).on('error', (err) => {
                            reject(err);
                        }).connect(hopConfig);
                    });
                    
                    connectConfig.sock = stream;
                    this.log(i18n.t('server.tunnelCreated'));
                    
                } catch (error) {
                    this.log(i18n.t('error.hopConnectionFailed', { error: String(error) }));
                    throw error;
                }
            } else {
                // Password가 설정에 없으면 사용자에게 입력 요청
                let password = config.password;
                if (!password) {
                    password = await vscode.window.showInputBox({
                        prompt: i18n.t('prompt.enterPasswordForHost', { host: config.host }),
                        password: true,
                        placeHolder: 'Password',
                        ignoreFocusOut: true
                    });
                    
                    if (!password) {
                        throw new Error(i18n.t('error.passwordRequired'));
                    }
                }
                connectConfig.password = password;
            }
        }

        await this.client.connect(connectConfig);
        this.connected = true;
        
        this.log(i18n.t('server.connectedDetailed', { host: config.host, port: config.port }));
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
            this.lastConfig = null;
        }
    }

    /**
     * 수동 재연결 시도
     */
    async attemptReconnect(): Promise<void> {
        if (this.reconnecting || !this.lastConfig) {
            return;
        }
        
        this.reconnecting = true;
        this.connected = false;
        this.log(i18n.t('server.reconnectingHost', { host: this.lastConfig.host }));
        
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
            
            this.log(i18n.t('server.reconnectedHost', { host: this.lastConfig.host }));
            
            // 사용자에게 알림
            vscode.window.showInformationMessage(
                i18n.t('server.reconnectedInfo', { serverName: this.lastConfig.name || this.lastConfig.host })
            );
        } catch (error) {
            this.log(i18n.t('server.reconnectFailedError', { error: String(error) }));
            this.connected = false;
            this.client = null;
            
            // 사용자에게 알림
            vscode.window.showWarningMessage(
                i18n.t('server.reconnectFailedWarning', { serverName: this.lastConfig.name || this.lastConfig.host })
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
            throw new Error(i18n.t('error.sfptClientNotConnected'));
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
                
                this.log(i18n.t('sync.localToRemoteStarted', { count: total }));
                
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
                            this.log(i18n.t('file.uploadSuccessRelative', { path: relativePath }));
                        }
                    } catch (error) {
                        result.failed.push(localFile);
                        this.log(i18n.t('file.uploadFailedError', { file: localFile, error: String(error) }));
                    }
                }
            }

            // 원격 → 로컬 동기화
            if (direction === 'remote-to-local' || direction === 'both') {
                this.log(i18n.t('sync.remoteToLocalStarted'));
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

            this.log(i18n.t('sync.completedDetailed', { 
                uploaded: result.uploaded, 
                downloaded: result.downloaded, 
                deleted: result.deleted, 
                failed: result.failed.length 
            }));
            
        } catch (error) {
            this.log(i18n.t('sync.error', { error: String(error) }));
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
                            this.log(i18n.t('file.downloadSuccessName', { name: fileInfo.name }));
                        }
                    } catch (error) {
                        result.failed.push(remoteFilePath);
                        this.log(i18n.t('file.downloadFailedPath', { path: remoteFilePath, error: String(error) }));
                    }
                }
            }
        } catch (error) {
            this.log(i18n.t('error.listFolderFailed', { path: remotePath, error: String(error) }));
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
                        this.log(i18n.t('file.remoteDeleted', { path: remoteFile.path }));
                    } catch (error) {
                        this.log(i18n.t('error.remoteDeleteFailed', { path: remoteFile.path, error: String(error) }));
                    }
                }
            }
        } catch (error) {
            this.log(i18n.t('error.remoteRemoveProcessFailed', { error: String(error) }));
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
                        this.log(i18n.t('file.localDeleted', { path: localFile }));
                    } catch (error) {
                        this.log(i18n.t('error.localDeleteFailed', { path: localFile, error: String(error) }));
                    }
                }
            }
        } catch (error) {
            this.log(i18n.t('error.localRemoveProcessFailed', { error: String(error) }));
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
            this.log(i18n.t('error.listRemoteFilesFailed', { path: remotePath, error: String(error) }));
        }
        
        return result;
    }
    
    /**
     * 원격 디렉토리를 재귀적으로 생성
     * @param remotePath 생성할 디렉토리 경로
     */
    private async ensureRemoteDir(remotePath: string): Promise<void> {
        if (!this.client) {
            return;
        }

        try {
            // 먼저 디렉토리가 존재하는지 확인
            const exists = await this.client.exists(remotePath);
            if (exists) {
                if (DEBUG_MODE) console.log(`remote dir exists: ${remotePath}`);
                return;
            }

            // 재귀적으로 디렉토리 생성
            if (DEBUG_MODE) console.log(`creating remote dir: ${remotePath}`);
            await this.client.mkdir(remotePath, true);
            if (DEBUG_MODE) console.log(`remote mkdir success: ${remotePath}`);
        } catch (error: any) {
            // "File already exists" 에러는 무시 (경쟁 조건)
            if (error.message && error.message.includes('already exists')) {
                if (DEBUG_MODE) console.log(`remote dir already exists: ${remotePath}`);
                return;
            }
            
            // 다른 에러는 로그 출력하고 재시도
            this.log(i18n.t('error.mkdirFailed', { path: remotePath, error: error.message || String(error) }));
            
            // 부모 디렉토리부터 순차적으로 생성 시도
            try {
                const parts = remotePath.split('/').filter(p => p);
                let currentPath = '/';
                
                for (const part of parts) {
                    currentPath = path.posix.join(currentPath, part);
                    
                    try {
                        const exists = await this.client.exists(currentPath);
                        if (!exists) {
                            await this.client.mkdir(currentPath, false);
                            if (DEBUG_MODE) console.log(`created: ${currentPath}`);
                        }
                    } catch (mkdirError: any) {
                        // 이미 존재하면 무시
                        if (!mkdirError.message?.includes('already exists')) {
                            throw mkdirError;
                        }
                    }
                }
            } catch (fallbackError) {
                this.log(i18n.t('error.recursiveMkdirFailed', { error: String(fallbackError) }));
                throw fallbackError;
            }
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
            throw new Error(i18n.t('error.sfptClientNotConnected'));
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
            console.error(i18n.t('error.listRemoteFilesFailed', { path: remotePath, error: String(error) }));
            return [];
        }
    }

    async deleteRemoteFile(remotePath: string, isDirectory: boolean = false): Promise<void> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        if (isDirectory) {
            await this.client.rmdir(remotePath, true);
        } else {
            await this.client.delete(remotePath);
        }
    }

    private activeStreams: Map<string, any> = new Map();

    /**
     * 원격 파일 실시간 감시 (tail -f)
     * @param remotePath 감시할 원격 파일 경로
     * @param callback 데이터 수신 시 호출될 콜백 함수
     * @returns 스트림 제어 객체 (stop 메서드 포함)
     */
    async watchRemoteFile(remotePath: string, callback: (data: string) => void): Promise<{ stop: () => void }> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        // @ts-ignore - Accessing internal ssh2 client
        const sshClient = this.client.client;
        
        if (!sshClient) {
            throw new Error(i18n.t('error.sshClientNotAvailable'));
        }

        // 이미 감시 중인 경우 중지
        if (this.activeStreams.has(remotePath)) {
            const existingStream = this.activeStreams.get(remotePath);
            try {
                existingStream.close();
            } catch (e) {
                // Ignore error
            }
            this.activeStreams.delete(remotePath);
        }

        this.log(i18n.t('log.startWatching', { path: remotePath }));

        return new Promise((resolve, reject) => {
            // tail -f 실행
            sshClient.exec(`tail -f "${remotePath}"`, (err: any, stream: any) => {
                if (err) {
                    return reject(err);
                }

                this.activeStreams.set(remotePath, stream);

                stream.on('close', (code: any, signal: any) => {
                    this.log(i18n.t('log.stopWatching', { path: remotePath }));
                    this.activeStreams.delete(remotePath);
                }).on('data', (data: any) => {
                    const text = data.toString();
                    callback(text);
                }).stderr.on('data', (data: any) => {
                    const text = data.toString();
                    callback(`[STDERR] ${text}`);
                });

                resolve({
                    stop: () => {
                        stream.close(); // ssh2 stream close
                        // kill process if needed? stream.close() sends EOF usually.
                        // sending Ctrl+C might be needed for tail -f to stop gracefully on server side
                        try {
                            stream.write('\x03');
                        } catch(e) {
                            // nothing
                        } 
                    }
                });
            });
        });
    }

    /**
     * 원격 파일 감시 중지
     */
    stopWatchingRemoteFile(remotePath: string): void {
        const stream = this.activeStreams.get(remotePath);
        if (stream) {
            try {
                // Send Ctrl+C to stop the process
                stream.write('\x03');
                stream.close();
            } catch (error) {
                // Ignore
            }
            this.activeStreams.delete(remotePath);
        }
    }

    /**
     * 원격 파일명 검색 (재귀적)
     * @param remotePath 검색 시작 경로
     * @param pattern 검색 패턴 (문자열 또는 정규식)
     * @param isRegex 정규식 사용 여부
     * @param maxResults 최대 결과 개수
     * @returns 검색된 파일 목록
     */
    async searchRemoteFilesByName(
        remotePath: string,
        pattern: string,
        isRegex: boolean = false,
        maxResults: number = 100
    ): Promise<RemoteFile[]> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        const results: RemoteFile[] = [];
        const regex = isRegex ? new RegExp(pattern, 'i') : null;

        const searchRecursive = async (currentPath: string): Promise<void> => {
            if (results.length >= maxResults) {
                return;
            }

            try {
                const files = await this.client!.list(currentPath);

                for (const fileInfo of files) {
                    if (results.length >= maxResults) {
                        break;
                    }

                    const filePath = path.posix.join(currentPath, fileInfo.name);
                    
                    // 검색 패턴 매칭
                    const matches = regex 
                        ? regex.test(fileInfo.name)
                        : fileInfo.name.toLowerCase().includes(pattern.toLowerCase());

                    if (matches && fileInfo.type !== 'd') {
                        results.push({
                            name: fileInfo.name,
                            path: filePath,
                            isDirectory: false,
                            size: fileInfo.size,
                            modifyTime: new Date(fileInfo.modifyTime)
                        });
                    }

                    // 디렉토리면 재귀 탐색
                    if (fileInfo.type === 'd' && fileInfo.name !== '.' && fileInfo.name !== '..') {
                        await searchRecursive(filePath);
                    }
                }
            } catch (error) {
                this.log(i18n.t('search.error', { path: currentPath, error: String(error) }));
            }
        };

        await searchRecursive(remotePath);
        return results;
    }

    /**
     * 원격 파일 내용 검색 (Grep 사용으로 최적화)
     * @param remotePath 검색 시작 경로
     * @param searchText 검색할 텍스트
     * @param isRegex 정규식 사용 여부
     * @param filePattern 검색할 파일 패턴 (예: *.php, *.js)
     * @param maxResults 최대 결과 개수
     * @returns 검색된 파일 목록 (일치하는 줄 번호 포함)
     */
    async searchInRemoteFiles(
        remotePath: string,
        searchText: string,
        isRegex: boolean = false,
        filePattern: string = '*',
        maxResults: number = 100
    ): Promise<Array<{ file: RemoteFile; matches: Array<{ line: number; text: string }> }>> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        // @ts-ignore - Accessing internal ssh2 client
        const sshClient = this.client.client;
        
        // SSH 클라이언트를 사용할 수 없는 경우 (순수 SFTP만 있는 경우 등) 기존 방식 폴백
        if (!sshClient) {
            this.log('SSH client execution not available, falling back to slow search');
            return this.searchInRemoteFilesSlow(remotePath, searchText, isRegex, filePattern, maxResults);
        }

        try {
            // Grep 명령어 구성
            // -r: 재귀적, -n: 줄번호, -I: 바이너리 무시, -H: 파일명 출력
            // -E: 확장 정규식 (정규식 검색 시)
            const grepFlag = isRegex ? '-E' : '-F'; // -F: 고정 문자열(빠름)
            
            // 파일 패턴 처리 (--include)
            // filePattern이 '*'이면 모든 파일, 아니면 해당 패턴
            // 여러 패턴인 경우 콤마로 구분되어 있을 수 있음
            const includeParts = filePattern.split(',').map(p => p.trim());
            const includeFlags = includeParts.map(p => `--include="${p}"`).join(' ');
            
            // 검색어 이스케이프 (따옴표 처리)
            const safeSearchText = searchText.replace(/"/g, '\\"');
            
            // 명령어 조합
            // head -n X 로 결과 개수 제한 (파일 수가 아니라 매치 라인 수 제한이긴 함)
            const command = `grep ${grepFlag}rnIH ${includeFlags} "${safeSearchText}" "${remotePath}" | head -n ${maxResults * 10}`;
            
            if (DEBUG_MODE) console.log(`Executing grep: ${command}`);
            console.log(`Executing grep: ${command}`);

            const output = await this.executeCommand(command);
            
            // 결과 파싱
            const results: Map<string, { file: RemoteFile; matches: Array<{ line: number; text: string }> }> = new Map();
            const lines = output.split('\n');
            let matchCount = 0;

            for (const line of lines) {
                if (!line || matchCount >= maxResults) continue;

                // grep 출력 형식: filename:line:content
                // 파일명에 콜론이 있을 수 있으므로 첫 두 콜론만 분리
                const parts = line.split(':');
                if (parts.length < 3) continue;

                const filePath = parts[0];
                const lineNumber = parseInt(parts[1], 10);
                const content = parts.slice(2).join(':');

                if (isNaN(lineNumber)) continue;

                // 이미 결과에 있는 파일인지 확인
                if (!results.has(filePath)) {
                    if (results.size >= maxResults) continue;
                    
                    const fileName = path.posix.basename(filePath);
                    results.set(filePath, {
                        file: {
                            name: fileName,
                            path: filePath,
                            isDirectory: false,
                            // grep으로는 크기/시간을 알 수 없으므로 기본값
                            // 필요하면 stat으로 추가 조회할 수 있으나 속도를 위해 생략
                        },
                        matches: []
                    });
                }

                const fileResult = results.get(filePath);
                if (fileResult && fileResult.matches.length < 10) { // 파일당 최대 10개 매치만 표시
                    fileResult.matches.push({
                        line: lineNumber,
                        text: content.trim()
                    });
                    matchCount++;
                }
            }

            return Array.from(results.values());

        } catch (error) {
            console.error('Grep search failed:', error);
            this.log(i18n.t('search.grepFailed', { error: String(error) }));
            // 실패 시 느린 방식으로 폴백
            return this.searchInRemoteFilesSlow(remotePath, searchText, isRegex, filePattern, maxResults);
        }
    }

    /**
     * 원격 파일 내용 검색 (기존 느린 방식 - 폴백용)
     */
    async searchInRemoteFilesSlow(
        remotePath: string,
        searchText: string,
        isRegex: boolean = false,
        filePattern: string = '*',
        maxResults: number = 50
    ): Promise<Array<{ file: RemoteFile; matches: Array<{ line: number; text: string }> }>> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        const results: Array<{ file: RemoteFile; matches: Array<{ line: number; text: string }> }> = [];
        const regex = isRegex ? new RegExp(searchText, 'gi') : null;
        
        // 파일 패턴을 정규식으로 변환
        const fileRegex = new RegExp(
            filePattern
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.'),
            'i'
        );

        const searchRecursive = async (currentPath: string): Promise<void> => {
            if (results.length >= maxResults) {
                return;
            }

            try {
                const files = await this.client!.list(currentPath);

                for (const fileInfo of files) {
                    if (results.length >= maxResults) {
                        break;
                    }

                    const filePath = path.posix.join(currentPath, fileInfo.name);

                    if (fileInfo.type === 'd' && fileInfo.name !== '.' && fileInfo.name !== '..') {
                        await searchRecursive(filePath);
                    } else if (fileInfo.type !== 'd') {
                        // 파일 패턴 확인
                        if (!fileRegex.test(fileInfo.name)) {
                            continue;
                        }

                        try {
                            // 파일 다운로드 (메모리로)
                            const buffer = await this.client!.get(filePath);
                            const content = buffer.toString('utf-8');
                            const lines = content.split('\n');
                            const matches: Array<{ line: number; text: string }> = [];

                            // 각 줄 검색
                            for (let i = 0; i < lines.length; i++) {
                                const lineText = lines[i];
                                const hasMatch = regex
                                    ? regex.test(lineText)
                                    : lineText.toLowerCase().includes(searchText.toLowerCase());

                                if (hasMatch) {
                                    matches.push({
                                        line: i + 1,
                                        text: lineText.trim()
                                    });

                                    // 너무 많은 매칭은 제한
                                    if (matches.length >= 10) {
                                        break;
                                    }
                                }
                            }

                            if (matches.length > 0) {
                                results.push({
                                    file: {
                                        name: fileInfo.name,
                                        path: filePath,
                                        isDirectory: false,
                                        size: fileInfo.size,
                                        modifyTime: new Date(fileInfo.modifyTime)
                                    },
                                    matches
                                });
                            }
                        } catch (fileError) {
                            // 바이너리 파일이나 읽기 실패 파일 무시
                            if (DEBUG_MODE) console.log(`파일 읽기 실패: ${filePath}`);
                        }
                    }
                }
            } catch (error) {
                this.log(i18n.t('search.contentError', { path: currentPath, error: String(error) }));
            }
        };

        await searchRecursive(remotePath);
        return results;
    }

    /**
     * 원격에 새 파일 생성
     */
    async createRemoteFile(remotePath: string, content: string = ''): Promise<void> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        // 빈 파일 생성 (Buffer로 전송)
        await this.client.put(Buffer.from(content, 'utf-8'), remotePath);
        this.log(i18n.t('file.created', { path: remotePath }));
    }

    /**
     * 원격에 새 폴더 생성
     */
    async createRemoteFolder(remotePath: string): Promise<void> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        await this.client.mkdir(remotePath, false);
        this.log(i18n.t('file.folderCreated', { path: remotePath }));
    }

    /**
     * 원격 명령 실행
     * @param command 실행할 쉘 명령어
     * @returns 명령어 실행 결과 (stdout)
     */
    async executeCommand(command: string): Promise<string> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        this.log(i18n.t('command.executing', { command }));
        
        // ssh2-sftp-client does not support exec directly, but we can use the underlying ssh2 client
        // However, sftp-client wrapper might not expose it easily or safely.
        // Let's check if we can access the ssh2 client.
        // Sadly, the library creates its own connection and hides it mostly.
        // But looking at the source or types, 'client' property is the ssh2 Client instance.
        
        // @ts-ignore - Accessing internal ssh2 client
        const sshClient = this.client.client;
        
        if (!sshClient) {
            throw new Error(i18n.t('error.sshClientNotAvailable'));
        }

        return new Promise((resolve, reject) => {
            sshClient.exec(command, (err: any, stream: any) => {
                if (err) {
                    return reject(err);
                }
                
                let output = '';
                let errorOutput = '';
                
                stream.on('close', (code: any, signal: any) => {
                    if (code === 0) {
                        resolve(output);
                    } else {
                        reject(new Error(`Command failed with code ${code}: ${errorOutput || output}`));
                    }
                }).on('data', (data: any) => {
                    output += data;
                }).stderr.on('data', (data: any) => {
                    errorOutput += data;
                });
            });
        });
    }

    /**
     * 원격 파일/폴더 권한 변경 (chmod)
     * @param remotePath 원격 경로
     * @param mode 권한 모드 (8진수 문자열: '755', '644' 등)
     */
    async changeFilePermissions(remotePath: string, mode: string): Promise<void> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        // 8진수 문자열을 숫자로 변환
        const modeNumber = parseInt(mode, 8);
        
        if (isNaN(modeNumber)) {
            throw new Error(i18n.t('file.invalidPermission', { mode }));
        }

        await this.client.chmod(remotePath, modeNumber);
        this.log(i18n.t('file.permissionChanged', { path: remotePath, mode }));
    }

    /**
     * 원격 파일/폴더 권한 조회
     * @param remotePath 원격 경로
     * @returns 권한 모드 (8진수 문자열)
     */
    async getFilePermissions(remotePath: string): Promise<string> {
        if (!this.client) {
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        const stats = await this.client.stat(remotePath);
        // mode를 8진수 문자열로 변환 (마지막 3자리만)
        const mode = (stats.mode & parseInt('777', 8)).toString(8).padStart(3, '0');
        return mode;
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
            this.log(i18n.t('error.metadataSaveFailed', { path: metadataPath }));
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
            throw new Error(i18n.t('error.sfptClientNotConnected'));
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
            vscode.window.showErrorMessage(i18n.t('error.noWorkspace'));
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
            throw new Error(i18n.t('error.sfptClientNotConnected'));
        }

        // Check if connection is still alive
        if (!this.isConnected()) {
            throw new Error(i18n.t('error.connectionLost'));
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
        // 원격 디렉토리가 존재하는지 확인하고 없으면 생성
        const remoteDir = path.posix.dirname(remotePath);
        await this.ensureRemoteDir(remoteDir);
        
        this.log(i18n.t('file.uploading', { local: localPath, remote: remotePath }));
        await this.client.put(localPath, remotePath);
        this.log(i18n.t('file.uploaded', { path: remotePath }));
        
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
        if (DEBUG_MODE) console.log(i18n.t('backup.start', { path: localPath }));

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
            
            if (DEBUG_MODE) console.log(i18n.t('backup.complete', { path: backupFilePath }));
            
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
                    if (DEBUG_MODE) console.log(i18n.t('backup.deletedOld', { name: backupFiles[i].name }));
                }
            }
        } catch (error) {
            console.error(i18n.t('backup.error'), error);
            // Backup failure should not stop the download
        }
    }

}
