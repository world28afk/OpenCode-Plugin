# oc-exit 独立终止脚本 —— 立即彻底关闭 OpenCode Desktop（桌面端 + 后台 sidecar）
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\quit-opencode.ps1
#   powershell ... -File scripts\quit-opencode.ps1 -DryRun      # 只看会杀哪些进程
#   powershell ... -File scripts\quit-opencode.ps1 -WithMcp     # 连 MCP 子进程一起收
#
# 为什么不用 taskkill /T:
#   /T 按父进程树递归，而脚本自身就在被终止的树里 -> 脚本自杀，后续清理丢失；
#   新版桌面端还会按 service.json 复用/重启 sidecar，杀一次容易漏。
#   这里改成 按镜像名取 PID -> Stop-Process -Id 精确终止 -> 轮询复查 直到干净。

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$WithMcp,
  [int]$MaxRounds = 20
)

$ErrorActionPreference = 'SilentlyContinue'
$LogPath = Join-Path $env:TEMP 'oc-exit-quit.log'

function Write-OcLog([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Message
  Write-Host $line
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch {}
}

function Get-OcProc([string[]]$Names) {
  $items = @()
  foreach ($name in $Names) {
    $filter = "Name='" + $name + "'"
    $items += @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue | Select-Object ProcessId, Name)
  }
  return $items
}

function Get-McpProc {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'mcp|@modelcontextprotocol|jshook|cyberchef|mcp-server|roxybrowser|ida-mcp|sequential-thinking|deepwiki'
  } | Select-Object ProcessId, Name
}

$desktopNames = @('OpenCode.exe')
$serviceNames = @('opencode-cli.exe')

if ($DryRun) {
  Write-OcLog 'dry-run: 以下进程将被终止'
  Get-OcProc $desktopNames | ForEach-Object { Write-OcLog ('  desktop  {0} pid={1}' -f $_.Name, $_.ProcessId) }
  Get-OcProc $serviceNames | ForEach-Object { Write-OcLog ('  service  {0} pid={1}' -f $_.Name, $_.ProcessId) }
  if ($WithMcp) { Get-McpProc | ForEach-Object { Write-OcLog ('  mcp      {0} pid={1}' -f $_.Name, $_.ProcessId) } }
  return
}

Write-OcLog 'quit requested'

for ($round = 1; $round -le $MaxRounds; $round++) {
  $desktop = @(Get-OcProc $desktopNames)
  $service = @(Get-OcProc $serviceNames)
  if ($desktop.Count -eq 0 -and $service.Count -eq 0) { break }

  # 先关桌面端：否则它会把刚被杀掉的 sidecar 重新拉起来
  foreach ($p in $desktop) {
    Write-OcLog ('kill {0} pid={1}' -f $p.Name, $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 300

  foreach ($p in @(Get-OcProc $serviceNames)) {
    Write-OcLog ('kill {0} pid={1}' -f $p.Name, $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 400
}

# 兜底：按镜像名再扫一遍（不用 /T，避免误伤本脚本自身）
taskkill /IM OpenCode.exe /F 2>$null | Out-Null
taskkill /IM opencode-cli.exe /F 2>$null | Out-Null

if ($WithMcp) {
  foreach ($p in @(Get-McpProc)) {
    Write-OcLog ('kill mcp {0} pid={1}' -f $p.Name, $p.ProcessId)
    taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
  }
}

# 清掉指向已死进程的 service.json，避免下次启动复用幽灵服务
$statePath = Join-Path $env:USERPROFILE '.local/state/opencode/service.json'
if ((Test-Path -LiteralPath $statePath) -and (@(Get-OcProc $serviceNames).Count -eq 0)) {
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-OcLog 'removed stale service.json'
}

$leftDesktop = @(Get-OcProc $desktopNames).Count
$leftService = @(Get-OcProc $serviceNames).Count
Write-OcLog ('done; left desktop={0} service={1}' -f $leftDesktop, $leftService)
