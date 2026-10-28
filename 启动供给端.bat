@echo off
chcp 65001 >nul
title 资源池供给端 Provider
color 0B

echo ════════════════════════════════════════════════
echo   资源供给端（需管理员身份运行本窗口）
echo   首次使用: 把管理员给的引导串作为参数拖进来运行
echo   示例:     启动供给端.bat rce_xxxxxxxx
echo ════════════════════════════════════════════════
cd /d "%~dp0"
if not exist node_modules (
    echo [首次] 安装依赖...
    call npm install --no-audit --no-fund
)
npx tsx src/provider/index.ts %*
echo.
echo 进程退出。按任意键关闭...
pause >nul
