import * as vscode from 'vscode';

export type LanguageCode = 'en' | 'ko';

export interface Messages {
  [key: string]: string;
}

/**
 * 국제화(i18n) 시스템
 * VS Code의 언어 설정에 따라 자동으로 언어 전환
 */
export class I18n {
  private static instance: I18n;
  private currentLanguage: LanguageCode = 'en';
  private messages: Messages = {};

  private constructor() {
    this.initializeLanguage();
    this.loadMessages();
  }

  static getInstance(): I18n {
    if (!I18n.instance) {
      I18n.instance = new I18n();
    }
    return I18n.instance;
  }

  /**
   * VS Code의 언어 설정에서 언어 코드 결정
   */
  private initializeLanguage(): void {
    const vscodeLanguage = vscode.env.language;
    
    if (vscodeLanguage.startsWith('ko')) {
      this.currentLanguage = 'ko';
    } else {
      this.currentLanguage = 'en';
    }
  }

  /**
   * 언어에 맞는 메시지 로드
   */
  private loadMessages(): void {
    const allMessages: Record<LanguageCode, Messages> = {
      en: {
        // Extension activation
        'ext.activated': 'ctlim SFTP extension is now active',
        'ext.ftpClientCreating': 'Creating FTP client for {host}',
        'ext.sftpClientCreating': 'Creating SFTP client for {host}',
        
        // Workspace & Configuration
        'workspace.notFound': 'Workspace not found. Please open a workspace.',
        'config.fileNotFound': 'SFTP configuration file not found. Create it?',
        'config.createOption': 'Create',
        'config.cancel': 'Cancel',
        'config.invalid': 'Invalid configuration file.',
        'config.noServers': 'No servers configured in config file.',
        'config.selectServer': 'Select a server to connect to',
        'config.serverCreated': 'Configuration file created successfully.',
        
        // Server Connection
        'server.connecting': 'Connecting to server...',
        'server.connected': 'Connected to server: {serverName}',
        'server.disconnected': 'Disconnected from server: {serverName}',
        'server.connectionFailed': 'Failed to connect: {error}',
        'server.reconnecting': 'Attempting to reconnect...',
        'server.reconnected': '🔄 SFTP Reconnection Successful: {serverName}',
        'server.reconnectFailed': '⚠️ SFTP Reconnection Failed: {serverName}\nPlease reconnect manually.',
        'server.notConnected': 'Server not connected.',
        'server.connectionLost': 'Server connection lost.',
        'server.selectToConnect': 'Select a server or group',
        'server.selectForSync': 'Select a server',
        
        // File Operations
        'file.uploading': 'Uploading: {fileName}',
        'file.uploadSuccess': '✅ Upload completed: {fileName}',
        'file.uploadFailed': '❌ Upload failed: {fileName}',
        'file.uploadRetry': '✅ Upload successful after reconnection: {fileName}',
        'file.uploadRetryFailed': 'Retry failed: {error}',
        
        'file.downloading': 'Downloading: {fileName}',
        'file.downloadSuccess': '✅ Download completed: {fileName}',
        'file.downloadFailed': '❌ Download failed: {error}',
        'file.downloadBackupSuccess': '✅ Download completed: {fileName}',
        
        'file.deleting': 'Deleting: {fileName}',
        'file.deleteSuccess': '✅ Deletion completed: {fileName}',
        'file.deleteFailed': '❌ Deletion failed: {error}',
        'file.confirmDelete': 'Are you sure you want to delete "{fileName}"?',
        
        'file.searching': 'Searching...',
        'file.searchResults': '{count} files found',
        'file.searchNoResults': 'No search results for: "{query}"',
        
        // Sync Operations
        'sync.starting': 'Starting synchronization...',
        'sync.completed': '✅ Synchronization completed!',
        'sync.failed': '❌ Synchronization failed: {error}',
        
        // Status Messages
        'status.connected': '$(cloud) SFTP: {serverName}',
        'status.disconnected': '$(cloud-upload) SFTP: Not connected',
        'status.multiServer': '$(cloud) SFTP: {count} servers connected',
        'status.connectedDisconnect': 'Click to disconnect',
        'status.disconnectedConnect': 'Click to connect',
        
        // Error Messages
        'error.notImplemented': 'This feature is not yet implemented.',
        'error.invalidConfig': 'Invalid configuration.',
        'error.missingField': 'Missing required field: {field}',
        'error.fileNotFound': 'File not found: {path}',
        'error.directoryNotFound': 'Directory not found: {path}',
        'error.permissionDenied': 'Permission denied: {path}',
        'error.connectionTimeout': 'Connection timeout. Check server status.',
        'error.connectionRefused': 'Connection refused. Check host and port.',
        'error.unknownError': 'An unknown error occurred: {error}',
        'error.workspaceNotFound': 'Workspace not found.',
        'error.configFileNotFound': 'SFTP configuration file not found. Create it?',
        'error.noServerInConfig': 'No servers configured in config file.',
        'error.switchServerFailed': 'Failed to switch server: {error}',
        'error.cannotGetServerInfo': 'Cannot get server connection information',
        'error.configNotFound': 'Server configuration not found: {serverName}',
        'error.openBookmarkFailed': 'Failed to open bookmark: {error}',
        
        // Info Messages
        'info.configPath': 'Configuration file location',
        'info.metadataPath': 'Metadata directory',
        'info.backupPath': 'Backup directory',
        'info.connectionInfo': 'Connected to {serverName} | {host}:{port}',
        'info.serverConnected': 'Server connected: {serverName}',
        'info.serverDisconnected': 'Server disconnected: {serverName}',
        
        // BATCH 2: downloadMultipleFiles
        'error.selectFilesToDownload': 'Please select files to download.',
        'error.noDownloadableFiles': 'No downloadable files selected.',
        'progress.downloadingFiles': 'Downloading {count} files...',
        'progress.downloadingFile': '{fileName} ({current}/{total})',
        'success.filesDownloaded': '✅ {count} files downloaded successfully',
        'warning.downloadCompleted': '⚠️ Download completed: {success} successful, {failed} failed',
        
        // BATCH 3: deleteMultipleFiles
        'error.selectFilesToDelete': 'Please select files to delete.',
        'error.noDeletableFiles': 'No deletable files selected.',
        'error.deleteFailed': '❌ Delete failed: {error}',
        'confirm.deleteItems': 'Delete {count} items?',
        'progress.deletingFiles': 'Deleting {count} items...',
        'progress.deletingFile': '{fileName} ({current}/{total})',
        'success.itemsDeleted': '✅ {count} items deleted successfully',
        'warning.deleteCompleted': '⚠️ Delete completed: {success} successful, {failed} failed',
        
        // Additional common messages
        'action.ok': 'OK',
        'action.cancel': 'Cancel',
        'action.config': 'Config',
        'action.connect': 'Connect',
        'action.disconnect': 'Disconnect',
        'action.download': 'Download',
        'action.upload': 'Upload',
        'action.delete': 'Delete',
        'action.refresh': 'Refresh',
        'action.reconnect': 'Reconnect',
        
        // BATCH 4: saveAsCommand
        'input.selectInputMethod': 'Select how to enter remote path',
        'input.directInput': '$(edit) Direct Input',
        'input.treeSelect': '$(folder-opened) Select from Tree',
        'prompt.remotePathInput': 'Enter remote save path',
        'placeholder.remotePath': '/var/www/html/file.php',
        'error.pathRequired': 'Please enter a path',
        'error.absolutePath': 'Please enter absolute path (e.g., /var/www/...)',
        'progress.uploading': 'Uploading: {fileName}',
        'success.uploadComplete': 'Upload complete: {remotePath}',
        'error.uploadFailed': 'Upload failed: {remotePath}',
        'error.uploadFailedGeneral': 'Upload failed: {error}',
        
        // Conflict Resolution
        'conflict.detect': '⚠️ Conflict Detected!\n\nFile has been modified on server: {fileName}\n\nHow would you like to proceed?',
        'conflict.overwrite': 'Overwrite (Local → Server)',
        'conflict.download': 'Download (Server → Local)',
        'conflict.compare': 'Compare & Merge',
        'conflict.lossWarning': '⚠️ Local changes will be lost!\n\nOverwrite with server file?',
        'prompt.diffAction': 'File conflict detected: {fileName}\nWhat would you like to do?',
        'action.confirm': 'Confirm',
        'action.keepLocal': 'Keep Local (Overwrite Remote)',
        'action.useRemote': 'Use Remote (Overwrite Local)',
        'action.manualMerge': 'Manual Merge',

        // BATCH 6: Missed Korean strings in extension.ts
        'error.serverConnectionAttempt': 'You are not connected to the server. Would you like to connect?',
        'error.configNotFoundSimple': 'SFTP configuration not found.',
        'error.workspaceRootNotFound': 'Workspace root not found.',
        'sync.directionLocalToRemote': 'Local -> Remote',
        'sync.directionRemoteToLocal': 'Remote -> Local',
        'action.yes': 'Yes',
        'action.no': 'No',
        'action.viewFailedList': 'View Failed List',
        'error.failedFileList': 'Failed Files:\n\n{list}',
        'prompt.copyFileName': 'Enter name for the copied file',
        'error.fileNameRequired': 'Please enter a file name',
        'error.diffOriginalRequired': 'Original file name required',
        'prompt.renameFileName': 'Enter new file name',
        'confirm.rename': 'Do you want to rename the file?\n\n{oldName} -> {newName}',
        'message.renaming': 'Renaming file: {fileName}',
        'message.downloadingOriginal': 'Downloading original file...',
        'message.uploadingNewName': 'Uploading with new name...',
        'message.deletingOriginal': 'Deleting original file...',
        'prompt.selectServerToSearch': 'Select server to search',
        'prompt.searchPattern': 'Enter file name to search (Regex supported: /pattern/)',
        'message.searchingRemote': 'Searching remote files...',
        'message.searchingPattern': 'Searching "{pattern}"...',
        'message.noSearchResults': 'No search results found: "{pattern}"',
        'message.filesFoundOpen': '{count} files found - Select file to open',
        'prompt.searchText': 'Enter text to search (Regex supported: /pattern/)',
        'prompt.filePattern': 'Enter file pattern to search (* = all files)',
        'message.searchingContent': 'Searching file content...',
        'message.searchingContentPattern': 'Searching "{pattern}" ({filePattern})...',
        'message.matchesFound': '{count} matches',
        'prompt.permissionMode': 'Enter permission mode (3-digit octal)',
        'warn.permissionSecurity': '⚠️ Security Warning\n\n777 permission grants full access to everyone.\nFile: {fileName}\n\nAre you sure?',
        'prompt.selectServerSSH': 'Select server to open SSH terminal',
        'message.sshStarted': '🔌 SSH Terminal started: {serverName}',
        'message.noTransferHistory': '📋 No transfer history.',
        'prompt.historySelect': 'Transfer History ({count}) - Select to retry or view stats',
        'confirm.retryTransfer': 'Retry failed transfer?\n\nFile: {fileName}\nError: {error}',
        'prompt.statsSelectServer': 'Select server to view statistics',
        'confirm.clearHistory': 'Delete all transfer history?',
        'message.historyCleared': '✅ Transfer history cleared.',
        'message.pathCopied': '📋 Path copied: {path}',
        'prompt.webUrl': 'Enter web server base URL (e.g. http://example.com)',
        'confirm.saveWebUrl': 'Save this URL to server config?\n{url}',
        'message.manualWebUrl': '💡 Auto-save feature coming in next version.',
        'message.browserOpened': '🌐 Opened in browser: {url}',
        'warning.bookmarkExists': 'Path already bookmarked.',
        'prompt.enterBookmarkName': 'Enter bookmark name',
        'placeholder.bookmarkName': 'e.g. My Important File',
        'prompt.bookmarkDescription': 'Bookmark description (optional)',
        'placeholder.bookmarkDescription': 'e.g. Config file for dev environment',
        'info.bookmarkAdded': '⭐ Bookmark added: {name}',
        'message.bookmarkAdded': '⭐ Bookmark added: {name}',
        'message.noBookmarks': '⭐ No saved bookmarks.',
        'prompt.bookmarkSelect': '{count} bookmarks - Select to open',
        'message.noBookmarksToDelete': 'No bookmarks to delete.',
        'prompt.bookmarkSelectDelete': 'Select bookmark to delete',
        'confirm.deleteBookmark': 'Delete bookmark?\n\n{name}',
        'message.bookmarkDeleted': '🗑️ Bookmark deleted: {name}',
        'message.noFrequentBookmarks': '⭐ No frequently used bookmarks.',
        'prompt.configTemplateName': 'Enter template name',
        'prompt.submitTemplateDesc': 'Template description (optional)',
        'message.templateSaved': '💾 Template saved: {name}',
        'message.noTemplates': '💾 No saved templates.\nSave a server as template first.',
        'message.noTemplatesManage': '💾 No saved templates.',
        'prompt.templateSelectAdd': '{count} templates - Select to add server',
        'prompt.enterHost': 'Enter server host',
        'prompt.enterUsername': 'Enter username',
        'prompt.enterPasswordOpt': 'Enter password (optional - prompt on connect)',
        'prompt.enterServerNameOpt': 'Enter server name (optional)',
        'message.serverAddedFromTemplate': '✅ Server added: {serverName}\nTemplate: {templateName}',
        'prompt.templateSelectDelete': '{count} templates - Select to delete',
        'confirm.deleteTemplate': 'Delete template?\n\n{name}',
        'message.templateDeleted': '🗑️ Template deleted: {name}',
        'confirm.createConfig': 'ctlim SFTP configuration file missing. Create one?',
        'message.noActiveWorkspace': 'No active workspace.',
        'error.configNoServerInfo': 'No server information in config file.',
        'prompt.selectServerConnect': 'Select server to connect',

        // Batch 7 (sftpClient & sftpTreeProvider)
        'server.reconnectingHost': 'Reconnecting: {host}...',
        'server.connectedDetailed': 'Server connected: {host}:{port}',
        'sync.localToRemoteStarted': 'Sync local -> remote started: {count} files',
        'sync.uploadSuccessRelative': 'Upload success: {path}',
        'sync.uploadFailed': 'Upload failed: {path} - {error}',
        'sync.remoteToLocalStarted': 'Sync remote -> local started',
        'sync.downloadSuccess': 'Download success: {name}',
        'sync.downloadFailed': 'Download failed: {path} - {error}',
        'sync.remoteDelete': 'Remote file deleted: {path}',
        'sync.remoteDeleteFailed': 'Remote file delete failed: {path} - {error}',
        'sync.localDelete': 'Local file deleted: {path}',
        'sync.localDeleteFailed': 'Local file delete failed: {path} - {error}',
        'sync.completeStats': 'Sync complete: Upload={upload}, Download={download}, Delete={delete}, Failed={failed}',
        'sync.error': 'Sync error: {error}',
        'file.statLocalMismatch': 'Download folder recursive failed: {path} - {error}',
        'file.readFailed': 'File read failed: {path}',
        'file.createRemote': 'File created: {path}',
        'folder.createRemote': 'Folder created: {path}',
        'permission.changed': 'Permissions changed: {path} -> {mode}',
        'metadata.readInfo': 'read metadate info {path}\n {remotePath} : mtime={mtime}, size={size}',
        'metadata.compare': 'compare metadata \nlocal mtime={lMtime}, size={lSize}\nremote mtime={rMtime}, size={rSize}',
        'metadata.save': 'save metadate info {remotePath} : mtime={mtime}, size={size}',
        'metadata.saveFile': 'save metadate file {path}',
        'metadata.saveFailed': 'Failed to save metadata: {path}',
        'file.reuploading': 'Uploading: {local} -> {remote}',
        'file.uploadComplete': 'Upload complete: {remote}',
        'backup.start': 'Backup {path}',
        'tree.noServerConfig': 'No ctlim SFTP servers configured',
        'tree.runConfigCmd': 'Run "ctlim SFTP: Config" to setup',
        'tree.bookmarkGroup': 'Bookmarks ({count})',
        'tree.bookmarkGroupTooltip': 'Saved bookmarks',
        'tree.connectServer': 'Connect to Server',
        'tree.openRemoteFile': 'Open Remote File',
        'tree.openBookmark': 'Open Bookmark',
        'tree.errorLoadRemote': 'Error loading remote files',
        'drag.onlyServerFolder': 'Files can only be dragged to server or folder.',

        'option.allServers': 'All Servers',
        'prompt.selectServerForStats': 'Select server for statistics',
        'title.transferStatistics': 'Transfer Statistics',
        'stats.uploads': 'Uploads',
        'stats.downloads': 'Downloads',
        'stats.success': 'Success',
        'stats.failed': 'Failed',
        'stats.successRate': 'Success Rate',
        'stats.totalTransfer': 'Total Transfer',
        'stats.averageSpeed': 'Average Speed',


        // Missing Keys
        'title.bookmarks': 'Bookmarks',
        'label.group': 'Group',
        'detail.usageCount': 'Usage: {count}',
        'label.path': 'Path',
        'label.server': 'Server',
        'label.description': 'Description',
        'detail.size': 'Size',
        'detail.modified': 'Modified',
        'detail.noDescription': 'No description',
        'error.dragDropTargetInvalid': 'Drag and drop target is invalid. Drop on server or folder.',
        'error.targetPathNotFound': 'Target remote path not found.',
        'drag.noTarget': 'Target path not found.',
        'drag.noUriList': 'No uri-list data found',
        'drag.notConnected': 'Not connected to server.',
        'drag.uploading': 'Uploading files...',
        'drag.uploadSuccess': '✅ {count} items uploaded',
        'drag.preparing': 'Preparing directory drag: {path}',
        'drag.downloading': 'Downloading for drag: {path}',
        'drag.prepared': 'Drag prepared with {count} file(s)',
        'info.noTransferHistory': '📋 No transfer history.',
        'info.noSavedBookmarks': '⭐ No saved bookmarks.',
        'info.noBookmarksToDelete': 'No bookmarks to delete.',
        'info.noFrequentBookmarks': '⭐ No frequently used bookmarks.',
        'info.noSavedTemplates': '💾 No saved templates.',
        'info.noTemplatesAvailable': '💾 No saved templates.',
        'info.bookmarkAlreadyExists': 'Path already bookmarked.',
        'info.transferHistoryDeleted': '✅ Transfer history cleared.',
        'info.nextVersionFeature': '💡 Auto-save feature coming in next version.',
        'info.transferHistoryNoData': '⭐ No saved templates.\nSave a server as template first.',
        'info.transferHistoryNoDataAlt': '💾 No saved templates.',
        'info.bookmarkNavigationInfo': 'Bookmark navigation in progress: onDidChangeSelection ignored',
        'info.bookmarkNavigationInProgress': 'Bookmark navigation in progress: onDidChangeSelection ignored',
        'info.reconnectionAfterUploadSuccess': 'Upload success after reconnection',
        'info.noOpenDocuments': 'No open documents.',
        'info.noMetadataDocuments': 'No open documents with metadata.',
        'info.backupLog': 'Backup {path}',
        'info.backupComplete': 'Backup complete: {path}',
        'info.deleteOldBackup': 'Delete old backup: {name}',
        'action.selectServer': 'Select server',
        'action.selectTemplate': 'Select a server to connect to',
        'action.selectBookmark': 'Select a server to connect to', // TODO: Fix translation

        // Extension.ts new keys
        'error.bookmarkManagerInitFailed': 'Bookmark manager initialization failed.',
        'status.serverNotConnected': 'Server not connected: {serverName}',
        'action.connectQuery': 'Do you want to connect?',
        'error.bookmarkNavFailed': 'Bookmark navigation failed: {error}',
        'action.clickToSelect': 'Click to select server',
        'action.clickToManage': 'Click to manage',
        'status.connectedCount': '$(cloud) SFTP: {count} servers connected',
        'status.connectedServersList': 'Connected servers:\n{list}',
        'conflict.detectedSingle': '🔄 Remote file change detected!\n\nFile: {fileName}\nRemote file has been modified.',
        'conflict.detectedMultiple': '🔄 Remote file changes detected!\n\n{count} files have been modified on server.',
        'action.downloadAll': 'Download All',
        'action.selectIndividually': 'Select Individually',
        'action.ignore': 'Ignore',
        'status.downloadingRemoteFiles': 'Downloading remote files...',
        'info.downloadedMultipleFiles': '✅ {count} files downloaded',
        'conflict.fileChanged': '⚠️ File: {fileName}\nModified on server.',
        'info.downloadSuccess': '✅ Download complete: {fileName}',
        'error.downloadFailed': '❌ Download failed: {fileName}',
        
        // BATCH 8 (sftpClient.ts)
        'error.mkdirFailed': 'Mkdir failed ({path}): {error}',
        'error.recursiveMkdirFailed': 'Recursive mkdir failed: {error}',
        'search.error': 'Search error ({path}): {error}',
        'search.contentError': 'Search content error ({path}): {error}',
        'file.invalidPermission': 'Invalid permission mode: {mode}',
        'file.permissionChanged': 'Permission changed: {path} -> {mode}',
        'error.sfptClientNotConnected': 'SFTP client not connected.',
        'error.noWorkspace': 'Workspace not found.',
        'file.uploaded': 'Upload completed: {path}',
        'backup.error': 'Backup failed:',
      },
      ko: {
        // 확장 활성화
        'ext.activated': 'ctlim SFTP 확장이 활성화되었습니다',
        'ext.ftpClientCreating': '{host}에 대한 FTP 클라이언트 생성 중',
        'ext.sftpClientCreating': '{host}에 대한 SFTP 클라이언트 생성 중',
        
        // 워크스페이스 & 설정
        'workspace.notFound': '워크스페이스를 찾을 수 없습니다. 워크스페이스를 열어주세요.',
        'config.fileNotFound': 'SFTP 설정 파일이 없습니다. 생성하시겠습니까?',
        'config.createOption': '생성',
        'config.cancel': '취소',
        'config.invalid': '잘못된 설정 파일입니다.',
        'config.noServers': '설정 파일에 서버 정보가 없습니다.',
        'config.selectServer': '연결할 서버를 선택하세요',
        'config.serverCreated': '설정 파일이 생성되었습니다.',
        
        // 서버 연결
        'server.connecting': '서버에 연결 중입니다...',
        'server.connected': '서버 연결 성공: {serverName}',
        'server.disconnected': '서버 연결 해제: {serverName}',
        'server.connectionFailed': '연결 실패: {error}',
        'server.reconnecting': '재연결 시도 중...',
        'server.reconnected': '🔄 SFTP 재연결 성공: {serverName}',
        'server.reconnectFailed': '⚠️ SFTP 재연결 실패: {serverName}\n다시 연결해주세요.',
        'server.notConnected': '서버에 연결되어 있지 않습니다.',
        'server.connectionLost': '서버 연결이 끊어졌습니다.',
        'server.selectToConnect': '서버나 그룹을 선택하세요',
        'server.selectForSync': '서버를 선택하세요',


        // Missing Keys (KO)
        'title.bookmarks': '북마크',
        'label.group': '그룹',
        'detail.usageCount': '사용 횟수: {count}',
        'label.path': '경로',
        'label.server': '서버',
        'label.description': '설명',
        'detail.size': '크기',
        'detail.modified': '수정됨',
        'detail.noDescription': '설명 없음',  
        'error.dragDropTargetInvalid': '드래그 앤 드롭 대상이 유효하지 않습니다. 서버 또는 폴더에 드롭하세요.',
        'error.targetPathNotFound': '대상 원격 경로를 찾을 수 없습니다.',
        'drag.noTarget': '대상 경로를 찾을 수 없습니다.',
        'drag.noUriList': 'URI 목록 데이터가 없습니다.',
        'drag.notConnected': '서버에 연결되지 않았습니다.',
        'drag.uploading': '파일 업로드 중...',
        'drag.uploadSuccess': '✅ {count}개 항목 업로드 완료',
        'drag.preparing': '디렉토리 드래그 준비 중: {path}',
        'drag.downloading': '드래그를 위해 다운로드 중: {path}',
        'drag.prepared': '{count}개 파일로 드래그 준비 완료',
        'info.noTransferHistory': '📋 전송 기록이 없습니다.',
        'info.noSavedBookmarks': '⭐ 저장된 북마크가 없습니다.',
        'info.noBookmarksToDelete': '삭제할 북마크가 없습니다.',
        'info.noFrequentBookmarks': '⭐ 자주 사용하는 북마크가 없습니다.',
        'info.noSavedTemplates': '💾 저장된 템플릿이 없습니다.',
        'info.noTemplatesAvailable': '💾 저장된 템플릿이 없습니다.',
        'warning.bookmarkExists': '이미 북마크에 추가된 경로입니다.',
        'prompt.enterBookmarkName': '북마크 이름을 입력하세요',
        'placeholder.bookmarkName': '예: 주요 설정 파일',
        'prompt.bookmarkDescription': '북마크 설명 (선택사항)',
        'placeholder.bookmarkDescription': '예: 개발 서버 환경 설정',
        'info.bookmarkAdded': '⭐ 북마크 추가됨: {name}',
        'info.transferHistoryDeleted': '✅ 전송 히스토리가 삭제되었습니다.',
        'info.nextVersionFeature': '💡 다음 버전에서 자동 저장 기능이 추가됩니다.',
        'info.transferHistoryNoData': '⭐ 저장된 템플릿이 없습니다.\n먼저 서버를 템플릿으로 저장하세요.',
        'info.transferHistoryNoDataAlt': '💾 저장된 템플릿이 없습니다.',
        'info.bookmarkNavigationInfo': '북마크 네비게이션 중: onDidChangeSelection 무시됨',
        'info.bookmarkNavigationInProgress': '북마크 네비게이션 중: onDidChangeSelection 무시됨',
        'info.reconnectionAfterUploadSuccess': '재연결 후 업로드 성공',
        'info.noOpenDocuments': '열려있는 문서가 없습니다.',
        'info.noMetadataDocuments': '메타데이터가 있는 열린 문서가 없습니다.',
        'info.backupLog': '백업 {path}',
        'info.backupComplete': '백업 완료: {path}',
        'info.deleteOldBackup': '오래된 백업 삭제: {name}',
        'action.selectServer': '서버를 선택하세요',
        'action.selectTemplate': '연결할 템플릿 선택',
        'action.selectBookmark': '연결할 북마크 선택',
        
        // Extension.ts new keys
        'error.bookmarkManagerInitFailed': '북마크 관리자를 초기화할 수 없습니다.',
        'action.connectQuery': '연결하시겠습니까?',
        'error.bookmarkNavFailed': '북마크 네비게이션 실패: {error}',
        'action.clickToSelect': '클릭하여 서버 선택',
        'action.clickToManage': '클릭하여 관리',
        'status.connectedCount': '$(cloud) SFTP: {count}개 서버 연결됨',
        'status.connectedServersList': '연결된 서버:\n{list}',
        'conflict.detectedSingle': '🔄 서버 파일 변경 감지!\n\n파일: {fileName}\n서버의 파일이 수정되었습니다.',
        'conflict.detectedMultiple': '🔄 서버 파일 변경 감지!\n\n{count}개의 파일이 서버에서 수정되었습니다.',
        'action.downloadAll': '모두 다운로드',
        'action.selectIndividually': '개별 선택',
        'action.ignore': '무시',
        'status.downloadingRemoteFiles': '원격 파일 다운로드 중...',
        'info.downloadedMultipleFiles': '✅ {count}개 파일 다운로드 완료',
        'conflict.fileChanged': '⚠️ 파일: {fileName}\n서버에서 수정되었습니다.',
        'prompt.diffAction': '파일 충돌 감지: {fileName}\n어떻게 하시겠습니까?',
        'action.keepLocal': '로컬 유지 (서버 덮어쓰기)',
        'action.useRemote': '서버 사용 (로컬 덮어쓰기)',
        'action.manualMerge': '수동 병합',
        'info.downloadSuccess': '✅ 다운로드 완료: {fileName}',
        'error.downloadFailed': '❌ 다운로드 실패: {fileName}',

        // BATCH 7: sftpClient.ts and sftpTreeProvider.ts extracted strings
        'server.connectedDetailed': '서버 연결 성공: {host}:{port}',
        'server.reconnectingHost': '재연결 시도 중: {host}...',
        'server.reconnectedHost': '✅ 재연결 성공: {host}',
        'server.reconnectedInfo': '🔄 SFTP 재연결 성공: {serverName}',
        'server.reconnectFailedError': '❌ 재연결 실패 (attemptReconnect): {error}',
        'server.reconnectFailedWarning': '⚠️ SFTP 재연결 실패: {serverName}\n다시 연결해주세요.',
        'sync.localToRemoteStarted': '로컬 → 원격 동기화 시작: {count}개 파일',
        'file.uploadSuccessRelative': '업로드 성공: {path}',
        'file.uploadFailedError': '업로드 실패: {file} - {error}',
        'sync.remoteToLocalStarted': '원격 → 로컬 동기화 시작',
        'sync.completedDetailed': '동기화 완료: 업로드={uploaded}, 다운로드={downloaded}, 삭제={deleted}, 실패={failed}',
        'sync.error': '동기화 오류: {error}',
        'file.downloadSuccessName': '다운로드 성공: {name}',
        'file.downloadFailedPath': '다운로드 실패: {path} - {error}',
        'error.listFolderFailed': '폴더 목록 조회 실패: {path} - {error}',
        'file.remoteDeleted': '원격 파일 삭제: {path}',
        'error.remoteDeleteFailed': '원격 파일 삭제 실패: {path} - {error}',
        'error.remoteRemoveProcessFailed': '원격 삭제 파일 처리 실패: {error}',
        'file.localDeleted': '로컬 파일 삭제: {path}',
        'error.localDeleteFailed': '로컬 파일 삭제 실패: {path} - {error}',
        'error.localRemoveProcessFailed': '로컬 삭제 파일 처리 실패: {error}',
        'error.listRemoteFilesFailed': '원격 파일 목록 조회 실패: {path} - {error}',
        'error.searchError': '검색 중 오류 ({path}): {error}',
        'error.searchContentError': '내용 검색 중 오류 ({path}): {error}',
        'file.created': '파일 생성 완료: {path}',
        'folder.created': '폴더 생성 완료: {path}',
        'error.invalidMode': '잘못된 권한 모드: {mode}',
        'permission.changed': '권한 변경 완료: {path} -> {mode}',
        'tree.bookmarkGroup': '북마크 ({count})',
        
        // BATCH 8 (sftpClient.ts)
        'error.mkdirFailed': 'mkdir 실패 ({path}): {error}',
        'error.recursiveMkdirFailed': '재귀적 mkdir 실패: {error}',
        'search.error': '검색 중 오류 ({path}): {error}',
        'search.contentError': '내용 검색 중 오류 ({path}): {error}',
        'file.invalidPermission': '잘못된 권한 모드: {mode}',
        'file.permissionChanged': '권한 변경 완료: {path} -> {mode}',
        'error.noWorkspace': '워크스페이스를 찾을 수 없습니다.',
        'file.uploaded': '업로드 완료: {path}',
        'backup.error': '백업 실패:',
        'backup.deletedOld': '오래된 백업 삭제: {name}',
        'backup.complete': '백업 완료: {path}',

        // BATCH 9 (ftpClient.ts remaining)
        'error.ftpClientNotConnected': 'FTP 클라이언트가 연결되지 않았습니다.',
        'error.metadataSaveFailed': '메타데이터 저장 실패:',
        'sync.ftpLocalToRemoteStarted': 'FTP 로컬 → 원격 동기화 시작: {count}개 파일',
        'sync.ftpCompletedDetailed': 'FTP 동기화 완료: 업로드={uploaded}, 실패={failed}',
        'sync.ftpError': 'FTP 동기화 오류: {error}',
        'error.ftpSearchLimited': 'FTP 프로토콜에서는 파일 검색이 제한적으로 지원됩니다. 대신 수동으로 폴더를 탐색하세요.',
        'error.ftpContentSearchNotSupported': 'FTP 프로토콜에서는 파일 내용 검색이 지원되지 않습니다.',
        'error.ftpChmodNotSupported': 'FTP 서버가 CHMOD를 지원하지 않거나 권한이 없습니다.',
        'error.backupFailed': '백업 실패:',
        
        'server.ftpReconnecting': 'FTP 재연결 시도 중: {host}...',
        'server.ftpReconnected': '✅ FTP 재연결 성공: {host}',
        'server.ftpReconnectedInfo': '🔄 FTP 재연결 성공: {serverName}',
        'server.ftpReconnectFailed': '❌ FTP 재연결 실패: {error}',
        'server.ftpReconnectFailedWarning': '⚠️ FTP 재연결 실패: {serverName}\n다시 연결해주세요.',
        
        'file.ftpUploading': 'FTP 업로드 중: {local} -> {remote}',
        'file.ftpUploadComplete': 'FTP 업로드 완료: {remote}',
        'file.ftpUploadFailed': 'FTP 업로드 실패: {error}',
        
        'file.ftpDownloading': 'FTP 다운로드 중: {remote} -> {local}',
        'file.ftpDownloadComplete': 'FTP 다운로드 완료: {local}',
        'file.ftpDownloadFailed': 'FTP 다운로드 실패: {error}',
        
        'file.ftpDeleteComplete': 'FTP 파일 삭제 완료: {path}',
        'file.ftpDeleteFailed': 'FTP 파일 삭제 실패: {error}',
        
        'folder.ftpMkdir': 'FTP 디렉토리 생성/확인: {path}',
        'error.ftpMkdirFailed': 'FTP 디렉토리 생성 실패: {path} - {error}',
        
        'file.ftpInfo': 'FTP 파일 정보: {path} - mtime={mtime}, size={size}',
        'error.ftpInfoFailed': 'FTP 파일 정보 조회 실패: {error}',
        
        'metadata.comparing': '메타데이터 비교:\n로컬 mtime={lTime}, size={lSize}\n원격 mtime={rTime}, size={rSize}',
        
        'file.uploadSuccessSimple': '업로드 성공: {path}',
        'file.uploadFailSimple': '업로드 실패: {path} - {error}',
        
        'file.createComplete': '파일 생성 완료: {path}',
        'file.createFail': '파일 생성 실패: {path} - {error}',
        
        'folder.createComplete': '폴더 생성 완료: {path}',
        'folder.createFail': '폴더 생성 실패: {path} - {error}',
        
        'permission.ftpChanged': '권한 변경 완료: {path} -> {mode}',
        'permission.ftpChangeFailed': '권한 변경 실패: {path} - {error}',
        'permission.ftpReadFailed': '권한 조회 실패: {path} - {error}',
        
        'error.recursiveListFailed': '재귀적 목록 조회 실패: {path} - {error}',
        
        'file.downloadSuccessSimple': '다운로드 성공: {name}',
        'file.downloadFailSimple': '다운로드 실패: {path} - {error}',
        
        'file.remoteDeleteSimple': '원격 파일 삭제: {path}',
        'file.remoteDeleteFailSimple': '원격 파일 삭제 실패: {path} - {error}',
        'error.remoteProcessFail': '원격 삭제 파일 처리 실패: {error}',
        
        'file.localDeleteSimple': '로컬 파일 삭제: {path}',
        'file.localDeleteFailSimple': '로컬 파일 삭제 실패: {path} - {error}',
        'error.localProcessFail': '로컬 삭제 파일 처리 실패: {error}',

        'option.allServers': '모든 서버',
        'prompt.selectServerForStats': '통계를 볼 서버 선택',
        'title.transferStatistics': '전송 통계',
        'stats.uploads': '업로드',
        'stats.downloads': '다운로드',
        'stats.success': '성공',
        'stats.failed': '실패',
        'stats.successRate': '성공률',
        'stats.totalTransfer': '총 전송량',
        'stats.averageSpeed': '평균 속도',
      }
    };
    
    this.messages = allMessages[this.currentLanguage];
  }

  /**
   * 메시지 키로 문자열 가져오기
   * @param key 메시지 키
   * @param vars 치환할 변수 ({varName} 형식)
   * @returns 번역된 문자열
   */
  t(key: string, vars?: Record<string, string | number>): string {
    let message = this.messages[key];
    
    if (message === undefined) {
      console.warn(`Translation key not found: ${key}`);
      return key;
    }
    
    if (typeof message !== 'string') {
      console.warn(`Translation value is not a string: ${key}`);
      return key;
    }
    
    // 변수 치환
    if (vars) {
      Object.entries(vars).forEach(([varName, value]) => {
        message = message.replace(new RegExp(`{${varName}}`, 'g'), String(value));
      });
    }
    
    return message;
  }

  /**
   * 현재 언어 설정 반환
   */
  getLanguage(): LanguageCode {
    return this.currentLanguage;
  }

  /**
   * 언어 변경
   */
  setLanguage(lang: LanguageCode): void {
    if (lang !== this.currentLanguage) {
      this.currentLanguage = lang;
      this.loadMessages();
    }
  }
}

export const i18n = I18n.getInstance();
