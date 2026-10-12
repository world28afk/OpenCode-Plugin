# oc-purge 桌面端注入（dock）

上游 dsh-purge 的 `client.js` 在**会话标题旁**挂一个 “dsh-purge” 按钮，点开右侧 dock
（Clean / Drill 两页）。OpenCode Desktop/Web 没有官方 UI 插件接口，因此本插件用
**DOM 注入**（见 `oc-plugin/docs/opencode-plugin-development.md` §9）实现等价能力。

## 效果

- 输入框上方「⚔ 破甲」按钮（运行中/未连接）。点开右侧面板（**Clean / Drill** 双页，**Light / Ink**，首启告知 + Drill 授权门）。
- 卡片式布局（大厂风格），每张卡带标题与说明，操作结果以 toast 反馈：
  - **快速操作**：应用 / 复原默认 / 停用·开启；策略 segmented（fallback·strict·always）；能力协议开关。
  - **提示词方案（一键切换）**：方案列表点一下即切换；每行支持 使用 / 复制 / 删除；「另存为方案」把当前正文存为新方案。
  - **提示词内容**：编辑当前方案（或手写），保存即生效，带字符计数。
  - **模型绑定**：把「模型 / agent」映射到方案 —— 不同模型用不同提示词（provider/model → model → agent）。
  - **自己的服务器**、**本地规则（CWD）**、**技能（导出/导入/新建）**、**连接**（手填服务地址）。
  - **Drill**：授权后展示内置红队技能、已装技能、靶标白名单与上游 Drill 授权声明。

面板数据与写面全部来自服务端插件 RPC：
```
POST {base}/api/rpc/purge.status/{get|set|apply|revert|rules|skills|servers|cwd}
```

## 用法

```powershell
# 1) 只在控制台试用（刷新即失效）: Ctrl+Shift+I → Console → 粘贴 desktop/oc-purge-dock.js
# 2) 持久化（写进 app.asar，自动备份 app.asar.oc-purge.bak）
node scripts/patch-desktop.mjs --dry-run      # 先验证（不改动安装）
node scripts/patch-desktop.mjs                # 注入（需先完全退出桌面端）
node scripts/patch-desktop.mjs --unpatch      # 只移除本插件内容
node scripts/patch-desktop.mjs --restore      # 还原到首次注入前备份
# 自动关闭→打补丁→重启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-desktop.ps1
```

## 注意

- 桌面端**自动更新会覆盖 app.asar**，升级后需重新打补丁。
- **插件独立**：dock 自带服务地址探测（拦截页面 `/api/*` origin + 端口探测），面板底部「连接」可手填
  `http://127.0.0.1:49374` 之类的地址；**不读取其它插件的 localStorage 键**。
- 面板采用「数据签名驱动渲染」：只在数据变化时重建，编辑中不重建，因此按钮随时可点、输入不丢字。
- 与其它插件（`oc-deepseek-banlance` / `oc-cyberbot` / `oc-plugin-manager` 等）注入共存互不影响：
  各自独立脚本、独立 `<script>` 标签、独立备份名。
- 页面 CSP 禁止 `eval`，持久注入必须走 asar 内的同源脚本文件（本工具已按此实现）。
