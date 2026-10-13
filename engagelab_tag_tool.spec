# -*- mode: python ; coding: utf-8 -*-

import sys


app_name = "EngageLab-Tag-Tool"

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=[],
    datas=[("static", "static")],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=app_name,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
)

if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="EngageLab Tag 工具.app",
        icon=None,
        bundle_identifier="local.engagelab.tag-tool",
        version="1.0.0",
        info_plist={
            "CFBundleDisplayName": "EngageLab Tag 工具",
            "CFBundleName": "EngageLab Tag 工具",
            "LSMinimumSystemVersion": "11.0",
            "NSHighResolutionCapable": True,
            "NSPrincipalClass": "NSApplication",
        },
    )
