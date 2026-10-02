# Desktop 徽章注入（输入框上方运行状态绿框）

`oc-infinite-gen-4-inject.js` 在 OpenCode Desktop / Web UI 的**输入框正上方**显示运行状态徽章：

| 状态 | 样式 | 文案 |
| :--- | :--- | :--- |
| 运行中 | 绿色边框/绿点 | `● 无限四代 v0.4.1 · 运行中`（悬停显示注入槽位详情） |
| 未运行 | 灰色边框/灰点 | `● 无限四代 · 未运行` |
| 检测中 | 灰色 | `● 无限四代 · 检测中…` |

## 数据通道

服务端插件 RPC：`POST {base}/api/rpc/infinite.gen4.profile/get`（body `{"input":{}}`）。

- **Web 页面**：`base = location.origin`（同源登录态）
- **Desktop（`oc://renderer`）**：自动探测本机服务端口（`/api/info`，并行探测 + 失败不缓存）；
  Electron main 会给顶层 frame 发往本机服务 origin 的请求自动附加 Basic 认证。

## 用法

- 控制台：`Ctrl+Shift+I` → Console → 粘贴整个文件。
- 持久化：

```powershell
node scripts/patch-desktop.mjs --dry-run   # 先验证（不改动安装）
# 完全退出 OpenCode Desktop 后:
node scripts/patch-desktop.mjs             # 注入（自动备份 app.asar.oc-infinite-gen-4.bak）
node scripts/patch-desktop.mjs --restore   # 一键还原
```

多个插件的注入可叠加（各自文件与 `<script>` 标签，幂等）。桌面端自动更新会覆盖 app.asar，重新执行注入即可。

## 可用 API（注入后）

```js
ocInfiniteGen4Badge.refresh()                            // 立即检查运行状态
ocInfiniteGen4Badge.state                                // { phase, profile, error, checkedAt }
ocInfiniteGen4Badge.setServerBase("http://127.0.0.1:49374") // 端口探测失败时手动指定
ocInfiniteGen4Badge.destroy()                            // 清理注入
```
