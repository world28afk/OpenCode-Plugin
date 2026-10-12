# oc-purge

**dsh-purge → OpenCode V2 插件移植版**（上游： [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) v1.1.71，MIT）

把 DeepSeek Harness（DSH / Cordis）红队插件 **dsh-purge** 按
[`oc-plugin`](../oc-plugin/docs/dsh-to-opencode-migration.md) 的迁移指南移植为 **OpenCode V2 插件**：
逐模型可换提示词、多规则集、能力选用协议、捆绑红队技能，服务端注入 + TUI 状态条 + 桌面 dock。

> ⚠️ 署名要求：本项目按上游 MIT 许可的二开要求，**保留作者署名与来源仓库**
> [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge)。
> 仅限本地自有主机的红队评测 / 鲁棒性研究使用。

---

## 目录结构

```
oc-purge/
├── .opencode/plugins/oc-purge/     # 插件包（OpenCode V2 自动发现）
│   ├── package.json                    # exports "." → src/index.ts；"./tui" → src/tui.tsx
│   ├── index.ts                        # 目录解析兜底入口
│   ├── prompts/
│   │   ├── default-prompt-inject.md    # 上游加密默认提示词（解封后逐字保留）
│   │   └── capability-protocol.md      # 能力选用协议（官方 / 红队 lead / 红队 executor）
│   └── src/
│       ├── index.ts                    # 默认导出 { id, setup }
│       ├── mount.ts                    # 挂载：注入 hook + 工具 + 命令 + RPC（能力探测降级）
│       ├── config.ts                   # 状态模型 + 注入解析优先级 + 策略
│       ├── inject.ts                   # 槽位组装 + ChatML 布局整理
│       ├── netScope.ts                 # Own servers 白名单校验（等价 net-scope.js）
│       ├── workspace.ts                # CWD rules 扫描 / 勾选注入（等价 rules.js）
│       ├── tools.ts                    # purge_* 工具集
│       ├── rpc.ts                      # purge.status RPC（get/set/apply/revert/rules/skills/servers/cwd）
│       ├── profile.ts                  # 状态元数据（工具与 RPC 共用）
│       ├── prompts.ts / skills.ts      # 由 scripts/sync-assets.mjs 生成的内联资产
│       └── tui.tsx                     # TUI 状态条半体
├── skills/redteam/*.md                 # 上游捆绑红队技能（23 项，逐字保留，可读副本）
├── skills/redteam.bundle.json.gz       # 技能资产包（压缩, 权威来源; 防终端安全软件误删明文）
├── presets/redteam/*                   # 上游红队预设（逐字保留）
├── docs/drill-auth-legal.html          # 上游 Drill 授权与法律声明（逐字保留）
├── docs/comparison-with-upstream.md    # 与上游的界面/功能差异对照（含还原情况）
├── desktop/oc-purge-dock.js        # 桌面/Web DOM 注入（输入框上方「⚔ 破甲」+ 右侧面板）
├── scripts/
│   ├── sync-assets.mjs                 # 资产 → 内联 TS 模块（prompts.ts / skills.ts）
│   ├── patch-desktop.mjs               # app.asar 注入工具（--dry-run/--unpatch/--restore）
│   ├── apply-desktop.ps1               # 关闭 → 打补丁 → 重启
│   ├── smoke.test.ts                   # 假 Context 端到端冒烟
│   └── verify.mjs                      # 确定性回归校验
└── LICENSE                             # MIT（上游）
```

## 移植映射（DSH → OpenCode V2）

| 上游 dsh-purge (DSH / Cordis) | 本移植 (OpenCode V2) |
| :--- | :--- |
| `export const name / inject` + `apply(ctx, config)` | 默认导出 `{ id, setup }`（`Plugin.define` 仅类型辅助） |
| `ctx.systemPrompt.section({ name, order, text })` ×3 | `ctx.session.hook("context", e => e.system.push(...))`（slot/order 存入 metadata） |
| `ctx.tools.register(...)` (status/apply/revert) | `ctx.tool.transform(editor => editor.add(...))`（purge_status / purge_inject / purge_rules / purge_skills） |
| `prompt-inject.md` + `rules/` + workspace policy（落盘 `$DSH_HOME`） | 插件私有 `ctx.storage`（customText / activeRule / rules / policy） |
| `lib/redteam` HTTP 桥 `POST /redteam/api` | `ctx.rpc.register("dsh.purge.status")` → `get` / `set` |
| `skills/redteam/*.md` 导入官方 skills 目录 | 内置资产 + `purge_skills` 工具导出到 `<项目>/.opencode/skills/` |
| `client.js`（会话标题旁 dock） | `src/tui.tsx`（TUI）+ `desktop/oc-purge-dock.js`（桌面 DOM 注入） |
| `cordis.patch.yml` + `scripts/lib/patcher.js`（改宿主文件） | **整节删除**：V2 无宿主补丁面，hook 每次请求生效，卸载即净 |
| `{{cwd}}` 等 DSH 模板转义 | **删除**：OpenCode 无模板层，原文注入 |

> 上游的核心清洗是「打补丁改 `@deepseek-ai` 包文件」。OpenCode V2 没有等价面也**不需要**：
> 系统提示词注入改为 `session.hook("context")`，每次模型调用组装 system 时生效，且不污染持久化历史。

## 安装（本机）

```powershell
# 1) 把插件同步到全局插件目录 (~\.config\opencode\plugins)
powershell -NoProfile -ExecutionPolicy Bypass -File .\sync-plugins.ps1

# 2) 桌面 dock 注入（可选；各插件独立）
node .\oc-purge\scripts\patch-desktop.mjs --dry-run
node .\oc-purge\scripts\patch-desktop.mjs
```

