# oc-perf-guard

**OpenCode 性能守卫** — 两类资源问题的观测、判定与自动治理：

1. **运行期脚本**（主要能力）：模型经 shell 工具跑起来的小脚本可能**占用过高**把机器拖卡，或者工具调用早结束了**进程还在跑（模型忘了）**。
2. **MCP 进程**：服务为每个活动 location 各拉起一整套 MCP，容易堆出几十个 node/python 进程。

> v0.3 起改用 **Laya 式本地规则判定**（照 `oc-router-laya` 的思路）自动决策，不再依赖"把问题发给模型"——实测会话忙碌时 `session.prompt(queue)` 投递不可达；改为**规则判定 + synthetic 通知**（synthetic 是持久化写入，会话忙也能落地），模型下一轮可从通知里看到并按需调整。

## 脚本治理怎么工作

```
shell 工具调用 ──execute.before──► 记录 (sessionID, command, callID)
                ──execute.after───► 标记该调用已结束（→ "脱离工具调用的后台残留"）
                                            │
每 30s 采样（CIM: CPU 时间 / 内存 / 启动时间）┤
                                            ▼
  findCandidates: node/python/bun/pwsh 且 非 MCP 且 非采集器
                  ├─ 挂在服务下（模型起的脚本）
                  └─ 已成孤儿但能匹配到已记录命令（忘了收尾的后台脚本）
                                            ▼
  judgeScript（Laya 式规则, 先匹配先赢）
    R0 serve/dev/watch/tail -f …            → nice（长驻服务正当, 只降优先级）
    R1 内存 ≥ memoryKillMB                  → kill
    R2 CPU ≥ cpuPercent 且非长任务型         → kill
    R3 build/test/train/install …            → nice（正当长任务）
    R4 运行 ≥ maxRuntimeMs 且 CPU < idle     → kill（卡住/被遗忘）
    R5 运行 ≥ maxRuntimeMs 且仍占用          → nice
    其它                                     → observe
                                            ▼
  ScriptGovernor 分级执行（mode=auto）
    kill 目标: ① 降到 Idle + 宽限 120s + 通知 → ② 仍未恢复则 taskkill 整树 + 通知
    nice 目标: 降到 Idle + 保留 30min（不再打扰）
    保护: 同 PID 冷却、每小时动作上限、script_keep 可撤销待终止
                                            ▼
  通知: synthetic 消息（+ 可选 notifyPrompt 再补一条 prompt）/ RPC 事件 / TUI
```

通知示例（写入会话, 模型/用户都能看到）：

```
⚠️ oc-perf-guard 已自动处置脚本（Laya 式规则判定）

- PID 27192 node.exe · CPU 98% · 内存 49.9MB · 已运行 1m
- 命令: node -e "while(true){}"
- 判定: kill（one-shot）— CPU 98%（≥70%）且非长任务型
- 已执行: 优先级降到 Idle；若 120s 后仍超阈值将自动终止（需要保留请调用 script_keep(pid=27192)）
优化建议: 降低占用: 分片/分批执行、限制并发线程数、加 sleep 节流、避免忙等死循环
（自动资源治理, 无需回复。）
```

## 工具 / RPC

| 通道 | 名称 | 说明 |
| :--- | :--- | :--- |
| 工具 | `script_list` | 实时采样: 脚本进程 + CPU/内存/时长/判定(verdict)/已执行动作 |
| 工具 | `script_kill` | 手动终止脚本进程树 |
| 工具 | `script_nice` | 手动降优先级（`idle`/`below-normal`/`normal`） |
| 工具 | `script_keep` | 确认保留（默认 30 分钟静默, 可撤销待终止） |
| 工具 | `perf_processes` | MCP 归因快照 + 阈值告警 |
| 工具 | `perf_cleanup` | 清理 MCP 进程树（默认 dryRun） |
| RPC | `perf.guard/{status,cleanup,scripts,scriptKill,scriptKeep,scriptNice}` | 外部客户端可用 |
| 事件 | `rpc.perf.guard.warning` | 含 `script.action`（治理动作）与 MCP 告警 |
| TUI | 「⚙ n 进程 · m 脚本」+ `/perf` 面板 | 有脚本被治理时变红 |

## 配置（插件 options）

```jsonc
{
  "warnAt": 60,               // MCP: node/python/bun 进程数告警线
  "serviceWarnMB": 1200,      // MCP: 服务进程内存告警线
  "intervalMs": 120000,       // MCP 监视周期
  "scripts": {
    "enabled": true,
    "intervalMs": 30000,      // 脚本采样周期
    "mode": "auto",           // auto = 判定并执行; notify = 只通知
    "cpuPercent": 70,         // 单核 100% 计; 单线程满跑 ≈100
    "memoryMB": 1200,         // 进入治理视野的内存线
    "memoryKillMB": 2400,     // 内存硬线（达到即判定终止）
    "maxRuntimeMs": 600000,   // 超过 10 分钟视为"太久"
    "minAgeMs": 10000,        // 刚启动的脚本不打扰
    "idleCpuPercent": 5,      // 低于该 CPU 视为空闲（识别卡住/被遗忘）
    "graceMs": 120000,        // kill 前宽限（先降优先级）
    "keepMs": 1800000,        // script_keep / nice 后的静默时长
    "actionCooldownMs": 30000,// 同 PID 动作冷却
    "maxActionsPerHour": 10,  // 每小时动作上限
    "askCooldownMs": 600000,  // notify 模式下的通知间隔
    "notifyPrompt": false     // 除 synthetic 外再尽力发一条 prompt（忙碌时可能不达）
  }
}
```

## 安装

```powershell
Copy-Item -Recurse .opencode\plugins\oc-perf-guard "$env:USERPROFILE\.config\opencode\plugins\"
# 或在本工作区: powershell -File D:\OpenCode-Plugin\sync-plugins.ps1
```

## 推荐的配套优化

1. `exa` 用远程直连，不要 `npx mcp-remote`（每 location 省三层进程）。
2. 设置 → 扩展 → MCP 里关掉不用的服务器（每个开关 = 每 location 少一套进程）。
3. 不用的项目窗口及时关闭：MCP 进程数 = 活动 location 数 × 每 location 的 MCP 数。
4. 不要把 `npx` 换成 `bunx`：多 location 并发会踩共享临时目录（EBUSY，实测）。

## 回归校验

```powershell
bun scripts/verify.mjs
bun test scripts/smoke.test.ts   # 归因/清理/CPU 采样/候选识别/规则判定/分级执行/mount 闭环, 全部 fixture
```

## 目录结构

```
oc-perf-guard/
├── .opencode/plugins/oc-perf-guard/
│   ├── package.json       # exports "." / "./rpc" / "./tui"
│   ├── src/processes.ts   # 进程采集(CIM: CPU 时间/内存/启动时间) + MCP 归因 + 清理计划
│   ├── src/scripts.ts     # 脚本候选识别 + CPU 采样 + 命令记录/归属
│   ├── src/judge.ts       # Laya 式规则判定(命令分类 + 处置动作 + 通知文案)
│   ├── src/governor.ts    # 分级执行状态机: 冷却/宽限/限流/降优先级/终止/保留
│   ├── src/mount.ts       # 工具 hook + 双通道监视 + 工具/RPC
│   └── tui.tsx            # 状态条 + /perf 面板
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · LICENSE (MIT)
```
