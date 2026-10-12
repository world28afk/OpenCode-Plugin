# 一次性重打全部桌面注入（关闭一次 → 用根 patcher 全量注入 → 重启一次）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Plugin\scripts\apply-desktop-all.ps1
#
# 说明：
#   - 根 scripts/patch-desktop.py 会动态发现所有 oc-*/desktop/*-inject.js 与 *-dock.js
#     （oc-cyberbot / oc-deepseek-banlance / oc-plugin-manager / oc-purge）。
#     oc-infinite-gen-4 已停用（DISABLED_PLUGINS），不再注入。
#   - 桌面端会先被关闭（app.asar 被占用时无法写入），打完补丁后自动重启。
#   - 卸载/还原见同目录 patch-desktop.py 的 --unpatch / --restore。
param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "oc-desktop-apply-all.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log -Encoding UTF8; Write-Output $m }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$appDir = Join-Path $env:LOCALAPPDATA "Programs\@opencodedesktop"
$exe = Join-Path $appDir "OpenCode.exe"

function Stop-Desktop {
  Log "closing OpenCode Desktop..."
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 4
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Start-Desktop {
  Log "relaunching app..."
  try {
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"' + $exe + '"' } | Out-Null
  } catch {
    Start-Process $exe
  }
  Start-Sleep -Seconds 18
  $running = Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" }
  if ($running) { Log "OK: app running" } else { Log "WARN: app not detected after relaunch" }
}

Push-Location $root
try {
  if ($DryRun) {
    Log "dry-run: validating patch plan (no close, no write)"
    python scripts/patch-desktop.py --dry-run 2>&1 | ForEach-Object { Log $_ }
    return
  }

  Stop-Desktop
  Log "applying all desktop injections..."
  python scripts/patch-desktop.py 2>&1 | ForEach-Object { Log $_ }
  Start-Desktop
  Log "done; log: $log"
}
catch {
  Log "ERROR: $_"
  Start-Desktop
}
finally {
  Pop-Location
}
