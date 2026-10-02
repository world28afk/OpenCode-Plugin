# oc-router-laya

**OpenCode 档位路由（Laya 思路的 OpenCode 适配版）** — 对没有明确档位指令的消息，自动判断需要多少「思考预算」，并把请求路由到合适的档位。设计参考 [`HapyRain/dsh-router-laya`](https://github.com/HapyRain/dsh-router-laya)（Apache-2.0），本仓库是针对 OpenCode V2 插件 API 的独立实现。

> 与上游的差异：上游用 846MB 的本地微调分类模型（Laya/ModernBERT）做判定；本实现改为**确定性启发式判定**（零依赖、零延迟、完全离线），并保留可选「任意模型做 judge」。上游只适配 DeepSeek 系档位；本实现是**多模型档位表**：档位可以映射到任意 provider/model 的 variant（`low/high/max/xhigh/...`），也可以跨模型路由。

## 判断管线（四层，逐层对应上游语义）

1. **词典意图**（一票定档）：
   - `用最高档` / `拉满` / `全力` → force max
   - `认真点` / `深入分析` / `think harder` → force high
   - `省点` / `最低档` / `简单回答` → force low
   - `继续` / `接着` → 保持上轮档位
   - `别用 max` / `不要拉满` → 记一条「排除」约束（最后统一执行）
2. **启发式判定**：对 7 问协议（副作用 / 跨模块 / 步骤依赖 / 深推理 / 代码 / 生成 / 会话复利）做中英双语信号检测，然后走上游同款 7 条规则（含权重表 `Q1 .18 / Q2 .18 / Q3 .12 / Q4 .29 / Q5 .09 / Q6 .14`）：
   - Rule 0：Q7 会话复利 → high（永不给 max）
   - Rule 1：Q4 且非 Q1 → max
   - Rule 2：Q2 且 Q3 → max
   - Rule 3：Q1 且 Q4 且 Q5 且非 Q2 → high
   - Rule 4：Q2 且非 Q3 → high
   - Rule 5：Q1 → 加权分 ≥ 0.60 ? max : high
   - Rule 6：加权分 ≥ 0.40 ? high : low
3. **复利升级**：本轮消息是上轮的「重试」（相同/前缀，或句首重试词；纠正语必须带明确重试动词）→ 沿阶梯升一档（low→high→max）。
4. **约束过滤**：`别用 max` 这类约束在最后统一生效，压住升级结果。

## 应用方式（OpenCode）

在 `prompt` hook 中决策，并调用 `session.switchModel` 把**本轮会话模型**切到目标档位：

```jsonc
// ~/.config/opencode/router-laya.json   （或 <项目>/.opencode/router-laya.json，后者优先）
{
  "mode": "auto",              // auto | manual（manual 只记录决策不切换）
  "judge": "heuristic",        // heuristic | model | off
  "judgeModel": { "providerID": "deepseek", "id": "deepseek-flash", "variant": "low" },
  "respectExplicit": true,     // 检测到会话模型被外部手动切换时，尊重显式选择
  "escalateOnRegenerate": true,
  "fallback": "low",
  "tiers": {
    "low":  { "providerID": "deepseek", "id": "deepseek-flash", "variant": "low" },
    "high": { "providerID": "deepseek", "id": "deepseek-flash", "variant": "high" },
    "max":  { "providerID": "opencode-go", "id": "glm-5.3-flash", "variant": "max" }
  }
}
```

**多模型适配**：
- 档位 = 同一模型的 variant（`deepseek-flash` 自带 `none/low/high/max`；`glm-5.3-flash` 自带 `low/high/max`）；
- 也可以跨模型/跨 provider：低档用便宜快模型，高档用最强模型；
- `variant` 省略时按档位名自动解析（`low → low/minimal/none`，`max → max/xhigh`，兼容 `qwen3.8-flash` 的 `xhigh`）；
- 默认档位表在启动时从模型注册表自动挑选（首选 `deepseek/deepseek-flash`，否则任意三档 variants 齐全的模型）。

## 入口

| 通道 | 用法 |
| :--- | :--- |
| 命令 | `/router status \| auto \| manual \| tier low\|high\|max \| decide <文本> \| history` |
| 工具 | `router_status`（状态+可用模型 variants）、`router_decide`（预演决策）、`router_set`（模式/一次性档位）、`router_history` |
| RPC | `POST /api/rpc/router.laya/{status\|decide\|history\|setMode\|setTier}`，事件 `rpc.router.laya.decision` |
| TUI | 状态条「⌁ auto·high」+ `/router` 面板（最近决策） |

## 安装

```powershell
Copy-Item -Recurse .opencode\plugins\oc-router-laya "$env:USERPROFILE\.config\opencode\plugins\"
```

安装后默认 `auto`。想先观察再启用：先 `/router manual`（只记录决策），看 `/router decide <文本>` 的判定是否符合预期，再 `/router auto`。

## 回归校验

```powershell
bun scripts/verify.mjs
bun test scripts/smoke.test.ts   # 规则/词典/启发式/配置/管线/hook 全离线 fixture
```

## 目录结构

```
oc-router-laya/
├── .opencode/plugins/oc-router-laya/
│   ├── package.json       # exports "." / "./rpc" / "./tui"
│   ├── src/tiers.ts       # 阶梯 + 7 条规则 + 权重（上游语义逐条对应）
│   ├── src/lexicon.ts     # 词典意图（force/inherit/exclude）
│   ├── src/heuristic.ts   # 7 问信号检测（替代 846MB 本地模型）
│   ├── src/policy.ts      # 四层决策管线 + 重试检测
│   ├── src/config.ts      # 多模型档位表 + 文件/选项合并
│   ├── src/state.ts       # 会话状态 + 决策历史
│   ├── src/mount.ts       # prompt hook + 工具 + 命令 + RPC
│   └── tui.tsx            # 状态条 + /router 面板
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · NOTICE · LICENSE (MIT)
```

## 已知边界（v0.1）

- 判定为确定性启发式：中文语料上准确率取决于词典覆盖，可持续扩充 `heuristic.ts`；需要更强判定可切 `judge: "model"`（一轮会话只判定一次并缓存）。
- 路由在 `prompt` hook 中应用：若宿主在 hook 之后才读取会话模型，则从**下一轮**生效（本实现按当前轮设计，实测见仓库验证记录）。
- 未包含桌面端 composer 档位芯片（上游 client.js 的对应物）；TUI 状态条已覆盖同等信息。
