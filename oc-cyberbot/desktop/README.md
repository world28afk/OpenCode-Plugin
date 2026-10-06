# oc-cyberbot Desktop 注入说明

`oc-cyberbot-inject.js` 由 `scripts/patch-desktop.mjs` 追加到应用 renderer 的 `index.html`（`<script src="./oc-cyberbot-inject.js">`），在桌面端界面中：

- 为每条 **agent 回复** 的「复制回复」按钮旁追加一个**铅笔图标的「修改回复」按钮**（克隆原按钮结构与样式，仅替换图标与标签）。
- 点击后列出**本轮**（上一次用户消息之后）的全部「回复」(text) 与「思考」(reasoning) 段：
  点击任意一条进入编辑（预填原文）；每条也可直接删除（行尾 ✕ 或编辑页「删除」，带确认）。
- 保存/删除调用服务端 RPC 写回会话存储；点「完成」后自动刷新界面。
- **启用门控**：定期 `POST /api/rpc/cyberbot.message/ping`；拿到 `{ok:true}` 才注入按钮。插件被禁用（RPC 404）时按钮自动消失。
- 消息定位：从按钮向上查找 `data-message-id` 或 `id="msg_..."/"message-msg_..."` 的祖先元素；会话 ID 从地址栏 `/session/ses_...` 解析。

## 服务端 RPC

- `POST {base}/api/rpc/cyberbot.message/ping` → `{ ok, version, db }`
- `POST {base}/api/rpc/cyberbot.message/list`　`{ input: { sessionID, messageID } }` → `{ ok, items: [{ messageID, partIndex, kind, text, seq }] }`
- `POST {base}/api/rpc/cyberbot.message/get`　`{ input: { sessionID, messageID } }` → `{ ok, text?, error? }`
- `POST {base}/api/rpc/cyberbot.message/edit` `{ input: { sessionID, messageID, text, partIndex? } }` → `{ ok, text?, error? }`（partIndex 缺省时兼容旧行为：合并替换全部 text 段）
- `POST {base}/api/rpc/cyberbot.message/remove` `{ input: { sessionID, messageID, partIndex } }` → `{ ok, error? }`（仅允许删除 text/reasoning 段）

web 客户端场景下脚本会从 `localStorage["opencode.global.dat:server"]` 读取连接信息并附加 Basic 认证头；
桌面 app 场景通常由宿主环境自动携带认证。

## 安装 / 移除

```powershell
node scripts/patch-desktop.mjs --dry-run   # 验证（不改安装）
# 安全退出 OpenCode Desktop 后:
node scripts/patch-desktop.mjs             # 注入（首次自动备份 app.asar.oc-cyberbot.bak）
node scripts/patch-desktop.mjs --unpatch   # 只移除本插件注入
node scripts/patch-desktop.mjs --restore   # 还原到首次注入前的备份
```

注：应用自动更新会覆盖 `app.asar`，更新后需要重新执行注入。

## 调试 API（浏览器控制台）

```js
ocCyberbot.refresh()        // 立即重新探测启用状态
ocCyberbot.state            // { enabled, lastError, serverBase, buttons }
ocCyberbot.remove()         // 移除已注入按钮
ocCyberbot.destroy()        // 完全卸载注入
```
