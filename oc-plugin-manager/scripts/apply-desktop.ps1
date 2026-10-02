# oc-plugin-manager 桌面端自动应用（关闭 → 打补丁 → 重启）
# 仅使用本插件自己的 scripts/patch-desktop.mjs；与其它插件的注入互不影响。
$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "oc-plugin-manager-desktop.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log -Encoding UTF8 }

$appDir = "C:\Users\Administrator\AppData\Local\Programs\@opencodedesktop"
$exe = Join-Path $appDir "OpenCode.exe"
$repo = "D:\OpenCode-Plugin\oc-plugin-manager"

try {
  Log "start; waiting 25s"
  Start-Sleep -Seconds 25

  Log "closing OpenCode Desktop..."
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | ForEach-Object { [void]$_.CloseMainWindow() }
  Start-Sleep -Seconds 4
  Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  Log "applying patch (plugin-owned patcher)..."
  Set-Location $repo
  $out = & node scripts\patch-desktop.mjs 2>&1 | Out-String
  $out.Trim() | ForEach-Object { Log $_ }

  Log "relaunching app..."
  Start-Process $exe
  Start-Sleep -Seconds 20
  $running = Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" }
  if ($running) { Log "OK: app running (plugin-manager injector applied)" } else { Log "WARN: app not detected after relaunch" }
}
catch {
  Log "ERROR: $_"
  try { Start-Process $exe; Log "attempted relaunch after error" } catch { Log "relaunch failed: $_" }
}
