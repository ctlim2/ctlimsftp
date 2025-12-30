export interface SftpConfig {
    name?: string;
    group?: string;
    context?: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    remotePath: string;
    uploadOnSave?: boolean;
    downloadOnOpen?: boolean | 'confirm';
    downloadBackup?: string;
    ignore?: string[];
    watcher?: {
        files: string | false;
        autoUpload: boolean;
        autoDelete: boolean;
    };
    profiles?: {
        [key: string]: Partial<SftpConfig>;
    };
    defaultProfile?: string;
    workspaceRoot?: string;
    metadataPath?: string;
    // 연결 타임아웃 및 Keep-Alive 설정
    connectTimeout?: number;        // 연결 타임아웃 (밀리초, 기본 10000)
    readyTimeout?: number;          // 준비 타임아웃 (밀리초, 기본 20000)
    keepaliveInterval?: number;     // Keep-Alive 간격 (밀리초, 기본 10000)
    keepaliveCountMax?: number;     // Keep-Alive 최대 재시도 (기본 3)
}

export interface ServerListItem {
    name: string;
    group?: string;
    host: string;
    port: number;
    username: string;
    remotePath: string;
    configPath: string;
}

export interface RemoteFile {
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    modifyTime?: Date;
}

export interface FileMetadata {
    remotePath: string;
    remoteModifyTime: number;
    remoteFileSize: number;
    localPath: string;
    downloadTime: number;
    configName?: string;  // 파일이 속한 서버 config 이름
    workspaceRoot?: string;

}

export interface TransferHistory {
    id: string;
    type: 'upload' | 'download' | 'sync';
    status: 'success' | 'failed' | 'cancelled';
    localPath: string;
    remotePath: string;
    fileSize: number;
    transferSpeed?: number;  // bytes per second
    duration: number;  // milliseconds
    timestamp: number;
    errorMessage?: string;
    serverName: string;
}

export interface TransferStatistics {
    totalUploads: number;
    totalDownloads: number;
    totalBytes: number;
    successCount: number;
    failedCount: number;
    averageSpeed: number;
}
