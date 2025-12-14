declare module 'ssh2-sftp-client' {
    export interface ConnectOptions {
        host: string;
        port: number;
        username: string;
        password?: string;
        privateKey?: Buffer | string;
    }

    export interface FileStats {
        mode: number;
        uid: number;
        gid: number;
        size: number;
        accessTime: number;
        modifyTime: number;
    }

    export default class SftpClient {
        constructor();
        connect(options: ConnectOptions): Promise<void>;
        end(): Promise<void>;
        stat(remotePath: string): Promise<FileStats>;
        get(remotePath: string, localPath: string): Promise<string>;
        put(localPath: string | Buffer | NodeJS.ReadableStream, remotePath: string): Promise<string>;
        list(remotePath: string): Promise<any[]>;
        exists(remotePath: string): Promise<false | string>;
        mkdir(remotePath: string, recursive?: boolean): Promise<string>;
        rmdir(remotePath: string, recursive?: boolean): Promise<string>;
        delete(remotePath: string): Promise<string>;
        rename(fromPath: string, toPath: string): Promise<string>;
    }
}
