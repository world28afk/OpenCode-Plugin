# oc-workflow

**OpenCode Workflow 层** — 把一次性的多 Agent 调度升级为可命名、可保存、可复用、可观察、可恢复的 Workflow。设计参考 [`omdsh-dev/dsh_workflow`](https://github.com/omdsh-dev/dsh_workflow)（DSH/KodaX workflow 能力面），本仓库是针对 OpenCode V2 插件 API 的独立实现。

> 上游 `dsh_workflow` 由 dsh-external 社区以 MIT 发布；本实现只参考其产品行为与执行模型（capsule / run graph / resume cache / patterns），代码全部重写，不复制上游源码。

## 它为 OpenCode 带来什么

| 只有一次性调度 | 安装 oc-workflow 后 |
| :--- | :--- |
| 每轮重新描述"怎么拆任务、怎么并发、怎么验证" | 保存为 `.workflow.json`，按名字运行 |
| 并行结果散落在会话里 | `run.json` + `events.jsonl` + `artifacts/` 永久落盘 |
| 中断后从头再来 | `resume-run` 按任务指纹命中 effect cache，只续跑未完成部分 |
| 并发/预算靠提示词约束 | capsule `limits` + 运行时硬限制（超出 agent 预算直接失败） |
| 生成本身不可复用 | `workflow_manage save` 把任意 run 固化为项目/个人 workflow |

## 使用

```text
/workflow list                            # 列出可用 workflow
/workflow run parallel-investigation {"question":"为什么这个测试间歇失败？"}
/workflow runs                            # 最近运行
/workflow show <runId>                    # 运行详情（含每步状态/缓存标记）
/workflow pause|resume|stop <runId>
/workflow rerun <runId>                   # 用不可变 capsule 重跑
/workflow resume-run <runId>              # 按缓存续跑
/workflow prune 20                        # 保留最近 20 个 run
```

模型也可以直接调用三个工具：

- `workflow_list` — 发现 builtin / 项目 / 个人 workflow，列出最近运行（含当前自动派发配置）
- `run_workflow` — 按名字或内联 capsule 运行（默认后台返回 `runId`；`wait: true` 同步等待）
- `workflow_manage` — `runs | show | pause | resume | stop | rerun | resumeRun | prune | save`

RPC（供任何客户端）：`POST /api/rpc/workflow.engine/{list|runs|start|show|pause|resume|stop|rerun|resumeRun|prune}`，SSE 事件 `rpc.workflow.engine.run`。

## 自动派发（把重任务交给子代理）

默认开启。每轮会向模型注入「重任务派发」策略，并在识别到**耗时耗力**的任务时**自动**派发，完成后把结果带回当前会话 —— 不需要用户手动 `/workflow run`。

**默认执行方式 = OpenCode 原生后台任务**：调用内置 `subagent` 工具（`background: true`），子代理作为可审计的子会话运行，**不在项目内新开窗口**、不阻塞当前会话，完成后由 OpenCode 通知回本会话。若需要并行 + 汇总结论 + 证据落盘 + 缓存续跑，可把 `execution` 设为 `workflow` 走 oc-workflow 引擎。

识别范围（可配置）：

| 类别 | 例子 |
| :--- | :--- |
| 大范围探索/定位 | 跨多文件检索、架构梳理、调用链/影响面分析 |
| 调查/根因分析 | bug 根因、为什么失败、间歇性/flaky |
| 多方案评估/审查 | 代码评审、方案对比、风险与回归评估 |
| 机械性重复操作 | 批量改写/替换/验证、逐文件处理 |

- 触发条件：启发式打分（关键词 + 多问题 + 篇幅 + 列表/多行）≥ `threshold`；寒暄、`/命令`、显式「不要派发」不会触发。
- 执行方式 `execution`：`background`（默认，内置 `subagent` 后台任务）或 `workflow`（oc-workflow 引擎：并行→汇总→artifact→缓存）。两者都通过原生 `subagent` 工具承载子代理（可审计子会话）。
- 防递归：workflow/子代理创建的子会话不会再触发自动派发。
- 防滥用：同会话 `cooldownMs` 冷却 + `maxPerSession` 上限。

配置（后者覆盖前者）：`~/.config/opencode/workflow-auto.json` < `<项目>/.opencode/workflow-auto.json` < 插件 `options.auto`：

```jsonc
{
  "enabled": true,
  "mode": "auto",              // auto=策略注入+自动触发 | suggest=仅策略注入 | off=关闭
  "injectPolicy": true,
  "threshold": 2,
  "categories": ["explore", "investigate", "review", "mechanical"],
  "execution": "background",   // background=OpenCode 后台任务(默认) | workflow=oc-workflow 引擎
  "agent": "general",          // background 模式使用的 agent(如 general / explore)
  "workflow": "parallel-investigation",
  "inputField": "question",
  "cooldownMs": 120000,
  "maxPerSession": 3,
  "minPromptLength": 6
}
```

运行期开关（写入全局配置文件）：`/workflow auto on|off|suggest|status`。


## Capsule v1（`oc.workflow/v1`）

```jsonc
{
  "version": "oc.workflow/v1",
  "name": "my-review",
  "intent": "对当前改动做双评审并出报告",
  "inputs": {
    "requirement": { "type": "string", "description": "约束条件" },
    "testEvidence": { "type": "string" }
  },
  "limits": { "maxAgents": 8, "maxConcurrency": 2 },
  "steps": [
    { "type": "phase", "name": "capture" },
    { "type": "capture", "id": "diff", "command": "git diff", "maxLength": 60000 },
    { "type": "parallel", "concurrency": 2, "tasks": [
      { "id": "correctness", "readOnly": true, "prompt": "审查正确性: {{inputs.requirement}}\n{{steps.diff.output}}" },
      { "id": "risk", "readOnly": true, "prompt": "审查风险/回归/安全\n{{steps.diff.output}}" }
    ]},
    { "type": "synthesize", "id": "final", "from": ["correctness", "risk"],
      "prompt": "复核并输出最终报告\n{{steps.correctness.output}}\n{{steps.risk.output}}" },
    { "type": "artifact", "name": "review.md", "from": "final" }
  ]
}
```

步骤类型：`phase`（阶段）/ `agent`（子代理）/ `parallel`（并行任务）/ `synthesize`（汇总）/ `capture`（受限命令，仅允许 `git` 前缀）/ `artifact`（证据落盘）/ `log`。

模板插值：`{{inputs.NAME}}`、`{{steps.ID.output}}`；未解析的引用会记入事件，不会静默吞掉。

发现顺序：内置（不可遮蔽）→ `~/.config/opencode/workflows/`（个人）→ `<项目>/.opencode/workflows/`（项目覆盖个人）。

保存位置：`<项目>/.opencode/workflow-runs/<runId>/{run.json, events.jsonl, results/, artifacts/}`。

## 内置 workflow

| 名称 | 说明 |
| :--- | :--- |
| `parallel-investigation` | 事实 / 反例 / 影响面三路并行调查 → 负责人汇总 |
| `scoped-review` | 捕获 git diff → 正确性 + 风险双评审 → 复核 → `review.md` |
| `fan-out-and-synthesize` | 通用扇出-汇总模板 |

六个标准 pattern（classify-and-act / fan-out-and-synthesize / adversarial-verification / generate-and-filter / tournament / loop-until-done）：内置覆盖前两个的直用形态，其余可按上面的 capsule 格式自行落盘组合。

## 执行模型

- 每个任务优先经内置 `subagent` 工具承载（OpenCode 原生子代理 / 后台任务，桌面端作为 subagent 展示，可审计）；工具不可用时回退到真实子会话（`ctx.session.create` → `prompt` → `wait` → `context` 读取结果）。
- `readOnly: true` 的任务默认路由到只读 agent（若存在 `explore`）。
- `pause` 阻断尚未发布的任务（含并发信号量队列），`resume` 继续；`stop` 中断活动子会话并把未开始步骤标记 `skipped`。
- `resume-run` 只复用 **已完成** 任务的结果（按 `prompt + agent + model` 指纹）；失败任务不会被缓存。
- 超出 `maxAgents` 预算 → run 失败（fail loud, 不降级）。
- 活动 run 是进程内状态；`run.json` 是历史与恢复依据，服务重启后可 `resume-run`。

## 安装

```powershell
# 全局（所有项目可用）
Copy-Item -Recurse .opencode\plugins\oc-workflow "$env:USERPROFILE\.config\opencode\plugins\"

# 或仅当前项目
Copy-Item -Recurse .opencode\plugins\oc-workflow "<项目>\.opencode\plugins\"
```

## 回归校验

```powershell
bun scripts/verify.mjs
bun test scripts/smoke.test.ts   # capsule/插值/目录/存储/引擎(含暂停门控与缓存续跑)/mount, 全部离线 fixture
```

## 目录结构

```
oc-workflow/
├── .opencode/plugins/oc-workflow/
│   ├── package.json       # exports "." / "./rpc" / "./tui"
│   ├── src/capsule.ts     # capsule 校验 + 输入解析
│   ├── src/catalog.ts     # builtin/项目/个人 发现
│   ├── src/builtins.ts    # 内置 workflow
│   ├── src/auto.ts        # 自动派发（重任务识别 + 策略注入 + 配置）
│   ├── src/engine.ts      # 编排/暂停/预算/缓存
│   ├── src/agents.ts      # 子会话桥接（spawn/wait/取输出）
│   ├── src/store.ts       # run 持久化
│   ├── src/interpolate.ts # {{inputs}} / {{steps.output}}
│   ├── src/mount.ts       # 工具 + 命令 + 会话钩子 + RPC
│   ├── src/rpc.ts         # 契约 workflow.engine
│   └── tui.tsx            # 状态条 + /workflows 面板
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · LICENSE (MIT)
```

## 已知边界（v0.1）

- 自动派发是启发式识别（关键词 + 结构打分），可能漏判或误判；用 `/workflow auto off` 或配置 `categories` / `threshold` 调整；自动派发（无论 background 还是 workflow）会消耗额外子代理预算。原生 `subagent` 工具不可用时（旧内核）自动回退到 oc-workflow 引擎。
- 仅支持 JSON capsule（可信本地 `.mjs` 模块执行在路线图上；上游的 QuickJS 沙箱不在本版范围）。
- `capture` 只允许 `git` 前缀命令。
- 暂停/停止仅对当前进程内的活动 run 生效；历史 run 只能 `show/rerun/resume-run/prune`。
- 结构化输出 schema 校验暂未实现（prompt 里自行约束格式）。
