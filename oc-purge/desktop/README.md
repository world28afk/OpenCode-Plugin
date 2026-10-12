# oc-purge 桌面端注入（dock）

上游 dsh-purge 的 `client.js` 在**会话标题旁**挂一个 “dsh-purge” 按钮，点开右侧 dock
（Clean / Drill 两页）。OpenCode Desktop/Web 没有官方 UI 插件接口，因此本插件用
**DOM 注入**（见 `oc-plugin/docs/opencode-plugin-development.md` §9）实现等价能力。

## 效果

- 输入框上方一枚 **「⚔ 破甲」** 按钮（运行中 / 未连接）。
- 点开右侧面板（**Clean / Drill 双页**，**Light / Ink** 主题，首启告知 + Drill 三勾选授权门）：
  - Clean：注入状态、提示词来源、策略、能力协议、规则集、自己的服务器、本地规则、技能；
    操作 应用 / 复原 / 停用注入；提示词编辑器；规则库（启用/删除/新建）；Own servers；
    CWD rules 扫描勾选；技能导出/导入/新建。
  - Drill：授权后展示内置红队技能、已装技能、靶标白名单与上游 Drill 授权声明入口。

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
- 与其它插件（`oc-infinite-gen-4` / `oc-deepseek-banlance` 等）注入共存互不影响：
  各自独立脚本、独立 `<script>` 标签、独立备份名。
- 页面 CSP 禁止 `eval`，持久注入必须走 asar 内的同源脚本文件（本工具已按此实现）。
