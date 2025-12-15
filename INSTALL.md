# ctlim SFTP Extension 설치 가이드

## 자동 설치 (권장)

### Windows
1. `install.bat` 파일을 더블클릭
2. 설치 완료 후 VS Code 재시작

### Mac/Linux
```bash
chmod +x install.sh
./install.sh
```

## 수동 설치

### 방법 1: VS Code에서 설치
1. VS Code 실행
2. Extensions (Ctrl+Shift+X 또는 Cmd+Shift+X)
3. 우측 상단 "..." 메뉴 클릭
4. "Install from VSIX..." 선택
5. `ctlim-sftp-0.2.0.vsix` 파일 선택

### 방법 2: 명령줄에서 설치
```bash
code --install-extension ctlim-sftp-0.2.0.vsix
```

## 사용 방법

1. **설정 파일 생성**
   - 명령 팔레트 (Ctrl+Shift+P 또는 Cmd+Shift+P)
   - "ctlim SFTP: Config" 입력 및 실행
   - `.vscode/ctlim-sftp.json` 파일이 생성됨

2. **서버 정보 입력**
   ```json
   {
       "name": "My Server",
       "context": "./",
       "host": "your-server.com",
       "port": 22,
       "username": "your-username",
       "password": "your-password",
       "remotePath": "/home/user/public_html",
       "uploadOnSave": true,
       "downloadOnOpen": false,
       "ignore": [
           ".vscode",
           ".git",
           "node_modules"
       ]
   }
   ```

3. **서버 연결**
   - 왼쪽 Activity Bar의 SFTP 아이콘 클릭
   - 서버 이름 클릭하여 연결

4. **파일 작업**
   - 파일 저장 시 자동 업로드 (uploadOnSave: true)
   - 트리에서 파일 클릭하여 다운로드
   - 우클릭 메뉴로 업로드/다운로드

## 주요 기능

- ✅ 자동 업로드 (Upload on Save)
- ✅ 파일 충돌 감지
- ✅ 서버 파일 탐색기
- ✅ 다중 서버 지원
- ✅ VS Code 시작 시 변경사항 체크
- ✅ 메타데이터 기반 동기화

## 문제 해결

### VS Code를 찾을 수 없음
- Windows: PATH 환경변수에 VS Code 추가
- Mac: VS Code에서 "Shell Command: Install 'code' command in PATH" 실행

### 확장이 보이지 않음
- VS Code 재시작
- Extensions 패널에서 "ctlim SFTP" 검색

## 라이선스
MIT License
