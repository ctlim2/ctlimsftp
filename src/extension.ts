import * as vscode from 'vscode';
import { SftpClient } from './sftpClient';
import { FileMetadataTracker } from './fileMetadataTracker';

let sftpClient: SftpClient;
let fileTracker: FileMetadataTracker;

export function activate(context: vscode.ExtensionContext) {
    console.log('CTLim SFTP extension is now active');

    // Initialize services
    sftpClient = new SftpClient();
    fileTracker = new FileMetadataTracker(context);

    // Register commands
    const downloadCommand = vscode.commands.registerCommand('ctlimsftp.downloadFile', async () => {
        await downloadFile();
    });

    const uploadCommand = vscode.commands.registerCommand('ctlimsftp.uploadFile', async () => {
        await uploadFile();
    });

    const configureCommand = vscode.commands.registerCommand('ctlimsftp.configure', async () => {
        await configureConnection();
    });

    context.subscriptions.push(downloadCommand, uploadCommand, configureCommand);
}

async function downloadFile() {
    try {
        const config = vscode.workspace.getConfiguration('ctlimsftp');
        const host = config.get<string>('host');
        
        if (!host) {
            vscode.window.showErrorMessage('Please configure SFTP connection first using "SFTP: Configure Connection"');
            return;
        }

        // Prompt for remote file path
        const remotePath = await vscode.window.showInputBox({
            prompt: 'Enter remote file path to download',
            placeHolder: '/path/to/file.txt'
        });

        if (!remotePath) {
            return;
        }

        // Prompt for local save location
        const localUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(remotePath.split('/').pop() || 'file.txt')
        });

        if (!localUri) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Downloading file from SFTP server",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Connecting..." });
            
            const password = await vscode.window.showInputBox({
                prompt: 'Enter SFTP password',
                password: true
            });

            if (!password) {
                throw new Error('Password required');
            }

            await sftpClient.connect({
                host: host,
                port: config.get<number>('port') || 22,
                username: config.get<string>('username') || '',
                password: password
            });

            progress.report({ message: "Downloading..." });
            
            // Get file stats before downloading
            const stats = await sftpClient.stat(remotePath);
            
            await sftpClient.downloadFile(remotePath, localUri.fsPath);
            
            // Store metadata for future comparison
            await fileTracker.storeFileMetadata(localUri.fsPath, {
                remotePath: remotePath,
                mtime: stats.modifyTime,
                size: stats.size
            });

            await sftpClient.disconnect();
            
            // Open the downloaded file
            const document = await vscode.workspace.openTextDocument(localUri);
            await vscode.window.showTextDocument(document);
            
            vscode.window.showInformationMessage(`File downloaded successfully: ${remotePath}`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function uploadFile() {
    try {
        const config = vscode.workspace.getConfiguration('ctlimsftp');
        const host = config.get<string>('host');
        
        if (!host) {
            vscode.window.showErrorMessage('Please configure SFTP connection first using "SFTP: Configure Connection"');
            return;
        }

        // Get active file
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file to upload');
            return;
        }

        const localPath = editor.document.uri.fsPath;
        
        // Check if we have metadata for this file
        const metadata = await fileTracker.getFileMetadata(localPath);
        let remotePath: string;

        if (metadata) {
            remotePath = metadata.remotePath;
        } else {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter remote file path to upload to',
                placeHolder: '/path/to/file.txt'
            });

            if (!input) {
                return;
            }
            remotePath = input;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Uploading file to SFTP server",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Connecting..." });
            
            const password = await vscode.window.showInputBox({
                prompt: 'Enter SFTP password',
                password: true
            });

            if (!password) {
                throw new Error('Password required');
            }

            await sftpClient.connect({
                host: host,
                port: config.get<number>('port') || 22,
                username: config.get<string>('username') || '',
                password: password
            });

            // Check for modifications before uploading
            if (metadata) {
                const currentStats = await sftpClient.stat(remotePath);
                if (currentStats.modifyTime !== metadata.mtime || currentStats.size !== metadata.size) {
                    const choice = await vscode.window.showWarningMessage(
                        `⚠️ Warning: The file "${remotePath}" has been modified on the server!\n\n` +
                        `Original: ${new Date(metadata.mtime).toLocaleString()} (${metadata.size} bytes)\n` +
                        `Current: ${new Date(currentStats.modifyTime).toLocaleString()} (${currentStats.size} bytes)\n\n` +
                        `Another user may have made changes. Do you want to overwrite the server file?`,
                        'Overwrite',
                        'Cancel'
                    );

                    if (choice !== 'Overwrite') {
                        await sftpClient.disconnect();
                        return;
                    }
                }
            }

            progress.report({ message: "Uploading..." });
            await sftpClient.uploadFile(localPath, remotePath);
            
            // Update metadata after successful upload
            const newStats = await sftpClient.stat(remotePath);
            await fileTracker.storeFileMetadata(localPath, {
                remotePath: remotePath,
                mtime: newStats.modifyTime,
                size: newStats.size
            });

            await sftpClient.disconnect();
            
            vscode.window.showInformationMessage(`File uploaded successfully: ${remotePath}`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function configureConnection() {
    const config = vscode.workspace.getConfiguration('ctlimsftp');

    const host = await vscode.window.showInputBox({
        prompt: 'Enter SFTP server host',
        value: config.get<string>('host') || ''
    });

    if (host === undefined) {
        return;
    }

    const portInput = await vscode.window.showInputBox({
        prompt: 'Enter SFTP server port',
        value: String(config.get<number>('port') || 22)
    });

    if (portInput === undefined) {
        return;
    }

    const username = await vscode.window.showInputBox({
        prompt: 'Enter SFTP username',
        value: config.get<string>('username') || ''
    });

    if (username === undefined) {
        return;
    }

    const remotePath = await vscode.window.showInputBox({
        prompt: 'Enter default remote path',
        value: config.get<string>('remotePath') || '/'
    });

    if (remotePath === undefined) {
        return;
    }

    // Update configuration
    await config.update('host', host, vscode.ConfigurationTarget.Workspace);
    await config.update('port', parseInt(portInput), vscode.ConfigurationTarget.Workspace);
    await config.update('username', username, vscode.ConfigurationTarget.Workspace);
    await config.update('remotePath', remotePath, vscode.ConfigurationTarget.Workspace);

    vscode.window.showInformationMessage('SFTP configuration saved successfully');
}

export function deactivate() {
    if (sftpClient) {
        sftpClient.disconnect();
    }
}
