# Desktop / Web UI 注入脚本

`oc-balance-inject.js` 把 DeepSeek 余额增强到 OpenCode Desktop / Web UI：

1. **右上角「上下文小圆圈」右侧**：余额直接显示在圆圈旁边（`余额 ¥xx.xx`），点击可立即刷新；悬停看明细。
2. **该圆圈的悬浮提示**：在「Token / 成本 / 使用率」之后追加「余额」行。
3. **审查页（Review）→「上下文」页**：统计网格追加「余额」卡片，统计网格下方追加「DeepSeek 账户余额」明细卡。

## 2.2.x 布局适配

新版把上下文用量挪到了会话头部，旧版 `w-[120px]` 悬浮容器已不存在。现在的锚点：

```text
.session-header-actions
  └ button[aria-label="查看上下文用量"]
      └ svg[data-component="progress-circle"][data-appearance="indicator"]
```

余额徽标 `[data-oc-balance="badge"]` 作为该 `button` 的**兄弟节点**插在右侧（`insertAdjacentElement("afterend")`），不塞进圆圈内部。
Solid 重渲染替换按钮后会由 `MutationObserver` 重新贴回圆圈右侧；同一位置只保留一个徽标。


## 数据来源（按顺序）

1. 服务端插件 RPC：`POST {base}/api/rpc/deepseek.balance.v1/get`
   - **Web 页面**：`base = location.origin`（同源登录态）
   - **Desktop（`oc://renderer`）**：`base` 按以下顺序自动探测本机服务地址——
     ① `performance.getEntriesByType("resource")` 里已出现过的 `/api/*` origin（最可靠，端口随实例动态分配）；
     ② 脚本早期 `fetch`/`XMLHttpRequest` 捕获到的同源请求 origin；③ `localStorage` 里缓存的可用 base；
     ④ 兜底才逐个试固定端口（49374/4096/…）。
     Electron main 会给顶层 frame 发往本机服务 origin 的请求**自动附加 Basic 认证**，因此脚本无需接触密钥。
     探测失败不缓存、5 秒重试，直至应用完成连接。
2. `GET /api/config` 中 `provider.ds/deepseek` 的 `apiKey` → 直连 `https://api.deepseek.com/user/balance`（兜底）。
3. `localStorage["oc-deepseek-balance:apiKey"]`（可通过 `ocDeepSeekBalance.setKey("sk-...")` 写入）。

## 用法

- **临时**：桌面端 `Ctrl+Shift+I` 打开 DevTools → Console → 粘贴整个文件 → 回车。刷新/重启后失效。
- **持久**：仓库根目录执行 `node scripts/patch-desktop.mjs`（先 `--dry-run`，要求退出桌面端；自动备份，`--restore` 还原）。
- **桌面端不想退出**：`python scripts/patch-desktop.py --in-place --only oc-deepseek-banlance`
  （追加式原地热更新，旧数据区不动、已有条目偏移不变，当前进程继续跑旧脚本，重启后加载新脚本）。

## 本地验证（不重启桌面端）

`desktop/oc-balance-inject.js` 的 DOM 逻辑可用无头 Chrome 复刻 2.2.5 头部结构做断言：
复刻 `.session-header-actions` + `button > svg[data-component="progress-circle"]` 与 `role="dialog"` 悬浮层，
检查徽标位置/单实例/幂等/重渲染后重新贴回、悬浮行插在 `[role="separator"]` 之前。

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
- 页面结构变化由 `MutationObserver` 自动重挂；`requestAnimationFrame` 被节流时（窗口被遮挡）有 250ms 定时兜底。
- 目标选择器基于 OpenCode 2.2.x（`.session-header-actions` + `svg[data-component="progress-circle"]`、`@[32rem]:grid-cols-2` 统计网格）；UI 大改版后需同步更新选择器。
- Electron 官方插件 API 无 UI 注入面，本脚本是社区常用的 DOM 增强方式；桌面端升级（自动更新）后 app.asar 会被覆盖，重新执行 `node scripts/patch-desktop.mjs` 即可。
