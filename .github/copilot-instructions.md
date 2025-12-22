# ctlim SFTP Extension - AI 코딩 에이전트 가이드

## 프로젝트 개요
VS Code용 SFTP 확장 프로그램으로, 파일 저장 시 자동 업로드와 충돌 감지 기능을 제공합니다.
- **메인 라이브러리**: `ssh2-sftp-client` (구형 SSH 서버 호환용 알고리즘 포함)
- **언어**: TypeScript (target: ES2020, strict mode)
- **빌드 출력**: `out/` 디렉토리

## 아키텍처

### 핵심 컴포넌트 (3계층 구조)

1. **SftpClient** ([src/sftpClient.ts](../src/sftpClient.ts)) - 핵심 비즈니스 로직
   - SFTP 연결 관리: `ssh2-sftp-client` 래퍼
   - 파일 작업: `uploadFile()`, `downloadFile()`, `syncFolder()`
   - 메타데이터 기반 충돌 감지 시스템 (아래 참조)
   - 구형 서버 호환: `connect()` 메서드의 `algorithms` 옵션에 레거시 kex/cipher 명시적 포함

2. **SftpTreeProvider** ([src/sftpTreeProvider.ts](../src/sftpTreeProvider.ts)) - UI 계층
   - Activity Bar 트리 뷰 제공: 서버 목록 + 원격 파일 탐색
   - 다중 서버 연결 관리: `connectedServers` Map으로 여러 서버 동시 접속
   - 동적 서버 로딩: `.vscode/ctlim-sftp.json`에서 자동 서버 목록 구성
   - 파일 아이콘 자동 매칭 (`getFileIcon()` 메서드)

3. **extension.ts** ([src/extension.ts](../src/extension.ts)) - 통합 레이어
   - VS Code 명령어 등록 및 이벤트 핸들링
   - `onDidSaveTextDocument`: 자동 업로드 트리거
   - 설정 파일 로딩 전략: 캐시(`documentConfigCache`) → 메타데이터 조회 → 경로 매칭
   - 충돌 해결 UI: 덮어쓰기/취소/비교(Diff) 옵션 제공

### 메타데이터 시스템 (충돌 감지)