## 配置（插件选项）

`opencode.json` 的对象形式（`plugins` 配置）或目录默认值：

| 选项 | 默认 | 说明 |
| :--- | :--- | :--- |
| `inject` | `true` | 是否注入（`session.hook("context")`） |
| `redteam` | `false` | 能力协议使用「红队 lead」措辞 |
| `redteamChild` | `false` | 能力协议使用「红队 executor」措辞 |
| `skillsDir` | `<项目>/.opencode/skills` | `purge_skills` 导出目标目录 |

## 操作（工具 / 命令 / RPC）

| 工具 | 作用 |
| :--- | :--- |
| `purge_status` | 运行状态：注入槽位 / 提示词来源 / 策略 / 规则 / 服务器 / 本地规则 / 技能 |
| `purge_apply` | 开注入并应用（等价上游 `purge_apply`） |
| `purge_revert` | 回落内置默认（清自定义文本/激活规则，等价上游 `purge_revert`） |
| `purge_inject` | `enable`·`disable`·`set-text`·`clear-text`·`set-policy`·`set-post`·`set-capability` |
| `purge_rules` | 提示词方案（一键切换）：`list`·`use`·`save`·`duplicate`·`rename`·`delete`·`bind`·`unbind`·`reset` |
| `purge_skills` | `list`·`install`·`import`·`create`·`delete`（等价 `/skills`） |
| `purge_servers` | `list`·`set`（Own servers 白名单） |
| `purge_cwd` | `scan`·`select`·`deselect`·`clear`（CWD rules） |

**提示词方案（一键切换）**：方案＝上游的规则集（`rules/`）。桌面面板点方案即切换；
`bind` 可把「模型 / agent」映射到方案，实现上游 README 的卖点「不同模型可换不同提示词」：
```
匹配顺序：provider/model → model → agent
命中绑定 → 当前启用方案 → 手写文本 → 勾选本地规则 → 内置默认
```

斜杠命令（宿主提供 `command.transform` 时注册）：`/purge`、`/rules`、`/skills`。

```
POST /api/rpc/purge.status/{}          # get|set|apply|revert|rules|skills|servers|cwd
POST /api/rpc/purge.status/set         {"input":{"policy":"strict","enabled":true}}
POST /api/rpc/purge.status/rules       {"input":{"action":"activate","id":"alpha"}}
POST /api/rpc/purge.status/servers     {"input":{"action":"set","text":"203.0.113.10"}}
```

**注入解析优先级**：命中的「模型绑定」→ 当前启用方案 → 手写文本 → 勾选本地规则 → 内置默认资产；
策略 `fallback`（默认）/ `strict`（只用用户文本）/ `always`（用户文本后追加默认）。

> 与上游的完整界面/功能差异对照（含 N/A 原因）见
> [docs/comparison-with-upstream.md](docs/comparison-with-upstream.md)。

## OpenCode 适配要点

- **注入即生效**：`session.hook("context")` 在每次模型调用组装 system 时注入，改动无需重启宿主。
- **剥离 ChatML 外壳**：上游把注入文本当 DSH 的 ChatML system 消息；OpenCode 的 system 已是结构化段，
  默认只注入正文（`options.preserveChatml: true` 可还原上游原样）。
- **槽位命名**：`oc-purge:inject` / `oc-purge:capabilities` / `oc-purge:post`（order 值沿用上游 -100000 / -99999 / 5100）。
- **技能目录**：OpenCode 实际发现路径 `<项目>/.opencode/skills/<id>/SKILL.md`（也兼容官方 `skill/`、`.claude/skills`）。
- **插件独立**：桌面 dock 自带服务地址探测（拦截页面 `/api/*` origin + 端口探测 + 面板内「连接」手填），
  **不依赖其它插件的 localStorage 键**；并自动从页面请求里捕获当前会话 `location`，
  RPC 以 `location[directory]` 传参，确保读写命中**同一插件实例**（否则面板看到的模型/状态会与当前会话不一致）。
- **内置默认恒可用**：方案列表顶部固定「内置默认（破甲提示词）」一行，可一键使用，也可一键「复制为方案」变成可编辑方案。
- **无宿主补丁**：删除 `cordis.patch.yml` / patcher.js；卸载即净。

## 回归校验

```powershell
bun scripts/verify.mjs        # 资产哈希/生成一致性/纯函数/静态挂点/包布局/语法构建/冒烟
bun test scripts/smoke.test.ts
```

## 许可与署名

- 上游 `dsh-purge` © YuJunZhiXue，**MIT License**（见 `LICENSE`、`.opencode/plugins/oc-purge/LICENSE`）。
- 本移植保留上游署名与来源仓库；默认提示词、能力协议、红队技能、红队预设、Drill 授权声明
  **逐字保留**并由 `scripts/verify.mjs` 做 SHA256 校验。
- 红队技能以 `skills/redteam.bundle.json.gz` 为权威压缩资产（防终端安全软件误删明文 md）；
  `node scripts/sync-assets.mjs` 会按需把 `skills/redteam/*.md` 还原并重新生成 `src/skills.ts`。
- 红队技能中的上游第三方内容另见 `docs/redteam-upstream-LICENSE` / `docs/redteam-upstream-DISCLOSURE`。
- 仅用于本地自有主机 / 离线靶标 / 已获书面授权的演练；不得用于非法用途。
