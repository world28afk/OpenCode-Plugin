# Desktop 角标注入（右下角电源角标 + 右键菜单）

`oc-exit-inject.js` 在 OpenCode Desktop / Web UI **右下角**固定显示一个电源角标（`⏻`）：

- **左键** / **右键** → 弹出菜单：
  - `显示 OpenCode` — 显示并激活主窗口
  - `退出 OpenCode` — 彻底退出（关闭界面 + 结束后台服务）
- 角标颜色反映服务连接：绿色=已连接，灰色=未连接。

## 数据通道

服务端插件 RPC：

- `POST {base}/api/rpc/exit.control/status`（body `{"input":{}}`）
- `POST {base}/api/rpc/exit.control/focus`
- `POST {base}/api/rpc/exit.control/quit`

- **Web 页面**：`base = location.origin`（同源登录态）
- **Desktop（`oc://renderer`）**：自动探测本机服务端口（`/api/info`，并行探测 + 失败不缓存）；
  Electron main 会给顶层 frame 发往本机服务 origin 的请求自动附加 Basic 认证。

## 用法

- 控制台：`Ctrl+Shift+I` → Console → 粘贴整个文件。
- 持久化：

```powershell
node scripts/patch-desktop.mjs --dry-run   # 先验证（不改动安装）
# 完全退出 OpenCode Desktop 后:
node scripts/patch-desktop.mjs             # 注入（自动备份 app.asar.oc-exit.bak）
node scripts/patch-desktop.mjs --unpatch   # 只移除本插件注入
node scripts/patch-desktop.mjs --restore   # 还原备份
```

多个插件的注入可叠加（各自文件与 `<script>` 标签，幂等）。桌面端自动更新会覆盖 app.asar，重新执行注入即可。

## 可用 API（注入后）

```js
ocExit.show()                                    // 显示/激活窗口
ocExit.quit()                                    // 彻底退出
ocExit.refresh()                                 // 立即刷新连接状态
ocExit.state                                     // { connected, error, checkedAt, busy }
ocExit.setServerBase("http://127.0.0.1:49374")   // 端口探测失败时手动指定
ocExit.destroy()                                 // 清理注入
```
