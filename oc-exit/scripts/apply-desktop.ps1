# oc-exit 桌面端自动应用：关闭 → 打补丁 → 重启
# 只使用本插件自己的 scripts/patch-desktop.mjs（不与其他插件注入互相影响）
$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "oc-exit-desktop.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log -Encoding UTF8 }

# 2.x 起安装目录是 ai.opencode.desktop；老版本是 @opencodedesktop，两处都探
$appDir = @(
  (Join-Path $env:LOCALAPPDATA "Programs\ai.opencode.desktop"),
  (Join-Path $env:LOCALAPPDATA "Programs\@opencodedesktop")
) | Where-Object { Test-Path (Join-Path $_ "OpenCode.exe") } | Select-Object -First 1

if (-not $appDir) {
  Log "ERROR: 找不到 OpenCode Desktop 安装目录"
  exit 1
}

$exe = Join-Path $appDir "OpenCode.exe"
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

try {
  Log "start; appDir=$appDir; waiting 20s"
  Start-Sleep -Seconds 20

  Log "closing OpenCode Desktop + background service..."
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 4
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  # sidecar 必须单独收掉，否则 app.asar 仍被占用
  Get-Process -Name opencode-cli -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  Log "applying patch (plugin-owned patcher)..."
  Set-Location $repo
  $out = & node scripts\patch-desktop.mjs 2>&1 | Out-String
  $out.Trim() | ForEach-Object { Log $_ }

  Log "relaunching app..."
  Start-Process $exe
  Start-Sleep -Seconds 18
  $running = Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" }
  if ($running) { Log "OK: app running (oc-exit tray applied)" } else { Log "WARN: app not detected after relaunch" }
}
catch {
  Log "ERROR: $_"
  try { Start-Process $exe; Log "attempted relaunch after error" } catch { Log "relaunch failed: $_" }
}
