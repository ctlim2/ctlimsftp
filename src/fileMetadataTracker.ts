import * as vscode from 'vscode';

export interface FileMetadata {
    remotePath: string;
    mtime: number;
    size: number;
}

/**
 * Tracks metadata for files downloaded from SFTP server
 * to detect if they have been modified by others
 */
export class FileMetadataTracker {
    private static readonly STORAGE_KEY = 'ctlimsftp.fileMetadata';
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Store metadata for a file
     */
    async storeFileMetadata(localPath: string, metadata: FileMetadata): Promise<void> {
        const allMetadata = this.getAllMetadata();
        allMetadata[localPath] = metadata;
        await this.context.workspaceState.update(FileMetadataTracker.STORAGE_KEY, allMetadata);
    }

    /**
     * Retrieve metadata for a file
     */
    async getFileMetadata(localPath: string): Promise<FileMetadata | undefined> {
        const allMetadata = this.getAllMetadata();
        return allMetadata[localPath];
    }

    /**
     * Remove metadata for a file
     */
    async removeFileMetadata(localPath: string): Promise<void> {
        const allMetadata = this.getAllMetadata();
        delete allMetadata[localPath];
        await this.context.workspaceState.update(FileMetadataTracker.STORAGE_KEY, allMetadata);
    }

    /**
     * Get all stored metadata
     */
    private getAllMetadata(): { [localPath: string]: FileMetadata } {
        return this.context.workspaceState.get(FileMetadataTracker.STORAGE_KEY, {});
    }

    /**
     * Clear all metadata (useful for cleanup)
     */
    async clearAllMetadata(): Promise<void> {
        await this.context.workspaceState.update(FileMetadataTracker.STORAGE_KEY, {});
    }
}
