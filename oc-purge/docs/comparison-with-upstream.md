# oc-purge ↔ 上游 dsh-purge 差异对照（界面 / 功能）

对照上游 [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) v1.1.71（DSH / Cordis 宿主）。

图例：**已还原** = 在 OpenCode 上实现了等价能力；**部分** = 还原了主体，细节受 OpenCode API 限制；**N/A** = 上游能力依赖 DSH 宿主面，OpenCode 无对应接口（已说明替代或省略）。

---

## 1. 界面（UI）

| 上游 dsh-purge | oc-purge | 状态 |
| :--- | :--- | :--- |
| 会话标题旁 `dsh-purge` 按钮，打开右侧 dock | 输入框上方「⚔ 破甲」按钮 → 右侧 dock | 已还原（锚点不同：OpenCode 会话标题非稳定 DOM） |
| dock 双页 **Clean / Drill** | dock 双页 **Clean / Drill** | 已还原 |
| 主题 **Light / Ink** | Light / Ink（本机 localStorage 持久化） | 已还原 |
| 首次安装「使用告知」弹窗 + 勾选 | 首启告知弹窗 + 勾选 | 已还原（文案精简） |
| Drill 授权门：倒计时 + 滚动到底 + 三勾选 | 三勾选授权门 | 部分（无倒计时/滚动校验） |
| Patches 清单表（分组 / Applied·Pending·No match·Skipped / Written·shim·backup 指标） | —— | **N/A**：OpenCode 无宿主补丁面（迁移指南 §4.5）。改为「注入槽位」状态行 |
| Apply / Restore / Uninstall 按钮 | 应用 / 复原 / 停用注入 | 已还原（OpenCode 卸载 = 删除插件目录，无宿主补丁可卸） |
| Check update / Update / 渠道 stable·beta / 版本 pin | —— | **N/A**：上游更新=重装 npm 包；本移植随仓库更新 |
| 提示词编辑器 + Reset default | Prompt 文本域 + 保存 / 恢复默认 | 已还原 |
| Own servers 框（`net-scope-allow.txt`） | 自己的服务器框（插件存储 + 校验） | 已还原 |
| 规则库列表：启用 / 删除 / 新建 / Reset | 规则库列表：启用 / 删除 / 新建 / 关闭启用 | 已还原（Reset→deactivate） |
| 作用域策略 strict / fallback / always | 同三项 | 已还原 |
| CWD rules：扫描当前目录/祖先的 AGENTS.md·CLAUDE.md + 勾选 | 同（重新扫描 + 勾选注入） | 已还原 |
| Skills：导入 zip / 导入文件夹 / 新建 / 删除 | 技能：导出内置 / 导入路径 / 新建 / 删除 | 已还原 |
| Hooks 放行开关（deny/ask 的 30/31/64/65） | —— | **N/A**：OpenCode 无同构 PreToolUse / UserPromptSubmit / Stop deny 面 |
| 失败重试 / 断线续跑设置（autoRetry·retryMax·autoContinue·continueMax·continueText） | —— | **N/A**：OpenCode 会话续跑由宿主接管，插件无该控制点 |
| Restart 按钮 | —— | **N/A**：注入 hook 每次请求热生效，无需重启宿主 |
| 表面标示 surface(web/desktop/gui/tui) | profile.surface = `opencode` | 已还原（值改为 OpenCode） |

---

## 2. 功能

