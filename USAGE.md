# Usage Guide / 사용 가이드

## 파일 수정 감지 기능 동작 원리

이 VSCode SFTP 확장 프로그램은 다음과 같이 동작합니다:

### 1. 파일 다운로드 시 메타데이터 저장

파일을 SFTP 서버에서 다운로드할 때:
```
서버 파일: /home/user/document.txt
- 수정 시간: 2024-01-15 10:00:00
- 크기: 1024 bytes

→ 이 정보를 로컬에 저장
```

### 2. 파일 업로드 시 변경 감지

나중에 파일을 업로드할 때:
```
1. 서버의 현재 파일 상태 확인
2. 저장된 메타데이터와 비교
3. 변경이 감지되면 경고 메시지 표시
```

### 3. 경고 메시지 예시

```
⚠️ Warning: The file "/home/user/document.txt" has been modified on the server!

Original: 2024-01-15 10:00:00 (1024 bytes)
Current: 2024-01-15 11:30:00 (1567 bytes)

Another user may have made changes. Do you want to overwrite the server file?

[Overwrite] [Cancel]
```

## 설치 방법

### 옵션 1: VSIX 파일로 설치 (권장)

1. `ctlimsftp-1.0.0.vsix` 파일을 다운로드
2. VSCode 열기
3. 확장 프로그램 뷰 열기 (Ctrl+Shift+X / Cmd+Shift+X)
4. "..." 메뉴 클릭 → "Install from VSIX..." 선택
5. 다운로드한 .vsix 파일 선택

### 옵션 2: 소스에서 빌드

```bash
git clone https://github.com/ctlim2/ctlimsftp.git
cd ctlimsftp
npm install
npm run compile
npm run package
# 생성된 .vsix 파일을 VSCode에 설치
```

## 사용 단계별 가이드

### Step 1: SFTP 연결 설정

1. 명령 팔레트 열기: `Ctrl+Shift+P` (Windows/Linux) 또는 `Cmd+Shift+P` (Mac)
2. `SFTP: Configure Connection` 입력 및 선택
3. 다음 정보 입력:
   - **Host**: SFTP 서버 주소 (예: `sftp.example.com`)
   - **Port**: 포트 번호 (기본값: `22`)
   - **Username**: 사용자 이름
   - **Remote Path**: 원격 경로 (예: `/home/username`)

### Step 2: 파일 다운로드

1. 명령 팔레트에서 `SFTP: Download File` 선택
2. 원격 파일 경로 입력 (예: `/home/username/project/index.js`)
3. SFTP 비밀번호 입력
4. 로컬 저장 위치 선택
5. 파일이 다운로드되고 자동으로 열림

**중요**: 이 시점에서 파일의 수정 시간과 크기가 저장됩니다.

### Step 3: 파일 편집

다운로드한 파일을 자유롭게 편집합니다.

### Step 4: 파일 업로드

1. 편집한 파일이 활성화된 상태에서
2. 명령 팔레트에서 `SFTP: Upload File` 선택
3. SFTP 비밀번호 입력
4. **자동으로 서버 파일 변경 확인**
   - 변경이 없으면: 즉시 업로드
   - 변경이 감지되면: 경고 메시지 표시
5. 경고 메시지에서 선택:
   - `Overwrite`: 서버 파일을 덮어씁니다 (다른 사용자의 변경 사항이 손실됨)
   - `Cancel`: 업로드를 취소합니다 (권장: 최신 버전을 먼저 다운로드)

## 실제 사용 시나리오

### 시나리오 1: 동시 편집 감지

**상황**:
- 사용자 A가 `config.json` 다운로드 (10:00)
- 사용자 B가 같은 파일 수정 및 업로드 (10:15)
- 사용자 A가 수정 후 업로드 시도 (10:30)

**결과**:
```
⚠️ Warning: The file "/project/config.json" has been modified on the server!

Original: 2024-01-15 10:00:00 (256 bytes)
Current: 2024-01-15 10:15:00 (312 bytes)

Another user may have made changes. Do you want to overwrite the server file?
```

**권장 조치**:
1. `Cancel` 선택
2. 최신 버전을 다운로드
3. 변경 사항을 병합
4. 다시 업로드

### 시나리오 2: 정상 업로드

**상황**:
- 파일을 다운로드하고 편집
- 다른 사용자가 파일을 수정하지 않음

**결과**:
- 경고 없이 즉시 업로드 완료
- 메타데이터 자동 업데이트

## 설정 옵션

VSCode 설정 (`settings.json`)에서 구성 가능:

```json
{
  "ctlimsftp.enableModificationWarning": true,
  "ctlimsftp.host": "sftp.example.com",
  "ctlimsftp.port": 22,
  "ctlimsftp.username": "myusername",
  "ctlimsftp.remotePath": "/home/myusername"
}
```

### 설정 설명

- `enableModificationWarning`: 수정 경고 기능 활성화/비활성화
  - `true` (기본값): 경고 활성화
  - `false`: 경고 비활성화 (항상 덮어쓰기)

## 문제 해결

### Q: 비밀번호를 매번 입력해야 하나요?

A: 현재 버전에서는 보안을 위해 매 작업마다 비밀번호를 입력해야 합니다. 향후 버전에서 SSH 키 기반 인증을 추가할 예정입니다.

### Q: 경고가 표시되지 않습니다

A: 다음을 확인하세요:
1. `ctlimsftp.enableModificationWarning` 설정이 `true`인지 확인
2. 파일을 `SFTP: Download File` 명령으로 다운로드했는지 확인
3. 다른 방법으로 다운로드한 파일은 메타데이터가 없어 경고가 표시되지 않습니다

### Q: 이미 다운로드한 파일의 메타데이터를 초기화하려면?

A: 파일을 다시 `SFTP: Download File` 명령으로 다운로드하면 메타데이터가 업데이트됩니다.

## 기술적 세부사항

### 메타데이터 저장

- **저장 위치**: VSCode의 워크스페이스 상태 (workspace state)
- **저장 정보**:
  - 로컬 파일 경로
  - 원격 파일 경로
  - 수정 시간 (Unix timestamp)
  - 파일 크기 (bytes)

### 비교 로직

```typescript
if (currentStats.modifyTime !== metadata.mtime || 
    currentStats.size !== metadata.size) {
    // 경고 표시
}
```

- 수정 시간 또는 크기가 다르면 변경으로 간주
- 두 값 모두 비교하여 정확도 향상

## 보안 고려사항

1. **비밀번호 보안**: 비밀번호는 메모리에만 저장되며 디스크에 저장되지 않습니다
2. **SFTP 연결**: SSH2 프로토콜 사용 (암호화된 연결)
3. **메타데이터**: 파일 내용이 아닌 메타데이터만 저장

## 라이선스

ISC License - 상업적 및 개인적 사용 가능
