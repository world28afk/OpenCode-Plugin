# oc-cyberbot

OpenCode 的「修改回复」插件：在桌面端 agent 回复消息的「复制回复」按钮旁，
增加一个铅笔图标的「修改回复」按钮，点击后可列出本轮全部「回复」与「思考」段，
逐条编辑或删除，并写回会话。

## 组成

| 部分 | 路径 | 说明 |
| :--- | :--- | :--- |
| 服务端插件 | `.opencode/plugins/oc-cyberbot/` | 注册 RPC：ping / get / edit；直接读写 `opencode.db` 的 `session_message` 表 |
| 桌面注入 | `desktop/oc-cyberbot-inject.js` | 「修改回复」按钮 + 回复/思考列表与编辑、删除（renderer 注入） |
| 注入工具 | `scripts/patch-desktop.mjs` | 注入 / 移除 / 还原（`--dry-run`、`--unpatch`、`--restore`）|
| 自动应用 | `scripts/apply-desktop.ps1` | 关闭应用 → 注入 → 重启（一键）|

## 工作原理

- 聊天记录存储在 `~/.local/share/opencode/opencode.db`（SQLite）；V2 消息真身为
  `session_message.data`（JSON，`content` 数组保存 reasoning / text / tool 等段）。
- 「修改回复」保存时把该消息的全部 text 段合并替换为编辑后的文本（其它段不动），
  并更新 `time_updated`；OpenCode 服务端读取会话时实时读取数据库，修改立即生效。
- 按钮按需出现：仅当服务端插件启用（RPC ping 可用）时才注入；插件禁用后按钮消失。

## 安装

```powershell
# 1) 同步到全局插件目录（在完整插件仓库根目录执行）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Plugin\sync-plugins.ps1

# 2) 安全退出 OpenCode Desktop 后注入桌面按钮
node D:\OpenCode-Plugin\oc-cyberbot\scripts\patch-desktop.mjs
# 或使用自动流程（自动关闭 → 注入 → 重启）:
powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Plugin\oc-cyberbot\scripts\apply-desktop.ps1
```

> 应用每次自动更新都会覆盖 `app.asar`，更新后重新执行第 2 步即可。

## 卸载

```powershell
node scripts/patch-desktop.mjs --unpatch     # 移除桌面按钮
# 服务端插件在 设置 → 扩展 → 插件 中关闭，或删除全局插件目录中的 oc-cyberbot
```

## 注意

- 编辑的是**已持久化的回复文本**：会影响后续模型读取的历史上下文；
  如需保留原文，请先复制一份。
- 不支持编辑 user（用户）消息（本插件只处理「复制回复」按钮所在的 agent 回复）。
- 编辑后界面会自动刷新以重新渲染修改后的 Markdown。