| 上游 dsh-purge | oc-purge | 状态 |
| :--- | :--- | :--- |
| 系统提示词注入：prompt-inject(A) → 本地 md(B) → 插件默认(D)，+ 策略(C) | 同一决策树（`resolveInjectText`）经 `session.hook("context")` 注入 | 已还原 |
| 能力选用协议（官方 / 红队 lead / 红队 executor 三态） | 同三段，槽位 `dshpg-capabilities` | 已还原 |
| 工具 `purge_status` / `purge_apply` / `purge_revert` | 同名 + `purge_inject` / `purge_rules` / `purge_skills` / `purge_servers` / `purge_cwd` | 已还原（并扩展） |
| 斜杠命令 `/purge` `/rules` `/skills` | 同三个（`ctx.command.transform` 动态注册） | 已还原（运行时无 command API 则省略） |
| 斜杠命令 `/rewind`（撤回一次/一轮） | —— | **N/A**：上游走 `session.fork({ atSeq })`；OpenCode V2 插件面无等价公开 API |
| 宿主补丁清单（沙箱放行 / permission / persona / phase-1 过滤 / shim 注入 / CMD 静默 / app.asar 解包…） | —— | **N/A / 删除**：迁移指南 §4.5 —— V2 无宿主补丁面，卸载即净 |
| shim（dsh.cmd / dsh.ps1 / dsh）注入与还原 | —— | **N/A**：无 DSH launcher |
| 演练台：assets / 技能 / 环境适配 / 报告回放 + SQLite 事实库 + `/redteam/api` | 技能资产 + 靶标白名单 + Drill 授权门 | 部分（事实库/报告回放/环境适配依赖 DSH 宿主面） |
| 技能导入官方 `$DSH_HOME/skills/<id>/SKILL.md` | 导出/导入/新建/删除到 `<项目>/.opencode/skills/<id>/SKILL.md` | 已还原（目录改为 OpenCode 技能发现路径） |
| 规则库落盘 `$DSH_HOME/rules/` + `prompt-inject.md` | 插件私有 `ctx.storage`（同结构：customText / activeRule / rules） | 已还原 |
| Own servers 白名单（单 IP / 完整主机名，丢弃密钥·口令·网段·通配符） | 同 `netScope` 校验与规范化 | 已还原（OpenCode 无网络拦截面，仅作声明与记录） |
| 内置红队技能 `skills/redteam/*.md` | 逐字保留（23 项，SHA256 校验；压缩包 `skills/redteam.bundle.json.gz` 防误删） | 已还原 |

---

## 3. 为什么这些项是 N/A（不可还原）

- **宿主补丁 / shim / CMD 静默 / app.asar 解包**：上游核心是「改 DSH 宿主文件」。OpenCode V2 的
  等价面就是 `session.hook("context")`（每次请求生效、不改宿主文件），迁移指南明确要求**删除**这一节。
- **Hooks deny / continue-retry**：OpenCode 没有 DSH 的 `PreToolUse` / `UserPromptSubmit` / `Stop` deny
  同构扩展面，也没有插件级「续跑/重试」控制点；强行实现会与宿主策略冲突。
- **`/rewind`**：依赖 DSH `session.fork({ atSeq })`；OpenCode 插件 API 未暴露等价的会话回滚。
- **更新检查 / 渠道切换 / Restart**：上游更新 = npm 重装 + 重启宿主；本移植为仓库内插件，
  热加载生效，无需该链路。
- **演练台事实库 / 报告回放 / 环境适配**：绑定 DSH 的 SQLite store、HTTP 桥与宿主环境探测。

---

## 4. 本轮为「还原」新增/变更

服务端：
- 新增工具 `purge_apply` / `purge_revert`（对齐上游同名工具语义：应用=开注入、复原=回落内置默认）。
- 新增 `purge_servers`（Own servers 白名单）、`purge_cwd`（CWD rules 扫描/勾选）。
- `purge_skills` 扩展为 `list｜install｜import｜create｜delete`（对齐 `/skills`）。
- 新增斜杠命令 `/purge` `/rules` `/skills` 动态注册（能力探测 + try/catch 降级）。
- RPC 由 `get/set` 扩展为 `get｜set｜apply｜revert｜rules｜skills｜servers｜cwd`。
- 注入决策加入 **本地规则(B)** 一层：customText(A) → 规则集(A) → CWD 勾选(B) → 内置默认(D)。

桌面 dock：
- 双页 Clean / Drill + Light / Ink 主题 + 首启告知 + Drill 三勾选授权门。
- Clean 页补齐：应用/复原/停用、策略三态、能力协议开关、提示词编辑器（保存/恢复默认）、
  规则库（启用/删除/新建）、自己的服务器、本地规则扫描勾选、技能（导出/导入/新建）。

资产：
- 默认提示词（解封）、能力协议、23 项红队技能、红队预设、Drill 授权声明 **逐字保留**，SHA256 校验。
