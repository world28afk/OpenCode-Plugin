# oc-bark

**OpenCode 的原版提示音事件 → Bark 推送**（iPhone 通知）。

桌面端 `设置 → Sound effects` 里的三档提示音，都有对应的 Bark 推送（默认全开，可逐项关闭）：

| 原版声音 | 触发事件 | 推送示例 |
| :--- | :--- | :--- |
| **Agent**（`staplebops-01`，完成/需要关注） | `session.execution.succeeded` | `关于‘帮我修复登录接口的空指针’任务目前已完成，历时3.4分钟` |
| **Permissions**（`staplebops-02`，需要授权） | `permission.asked` | `关于‘部署到生产’任务需要授权：bash rm -rf /tmp/build` |
| **Errors**（`nope-03`，出错） | `session.execution.failed` | `关于‘部署到生产’任务执行失败，历时2分钟` |

> ✅ **原版提示音保持原样。** 提示音由官方界面半体自己播放（Agent/Permissions/Errors 三项可在设置里换音/开关）。
> oc-bark 是纯服务端插件：**不补丁桌面包、不改动界面、不覆盖任何音频**——它只是订阅同一批服务端事件，
> 额外发一条 Bark 推送。手机端 Bark 铃声可用 `sound` 单独指定，与桌面端互不影响。

**推送标题 = 会话标题**（如「修复登录空指针」），正文才是「关于‘…’…」；会话暂无标题时回退到配置标题。
（`titleFromSession:false` 可改回固定标题。）

## 触发逻辑

```
你发送任务 ──► prompt hook 记录: 任务原文 + 起始时间
                    │
agent 跑完    ──► session.execution.succeeded  ──► 完成推送（Agent 音同源）
中途要授权    ──► permission.asked             ──► 授权推送（Permissions 音同源）
出错          ──► session.execution.failed     ──► 失败推送（Errors 音同源）
                    │
                    ├─ 子会话(parentID) 默认忽略（可开 notifyChildSessions）
                    ├─ 完成轮次短于 minDurationMs 跳过
                    └─► POST {server}/push ──► 手机 Bark 通知
```

- **历时**：从你提交任务（prompt hook）到轮次成功/失败（事件时间戳），同一台机器同一时钟。
- **任务原文**：取该轮用户 prompt 文本，折叠换行/连续空格后截断（默认 100 字符）。
  prompt hook 未覆盖的轮次（插件热载前已在跑）会从会话消息里找最近一条用户消息兜底；
  再兜底会话标题，最后 `未记录任务`。
- **授权详情**：优先用权限请求的 `message`，否则 `action + 第一个 resource`；为空时显示「请打开 OpenCode 处理」。
- **中断**：用户 ESC 永远不推；失败后若自动重试成功，仍会补推「完成」。
- **去重（防重复推送）**：桌面每个 location（项目窗口）都会加载一份插件实例，且 `ctx.event` 是**全局事件流**，
  同一完成事件会被 N 个实例各处理一次（实测 5 个窗口 = 5 条重复）。oc-bark 用四层去重：
  1. **进程级认领**（`globalThis` 按 `事件id` 认领，同一服务进程内只有一份实例真正推送）——主机制；
  2. 按事件 `location.directory` 只处理本窗口事件（事件带 location 时生效）；
  3. 事件 id 去重（重连重投同一事件只处理一次）；
  4. 轮次消费（每个用户轮次只推一次）+ 授权请求 id 去重。
  `bark_status` 的 `stats.deduped` 可看到被其它实例认领而跳过的次数。

## 配置

三种来源，优先级 **插件 options > 环境变量 > 配置文件**：

### 1. 配置文件（推荐）

写到 `~/.config/opencode/oc-bark.json`（Windows 即 `C:\Users\<你>\.config\opencode\oc-bark.json`）：

```json
{
  "server": "https://api.day.app",
  "deviceKey": "你的设备Key",
  "group": "OpenCode"
}
```

自建 Bark 服务器把 `server` 换成你的地址即可（如 `https://bark.example.com`）。

### 2. 环境变量

```powershell
$env:OC_BARK_SERVER   = "https://api.day.app"
$env:OC_BARK_DEVICE_KEY = "key1,key2"     # 或 OC_BARK_DEVICE_KEYS
$env:OC_BARK_CONFIG   = "D:\my\oc-bark.json"  # 可选: 覆盖配置文件路径
```

### 3. 插件 options（`opencode.jsonc`）

```jsonc
{
  "plugin": [
    { "package": "oc-bark", "options": { "server": "https://api.day.app", "deviceKey": "你的Key" } }
  ]
}
```

