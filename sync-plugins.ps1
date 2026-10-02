# D:\OpenCode-Plugin\sync-plugins.ps1
# 把各插件仓库的 .opencode/plugins/<name> 同步安装到用户全局插件目录。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Plugin\sync-plugins.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Plugin\sync-plugins.ps1 -WhatIf
param([switch]$WhatIf)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:USERPROFILE ".config\opencode\plugins"
New-Item -ItemType Directory -Force -Path $target | Out-Null

$count = 0
foreach ($repo in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "oc-*" }) {
  $pluginDir = Join-Path $repo.FullName ".opencode\plugins"
  if (-not (Test-Path $pluginDir)) { continue }
  foreach ($plugin in Get-ChildItem $pluginDir -Directory -ErrorAction SilentlyContinue) {
    if ($WhatIf) {
      Write-Output "would sync: $($plugin.Name)  <-  $($repo.Name)"
      $count++
      continue
    }
    $dest = Join-Path $target $plugin.Name
    try {
      if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction Stop }
      Copy-Item $plugin.FullName -Destination $dest -Recurse -Force -ErrorAction Stop
      Write-Output "synced: $($plugin.Name)  <-  $($repo.Name)"
      $count++
    } catch {
      Write-Warning "sync failed: $($plugin.Name) ($_)"
    }
  }
}
Write-Output ""
Write-Output "完成: $count 个插件 -> $target"
Write-Output "提示: 服务端插件热加载通常 10-15 秒内生效; 未生效时重启桌面端/服务。"
