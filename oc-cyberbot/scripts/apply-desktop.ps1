# oc-cyberbot 桌面注入自动应用：关闭 → 注入 → 重启。
# 可使用本脚本，也可手动执行 scripts/patch-desktop.mjs；不影响其它插件的注入。
$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "oc-cyberbot-desktop.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log -Encoding UTF8 }

$appDir = Join-Path $env:LOCALAPPDATA "Programs\@opencodedesktop"
$exe = Join-Path $appDir "OpenCode.exe"
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

try {
  Log "start; waiting 20s"
  Start-Sleep -Seconds 20

  Log "closing OpenCode Desktop..."
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 4
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  Log "applying patch (oc-cyberbot)..."
  Set-Location $repo
  $out = & node scripts\patch-desktop.mjs 2>&1 | Out-String
  $out.Trim() | ForEach-Object { Log $_ }

  Log "relaunching app..."
  Start-Process $exe
  Start-Sleep -Seconds 18
  $running = Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" }
  if ($running) { Log "OK: app running (oc-cyberbot inject applied)" } else { Log "WARN: app not detected after relaunch" }
}
catch {
  Log "ERROR: $_"
  try { Start-Process $exe; Log "attempted relaunch after error" } catch { Log "relaunch failed: $_" }
}
