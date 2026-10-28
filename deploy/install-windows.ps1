# ============================================================================
# 资源供给端 - Windows 自启动安装（计划任务：开机自动运行，SYSTEM 最高权限）
#
# 用法（管理员 PowerShell，在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1
#
# 前置：先用引导串完成配置（启动供给端.bat rce_... 生成 provider.config.json）
# 卸载：powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Remove
# ============================================================================
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

function Test-Node {
    try { $v = (node -v); return $v -match 'v(2[2-9]|[3-9]\d+)\.' } catch { return $false }
}

$taskName = 'RC-Provider'
$repoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已卸载自启动任务 $taskName"
    exit 0
}

# 管理员检查（配置 sshd 需要）
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Error '请以管理员身份运行（供给端需要配置 sshd）' }

Write-Host '==> 安装依赖'
if (-not (Test-Node)) { Write-Error '未找到 Node.js（需 >= 22），请先安装：https://nodejs.org/dist/latest-v22.x/' }
Push-Location $repoDir
npm install --no-audit --no-fund
Pop-Location

if (-not (Test-Path (Join-Path $repoDir 'provider.config.json'))) {
    Write-Error '缺少 provider.config.json：请先用引导串运行 启动供给端.bat rce_... 完成配置，再执行本脚本'
}

Write-Host "==> 注册计划任务 $taskName（开机自启，SYSTEM 权限，崩溃 1 分钟自动拉起）"
$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$repoDir\node_modules\tsx\dist\cli.mjs`" src/provider/index.ts" -WorkingDirectory $repoDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4
$running = (Get-ScheduledTask -TaskName $taskName).State
Write-Host ""
Write-Host "完成，任务状态: $running"
Write-Host "管理: Get-ScheduledTask $taskName | Get-ScheduledTaskInfo   停止: Stop-ScheduledTask $taskName"
