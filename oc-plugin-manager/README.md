# oc-plugin-manager

**OpenCode 插件管理器** — OpenCode Desktop 设置页「扩展 → 插件」本来只能**查看**插件列表，本插件为每一行加上**启用/禁用开关**，并提供 RPC / 工具 / TUI 三种通道。

- 🖥 **桌面端**：偏好设置 → 扩展 → 插件，每行右侧出现「已启用 / 已禁用」开关；被禁用的插件以灰显行补列表尾，可随时重新启用。
- 🧰 **工具**：`plugin_manager_list`（列出全部插件与状态）、`plugin_manager_set`（启用/禁用）。
- 🧩 **TUI**：状态条「🧩 插件 n/m」+ `/plugins` 面板。
- 📡 **RPC**：`POST /api/rpc/plugin.manager/{list|set}`（供任何客户端；`rpc.plugin.manager.updated` 事件）。

## 切换语义（可逆、不改宿主）

| 插件类型 | 位置 | 禁用方式 |
| :--- | :--- | :--- |
| 目录型 | `<项目>/.opencode/plugins/<name>/` 或 `~/.config/opencode/plugins/<name>/` | 目录重命名为 `<name>.disabled`（发现逻辑自动忽略） |
| 文件型 | 同上目录下的 `*.ts / *.js` | 重命名为 `<file>.disabled` |
| 配置型 | `opencode.json(c)` 的 `plugins` 数组字符串条目 | 在数组尾部追加 `-<id>` 标记（保留原条目与注释，启用时移除标记） |

- 启用 = 逆操作；所有操作可逆，**不修改任何宿主文件**。
- 管理器**保护自身**（`oc-plugin-manager` 不会被禁用）。
- 配置数组中的对象条目（`{ package, options }`）不支持自动切换，列表中标注「不可切换」。
- 切换后由服务端文件监视热加载；若个别环境未即时生效，重启服务/应用即可。

## 安装

### 1. 服务端插件（必须）

```powershell
# 全局（推荐, 管理所有项目的插件）
Copy-Item -Recurse .opencode\plugins\oc-plugin-manager "$env:USERPROFILE\.config\opencode\plugins\"

# 或仅当前项目
Copy-Item -Recurse .opencode\plugins\oc-plugin-manager "<项目>\.opencode\plugins\"
```

重启（或热加载）后即可用 RPC/工具/TUI。

### 2. 桌面端开关（可选，二选一）

```powershell
# 方式 A（临时）: 桌面端 Ctrl+Shift+I → Console → 粘贴 desktop/oc-plugin-manager-inject.js
# 方式 B（持久化, 独立注入可单独移除）:
node scripts/patch-desktop.mjs --dry-run    # 验证
# 完全退出桌面端后:
node scripts/patch-desktop.mjs              # 注入（自动备份 app.asar.oc-plugin-manager.bak）
node scripts/patch-desktop.mjs --unpatch    # 只移除本插件注入
node scripts/patch-desktop.mjs --restore    # 还原

# 或一键自动应用（关闭→打补丁→重启）:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-desktop.ps1
```

数据通道与其它桌面注入插件一致：自动探测本机服务端口（`/api/info`，401 视为找到），
Electron main 给顶层 frame 的本机请求自动附加认证。

## 选项

| 选项 | 默认 | 说明 |
| :--- | :--- | :--- |
| `projectDir` | `ctx.location.directory` | 项目插件目录的根（扫描 `<root>/.opencode/plugins`） |
| `home` | `os.homedir()` | HOME 根（扫描 `~/.config/opencode/plugins` 与 `~/.config/opencode/opencode.json`） |
| `configHome` | `$XDG_CONFIG_HOME` | 覆盖配置目录 |

## 回归校验

```powershell
bun scripts/verify.mjs          # 文件/静态/构建/注入脚本语法/冒烟
bun test scripts/smoke.test.ts  # 扫描/切换/配置编辑/挂载（全部在临时目录内）
```

## 目录结构

```
oc-plugin-manager/
├── .opencode/plugins/oc-plugin-manager/
│   ├── package.json           # exports "." / "./rpc" / "./tui"
│   ├── index.ts               # 目录解析兜底
│   ├── src/
│   │   ├── index.ts           # 默认导出 { id, setup }
│   │   ├── mount.ts           # 工具 + RPC + 降级
│   │   ├── manager.ts         # 扫描 + 重命名切换引擎
│   │   ├── config.ts          # opencode.json(c) 读取 + 标记式切换
│   │   └── rpc.ts             # RPC 契约 plugin.manager
│   └── tui.tsx                # TUI 状态条 + /plugins 面板
├── desktop/oc-plugin-manager-inject.js   # 设置页开关注入
├── scripts/patch-desktop.mjs · scripts/apply-desktop.ps1
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · LICENSE (MIT)
```

## 已知边界

- 正在运行的插件模块在重命名后会随热加载卸载；若宿主未触发重载，重启服务即可。
- 配置型条目仅支持字符串形式切换；对象条目请在配置文件中手动管理。
- 桌面端自动更新会覆盖 app.asar，升级后重新执行注入即可。