**저장 위치**: `.vscode/.sftp-metadata/<encoded-filename>.json`  
**인코딩 규칙** (`makeMetafileName()`):
- `:` → `_c_` (드라이브 문자)
- `_` → `_u_` (충돌 방지)
- `/`, `\` → `__` (경로 구분자)

**데이터 구조** ([types.ts](../src/types.ts)):
```typescript
interface FileMetadata {
    remotePath: string;           // 원본 원격 경로
    remoteModifyTime: number;     // 타임스탬프 (ms)
    remoteFileSize: number;
    localPath: string;
    downloadTime: number;
    configName?: string;          // 다중 서버 구분용
}
```

**충돌 감지 플로우**:
1. `uploadFile()` 호출 시 메타데이터 존재 확인
2. `client.stat(remotePath)`로 현재 원격 파일 시간 조회
3. `remoteModifyTime !== metadata.remoteModifyTime` 검증
4. 불일치 시 `{ uploaded: false, conflict: true, remotePath }` 반환
5. 사용자 선택 → 덮어쓰기 시 `skipConflictCheck=true`로 재호출

### 다중 서버 아키텍처

**설정 형식**:
```json
[
  {
    "name": "Dev Server",
    "context": "./",           // 워크스페이스 루트 (상대/절대 경로)
    "host": "dev.example.com",
    "remotePath": "/var/www",
    "uploadOnSave": true
  },
  {
    "name": "Prod Server",
    "context": "./dist",       // 다른 로컬 디렉토리 매핑
    "host": "prod.example.com",
    "remotePath": "/home/web"
  }
]
```

**Config 검색 우선순위** (extension.ts):
1. `documentConfigCache` (WeakMap, 문서별 캐시)
2. `findConfigByMetadata()` (메타데이터 파일에서 역추적)
3. `findConfigForFile()` (파일 경로와 `config.workspaceRoot` 매칭)
4. 폴백: `uploadOnSave: true`인 첫 번째 설정

## 개발 워크플로우

### 빌드 & 디버깅
```powershell
npm run compile          # TypeScript → out/ (commonjs)
npm run watch           # 자동 재컴파일 (파일 변경 감지)
F5                      # Extension Development Host 실행
```

**디버깅 팁**:
- `.vscode/launch.json`에서 `preLaunchTask: "watch"` 설정됨
- Extension Host에서 `Ctrl+Shift+P` → "Reload Window"로 재시작

### 패키징
```powershell
vsce package            # .vsix 파일 생성
vsce publish            # Marketplace 배포
```

## 코딩 컨벤션

### 경로 처리 (크로스 플랫폼)
- **로컬 경로**: `path.join()`, `path.dirname()` (Windows `\` 자동 처리)
- **원격 경로**: `path.posix.join()` (항상 `/` 사용)
- **예시**:
  ```typescript
  const remotePath = path.posix.join(config.remotePath, relativePath.replace(/\\/g, '/'));
  ```

### 에러 메시지
- 한글 사용: `"SFTP 클라이언트가 연결되지 않았습니다."`
- 사용자 친화적 알림: `vscode.window.showErrorMessage()` + 이모지 (✅/❌/⚠️)

### 비동기 패턴
- `async/await` 사용 (Promise 체이닝 회피)
- `vscode.window.withProgress()`로 장시간 작업 표시
- 에러 핸들링: try-catch로 `vscode.window.showErrorMessage()` 호출

## 주요 명령어 (package.json)

| 명령어 ID | 설명 | 구현 위치 |
|-----------|------|-----------|
| `ctlimSftp.config` | 설정 파일 생성/열기 | extension.ts `configCommand` |
| `ctlimSftp.connectServer` | 서버 연결 (TreeView 클릭) | sftpTreeProvider.ts `connectToServer()` |
| `ctlimSftp.upload` | 수동 업로드 | extension.ts `uploadCommand` |
| `ctlimSftp.openRemoteFile` | 원격 파일 열기 (다운로드 + 편집) | extension.ts `openRemoteFileCommand` |
| `ctlimSftp.refresh` | TreeView 새로고침 | sftpTreeProvider.ts `refresh()` |

## 외부 의존성

- **ssh2-sftp-client** (v10.0.3): SFTP 프로토콜 구현
  - 주의: 레거시 알고리즘 필요 시 `algorithms` 옵션 명시
- **VS Code API**:
  - `TreeDataProvider`: Activity Bar 트리 뷰
  - `FileSystemWatcher`: 파일 변경 감지 (미사용, `onDidSaveTextDocument` 대신)
  - `WeakMap<TextDocument, SftpConfig>`: 문서별 설정 캐시

## 알려진 제약사항

1. **메타데이터 의존성**: 첫 다운로드 없이 업로드 시 충돌 감지 불가
2. **SFTP 전용**: FTP/FTPS 미지원
3. **파일 단위 작업**: 폴더 단위 동기화는 `syncFolder()`로 순차 처리

## 참고 파일

- [package.json](../package.json) - 확장 manifest (명령어/메뉴/설정)
- [tsconfig.json](../tsconfig.json) - TypeScript 컴파일러 옵션
- [README.md](../README.md) - 사용자 문서 (한글, 설정 예시)
- [docs/architecture.md](../docs/architecture.md) - 상세 아키텍처 (존재 시)

---
**AI 에이전트 가이드라인**:
- 모든 답변은 한글로 작성
- 영어 전문 용어는 한글 발음 병기 (예: TreeView 트리뷰)
- 코드 수정 시 `path` vs `path.posix` 구분 엄수
- 메타데이터 인코딩 로직 변경 시 기존 파일 호환성 고려
