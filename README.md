# SFTP Extension for VS Code

SFTP/FTP 파일 동기화 확장 프로그램입니다.

## 기능

- 파일 업로드
- 파일 다운로드
- 로컬 -> 원격 동기화
- SFTP 설정 관리

## 사용 방법

1. `Ctrl+Shift+P`를 눌러 Command Palette 열기
2. "SFTP: Config" 명령 실행하여 설정 파일 생성
3. 설정 파일에 SFTP 서버 정보 입력
4. 파일 우클릭 -> "SFTP: Upload File" 또는 "SFTP: Download File" 선택

## 설정

`.vscode/sftp.json` 파일:

```json
{
  "host": "example.com",
  "port": 22,
  "username": "user",
  "password": "password",
  "remotePath": "/remote/path",
  "uploadOnSave": false
}
```

## 명령어

- `SFTP: Upload File` - 선택한 파일을 원격 서버에 업로드
- `SFTP: Download File` - 원격 서버에서 파일 다운로드
- `SFTP: Sync Local -> Remote` - 로컬 변경사항을 원격에 동기화
- `SFTP: Config` - SFTP 설정 파일 생성/열기
