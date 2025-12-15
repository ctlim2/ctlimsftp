# ctlim SFTP Extension 설치 스크립트
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "  ctlim SFTP Extension 설치" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

# VS Code 설치 확인
$vscode = Get-Command code -ErrorAction SilentlyContinue
if (-not $vscode) {
    Write-Host "VS Code가 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "https://code.visualstudio.com/ 에서 다운로드하세요." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "엔터를 눌러 종료하세요"
    exit 1
}

# VSIX 파일 찾기
$vsixFile = Get-ChildItem -Path $PSScriptRoot -Filter "ctlim-sftp-*.vsix" | Select-Object -First 1

if (-not $vsixFile) {
    Write-Host "VSIX 파일을 찾을 수 없습니다." -ForegroundColor Red
    Write-Host ""
    Read-Host "엔터를 눌러 종료하세요"
    exit 1
}

Write-Host "설치 파일: $($vsixFile.Name)" -ForegroundColor Green
Write-Host ""
Write-Host "설치 중..." -ForegroundColor Yellow
Write-Host ""

# 설치 실행
& code --install-extension $vsixFile.FullName --force

Write-Host ""
Write-Host "========================================" -ForegroundColor Green

if ($LASTEXITCODE -eq 0) {
    Write-Host "[SUCCESS] 설치 완료!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "사용 방법:" -ForegroundColor Cyan
    Write-Host "  1. VS Code를 재시작하세요"
    Write-Host "  2. 왼쪽 Activity Bar에서 SFTP 아이콘 클릭"
    Write-Host "  3. 명령 팔레트 (Ctrl+Shift+P) 에서 ctlim SFTP: Config 실행"
    Write-Host "  4. 서버 정보 입력 후 사용"
    Write-Host ""
} else {
    Write-Host "[ERROR] 설치 실패" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
}

Write-Host ""
Read-Host "엔터를 눌러 종료하세요"