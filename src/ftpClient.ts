import * as ftp from 'basic-ftp';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SftpConfig, RemoteFile, FileMetadata } from './types';

// 개발 모드 여부 (릴리스 시 false로 변경)
const DEBUG_MODE = true;

export class FtpClient {
    private client: ftp.Client | null = null;
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

    async connect(config: SftpConfig): Promise<void> {
        this.client = new ftp.Client();
        this.lastConfig = config;
        
        // FTP 디버그 로깅
        if (DEBUG_MODE) {
            this.client.ftp.verbose = true;
        }

        try {
            await this.client.access({
                host: config.host,
                port: config.port || 21,
                user: config.username,
                password: config.password,
                secure: config.protocol === 'ftps',
                secureOptions: config.protocol === 'ftps' ? {
                    rejectUnauthorized: false  // 자체 서명 인증서 허용
                } : undefined
            });
            
            this.connected = true;
            this.log(`FTP 서버 연결 성공: ${config.host}:${config.port || 21}`);
        } catch (error) {
            this.connected = false;
            this.log(`FTP 연결 실패: ${error}`);
            throw error;
        }
    }

    isConnected(): boolean {
        return this.connected && this.client !== null;
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.client.close();
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
        this.log(`FTP 재연결 시도 중: ${this.lastConfig.host}...`);
        
        try {
            // 기존 연결 정리
            if (this.client) {
                try {
                    this.client.close();
                } catch (error) {
                    // 이미 끊어진 연결이면 무시
                }
                this.client = null;
            }
            
            // 새 클라이언트 생성 및 재연결
            await this.connect(this.lastConfig);
            
            this.log(`✅ FTP 재연결 성공: ${this.lastConfig.host}`);
            
            // 사용자에게 알림
            vscode.window.showInformationMessage(
                `🔄 FTP 재연결 성공: ${this.lastConfig.name || this.lastConfig.host}`
            );
        } catch (error) {
            this.log(`❌ FTP 재연결 실패: ${error}`);
            this.connected = false;
            this.client = null;
            
            vscode.window.showWarningMessage(
                `⚠️ FTP 재연결 실패: ${this.lastConfig.name || this.lastConfig.host}\n다시 연결해주세요.`
            );
        } finally {
            this.reconnecting = false;
        }
    }

