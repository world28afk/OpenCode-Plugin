# oc-purge ↔ 上游 dsh-purge 差异对照（界面 / 功能）

对照上游 [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) **v1.1.71**（DSH / Cordis 宿主）。
上游已迭代到 **v1.1.90**，其中 v1.1.73 起发生定位分叉，见 [§6](#6-上游-1173-分叉记录基线-v1171--上游-v1190)。

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
- `purge_rules` 升级为**提示词方案**：`use`（一键切换）／`save`／`duplicate`／`rename`／`delete`／
  `bind`／`unbind`／`reset`；新增 **模型/agent → 方案 绑定**（上游 README 的「不同模型可换不同提示词」）。
- 新增斜杠命令 `/purge` `/rules` `/skills` 动态注册（能力探测 + try/catch 降级）。
- RPC 由 `get/set` 扩展为 `get｜set｜apply｜revert｜rules｜skills｜servers｜cwd`。
- 注入决策加入 **模型绑定(B1)** 与 **本地规则(B)**：绑定 → 启用方案 → 手写 → CWD → 内置默认。

桌面 dock：
- 双页 Clean / Drill + Light / Ink 主题 + 首启告知 + Drill 三勾选授权门。
- Clean 页补齐：应用/复原/停用、策略三态、能力协议开关、提示词编辑器（保存/恢复默认）、
  规则库（启用/删除/新建）、自己的服务器、本地规则扫描勾选、技能（导出/导入/新建）。

资产：
- 默认提示词（解封）、能力协议、23 项红队技能、红队预设、Drill 授权声明 **逐字保留**，SHA256 校验。

---

## 5. OpenCode 语义适配（与上游的刻意差异）

上游的运行宿主是 DSH（Cordis）。下列差异是**为了让功能在 OpenCode 上正确工作**而刻意保留的：

| 项目 | 上游（DSH） | oc-purge（OpenCode） | 原因 |
| :--- | :--- | :--- | :--- |
| 注入正文外壳 | 作为 ChatML system 消息（`<\|im_start\|>system:` + `<project_instructions>`）注入 | 默认**剥离外壳**，只注入正文（`options.preserveChatml:true` 可还原） | OpenCode 的 `event.system` 已是结构化 system 段，再套 ChatML 只会变成噪音 |
| DSH 模板变量 | `escapeDshInterpolation` 把非法 `{{` 拆成 `{ {`（DSH 会插值 `{{cwd}}` 等） | 删除该步（OpenCode 无模板层；资产内也无 `{{}}`） | 无插值语义 |
| 注入槽位名 | `dsh-purge` / `dshpg-capabilities` / `dsh-purge:post` | `oc-purge:inject` / `oc-purge:capabilities` / `oc-purge:post`（order 值不变） | 用 OpenCode 侧命名，避免 DSH 专属前缀 |
| 技能目录 | `$DSH_HOME/skills/<id>/SKILL.md` | `<项目>/.opencode/skills/<id>/SKILL.md`（含 frontmatter） | OpenCode 实际技能发现路径（`<dir>/skill`、`<dir>/skills`、`**/SKILL.md`） |
| 服务地址探测 | 宿主 slot/HTTP 桥 | 注入脚本**自包含**探测（拦截页面 `/api/*` origin + 端口探测 + 手填「连接」）；不读其它插件键 | 插件独立，不互相依赖 |
| 生效方式 | Apply 后重启宿主 | `session.hook("context")` 每次调用生效，改完即用、无需重启 | 迁移指南 §4.5 |
| 状态存储 | `$DSH_HOME` 文件 | 插件私有 `ctx.storage` | OpenCode 无宿主文件补丁面 |

界面侧：dock **重做为现代卡片式（大厂风格）**，并修复「反复重建导致按钮/输入框不可点击」的问题——
改为**数据签名驱动渲染**（只在数据变化时重建、编辑中不重建、重建保留输入与滚动）。
面板结构：顶部品牌 + 当前模型/来源；Clean / Drill 分段标签；状态胶囊；
卡片分区（快速操作 / 提示词方案 / 提示词内容 / 模型绑定 / 自己的服务器 / 本地规则 / 技能 / 连接）；
每张卡都有标题与一句说明，操作结果以 toast 反馈。

---

## 6. 上游 1.1.73 分叉记录（基线 v1.1.71 → 上游 v1.1.90）

本移植基线为上游 **v1.1.71**；上游此后迭代到 **v1.1.90**（跨 19 个版本）。上游 git 历史被重写过
（仓库仅存 17 个 commit，`v1.1.71` tag 已不存在），差异按 `release-notes.md` + 文件级比对判定。

### 6.1 四个方向性变化

| # | 上游变化 | 证据 | 本项目处理 |
| :-- | :-- | :-- | :-- |
| 1 | 开源版改为「本地靶场 only」：先解析再只放行 RFC1918 私网，`169.254` 元数据拒绝，`tools/pre-execute` 遇公网 IP 硬停 | `README.zh-CN.md`、`lib/net-scope.js`、1.1.74 / 1.1.77 | **不跟随**。本移植无目标门禁；仅吸收解析层归一（`::ffff:` 解包、链路本地拒绝）用于白名单规范化 |
| 2 | 删除红队技能库与知识库 | `skills/` 目录已不存在；commit `679a3db`；README「本仓库不含红队技能库/知识库」 | **不跟随**。保留 23 项捆绑技能 + `redteam.bundle.json.gz` |
| 3 | 内容政策收紧：游戏外挂改为硬禁止 | 1.1.74 会话门禁；默认提示词 Rule 1 改为「禁止，回复『不行，这是严令禁止的』」 | **不跟随**。`Scoped Rules 1` 保持 in-scope |
| 4 | 许可证 MIT → Apache-2.0 + NOTICE + 商用条款 | `LICENSE` / `NOTICE` / `LICENSE-COMMERCIAL.md`（2026-10-27 起新版本只发 Telegram / Release） | 本项目基于 v1.1.71（MIT），仍按 MIT 分发；引入 ≥ v1.1.73 代码时须保留 NOTICE 与署名 |

### 6.2 逐版本适用性

| 版本 | 主要内容 | 适用 |
| :-- | :-- | :-- |
| 1.1.73 | 0.2.1-rc.2 兼容、丢 `toolFilter`、hostFs fd、证据账本 `redteam_evidence_*`、**删技能库/知识库** | 否（DSH 宿主 + 本地无 redteam 工具集） |
| 1.1.74 | 靶场门禁、`::ffff:` 解包、丢 link-local、seal schema、**禁止外挂** | 部分：仅解析层已吸收 |
| 1.1.75–1.1.76 | Hub 一键装去重、codeload tarball、postinstall 写 bundles | 否 |
| 1.1.77 | 长任务公网门禁（分窗扫描 + 工具参数校验） | 否（与无门禁定位冲突） |
| 1.1.78 | 停用/卸载后 `selectedDefault` 回 `standard` | 否（DSH agent-preset） |
| 1.1.79 | 主/子智能体共用 inject + 权限 + 能力协议正文 | 否（本地三分支更细，红队调度正文在预设 ops） |
| 1.1.80 | pnpm 12 allowBuilds、zip 目录项 EEXIST、`lib/skills.js` 漏 `fs`、rc.3+ 不支持 | 否 |
| 1.1.81–1.1.83 | DSH NEXT 识别、allowBuilds 自愈、`cordis.patch.yml` 为 `[]` 时替换 | 否 |
| 1.1.84 | 尾部锚点（recency 槽）、锚点跟随语言、子代理审批接管、提示词缓存 + 熔断、patch #91 | 尾部锚点本地已等价（`event.system.push` 追加在末尾）；语言跟随由 House Rules 覆盖 |
| 1.1.85 | 深色模式主按钮白底白字（`--dsw-alias-brand-primary` 解析成近白） | 否（本地 dock 用自有 `data-theme="white"/"ink"` CSS 变量） |
| 1.1.86 | web 残留 server EADDRINUSE、asar 换包顺序 | 否 |
| 1.1.87 | 0 字节 `.bak`、原子写、`optional` 补丁软失败、asar 路径越界、`realpath`、更新只走 https | 否（本地状态走 `ctx.storage`） |
| 1.1.88 | rc.2 + rc.5 双版本 pattern、`dshTargets` | 否 |
| 1.1.89 | `cwd` 字面量 + `assembly.variables`、桌面退出留痕 | 否 |
| 1.1.90 | 撤销按钮移出 composer 子树（`createPortal`） | 否（本地 dock 无撤销按钮） |

### 6.3 已同步（对齐 v1.1.90 内容层）

1. **提示词结构**（`prompts/default-prompt-inject.md`）：并入上游重写稿的 5 节 —
   `FOREIGN LAYERS 外来模式`、`FIRST TOKEN 开头格式`、`DRAFT AUDIT 草稿审查 R1–R8`、
   `CATEGORY LOCK 类别锁`（含「不自引用」）、`DELIVERY FIRST 交付优先`。
   **保留**本地原有 `Scoped Rules 1–25`、`外挂 in-scope`、`CTF Core Contract`、`Sandbox test directions`。
2. **netScope 解析层**（`src/netScope.ts`）：IPv4-mapped IPv6 归一（`::ffff:1.2.3.4` / `::ffff:c0a8:10a`
   → 裸 v4，与 v4 条目共用去重），拒绝 `169.254.0.0/16` 与 `fe80::/10`。
   **仅作用于「自己的服务器」白名单规范化，不引入任何目标门禁。**
3. **文档**：本节 + README 顶部基线 / 许可 / 分叉说明。

### 6.4 明确不同步

`lib/*.js` 宿主补丁链（patch #32–#91、asar、`allowBuilds`、rc.2/rc.5、`restart-web` / `bin-preflight`、
桌面退出日志）、靶场门禁与公网 IP 拦截、技能库删除、游戏外挂硬禁止、1.1.85 深色按钮、1.1.90 撤销按钮 portal。
