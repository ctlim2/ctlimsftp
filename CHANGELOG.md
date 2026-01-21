# Change Log

All notable changes to the "ctlim SFTP" extension will be documented in this file.

## [1.1.7] - 2026-01-21

### Fixed
- 패키징 빌드 오류 수정 (`@types/vscode` 버전 다운그레이드 및 의존성 호환성 개선)

## [1.1.6] - 2026-01-20

### Added
- **원격 로그 실시간 감시 (Watch Log)**: 원격 파일 컨텍스트 메뉴에서 `tail -f` 명령을 통해 실시간 로그 확인 가능
- **로그 감시 중지**: 감시 시작 시 알림 메시지의 'Stop' 버튼으로 중지 기능 제공

## [1.1.4] - 2026-01-19

### Added
- 원격 파일 탐색기 (Remote File Explorer) - Activity Bar에서 서버 연결 및 파일 탐색
- 다중 서버 설정 지원 (Array of configs in ctlim-sftp.json)
- 파일 충돌 감지 기능 (Conflict detection using metadata)
- 원격 파일 열기 및 다운로드 기능
- 원격 파일/폴더 삭제 기능
- 시작 시 원격 파일 변경 감지 및 알림

### Features
- Upload on Save (저장 시 자동 업로드)
- 워크스페이스별 설정 파일 (`.vscode/ctlim-sftp.json`)
- Context 기반 워크스페이스 루트 설정
- SSH 키 인증 지원 (privateKey + passphrase)
- 구형 SSH 서버 호환성 지원

### Configuration
- `name`: 서버 식별자
- `context`: 워크스페이스 루트 경로
- `host`, `port`, `username`: 서버 연결 정보
- `password` 또는 `privateKey`: 인증 방식 선택
- `remotePath`: 원격 서버 경로
- `uploadOnSave`: 저장 시 자동 업로드 활성화
- `ignore`: 무시할 파일/폴더 패턴

## [0.1.0] - Initial Release

### Added
- 기본 SFTP 업로드/다운로드 기능
- 로컬 -> 원격 동기화
- 설정 파일 생성 명령어
