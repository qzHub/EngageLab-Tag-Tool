#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$PROJECT_DIR/.build-venv"

cd "$PROJECT_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -r packaging/requirements-build.txt
"$VENV_DIR/bin/python" -m PyInstaller --noconfirm --clean engagelab_tag_tool.spec

echo ""
echo "构建完成：$PROJECT_DIR/dist/EngageLab Tag 工具.app"
