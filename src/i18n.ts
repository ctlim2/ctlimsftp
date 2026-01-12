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
        'error.uploadFailedGeneral': 'Upload failed: {error}'
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
        
        // 파일 작업
        'file.uploading': '업로드 중: {fileName}',
        'file.uploadSuccess': '✅ 업로드 완료: {fileName}',
        'file.uploadFailed': '❌ 업로드 실패: {fileName}',
        'file.uploadRetry': '✅ 재연결 후 업로드 성공: {fileName}',
        'file.uploadRetryFailed': '재시도 실패: {error}',
        
        'file.downloading': '다운로드 중: {fileName}',
        'file.downloadSuccess': '✅ 다운로드 완료: {fileName}',
        'file.downloadFailed': '❌ 다운로드 실패: {error}',
        'file.downloadBackupSuccess': '✅ 다운로드 완료: {fileName}',
        
        'file.deleting': '삭제 중: {fileName}',
        'file.deleteSuccess': '✅ 삭제 완료: {fileName}',
        'file.deleteFailed': '❌ 삭제 실패: {error}',
        'file.confirmDelete': '"{fileName}"을(를) 삭제하시겠습니까?',
        
        'file.searching': '검색 중...',
        'file.searchResults': '{count}개 파일 발견',
        'file.searchNoResults': '검색 결과 없음: "{query}"',
        
        // 동기화 작업
        'sync.starting': '동기화 시작...',
        'sync.completed': '✅ 동기화 완료!',
        'sync.failed': '❌ 동기화 실패: {error}',
        
        // 기본 메시지
        'status.connected': '$(cloud) SFTP: {serverName}',
        'status.disconnected': '$(cloud-upload) SFTP: 연결 안 됨',
        'status.multiServer': '$(cloud) SFTP: {count}개 서버 연결됨',
        'status.connectedDisconnect': '클릭하여 연결 해제',
        'status.disconnectedConnect': '클릭하여 연결',
        
        // 오류 메시지
        'error.notImplemented': '아직 구현되지 않은 기능입니다.',
        'error.invalidConfig': '잘못된 설정입니다.',
        'error.missingField': '필수 필드가 없습니다: {field}',
        'error.fileNotFound': '파일을 찾을 수 없습니다: {path}',
        'error.directoryNotFound': '디렉토리를 찾을 수 없습니다: {path}',
        'error.permissionDenied': '권한 거부: {path}',
        'error.connectionTimeout': '연결 시간 초과. 서버 상태를 확인하세요.',
        'error.connectionRefused': '연결 거부. 호스트와 포트를 확인하세요.',
        'error.unknownError': '알 수 없는 오류 발생: {error}',
        'error.workspaceNotFound': '워크스페이스를 찾을 수 없습니다.',
        'error.configFileNotFound': 'SFTP 설정 파일이 없습니다. 생성하시겠습니까?',
        'error.noServerInConfig': '설정 파일에 서버 정보가 없습니다.',
        'error.switchServerFailed': '서버 전환 실패: {error}',
        
        // 도움말 & 정보
        'info.configPath': '설정 파일 위치',
        'info.metadataPath': '메타데이터 디렉토리',
        'info.backupPath': '백업 디렉토리',
        'info.connectionInfo': '{serverName} 연결됨 | {host}:{port}',
        'info.serverConnected': '서버 연결 성공: {serverName}',
        'info.serverDisconnected': '서버 연결 해제: {serverName}',
        
        // BATCH 2: downloadMultipleFiles
        'error.selectFilesToDownload': '다운로드할 파일을 선택하세요.',
        'error.noDownloadableFiles': '다운로드 가능한 파일이 없습니다.',
        'progress.downloadingFiles': '{count}개 파일 다운로드 중...',
        'progress.downloadingFile': '{fileName} ({current}/{total})',
        'success.filesDownloaded': '✅ {count}개 파일 다운로드 완료',
        'warning.downloadCompleted': '⚠️ 다운로드 완료: 성공 {success}개, 실패 {failed}개',
        
        // BATCH 3: deleteMultipleFiles
        'error.selectFilesToDelete': '삭제할 파일을 선택하세요.',
        'error.noDeletableFiles': '삭제 가능한 파일이 없습니다.',
        'error.deleteFailed': '❌ 삭제 실패: {error}',
        'confirm.deleteItems': '{count}개 항목을 삭제하시겠습니까?',
        'progress.deletingFiles': '{count}개 항목 삭제 중...',
        'progress.deletingFile': '{fileName} ({current}/{total})',
        'success.itemsDeleted': '✅ {count}개 항목 삭제 완료',
        'warning.deleteCompleted': '⚠️ 삭제 완료: 성공 {success}개, 실패 {failed}개',
        
        // 공통 메시지
        'action.ok': '확인',
        'action.cancel': '취소',
        'action.config': '설정',
        'action.connect': '연결',
        'action.disconnect': '연결 해제',
        'action.download': '다운로드',
        'action.upload': '업로드',
        'action.delete': '삭제',
        'action.refresh': '새로고침',
        'action.reconnect': '재연결',
        
        // BATCH 4: saveAsCommand
        'input.selectInputMethod': '원격 경로 입력 방법을 선택하세요',
        'input.directInput': '$(edit) 직접 입력',
        'input.treeSelect': '$(folder-opened) 트리에서 선택',
        'prompt.remotePathInput': '원격 저장 경로를 입력하세요',
        'placeholder.remotePath': '/var/www/html/file.php',
        'error.pathRequired': '경로를 입력해주세요',
        'error.absolutePath': '절대 경로로 입력해주세요 (예: /var/www/...)',
        'progress.uploading': '업로드 중: {fileName}',
        'success.uploadComplete': '✅ 업로드 완료: {remotePath}',
        'error.uploadFailed': '❌ 업로드 실패: {remotePath}',
        'error.uploadFailedGeneral': '업로드 실패: {error}',
        
        // BATCH 5: Sync and File Management Commands
        'sync.dontDelete': '삭제하지 않음',
        'sync.deleteDeletedFiles': '⚠️ 삭제된 파일도 동기화',
        'sync.selectDeleteHandling': '삭제된 파일 처리 방법을 선택하세요',
        'sync.bidirectional': '양방향 동기화',
        'sync.settings': '동기화 설정:\n\n',
        'sync.deleteChoice': '삭제: {value}',
        'sync.startButton': '동기화 시작',
        'sync.confirmStart': '계속하시겠습니까?',
        'progress.syncingFolder': '폴더 동기화 중...',
        'progress.syncPreparing': '동기화 준비 중...',
        'progress.processingFile': '{fileName} 처리 중...',
        'success.syncComplete': '✅ 동기화 완료!',
        'success.syncStats': '업로드: {uploaded}개 | 다운로드: {downloaded}개 | 삭제: {deleted}개',
        'success.syncDeleteCount': '🗑️ 삭제: {count}개',
        'error.syncFailed': '동기화 실패: {error}',
        
        'prompt.fileNameInput': '생성할 파일 이름을 입력하세요',
        'placeholder.exampleFileName': 'example.txt',
        'error.fileNameRequired': '파일 이름을 입력해주세요',
        'error.fileNameInvalidChars': '파일 이름에 경로 구분자를 포함할 수 없습니다',
        'success.fileCreated': '✅ 파일 생성 완료: {fileName}',
        'error.fileCreateFailed': '파일 생성 실패: {error}',
        
        'prompt.folderNameInput': '생성할 폴더 이름을 입력하세요',
        'placeholder.exampleFolderName': 'newfolder',
        'error.folderNameRequired': '폴더 이름을 입력해주세요',
        'error.folderNameInvalidChars': '폴더 이름에 경로 구분자를 포함할 수 없습니다',
        'success.folderCreated': '✅ 폴더 생성 완료: {folderName}',
        'error.folderCreateFailed': '폴더 생성 실패: {error}',
        
        'confirm.deleteFolderMessage': '폴더 "{fileName}"와 모든 하위 항목을 삭제하시겠습니까?',
        'confirm.deleteFileMessage': '파일 "{fileName}"을 삭제하시겠습니까?',
        'success.fileDeleted': '✅ 파일 삭제 완료: {fileName}',
        'success.folderDeleted': '✅ 폴더 삭제 완료: {fileName}',
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
