# CTLim SFTP - VSCode Extension

VSCode용 SFTP 확장 프로그램으로, 파일 동시 편집 충돌 방지를 위한 수정 감지 기능을 제공합니다.

## 주요 기능

### 🔔 파일 수정 감지 및 경고 (File Modification Warning)

이 확장 프로그램의 핵심 기능은 **동시 편집 충돌 방지**입니다:

- SFTP 서버에서 파일을 다운로드할 때 파일의 **수정 시간(mtime)**과 **크기(size)**를 저장합니다
- 파일을 저장하거나 업로드할 때 서버의 현재 파일 상태를 확인합니다
- 다른 사용자가 파일을 수정한 경우 **경고 메시지**를 표시합니다
- 경고 메시지에는 원본 파일과 현재 파일의 수정 시간 및 크기 정보가 포함됩니다

### 기타 기능

- SFTP 서버에서 파일 다운로드
- SFTP 서버로 파일 업로드
- SFTP 연결 설정 관리

## 설치 방법

1. 이 저장소를 클론하거나 다운로드합니다
2. `npm install`을 실행하여 의존성을 설치합니다
3. `npm run compile`을 실행하여 컴파일합니다
4. `npm run package`를 실행하여 VSIX 파일을 생성합니다
5. VSCode에서 생성된 `.vsix` 파일을 설치합니다

## 사용 방법

### 1. SFTP 연결 설정

명령 팔레트(Ctrl+Shift+P / Cmd+Shift+P)를 열고 다음을 입력합니다:
```
SFTP: Configure Connection
```

다음 정보를 입력합니다:
- SFTP 서버 호스트
- 포트 번호 (기본값: 22)
- 사용자 이름
- 원격 경로

### 2. 파일 다운로드

명령 팔레트에서:
```
SFTP: Download File
```

다운로드할 원격 파일 경로를 입력하고 로컬 저장 위치를 선택합니다.

### 3. 파일 업로드

편집할 파일을 열고 명령 팔레트에서:
```
SFTP: Upload File
```

파일을 업로드하기 전에 서버의 파일이 수정되었는지 자동으로 확인합니다.

### 4. 수정 감지 동작

파일을 저장하거나 업로드할 때:
1. 확장 프로그램이 서버의 현재 파일 상태를 확인합니다
2. 다운로드 시점과 비교하여 변경이 감지되면:
   ```
   ⚠️ Warning: The file "/path/to/file.txt" has been modified on the server!
   
   Original: 2024-01-01 10:00:00 (1234 bytes)
   Current: 2024-01-01 11:30:00 (1567 bytes)
   
   Another user may have made changes. Do you want to overwrite the server file?
   ```
3. 사용자가 덮어쓰기 여부를 선택할 수 있습니다

## 설정

VSCode 설정에서 다음 옵션을 구성할 수 있습니다:

- `ctlimsftp.enableModificationWarning`: 수정 감지 경고 활성화/비활성화 (기본값: true)
- `ctlimsftp.host`: SFTP 서버 호스트
- `ctlimsftp.port`: SFTP 서버 포트 (기본값: 22)
- `ctlimsftp.username`: SFTP 사용자 이름
- `ctlimsftp.remotePath`: 기본 원격 경로

## 기술 스택

- TypeScript
- VSCode Extension API
- ssh2-sftp-client (SFTP 클라이언트)

## 라이선스

ISC
