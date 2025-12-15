@echo off
chcp 65001 >nul 2>&1
cls
echo.
echo ====================================
echo   ctlim SFTP Extension 설치
echo ====================================
echo.

REM Check if VS Code is installed
where code >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ VS Code가 설치되어 있지 않습니다.
    echo    https://code.visualstudio.com/ 에서 다운로드하세요.
    pause
    exit /b 1
)

REM Find VSIX file
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
set "VSIX_FILE="
for %%f in (ctlim-sftp-*.vsix) do set "VSIX_FILE=%%f"

if "%VSIX_FILE%"=="" (
    echo ❌ VSIX 파일을 찾을 수 없습니다.
    echo    현재 디렉토리: %CD%
    pause
    exit /b 1
)

echo 📦 설치 파일: %VSIX_FILE%
echo.
echo 설치 중...

REM Install VSIX using code command
code --install-extension "%VSIX_FILE%" --force 2>&1
set INSTALL_RESULT=%errorlevel%

echo.
echo ========================================
if %INSTALL_RESULT% equ 0 (
    echo [SUCCESS] 설치 완료!
    echo ========================================
) else (
    echo [ERROR] 설치 실패 (오류 코드: %INSTALL_RESULT%)
    echo ========================================
)
echo.
echo.
echo 다음 단계:
echo 1. VS Code 창에서 "Install" 버튼 클릭
echo 2. 설치 완료 후 VS Code 재시작
echo 3. 왼쪽 Activity Bar에서 SFTP 아이콘 클릭
echo 4. 명령 팔레트 (Ctrl+Shift+P) 에서 "ctlim SFTP: Config" 실행
echo 5. 서버 정보 입력 후 사용
echo.

echo.
echo 엔터를 눌러 종료하세요...
pause >nul
echo 종료되었습니다.
exit /b 0
