# Markdown to PDF Converter Helper Script
# Usage: .\export-pdf.ps1

Write-Host "Markdown PDF Converter" -ForegroundColor Green
Write-Host ""

# Check if Markdown PDF extension is installed
$extensionInstalled = code --list-extensions | Select-String "yzane.markdown-pdf"

if ($extensionInstalled) {
    Write-Host "[OK] Markdown PDF extension is installed." -ForegroundColor Green
    Write-Host ""
    Write-Host "How to convert:" -ForegroundColor Yellow
    Write-Host "1. Open architecture.md in VS Code"
    Write-Host "2. Press Ctrl+Shift+P for Command Palette"
    Write-Host "3. Run 'Markdown PDF: Export (pdf)'"
    Write-Host "4. architecture.pdf will be created"
} else {
    Write-Host "[X] Markdown PDF extension is NOT installed." -ForegroundColor Red
    Write-Host ""
    $install = Read-Host "Install now? (Y/N)"
    
    if ($install -eq "Y" -or $install -eq "y") {
        Write-Host "Installing extension..." -ForegroundColor Yellow
        code --install-extension yzane.markdown-pdf
        Write-Host "[OK] Installation complete!" -ForegroundColor Green
        Write-Host ""
        Write-Host "After restarting VS Code:" -ForegroundColor Yellow
        Write-Host "1. Open architecture.md"
        Write-Host "2. Ctrl+Shift+P -> 'Markdown PDF: Export (pdf)'"
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Alternative (Online):" -ForegroundColor Yellow
Write-Host "1. Visit https://www.markdowntopdf.com/"
Write-Host "2. Upload architecture.md"
Write-Host "3. Download PDF"
Write-Host "============================================" -ForegroundColor Cyan
