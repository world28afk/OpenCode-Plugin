# OpenCode Plugin Workspace

统一管理在本机开发的全部 OpenCode 插件（源码仓库 + 桌面注入 + 安装脚本）。

## 插件仓库

| 仓库 | 说明 | 类型 | GitHub |
| :--- | :--- | :--- | :--- |
| `oc-infinite-gen-4` | 无限四代内核移植 + 桌面徽章 | 服务端 + 桌面注入 | world28afk/oc-infinite-gen-4 |
| `oc-deepseek-banlance` | DeepSeek 余额（上下文圈 + 审查页） | 服务端 + 桌面注入 | world28afk/oc-deepseek-banlance |
| `oc-plugin-manager` | 插件管理器（设置页原生开关启用/禁用） | 服务端 + 桌面注入 | world28afk/oc-plugin-manager |
| `oc-perf-guard` | 性能守卫（脚本资源治理：Laya 式规则判定 → 自动降优先级/宽限终止/保留；含 MCP 进程归因清理） | 服务端 + TUI | world28afk/oc-perf-guard |
| `oc-workflow` | Workflow（capsule/并行子代理/运行图/续跑） | 服务端 + TUI | world28afk/oc-workflow |
| `oc-router-laya` | 档位路由（Laya 四层管线, 多模型档位表） | 服务端 + TUI | world28afk/oc-router-laya |
| `oc-plugin` | OpenCode 插件开发与迁移文档 | 文档 | world28afk/oc-plugin |

## 常用操作

```powershell
# 1) 同步全部插件的服务端部分到全局插件目录（~\.config\opencode\plugins）
powershell -NoProfile -ExecutionPolicy Bypass -File .\sync-plugins.ps1

# 2) 桌面注入（各插件自带, 互不影响）
node .\oc-plugin-manager\scripts\patch-desktop.mjs          # 插件管理器开关
node .\oc-infinite-gen-4\scripts\patch-desktop.mjs          # 无限四代徽章
node .\oc-deepseek-banlance\scripts\patch-desktop.mjs       # 余额注入（如有）
# 或使用各自的 scripts\apply-desktop.ps1（自动关闭→打补丁→重启）

# 3) 回归校验（各仓库根目录）
bun scripts/verify.mjs
```

## 约定

- 每个仓库自包含：`.opencode/plugins/<name>/` 为插件本体；`scripts/` 含校验与桌面补丁工具；`desktop/` 为注入脚本。
- 运行时安装目录始终是 `~\.config\opencode\plugins`（OpenCode 的插件发现路径），本工作区只保存源码副本；改完源码跑一次 `sync-plugins.ps1` 即可。
- 桌面端注入通过 app.asar 补丁实现（各插件独立标签, 可单独 `--unpatch` 移除）；桌面端自动更新后需重打补丁。
- 仓库之间完全独立：注入/补丁/卸载互不干扰。
