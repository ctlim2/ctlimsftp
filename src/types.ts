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
    webUrl?: string;
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

export interface Bookmark {
    id: string;
    name: string;
    serverName: string;
    groupName?: string;
    remotePath: string;
    isDirectory: boolean;
    description?: string;
    createdAt: number;
    lastAccessedAt?: number;
    accessCount: number;
}
