# ctlim SFTP - VS Code SFTP Extension

간편한 SFTP 파일 동기화 확장 프로그램으로, 저장 시 자동 업로드와 충돌 감지 기능을 제공합니다.

## ✨ 주요 기능

- 🚀 **저장 시 자동 업로드** - 파일 저장 시 원격 서버에 자동 업로드
- 🔍 **충돌 감지** - 원격 파일 변경 감지 및 충돌 방지
- 📁 **원격 파일 탐색기** - Activity Bar에서 서버 연결 및 파일 탐색
- 🔄 **양방향 동기화** - 업로드/다운로드/전체 동기화
- 🖥️ **다중 서버 지원** - 하나의 설정 파일로 여러 서버 관리
- 🔐 **SSH 키 인증** - Password 또는 Private Key 인증 방식 지원
- ⚙️ **구형 서버 호환** - 다양한 SSH 알고리즘 지원으로 구형 서버 연결 가능

## 📦 설치 방법

1. VS Code Extensions에서 "ctlim SFTP" 검색
2. Install 클릭
3. 또는 [마켓플레이스](https://marketplace.visualstudio.com/)에서 직접 설치

## 🚀 빠른 시작

### 1단계: 설정 파일 생성

1. `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`)를 눌러 Command Palette 열기
2. `ctlim SFTP: Config` 명령 실행
3. 자동으로 `.vscode/ctlim-sftp.json` 파일이 생성됩니다

### 2단계: 서버 정보 입력

`.vscode/ctlim-sftp.json` 파일을 열고 서버 정보를 입력하세요:

```json
{
  "name": "My Server",
  "context": "./",
  "host": "example.com",
  "port": 22,
  "username": "username",
  "password": "password",
  "remotePath": "/var/www/html",
  "uploadOnSave": true,
  "ignore": [
    ".vscode",
    ".git",
    "node_modules"
  ]
}
```

### 3단계: 서버 연결 및 사용

1. **Activity Bar**에서 ctlim SFTP 아이콘 클릭
2. 서버 목록에서 연결할 서버 클릭
3. 파일 우클릭 → `ctlim SFTP: Upload File`로 업로드
4. 또는 `uploadOnSave: true` 설정으로 저장 시 자동 업로드

## ⚙️ 설정 옵션

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `name` | string | - | 서버 식별 이름 |
| `context` | string | `"./"` | 워크스페이스 루트 경로 (상대/절대 경로) |
| `host` | string | **필수** | SFTP 서버 호스트 |
| `port` | number | `22` | SFTP 서버 포트 |
| `username` | string | **필수** | 사용자명 |
| `password` | string | - | 비밀번호 (또는 privateKey 사용) |
| `privateKey` | string | - | SSH 키 파일 경로 (예: `"~/.ssh/id_rsa"`) |
| `passphrase` | string | - | SSH 키 비밀번호 |
| `remotePath` | string | `"/"` | 원격 서버 경로 |
| `uploadOnSave` | boolean | `false` | 저장 시 자동 업로드 활성화 |
| `ignore` | string[] | `[]` | 무시할 파일/폴더 패턴 |

### 다중 서버 설정 예시

```json
[
  {
    "name": "Development Server",
    "host": "dev.example.com",
    "username": "dev-user",
    "password": "dev-pass",
    "remotePath": "/home/dev/www"
  },
  {
    "name": "Production Server",
    "host": "prod.example.com",
    "username": "prod-user",
    "privateKey": "~/.ssh/prod_rsa",
    "passphrase": "key-password",
    "remotePath": "/var/www/production"
  }
]
```

## 📋 사용 가능한 명령어

| 명령어 | 설명 |
|--------|------|
| `ctlim SFTP: Config` | 설정 파일 생성 또는 열기 |
| `ctlim SFTP: Connect to Server` | 서버에 연결 |
| `ctlim SFTP: Disconnect Server` | 서버 연결 해제 |
| `ctlim SFTP: Upload File` | 선택한 파일을 원격 서버에 업로드 |
| `ctlim SFTP: Download File` | 원격 서버에서 파일 다운로드 |
| `ctlim SFTP: Sync Local -> Remote` | 로컬 변경사항을 원격에 전체 동기화 |
| `ctlim SFTP: Refresh Remote Explorer` | 원격 파일 목록 새로고침 |
| `ctlim SFTP: Delete Remote File` | 원격 파일/폴더 삭제 |

## 🔍 충돌 감지 작동 방식

1. 파일 다운로드 시 원격 파일의 수정 시간을 메타데이터에 저장
2. 업로드 시 원격 파일의 현재 수정 시간과 메타데이터 비교
3. 다른 경우 충돌 감지 → 사용자에게 선택 옵션 제공:
   - **덮어쓰기**: 로컬 파일로 원격 파일 덮어쓰기
   - **비교**: Diff 뷰로 변경사항 비교
   - **취소**: 업로드 중단

메타데이터는 `.vscode/.sftp-metadata/` 폴더에 저장됩니다.

## 🤝 기여 및 이슈

버그 리포트나 기능 제안은 [GitHub Issues](https://github.com/ctlim2/ctlimsftp/issues)에 올려주세요.

## 📄 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## 🔗 링크

- [GitHub Repository](https://github.com/ctlim2/ctlimsftp)
- [Issues](https://github.com/ctlim2/ctlimsftp/issues)
- [Changelog](CHANGELOG.md)
