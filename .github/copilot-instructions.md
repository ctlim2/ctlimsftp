# ctlim SFTP Extension - AI 코딩 에이전트 가이드

## 프로젝트 개요
VS Code용 SFTP 확장 프로그램으로, 파일 저장 시 자동 업로드와 충돌 감지 기능을 제공합니다.
- **메인 라이브러리**: `ssh2-sftp-client` (구형 SSH 서버 호환용 알고리즘 포함)
- **언어**: TypeScript (target: ES2020, strict mode)
- **빌드 출력**: `out/` 디렉토리

## 아키텍처

### 핵심 컴포넌트
1. **SftpClient** ([../src/sftpClient.ts](../src/sftpClient.ts))
   - SFTP 연결 및 파일 작업 담당
   - 메타데이터 기반 충돌 감지: `.vscode/.sftp-metadata/` 디렉토리에 원격 파일 수정 시간 저장
   - 구형 서버 호환: `algorithms` 옵션에 레거시 kex/cipher 포함

2. **Types** ([../src/types.ts](../src/types.ts))
   - `SftpConfig`: 서버 설정 (다중 서버 지원)
   - `FileMetadata`: 충돌 감지용 메타데이터 (remotePath, remoteModifyTime)

3. **Activity Bar 트리 뷰**
   - 서버 목록 및 원격 파일 탐색기
   - 컨텍스트 메뉴: 업로드/다운로드/삭제

### 데이터 플로우
```
파일 저장 → uploadOnSave 체크 → 메타데이터 비교 (충돌 감지) → 업로드 → 메타데이터 갱신
```

## 개발 워크플로우

### 빌드 & 테스트
```powershell
npm run compile          # TypeScript 컴파일 (out/ 디렉토리 생성)
npm run watch           # 자동 재컴파일
F5                      # VS Code Extension Host 디버깅
```

### 설정 파일 위치
- **확장 설정**: `.vscode/ctlim-sftp.json` (단일 또는 배열 형식)
- **메타데이터**: `.vscode/.sftp-metadata/` (충돌 감지용, 자동 생성)

## 프로젝트별 규칙

### 경로 처리 패턴
- **로컬 경로**: `path.join()` (Windows 호환)
- **원격 경로**: `path.posix.join()` (항상 `/` 사용)
- **메타데이터 파일명 인코딩**: `_` → `_u_`, `/` → `__`

### 충돌 감지 로직
1. 업로드 전 원격 파일 `modifyTime` 조회
2. `.vscode/.sftp-metadata/`의 저장된 시간과 비교
3. 불일치 시 `conflict: true` 반환 (업로드 차단)

### 에러 처리
- 한글 에러 메시지 사용: `"SFTP 클라이언트가 연결되지 않았습니다."`
- 원격 디렉토리 없으면 자동 생성: `ensureRemoteDir()`

## 주요 명령어
- `ctlim SFTP: Config` - 설정 파일 생성 (`.vscode/ctlim-sftp.json`)
- `ctlim SFTP: Connect to Server` - 서버 연결
- `ctlim SFTP: Upload File` - 수동 업로드

## 외부 의존성
- `ssh2-sftp-client`: SFTP 클라이언트 (v10.0.3)
- VS Code API: TreeView, OutputChannel, FileSystemWatcher

## 참고 파일
- [../package.json](../package.json) - 확장 manifest 및 명령어 정의
- [../README.md](../README.md) - 사용자 문서 (한글)

---
모든 답변은 한글로 해줘.
앞으로 영어 단어 뒤에 한글 발음을 적어주세요.
