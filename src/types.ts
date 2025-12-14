export interface SftpConfig {
    name?: string;
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
}

export interface ServerListItem {
    name: string;
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
    localPath: string;
    downloadTime: number;
}