### 全部配置项

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `server` | — | Bark 服务器地址（必填）；可写完整 `/push` 端点 |
| `deviceKey` / `deviceKeys` | — | 设备 Key（必填）；字符串可用逗号/空格分隔，或数组 |
| `enabled` | `true` | `false` 完全停用推送（仍可 `bark_status` / `bark_test`） |
| `notifyOnError` | `true` | 失败推送（对齐原版 Errors 音默认开启） |
| `notifyOnPermission` | `true` | 授权推送（对齐原版 Permissions 音默认开启） |
| `notifyChildSessions` | `false` | 子会话（子代理）的事件也推送 |
| `minDurationMs` | `0` | 完成轮次短于该时长不推送（不影响授权/失败推送） |
| `maxTaskChars` | `100` | 任务原文/详情截断长度（**按字符**，不会切坏 emoji） |
| `title` | `OpenCode 任务完成` | 完成推送标题（仅当会话无标题或 `titleFromSession:false`） |
| `errorTitle` | `OpenCode 任务失败` | 失败推送标题（回退值） |
| `permissionTitle` | `OpenCode 需要授权` | 授权推送标题（回退值） |
| `titleFromSession` | `true` | 用**会话标题**作为推送标题 |
| `template` | `关于‘{task}’任务目前已完成，历时{minutes}分钟` | 完成文案 |
| `errorTemplate` | `关于‘{task}’任务执行失败，历时{minutes}分钟` | 失败文案 |
| `permissionTemplate` | `关于‘{task}’任务需要授权：{detail}` | 授权文案（`{detail}`=权限详情） |
| `group` | — | Bark 分组（App 内聚合） |
| `sound` | — | **Bark 端**铃声（如 `minuet`），留空用 Bark 默认；与桌面端提示音无关 |
| `level` | — | `active` / `timeSensitive` / `passive` / `critical` |
| `icon` / `url` | — | 推送图标 / 点按跳转 URL |
| `timeoutMs` | `8000` | 推送超时 |

> `{minutes}` 三档格式：不足 1 分钟 → `不到1`；1~10 分钟 → 一位小数（`3.4`/`5`）；
> 10 分钟以上 → 取整（`42`）。

## 工具 / RPC

| 通道 | 名称 | 说明 |
| :--- | :--- | :--- |
| 工具 | `bark_status` | 配置来源 / 掩码 Key / 推送统计 / 待命轮次 / 问题清单 |
| 工具 | `bark_test` | 发一条测试推送（验证 server + deviceKey） |
| RPC | `bark.v1` `status` / `test` / `send` | 外部客户端可调用 |
| 事件 | `rpc.bark.v1.pushed` | 每次推送结果广播 |

```bash
# 手动验证（服务端口与密码见 ~/.config/opencode/service.json）
curl -u "opencode:<password>" --json '{"input":{}}' http://127.0.0.1:<port>/api/rpc/bark.v1/status
curl -u "opencode:<password>" --json '{"input":{"body":"hello"}}' http://127.0.0.1:<port>/api/rpc/bark.v1/send
```

## 安装

```powershell
# 本工作区统一同步（推荐）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\OpenCode-Plugin\sync-plugins.ps1

# 或手动
Copy-Item -Recurse .opencode\plugins\oc-bark "$env:USERPROFILE\.config\opencode\plugins\"
```

安装后写配置文件 → 重启桌面端（或等服务热载 10~15 秒）→ 对模型说：
「调用 bark_test 发个测试推送」，收到即配置成功。

## 单测 / 回归

```powershell
bun scripts/verify.mjs              # 布局 + 静态检查 + bun build + 冒烟
bun test scripts/smoke.test.ts      # 文案/客户端/配置/mount 闭环, 全部 fixture
```

## 目录结构

```
oc-bark/
├── .opencode/plugins/oc-bark/
│   ├── package.json        # exports "." / "./rpc"
│   ├── index.ts            # 目录解析兜底入口
│   └── src/
│       ├── index.ts        # 服务端入口 (默认导出 { id, setup })
│       ├── mount.ts        # prompt hook + 事件订阅(完成/失败/授权) + 工具 + RPC
│       ├── bark.ts         # Bark 客户端: URL 归一化 / payload / POST /push
│       ├── config.ts       # 三级配置解析 (options > env > file)
│       ├── format.ts       # 完成/失败/授权文案与分钟数格式化 (纯函数)
│       └── rpc.ts          # RPC 契约 bark.v1
├── oc-bark.example.json    # 配置文件模板
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · LICENSE (MIT)
```

## 排错

| 症状 | 排查 |
| :--- | :--- |
| 收不到推送 | 先跑 `bark_status`：`problems` 会直接指出缺 server 还是缺 Key |
| `bark_test` 失败 | 看返回的 `status` / `code` / `message`（业务码非 200 也会计入失败） |
| 404 | `server` 填的是根地址即可，插件会自动补 `/push`；若你填了完整端点则原样使用 |
| 改了配置不生效 | 配置在插件加载时读取：重启桌面端（或等热载）；`source` 字段可确认最终来源 |
| 不想收到某类通知 | `notifyOnError:false` / `notifyOnPermission:false`；子代理保持 `notifyChildSessions:false`；彻底关用 `enabled:false` |
| 多人/多设备 | `deviceKeys: ["k1","k2"]` 批量（公共 api.day.app 单次 ≤10 台，自建不限） |
