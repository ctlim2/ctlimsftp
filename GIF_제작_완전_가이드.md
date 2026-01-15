# 🎥 ctlim SFTP v1.0.0 - GIF 제작 완전 가이드

**버전**: 1.0.0  
**작성일**: 2026년 1월 15일  
**목적**: VS Code Marketplace 홍보용 GIF 4개 제작

---

## 📋 목차

1. [제작 준비물](#제작-준비물)
2. [GIF 1: 기본 플로우](#gif-1-기본-플로우-30초)
3. [GIF 2: 서버지정 - GUI 방식](#gif-2-서버지정---gui-방식-25초)
4. [GIF 3: 서버지정 - JSON 방식](#gif-3-서버지정---json-방식-20초)
5. [GIF 4: 북마크 기능](#gif-4-북마크-기능-20초)
6. [GIF 5: 기본 환경지정](#gif-5-기본-환경지정-25초)
7. [녹화 팁](#녹화-팁-중요)
8. [최종 체크리스트](#최종-체크리스트)

---

## 제작 준비물

### 필수 도구

#### ✅ ScreenToGif (강력 추천)
```
설치 방법 (Windows):
  방법 1: winget install NickeManarin.ScreenToGif
  방법 2: https://www.screentogif.com/ 에서 다운로드
  
특징:
  ✓ GIF 직접 생성 (MP4 → GIF 변환 불필요)
  ✓ 편집 기능 포함 (스피드 조정, 프레임 삭제)
  ✓ 무료 오픈소스
  ✓ 간편한 UI
```

#### ⭐ OBS Studio (전문 버전)
```
설치: https://obsproject.com/
특징:
  ✓ 프로페셔널한 품질
  ✓ 다양한 효과 추가 가능
  ✓ 음성/음악 추가 가능
단점:
  ✗ MP4로 녹화 후 GIF로 변환 필요
  ✗ 초기 설정이 복잡
```

#### 💡 기본 도구
```
Windows 11 Snipping Tool:
  - 내장 도구, 추가 설치 불필요
  - 기본적인 동영상 녹화 가능
  - GIF 변환 필요
```

### VS Code 설정

```
폰트 크기: 14-16pt
  → settings.json에 추가:
     "editor.fontSize": 16

테마: One Light 또는 GitHub Light
  → 밝은 테마로 가독성 향상

확장프로그램:
  ✓ ctlim-sftp v1.0.0 설치 완료
  ✓ 기타 불필요한 확장 비활성화 (화면 깔끔함)

상태바 표시:
  ✓ SFTP 연결 상태 표시
  ✓ 파일 저장 상태 표시
```

### 샘플 프로젝트 구조

```
MyProject/
├── .vscode/
│   ├── settings.json
│   └── ctlim-sftp.json (설정 파일)
├── src/
│   ├── test.php (메인 파일)
│   ├── config.php (북마크용)
│   └── index.html
├── .gitignore
├── README.md
└── package.json
```

### 테스트 서버 준비

```
필요사항:
  1. SSH/SFTP 접근 가능한 서버
  2. 테스트 계정 정보
     - Host: dev.example.com (또는 실제 서버)
     - Port: 22
     - Username: testuser
     - Password: ****
     - Remote Path: /var/www/html

대안 (서버 없는 경우):
  → 로컬 환경에서 OpenSSH Server 설정
    (Windows에서 SSH 서버 실행)
```

---

## GIF 1: 기본 플로우 (30초)

### 🎯 목표
"저장하면 자동으로 업로드된다"는 핵심 기능 시연

### 📝 상세 스크립트

#### [준비 단계]
```
- VS Code 오픈 (MyProject 폴더)
- Activity Bar에 ctlim SFTP 아이콘 보여야 함
- 파일: src/test.php (간단한 내용)
- 서버 미연결 상태 (초기 상태)
```

#### [녹화 세부사항]

| 시간 | 액션 | 설명 |
|------|------|------|
| 0-2초 | Activity Bar 클릭 | 느리게 ctlim SFTP 아이콘 클릭 |
| 2-4초 | 패널 로드 | SFTP 패널 열림 (로딩 애니메이션) |
| 4-7초 | 서버 목록 | "Dev Server" 표시 → 천천히 클릭 |
| 7-10초 | 연결 중 | 프로그레스 바 로딩 애니메이션 |
| 10-12초 | 완료 확인 | 일시정지 (원격 파일 트리 표시) |
| 12-15초 | 파일 오픈 | 에디터에서 src/test.php 클릭 |
| 15-18초 | 파일 표시 | 현재 코드 내용 표시 (읽기 가능) |
| 18-22초 | 파일 편집 | 천천히 몇 줄 코드 수정/추가 |
| 22-24초 | 저장 | Ctrl+S 눌러 저장 |
| 24-27초 | 업로드 확인 | ✅ 업로드 완료 메시지 표시 |
| 27-30초 | 완료 | 일시정지 (결과 강조) |

#### 현재 코드 (시작)
```php
<?php
echo "Hello World";
?>
```

#### 수정된 코드 (완료)
```php
<?php
echo "Hello World";
echo "Updated: " . date('Y-m-d H:i:s');
?>
```

### 화면 구성 (권장)

```
┌──────────────────────────────────────────────┐
│ VS Code (1280x720)                           │
├─────────────────┬──────────────────────────┤
│   Activity      │                          │
│   Bar (좌측)    │   에디터 (우측)           │
│                 │                          │
│ SFTP Explorer   │ src/test.php             │
│ ☁ Dev Server    │ 1  <?php                 │
│ ├─ var/         │ 2  echo "Hello...";      │
│ ├─ www/         │ 3  // 편집 중            │
│ ├─ html/        │ 4                        │
│ │ ├─ test.php ✓ │                          │
│ │ └─ config.php │ ✅ 업로드 완료!           │
│ └─ logs/        │                          │
│                 │                          │
├─────────────────┴──────────────────────────┤
│ 🔄 연결 중: Dev Server (1 파일 업로드)    │
└──────────────────────────────────────────────┘
```

---

## GIF 2: 서버지정 - GUI 방식 (25초)

### 🎯 목표
GUI 편집기를 통한 직관적인 서버 설정

### 📝 상세 스크립트

#### [준비 단계]
```
- VS Code 오픈 (깨끗한 상태)
- .vscode/ctlim-sftp.json 미존재
- Command Palette 사용 준비
```

#### [녹화 세부사항]

| 시간 | 액션 | 설명 |
|------|------|------|
| 0-2초 | Command Palette | Ctrl+Shift+P 눌러 열기 |
| 2-4초 | 검색 입력 | "config" 입력 (천천히) |
| 4-6초 | 옵션 선택 | "ctlim SFTP: Config" 클릭 |
| 6-10초 | GUI 편집기 | 아름다운 GUI 폼 로드 완료 |
| 10-13초 | 서버 이름 | "Server Name" 필드 → "Dev Server" 입력 |
| 13-16초 | Host 입력 | "Host" 필드 → "dev.example.com" 입력 |
| 16-18초 | 사용자명 | "Username" 필드 → "admin" 입력 |
| 18-20초 | Port 확인 | Port 필드 확인 (기본값 22) |
| 20-22초 | 원격 경로 | "Remote Path" → "/var/www/html" 입력 |
| 22-24초 | 저장 | 💾 "Save Configuration" 버튼 클릭 |
| 24-25초 | 완료 | ✅ 설정 완료 메시지 |

#### GUI 폼 구성

```
┌─────────────────────────────────┐
│ 🔧 Server Configuration         │
├─────────────────────────────────┤
│                                 │
│ Server Name:                    │
│ [Dev Server____________]        │
│                                 │
│ Host:                           │
│ [dev.example.com______]         │
│                                 │
│ Port:                           │
│ [22]                            │
│                                 │
│ Username:                       │
│ [admin_________________]        │
│                                 │
│ Password:                       │
│ [••••••••••]                    │
│                                 │
│ Remote Path:                    │
│ [/var/www/html________]         │
│                                 │
│ ✅ Upload on Save               │
│ ☐ Download on Open              │
│                                 │
│ [💾 Save]  [❌ Cancel]          │
│                                 │
└─────────────────────────────────┘
```

---

## GIF 3: 서버지정 - JSON 방식 (20초)

### 🎯 목표
JSON 편집기를 통한 고급 설정 (다중 서버)

### 📝 상세 스크립트

#### [준비 단계]
```
- GUI 설정이 완료된 상태 (또는 JSON 파일 미존재)
- Command Palette 준비
```

#### [녹화 세부사항]

| 시간 | 액션 | 설명 |
|------|------|------|
| 0-2초 | Command Palette | Ctrl+Shift+P 열기 |
| 2-4초 | 검색 | "config" 입력 |
| 4-6초 | JSON 편집기 선택 | "JSON 편집기" 옵션 선택 |
| 6-9초 | 파일 로드 | ctlim-sftp.json 파일 표시 |
| 9-12초 | 구조 수정 | 배열로 변경 ([ 로 시작) |
| 12-15초 | 2번째 서버 추가 | Prod Server 설정 입력 (천천히) |
| 15-18초 | 완료 | JSON 구조 완성 |
| 18-20초 | 저장 및 확인 | Ctrl+S → Activity Bar에 2개 서버 표시 |

#### JSON 파일 내용

```json
[
  {
    "name": "Dev Server",
    "host": "dev.example.com",
    "port": 22,
    "username": "admin",
    "password": "****",
    "remotePath": "/var/www/html",
    "uploadOnSave": true,
    "downloadOnOpen": "confirm",
    "ignore": [".git", "node_modules"]
  },
  {
    "name": "Prod Server",
    "host": "prod.example.com",
    "port": 22,
    "username": "admin",
    "password": "****",
    "remotePath": "/home/web",
    "uploadOnSave": false,
    "downloadOnOpen": true
  }
]
```

---

## GIF 4: 북마크 기능 (20초)

### 🎯 목표
자주 사용하는 파일을 북마크로 빠르게 접근

### 📝 상세 스크립트

#### [준비 단계]
```
- VS Code 오픈
- 서버 연결 완료 상태
- 원격 파일 트리 표시됨
```

#### [녹화 세부사항]

| 시간 | 액션 | 설명 |
|------|------|------|
| 0-2초 | 파일 탐색 | Activity Bar에서 파일 목록 표시 |
| 2-4초 | 파일 선택 | config.php 우클릭 |
| 4-6초 | 메뉴 표시 | 컨텍스트 메뉴 열기 |
| 6-8초 | 북마크 추가 | "⭐ Add Bookmark" 클릭 |
| 8-10초 | 이름 입력 | 다이얼로그 → "Main Config File" 입력 |
| 10-12초 | 설명 입력 | "Database configuration" (선택) |
| 12-14초 | 저장 | ✅ "Save" 버튼 클릭 |
| 14-17초 | 북마크 표시 | "⭐ Bookmarks (1)" 섹션 생성 |
| 17-20초 | 북마크 클릭 | 북마크 클릭 → 파일 즉시 열림 |

#### 결과 화면

```
Activity Bar (좌측):
┌───────────────────┐
│ ⭐ Bookmarks (1) │
│ └─ 📄 Main...   │
│   └─ Prod...   │
│                 │
│ ☁️ Prod Server   │
│ ├─ 📁 var/      │
│ ├─ 📁 www/      │
│ │ └─ 📁 html/   │
│ │   ├─ 📄 config│ ✓ 북마크
│ │   └─ 📄 index│
└───────────────────┘

에디터 (우측):
┌───────────────────┐
│ config.php   [●]  │
├───────────────────┤
│ <?php             │
│ // 데이터베이스   │
│ // 설정           │
│ ...               │
└───────────────────┘
```

---

## GIF 5: 기본 환경지정 (25초)

### 🎯 목표
5가지 주요 설정 옵션을 이해하기

### 📝 상세 스크립트

#### [준비 단계]
```
- ctlim-sftp.json 파일 오픈 상태
- JSON 편집기 활성화
```

#### [녹화 세부사항]

| 시간 | 액션 | 설명 |
|------|------|------|
| 0-3초 | 파일 표시 | ctlim-sftp.json 전체 구조 표시 |
| 3-7초 | context 강조 | 1️⃣ "context": "./src" 하이라이트 |
| 7-11초 | uploadOnSave 강조 | 2️⃣ "uploadOnSave": true 강조 |
| 11-15초 | downloadOnOpen 강조 | 3️⃣ "downloadOnOpen": "confirm" 강조 |
| 15-19초 | ignore 강조 | 4️⃣ "ignore" 배열 하이라이트 |
| 19-22초 | downloadBackup 강조 | 5️⃣ "downloadBackup": "..." 강조 |
| 22-25초 | 완료 | ✅ 5가지 필수 설정 완성! |

#### 주요 설정 설명

```
1️⃣ context: "./src"
   └─ 로컬 워크스페이스 루트 폴더
   └─ 상대/절대 경로 모두 가능
   └─ 기본값: "./'' (프로젝트 루트)

2️⃣ uploadOnSave: true
   └─ 파일 저장 시 자동 업로드
   └─ Ctrl+S → 즉시 서버 업로드
   └─ 개발 속도 향상

3️⃣ downloadOnOpen: "confirm"
   └─ 값: true / false / "confirm"
   └─ 파일 열 때 서버 버전 확인
   └─ 최신 버전 유지

4️⃣ ignore: [".git", "node_modules", "*.log"]
   └─ 업로드 제외 패턴
   └─ 불필요한 파일 전송 방지
   └─ 프로젝트 구조 유지

5️⃣ downloadBackup: ".vscode/.sftp-backup"
   └─ 다운로드 시 로컬 백업 위치
   └─ 기본값: "" (백업 비활성화)
   └─ 실수 방지
```

#### JSON 파일 구조

```json
{
  "name": "Development Server",
  "host": "dev.example.com",
  "port": 22,
  "username": "admin",
  "password": "****",
  "remotePath": "/var/www/html",
  
  "context": "./src",
  "uploadOnSave": true,
  "downloadOnOpen": "confirm",
  "downloadBackup": ".vscode/.sftp-backup",
  
  "ignore": [
    ".git",
    ".vscode",
    "node_modules",
    "*.log",
    "*.tmp",
    ".DS_Store"
  ],
  
  "webUrl": "http://dev.example.com"
}
```

---

## 녹화 팁 (중요!)

### ScreenToGif 사용법

#### 단계별 진행

```
1단계: ScreenToGif 실행
   └─ 설치 후 프로그램 실행

2단계: [Recorder] 버튼 클릭
   └─ 녹화 영역 선택 화면 표시

3단계: 녹화 영역 설정
   └─ 권장 크기: 1280x720 또는 1920x1080
   └─ VS Code 전체 화면 포함

4단계: [⏹ Record] 버튼 클릭
   └─ 녹화 시작

5단계: 천천히 동작 수행
   └─ 각 액션마다 0.5-1초 일시정지
   └─ 마우스 움직임을 명확하게

6단계: [⏹ Stop] 버튼 클릭
   └─ 녹화 종료

7단계: [Editor] 창 자동 열림
   └─ 스피드 조정: 50-70% (느리게)
   └─ 필요시 프레임 삭제

8단계: [Export] → [Gif] 클릭
   └─ 파일명 지정
   └─ 저장 위치 선택
   └─ GIF 파일 생성
```

### 필수 설정 (ScreenToGif)

#### Options (설정)

```
Display (표시):
  ☑ Show cursor (마우스 표시)
  ☑ Show keyboard (키보드 입력 표시) - 선택사항

Performance (성능):
  Latency: 30-50ms
  Frame Rate: 30fps 권장

Output (출력):
  Format: GIF
  Encoding: Optimized (권장)
```

### 녹화 중 필수 주의사항

```
⏱️ 타이밍
  - 각 액션마다 0.5-1초 일시정지
  - 사용자가 화면 변화를 따라갈 수 있도록

🐭 마우스 제어
  - 천천히 움직이기 (빠른 움직임 제외)
  - 목표 위치에서 1초 일시정지

⌨️  키보드 입력
  - 느린 속도로 입력 (0.1초/글자)
  - Ctrl+S 같은 단축키는 명확하게 표시

🎨 화면 가독성
  - 폰트 크기: 16pt 이상
  - 밝은 테마 사용
  - 불필요한 창 닫기

📐 해상도
  - 최소: 1280x720
  - 권장: 1920x1080
  - 일관된 해상도 유지
```

### 재촬영 팁

```
❌ 실패할 가능성이 높은 상황:
  - 인터넷 연결 불안정
  - 서버 응답 지연
  - 입력 실수

✅ 해결 방법:
  1. 로컬 환경 최적화
  2. 리소스 확보 (다른 프로그램 종료)
  3. 여러 번 리허설 후 녹화
  4. 필요시 2-3회 재촬영
```

---

## 최종 체크리스트

### 녹화 전 확인

- [ ] ScreenToGif 설치 완료
- [ ] VS Code 폰트 크기 16pt 이상
- [ ] 테마: 밝은 색상 (One Light 등)
- [ ] 샘플 프로젝트 준비 완료
- [ ] 테스트 서버 접속 확인
- [ ] 서버 설정 파일 삭제 (초기 상태)
- [ ] 모니터 해상도 확인 (1280x720 이상)

### 녹화 중 확인

- [ ] 마우스 표시 활성화
- [ ] 화면 명확함 (텍스트 읽기 가능)
- [ ] 각 액션 사이 0.5-1초 일시정지
- [ ] 서버 응답 대기 시간 고려
- [ ] 음성/배경음악 녹음 여부 결정

### 녹화 후 처리

- [ ] 스피드 조정 (50-70% 권장)
- [ ] 필요시 프레임 삭제
- [ ] GIF 파일크기 확인 (<10MB 권장)
- [ ] 동영상 품질 검증
- [ ] 파일명 정리
  - demo-basic-flow.gif
  - demo-gui-config.gif
  - demo-json-config.gif
  - demo-bookmark.gif
  - demo-env-setup.gif

### 최종 검토

- [ ] 모든 GIF 파일 생성 완료
- [ ] 각 GIF 길이 확인 (30초 내외)
- [ ] 해상도 일관성 확인
- [ ] 파일 크기 최적화
- [ ] Marketplace 업로드 준비

---

## 📊 최종 산출물 정보

| 번호 | GIF명 | 길이 | 주제 | 파일명 |
|------|------|------|------|--------|
| 1 | 기본 플로우 | 30초 | 저장 → 자동 업로드 | `demo-basic-flow.gif` |
| 2 | GUI 서버설정 | 25초 | 편리한 GUI 편집기 | `demo-gui-config.gif` |
| 3 | JSON 서버설정 | 20초 | 고급 다중 서버 설정 | `demo-json-config.gif` |
| 4 | 북마크 기능 | 20초 | 자주 쓰는 파일 빠른 접근 | `demo-bookmark.gif` |
| 5 | 환경설정 | 25초 | 5가지 필수 설정 옵션 | `demo-env-setup.gif` |

**총 시간**: 약 120초 (2분)  
**총 용량**: 약 30-50MB (압축 후)

---

## 🎬 녹화 시작!

모든 준비가 완료되었습니다!  
위 가이드를 따라 천천히 녹화하시면 됩니다. 

**행운을 빕니다!** 🚀

---

**문의사항이 있으시면 언제든 연락주세요.**  
**ctlim SFTP v1.0.0 - Marketplace 성공을 응원합니다!**
