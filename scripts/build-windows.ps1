$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $ProjectDir ".build-venv"

Set-Location $ProjectDir
py -3 -m venv $VenvDir
& "$VenvDir\Scripts\python.exe" -m pip install --upgrade pip
& "$VenvDir\Scripts\python.exe" -m pip install -r "packaging\requirements-build.txt"
& "$VenvDir\Scripts\python.exe" -m PyInstaller --noconfirm --clean engagelab_tag_tool.spec

Write-Host ""
Write-Host "构建完成：$ProjectDir\dist\EngageLab-Tag-Tool.exe"
