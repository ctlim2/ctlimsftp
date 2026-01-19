# Change Log

All notable changes to the "ctlim SFTP" extension will be documented in this file.

## [1.1.4] - 2026-01-19

### Changed
- README 이미지 URL을 GitHub blob URL(?raw=true)로 변경하여 마켓플레이스 즉시 표시 보장

### Fixed
- GitHub raw CDN 캐시 지연으로 인한 이미지 404 오류 해결

## [1.1.3] - 2026-01-19

### Changed
- README 대표 이미지를 충돌 감지(save-dif.gif)로 변경
- 북마크 기능 설명에 데모 GIF(bookmark.gif) 추가
- 다른 이름으로 저장 기본 동작을 직접 입력 방식으로 변경

### Improved
- 문서 시각화 개선으로 기능 이해도 향상

## [0.5.6] - 2026-01-15

### Fixed
- executeCustomCommand 에러 수정 - 트리 뷰 아이템의 선택적 config 속성 처리 개선
- SftpTreeItem 타입 체크 추가로 서버 아이템만 커스텀 명령 실행 가능
- Config 로딩 fallback chain 개선 (연결 캐시 → 파일 시스템)

### Added
- Commands 탭 (GUI 설정 편집기에서 서버 커스텀 명령 관리)
- 명령 추가/수정/삭제 기능

## [0.2.2] - 2025-12-16

### Added
- 패스워드 입력 프롬프트 - 설정 파일에 패스워드가 없을 때 연결 시 입력창 표시
- 키워드에 "ctlim" 추가로 검색 최적화

### Improved
- 보안 향상 - 설정 파일에 패스워드를 저장하지 않고 사용 가능

## [0.2.1] - 2025-12-16

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
