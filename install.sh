#!/bin/bash

echo "===================================="
echo "ctlim SFTP Extension 설치"
echo "===================================="
echo

# Check if VS Code is installed
if ! command -v code &> /dev/null; then
    echo "❌ VS Code가 설치되어 있지 않습니다."
    echo "   https://code.visualstudio.com/ 에서 다운로드하세요."
    exit 1
fi

# Find VSIX file
VSIX_FILE=$(ls ctlim-sftp-*.vsix 2>/dev/null | head -n 1)

if [ -z "$VSIX_FILE" ]; then
    echo "❌ VSIX 파일을 찾을 수 없습니다."
    exit 1
fi

echo "📦 설치 파일: $VSIX_FILE"
echo
echo "설치 중..."
code --install-extension "$VSIX_FILE" --force

if [ $? -eq 0 ]; then
    echo
    echo "✅ 설치 완료!"
    echo
    echo "사용 방법:"
    echo "1. VS Code를 재시작하세요"
    echo "2. 왼쪽 Activity Bar에서 SFTP 아이콘 클릭"
    echo "3. 명령 팔레트(Ctrl+Shift+P)에서 'ctlim SFTP: Config' 실행"
    echo "4. 서버 정보 입력 후 사용"
else
    echo
    echo "❌ 설치 실패"
fi

echo
read -p "Press Enter to continue..."
