# oc-dsh-purge 桌面端注入（dock）

上游 dsh-purge 的 `client.js` 在**会话标题旁**挂一个 “dsh-purge” 按钮，点开右侧 dock
（Clean / Drill 两页）。OpenCode Desktop/Web 没有官方 UI 插件接口，因此本插件用
**DOM 注入**（见 `oc-plugin/docs/opencode-plugin-development.md` §9）实现等价能力。

## 效果

- 输入框上方一枚 **「⚔ 破甲」** 按钮（状态点：绿=运行中 / 灰=未连接 / 黄=检测中）。
- 点开右侧面板：
  - 运行状态、提示词来源、策略、能力协议、规则集数量、内置技能数量、注入槽位。
  - 操作：停用/开启注入、切换策略（fallback / strict / always）、能力协议开关。
  - 文本框：自定义注入正文（等价上游 `prompt-inject.md`），保存 / 清空。
  - 底部列出内置红队技能 id。

面板数据来自服务端插件 RPC：
```
POST {base}/api/rpc/dsh.purge.status/get   {"input":{}}
POST {base}/api/rpc/dsh.purge.status/set   {"input":{...}}
```

## 用法

```powershell
# 1) 只在控制台试用（刷新即失效）: Ctrl+Shift+I → Console → 粘贴 desktop/oc-dsh-purge-dock.js
# 2) 持久化（写进 app.asar，自动备份 app.asar.oc-dsh-purge.bak）
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
