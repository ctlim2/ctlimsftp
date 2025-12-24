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
