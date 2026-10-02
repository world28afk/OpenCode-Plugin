# Desktop / Web UI 注入脚本

`oc-balance-inject.js` 把 DeepSeek 余额增强到 OpenCode Desktop / Web UI：

1. **右上角「上下文小圆圈」悬浮提示**：在「成本 / 使用率 / Token」之后追加「余额 ¥xx.xx」行，悬停可见明细。
2. **审查页（Review）→「上下文」页**：统计网格追加「余额」卡片，统计网格下方追加「DeepSeek 账户余额」明细卡。

## 数据来源（按顺序）

1. 服务端插件 RPC：`POST {base}/api/rpc/deepseek.balance.v1/get`
   - **Web 页面**：`base = location.origin`（同源登录态）
   - **Desktop（`oc://renderer`）**：`base` 自动探测本机服务端口（`/api/info`，并行探测 49374/4096 等）；
     Electron main 会给顶层 frame 发往本机服务 origin 的请求**自动附加 Basic 认证**，因此脚本无需接触密钥。
     探测失败不缓存、5 秒重试，直至应用完成连接。
2. `GET /api/config` 中 `provider.ds/deepseek` 的 `apiKey` → 直连 `https://api.deepseek.com/user/balance`（兜底）。
3. `localStorage["oc-deepseek-balance:apiKey"]`（可通过 `ocDeepSeekBalance.setKey("sk-...")` 写入）。

## 用法

- **临时**：桌面端 `Ctrl+Shift+I` 打开 DevTools → Console → 粘贴整个文件 → 回车。刷新/重启后失效。
- **持久**：仓库根目录执行 `node scripts/patch-desktop.mjs`（先 `--dry-run`，要求退出桌面端；自动备份，`--restore` 还原）。

## 可用 API（注入后）

```js
ocDeepSeekBalance.refresh()        // 立即刷新
ocDeepSeekBalance.state            // { snapshot, error, loading, fetchedAt }
ocDeepSeekBalance.setKey("sk-...")                    // 手动设置 Key（仅在无法读取服务端时使用）
ocDeepSeekBalance.setServerBase("http://127.0.0.1:49374") // 桌面端端口探测失败时手动指定
ocDeepSeekBalance.destroy()        // 清理注入
```

## 说明

- 脚本有数据时 60 秒轮询；无数据（桌面端服务尚未就绪）时 5 秒重试，探测失败不缓存。
- 页面结构变化由 `MutationObserver` 自动重挂。
- 目标选择器基于 OpenCode 2.0.x Web UI（`w-[120px]` 工具提示容器、`@[32rem]:grid-cols-2` 统计网格）；UI 大改版后需同步更新选择器。
- Electron 官方插件 API 无 UI 注入面，本脚本是社区常用的 DOM 增强方式；桌面端升级（自动更新）后 app.asar 会被覆盖，重新执行 `node scripts/patch-desktop.mjs` 即可。
