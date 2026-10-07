# oc-web-bridge —— 网页版插件注入桥

让**网页版**（浏览器访问的 OpenCode UI）也拥有与桌面版一致的插件界面：
插件管理器开关、DeepSeek 余额、无限四代、修改回复（oc-cyberbot）等注入 UI。

## 原理

OpenCode 网页版的静态资源内嵌在服务端 `opencode-cli.exe` 中（无法直接改盘上文件），
因此这里用一层**本地反向代理**实现注入，不需要重启 OpenCode：

1. 代理监听 `127.0.0.1:49380`，转发到真正的服务端 `127.0.0.1:49374`；
2. 对 `text/html` 响应注入 `<script src="/_oc-bridge/injects.js"></script>`（同源，符合 CSP `script-src 'self'`）；
3. `/_oc-bridge/injects.js` = 认证垫片 + 各插件的注入脚本合并：
   - 认证垫片：把网页版已保存的连接信息（`opencode.global.dat:server`）转成 Basic 头，
     自动附加到同源 `/api/*` 请求上，使注入脚本可调用服务端 RPC；
   - `oc-plugin-manager` / `oc-deepseek-banlance` / `oc-infinite-gen-4` / `oc-cyberbot` 的 renderer 注入；
4. SSE（`/api/event`）与静态资源流式透传，不受影响。

## 使用

```powershell
# 启动桥（后台无窗口）
node D:\OpenCode-Plugin\tools\oc-web-bridge\bridge.mjs
```

- **本机浏览器**：改用 `http://127.0.0.1:49380`（原 49374 仍可用，但没有注入 UI）；
- **frp 远程**：把隧道（ChmlFrp 启动器）的「本地端口」从 `49374` 改为 `49380`
  （或新建一条指向 `49380` 的隧道），公网地址不变，远程设备刷新后即带插件 UI；
- **首次使用**：连接页的「服务器 URL」填你正在访问的地址（本机 `http://127.0.0.1:49380`，
  远程填 frp 公网地址），密码不变；连接一次后长期有效。

## 备注

- 桥需要与 OpenCode 一起常驻；重启电脑后重新运行即可（可自行做计划任务）。
- 插件注入脚本更新后，重启一次桥以生效（桥启动时合并打包）。
- `oc-exit` 依赖系统托盘（主进程），网页版无法提供；`oc-perf-guard` / `oc-workflow` / `oc-router-laya`
  的 UI 属于 TUI 专用，其服务端功能（工具/工作流）在任何客户端都可用。
- 健康检查：`curl http://127.0.0.1:49380/_oc-bridge/health`