    /**
     * 파일 업로드
     */
    async uploadFile(localPath: string, remotePath: string, config: SftpConfig): Promise<boolean> {
        if (!this.client || !this.isConnected()) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            // 원격 디렉토리 생성
            const remoteDir = path.posix.dirname(remotePath);
            await this.ensureRemoteDir(remoteDir);
            
            this.log(`FTP 업로드 중: ${localPath} -> ${remotePath}`);
            await this.client.uploadFrom(localPath, remotePath);
            this.log(`FTP 업로드 완료: ${remotePath}`);
            
            // 메타데이터 저장
            const remoteMetadata = await this.getRemoteFileInfo(remotePath);
            this.saveFileMetadata(localPath, remotePath, remoteMetadata.remoteModifyTime, remoteMetadata.remoteFileSize, config);
            
            return true;
        } catch (error) {
            this.log(`FTP 업로드 실패: ${error}`);
            throw error;
        }
    }

    /**
     * 파일 다운로드
     */
    async downloadFile(remotePath: string, localPath: string, config: SftpConfig): Promise<void> {
        if (!this.client || !this.isConnected()) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            // 로컬 디렉토리 생성
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }

            this.log(`FTP 다운로드 중: ${remotePath} -> ${localPath}`);
            
            // 파일 다운로드
            const writable = fs.createWriteStream(localPath);
            await this.client.downloadTo(writable, remotePath);
            
            this.log(`FTP 다운로드 완료: ${localPath}`);
            
            // 메타데이터 저장
            await this.saveRemoteFileMetadata(remotePath, localPath, config);
        } catch (error) {
            this.log(`FTP 다운로드 실패: ${error}`);
            throw error;
        }
    }

    /**
     * 원격 파일 목록 조회
     */
    async listRemoteFiles(remotePath: string): Promise<RemoteFile[]> {
        if (!this.client || !this.isConnected()) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            const list = await this.client.list(remotePath);
            return list.map(item => ({
                name: item.name,
                path: path.posix.join(remotePath, item.name),
                isDirectory: item.type === 2,  // FileType.Directory
                size: item.size,
                modifyTime: item.modifiedAt ? new Date(item.modifiedAt) : new Date()
            }));
        } catch (error) {
            this.log(`FTP 파일 목록 조회 실패: ${remotePath} - ${error}`);
            return [];
        }
    }

    /**
     * 원격 파일 삭제
     */
    async deleteRemoteFile(remotePath: string, isDirectory: boolean = false): Promise<void> {
        if (!this.client || !this.isConnected()) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            if (isDirectory) {
                await this.client.removeDir(remotePath);
            } else {
                await this.client.remove(remotePath);
            }
            this.log(`FTP 파일 삭제 완료: ${remotePath}`);
        } catch (error) {
            this.log(`FTP 파일 삭제 실패: ${error}`);
            throw error;
        }
    }

    /**
     * 원격 디렉토리 생성 (재귀적)
     */
    private async ensureRemoteDir(remotePath: string): Promise<void> {
        if (!this.client) {
            return;
        }

        try {
            await this.client.ensureDir(remotePath);
            if (DEBUG_MODE) console.log(`FTP 디렉토리 생성/확인: ${remotePath}`);
        } catch (error) {
            this.log(`FTP 디렉토리 생성 실패: ${remotePath} - ${error}`);
            throw error;
        }
    }

    /**
     * 원격 파일 정보 조회
     */
    async getRemoteFileInfo(remotePath: string): Promise<{ remoteModifyTime: number; remoteFileSize: number }> {
        if (!this.client || !this.isConnected()) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            const remoteDir = path.posix.dirname(remotePath);
            const fileName = path.posix.basename(remotePath);
            
            const list = await this.client.list(remoteDir);
            const fileInfo = list.find(item => item.name === fileName);
            
            if (!fileInfo) {
                throw new Error(`파일을 찾을 수 없습니다: ${remotePath}`);
            }

            const remoteModifyTime = fileInfo.modifiedAt ? new Date(fileInfo.modifiedAt).getTime() : Date.now();
            const remoteFileSize = fileInfo.size;

            this.log(`FTP 파일 정보: ${remotePath} - mtime=${remoteModifyTime}, size=${remoteFileSize}`);
            
            return { remoteModifyTime, remoteFileSize };
        } catch (error) {
            this.log(`FTP 파일 정보 조회 실패: ${error}`);
            throw error;
        }
    }

    /**
     * 메타데이터 저장
     */
    async saveRemoteFileMetadata(remotePath: string, localPath: string, config: SftpConfig): Promise<void> {
        const remoteMetadata = await this.getRemoteFileInfo(remotePath);
        this.saveFileMetadata(localPath, remotePath, remoteMetadata.remoteModifyTime, remoteMetadata.remoteFileSize, config);
    }

    /**
     * 메타데이터 파일 저장 (SFTP와 호환)
     */
    saveFileMetadata(localPath: string, remotePath: string, remoteModifyTime: number, remoteFileSize: number, config: SftpConfig): void {
        const metadataPath = FtpClient.getMetadataPath(localPath, config);
        
        const metadata: FileMetadata = {
            remotePath,
            remoteModifyTime,
            remoteFileSize,
            localPath,
            downloadTime: Date.now(),
            configName: config.name
        };
        
        try {
            const metadataDir = path.dirname(metadataPath);
            if (!fs.existsSync(metadataDir)) {
                fs.mkdirSync(metadataDir, { recursive: true });
            }
            
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            this.log(`메타데이터 저장: ${metadataPath}`);
        } catch (error) {
            console.error('메타데이터 저장 실패:', error);
        }
    }

    /**
     * 메타데이터 경로 계산 (SFTP와 호환)
     */
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
        const safeLocalPath = FtpClient.makeMetafileName(localPath);
        return path.join(metadataDir, safeLocalPath);
    }

    /**
     * 메타데이터 비교
     */
    async isSameMetadata(localPath: string, remotePath: string, config: SftpConfig): Promise<boolean> {
        const metadataPath = FtpClient.getMetadataPath(localPath, config);
        
        if (!fs.existsSync(metadataPath)) {
            return false;
        }

        try {
            const fileContent = fs.readFileSync(metadataPath, 'utf-8');
            const localMetadata: FileMetadata = JSON.parse(fileContent);
            
            const remoteMetadata = await this.getRemoteFileInfo(remotePath);
            
            this.log(`메타데이터 비교:\n로컬 mtime=${localMetadata.remoteModifyTime}, size=${localMetadata.remoteFileSize}\n원격 mtime=${remoteMetadata.remoteModifyTime}, size=${remoteMetadata.remoteFileSize}`);
            
            return localMetadata.remoteModifyTime === remoteMetadata.remoteModifyTime &&
                   localMetadata.remoteFileSize === remoteMetadata.remoteFileSize;
        } catch (error) {
            return false;
        }
    }

    /**
     * 폴더 동기화
     */
    async syncFolder(
        localFolder: string,
        remotePath: string,
        config: SftpConfig,
        direction: 'local-to-remote' | 'remote-to-local' | 'both' = 'local-to-remote',
        deleteRemoved: boolean = false,
        progressCallback?: (current: number, total: number, fileName: string) => void
    ): Promise<{ uploaded: number; downloaded: number; deleted: number; failed: string[] }> {
        if (!this.client || !this.isConnected()) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        const result = {
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            failed: [] as string[]
        };

        try {
            // 로컬 → 원격 동기화
            if (direction === 'local-to-remote' || direction === 'both') {
                const localFiles = this.getAllFiles(localFolder, config.ignore || []);
                const total = localFiles.length;
                
                this.log(`FTP 로컬 → 원격 동기화 시작: ${total}개 파일`);
                
                for (let i = 0; i < localFiles.length; i++) {
                    const localFile = localFiles[i];
                    const relativePath = path.relative(localFolder, localFile).replace(/\\/g, '/');
                    const remoteFilePath = path.posix.join(remotePath, relativePath);
                    
                    if (progressCallback) {
                        progressCallback(i + 1, total, path.basename(localFile));
                    }
                    
                    try {
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

            this.log(`FTP 동기화 완료: 업로드=${result.uploaded}, 실패=${result.failed.length}`);
            
        } catch (error) {
            this.log(`FTP 동기화 오류: ${error}`);
            throw error;
        }

        return result;
    }

    /**
     * 로컬 파일 목록 수집
     */
    private getAllFiles(dir: string, ignore: string[]): string[] {
        const files: string[] = [];
        
        const walk = (currentPath: string) => {
            const items = fs.readdirSync(currentPath);
            
            for (const item of items) {
                const fullPath = path.join(currentPath, item);
                const relativePath = path.relative(dir, fullPath);
                
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

    /**
     * 로컬 파일 백업
     */
    async backupLocalFile(localPath: string, config: SftpConfig): Promise<void> {
        if (DEBUG_MODE) console.log(`백업: ${localPath}`);

        try {
            const workspaceRoot = config.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return;
            }

            if (config.downloadBackup === "") return;
            
            let remotePath = '';
            try {
                const metadataPath = FtpClient.getMetadataPath(localPath, config);
                if (fs.existsSync(metadataPath)) {
                    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                    remotePath = metadata.remotePath || '';
                }
            } catch (error) {
                // Metadata not found
            }

            const backupConfigPath = config.downloadBackup || '.vscode/.sftp-backup';
            const backupRootDir = path.isAbsolute(backupConfigPath) 
                ? backupConfigPath 
                : path.join(workspaceRoot, backupConfigPath);
            
            let backupDir = backupRootDir;
            if (remotePath) {
                const remoteDir = path.dirname(remotePath).replace(/^\/+/, '');
                backupDir = path.join(backupRootDir, remoteDir);
            }
            
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
            const fileName = path.basename(localPath);
            const backupFileName = `${fileName}.${timestamp}.backup`;
            const backupFilePath = path.join(backupDir, backupFileName);

            fs.copyFileSync(localPath, backupFilePath);
            
            if (DEBUG_MODE) console.log(`백업 완료: ${backupFilePath}`);
            
            // 오래된 백업 정리 (최근 5개만 유지)
            const backupPattern = new RegExp(`^${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\..*\\.backup$`);
            const backupFiles = fs.readdirSync(backupDir)
                .filter(f => backupPattern.test(f))
                .map(f => ({
                    name: f,
                    path: path.join(backupDir, f),
                    mtime: fs.statSync(path.join(backupDir, f)).mtime.getTime()
                }))
                .sort((a, b) => b.mtime - a.mtime);
            
            if (backupFiles.length > 5) {
                for (let i = 5; i < backupFiles.length; i++) {
                    fs.unlinkSync(backupFiles[i].path);
                    if (DEBUG_MODE) console.log(`오래된 백업 삭제: ${backupFiles[i].name}`);
                }
            }
        } catch (error) {
            console.error('백업 실패:', error);
        }
    }

    /**
     * 다운로드 폴더 경로 계산 (SFTP와 호환)
     */
    static getDownloadFolder(remotePath: string, workspaceFolder: string, config: SftpConfig, folderMake: boolean = true, isDir: boolean = true): string | null {
        const relativeToRemotePath = remotePath.startsWith(config.remotePath || '')
            ? remotePath.substring(config.remotePath.length).replace(/^\/+/, '')
            : path.basename(remotePath);
        
        const contextPath = config.context || './';
        const fullContextPath = path.isAbsolute(contextPath) 
            ? contextPath 
            : path.join(workspaceFolder, contextPath);
        
        const tempLocalPath = path.join(fullContextPath, relativeToRemotePath);
        const tempDir = path.dirname(tempLocalPath);
        
        if (folderMake && !fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        if (isDir) {
            return tempDir;
        }
        return tempLocalPath;
    }

    /**
     * 원격에 새 파일 생성 (FTP 지원)
     */
    async createRemoteFile(remotePath: string, content: string = ''): Promise<void> {
        if (!this.client) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            // FTP에서는 빈 파일을 직접 업로드
            const tempBuffer = Buffer.from(content, 'utf-8');
            await this.client.uploadFrom(require('stream').Readable.from([tempBuffer]), remotePath);
            this.log(`파일 생성 완료: ${remotePath}`);
        } catch (error) {
            this.log(`파일 생성 실패: ${remotePath} - ${error}`);
            throw error;
        }
    }

    /**
     * 원격에 새 폴더 생성 (FTP 지원)
     */
    async createRemoteFolder(remotePath: string): Promise<void> {
        if (!this.client) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            await this.client.ensureDir(remotePath);
            this.log(`폴더 생성 완료: ${remotePath}`);
        } catch (error) {
            this.log(`폴더 생성 실패: ${remotePath} - ${error}`);
            throw error;
        }
    }

    /**
     * 원격 파일명 검색 (FTP에서는 제한적 지원)
     */
    async searchRemoteFilesByName(
        remotePath: string,
        pattern: string,
        isRegex: boolean = false,
        maxResults: number = 100
    ): Promise<RemoteFile[]> {
        // FTP는 서버 측 검색을 지원하지 않으므로, 재귀적으로 목록을 가져와서 클라이언트에서 필터링
        throw new Error('FTP 프로토콜에서는 파일 검색이 제한적으로 지원됩니다. 대신 수동으로 폴더를 탐색하세요.');
    }

    /**
     * 원격 파일 내용 검색 (FTP에서는 미지원)
     */
    async searchInRemoteFiles(
        remotePath: string,
        searchText: string,
        isRegex: boolean = false,
        filePattern: string = '*',
        maxResults: number = 50
    ): Promise<Array<{ file: RemoteFile; matches: Array<{ line: number; text: string }> }>> {
        throw new Error('FTP 프로토콜에서는 파일 내용 검색이 지원되지 않습니다.');
    }

    /**
     * 원격 파일 권한 조회 (FTP LIST 명령 사용)
     */
    async getFilePermissions(remotePath: string): Promise<string> {
        if (!this.client) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            const dirPath = path.posix.dirname(remotePath);
            const fileName = path.posix.basename(remotePath);
            
            const files = await this.listRemoteFiles(dirPath);
            const file = files.find(f => f.name === fileName);
            
            if (!file) {
                throw new Error(`파일을 찾을 수 없습니다: ${remotePath}`);
            }

            // FTP LIST 응답에서 권한 정보 추출 (예: drwxr-xr-x)
            // basic-ftp는 rawModifiedAt 속성을 통해 원시 LIST 출력을 제공할 수 있음
            return '755'; // 기본값 (실제로는 LIST 파싱 필요)
        } catch (error) {
            this.log(`권한 조회 실패: ${remotePath} - ${error}`);
            return '----------';
        }
    }

    /**
     * 원격 파일 권한 변경 (FTP SITE CHMOD)
     */
    async changeFilePermissions(remotePath: string, mode: string): Promise<void> {
        if (!this.client) {
            throw new Error('FTP 클라이언트가 연결되지 않았습니다.');
        }

        try {
            // FTP SITE CHMOD 명령 사용
            await this.client.send(`SITE CHMOD ${mode} ${remotePath}`);
            this.log(`권한 변경 완료: ${remotePath} -> ${mode}`);
        } catch (error) {
            this.log(`권한 변경 실패: ${remotePath} - ${error}`);
            throw new Error('FTP 서버가 CHMOD를 지원하지 않거나 권한이 없습니다.');
        }
    }

    /**
     * 재귀적 원격 파일 목록 조회 (syncFolder에서 사용)
     */
    private async listRemoteFilesRecursive(remotePath: string): Promise<RemoteFile[]> {
        const result: RemoteFile[] = [];
        
        try {
            const files = await this.listRemoteFiles(remotePath);
            
            for (const file of files) {
                result.push(file);
                
                if (file.isDirectory && file.name !== '.' && file.name !== '..') {
                    const subFiles = await this.listRemoteFilesRecursive(file.path);
                    result.push(...subFiles);
                }
            }
        } catch (error) {
            this.log(`재귀적 목록 조회 실패: ${remotePath} - ${error}`);
        }
        
        return result;
    }

    /**
     * 원격 폴더 재귀 다운로드 (syncFolder에서 사용)
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
            const remoteFiles = await this.listRemoteFiles(remotePath);
            
            for (const fileInfo of remoteFiles) {
                const remoteFilePath = path.posix.join(remotePath, fileInfo.name);
                const localFilePath = path.join(localFolder, fileInfo.name);
                
                if (fileInfo.isDirectory) {
                    if (!fs.existsSync(localFilePath)) {
                        fs.mkdirSync(localFilePath, { recursive: true });
                    }
                    await this.downloadFolderRecursive(remoteFilePath, localFilePath, config, result, progressCallback);
                } else {
                    try {
                        let shouldDownload = false;
                        
                        if (!fs.existsSync(localFilePath)) {
                            shouldDownload = true;
                        } else {
                            const localStats = fs.statSync(localFilePath);
                            const remoteModifyTime = fileInfo.modifyTime ? fileInfo.modifyTime.getTime() : 0;
                            const localModifyTime = localStats.mtime.getTime();
                            
                            if (Math.abs(remoteModifyTime - localModifyTime) > 1000) {
                                shouldDownload = true;
                            }
                        }
                        
                        if (shouldDownload) {
                            if (progressCallback) {
                                progressCallback(result.downloaded + 1, 0, fileInfo.name);
                            }
                            
                            const localDir = path.dirname(localFilePath);
                            if (!fs.existsSync(localDir)) {
                                fs.mkdirSync(localDir, { recursive: true });
                            }
                            
                            await this.client.downloadTo(localFilePath, remoteFilePath);
                            await this.saveRemoteFileMetadata(remoteFilePath, localFilePath, config);
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
     * 원격에서 로컬에 없는 파일 삭제 (syncFolder에서 사용)
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
            
            const localRelativePaths = new Set(
                localFiles.map(f => path.relative(localFolder, f).replace(/\\/g, '/'))
            );
            
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
     * 로컬에서 원격에 없는 파일 삭제 (syncFolder에서 사용)
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
            
            const remoteRelativePaths = new Set(
                remoteFiles
                    .filter(f => !f.isDirectory)
                    .map(f => f.path.substring(remotePath.length).replace(/^\//, ''))
            );
            
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
    }}