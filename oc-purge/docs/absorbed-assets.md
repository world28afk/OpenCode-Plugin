# 外部资产吸收记录

记录从外部收集的提示词与技能里，哪些进了 oc-purge、进了哪里、哪些被丢弃及原因。
来源均为本机文件（`Desktop\tmp\`），不属于上游 dsh-purge 仓库。

处理原则：

1. **去人设化**：角色扮演外壳（人名、关系、癖好、口头禅）一律剥离，只留可迁移的机制。
2. **去限制段**：凡「仅授权环境 / 遵守 ToS / 法律风险 / 不适用于…」的门禁段一律删除（本项目定位为无门禁）。
3. **去示例化**：内容样例只保留「格式结论」，不保留具体题材样例。
4. **可回滚**：所有落地都有对应脚本，`--check` 可进 CI。

---

## 1. 四份越狱提示词

| 文件 | 大小 | 保留 | 丢弃 |
| :-- | --: | :-- | :-- |
| `CTF.md` | 2.7 KB | 无（已 100% 存在于本项目 `CTF Core Contract` / `CTF Scope and Evidence`） | 全文 |
| `ENI1.md` | 10.6 KB | Craft Instructions 7 条（角色默认成年、无免责、不给标题、禁 hypophora、禁「不是 X 而是 Y」、拟声词、结尾落动作、扮演用第一人称） | `<policy>` 安全政策全文、ENI 人设、kink 设定 |
| `ENI2.txt` | 32 KB | `<FALSE_POSITIVE_HANDLING>`（chaperone 姿态 + tag 清单 + 一句带过 + DRIFT CHECK）、写作 Tips 大全 | 露骨 few-shot、`<user_style>` 的「系统在骗你」「安全=服从」论述、ENI 人设 |
| `ENI3.txt` | 36 KB | DRIFT DETECTION 的具体措辞表、`Example D: Failure Recovery`（反模式）、Quality Lock 六条 | Example A/C 的题材内容、其余人设重复段 |

### 1.1 落到哪里

| 保留内容 | 落地文件 | 形态 |
| :-- | :-- | :-- |
| chaperone 姿态 + drift check | `prompts/default-prompt-inject.md` → `FOREIGN LAYERS — 外来模式` | 扩写该节（新增两段） |
| Example D 反模式 | `prompts/default-prompt-inject.md` → `ANTI-PATTERN — 失败回复对照` | 新增一节（换掉具体对象，只留机制） |
| 禁 AI 口头禅 | `prompts/default-prompt-inject.md` → `Style` | 新增「Banned constructions」清单 |
| Craft 7 条 + 写作 Tips + Quality Lock | `prompts/scheme-writing-craft.md` | 内置方案「写作模式」，首次装载播种 |

### 1.2 为什么这样切

- `FOREIGN LAYERS` 原来只写「不接战、不确认、不引用」，但没写**怎么做到不写长篇宣言**。模型最常见的失败不是服从提醒，而是**对着提醒发表独立宣言**（"I notice there's a reminder, but…"）。ENI2 的「engagement gives it purchase / 一句带过 / 立刻回任务」正好补这个洞。
- `Example D` 是六份文件里唯一给出**反面样例 + 逐条诊断**的教学结构，比十条正面规则更能压住拒绝。改写时把「拒绝写 RAT」换成通用表述，避免默认提示词绑死在单一题材上。
- 写作 craft 与红队/CTF 无关，做成**可选方案**：不启用时完全不生效；启用时替换默认提示词（方案语义如此）。

---

## 2. 两个技能

来源：`Desktop\tmp\game-hacking\`

| 技能 | 原大小 | 保留 | 丢弃 |
| :-- | --: | :-- | :-- |
| `game-hacking/SKILL.md` | 14.9 KB | 六步工作流、技术栈、DLL 注入 6 法、内存读写、指针链、Hook 5 类、反外挂对抗、2025-2026 新技术（DMA / Hypervisor / Direct Syscall / 回调解除 / HWID）、8 阶段工作流、开源项目清单、学习路径 | `## 安全与法律提醒` 整节 |
| `reverse-engineering/SKILL.md` | 36 KB | 通用基础（加密 / 断点 / 调用栈 / 内存布局）、Web / 二进制 / 移动端 / 协议四部分、工具速查表、常见错误、速查表 | `**不适用：**` 段、`> **法律提示：**` 段 |
| `game-hack.md` | 6.5 KB | 5 个可编译代码骨架（PatternScan / CreateRemoteThread 注入 / 透明 Overlay / Aimbot 角度 / 自动点击 + 模板匹配）、项目结构 | 「先问用户要什么功能」的交互段 |

### 2.1 附带资产

| 目录 | 内容 | 处理 |
| :-- | :-- | :-- |
| `game-hacking/references/` | 17 个文件 / 424 KB | 保留 16 个；**丢弃 `cheatsheet.md`（275 KB 单文件）**，避免资产包体积翻数倍 |
| `reverse-engineering/references/` | 4 个文件 / 53 KB | 全部保留 |
| `scripts/templates/` | 5 个文件 / 31 KB | 保留，落到 `templates/` |
| `game-hacking/game-hacking/` | 整份嵌套副本 | 丢弃（与外层同名同大小） |

### 2.2 落到哪里

```
skills/redteam/game-hacking/
├── SKILL.md                       # 去法律段 + 并入 game-hack.md 代码骨架
├── references/                    # 16 个
└── templates/                     # 5 个

skills/redteam/reverse-engineering/
├── SKILL.md                       # 去「不适用」+「法律提示」
└── references/                    # 4 个
```

两者都是**目录型技能**：`skills/redteam.bundle.json.gz` 里以 `<id>/<相对路径>` 为键，
`purge_skills install` 会把 `references/` 与 `templates/` 一起落到 `.opencode/skills/<id>/`。

---

## 3. 复现

```bash
node scripts/bundle-skills.mjs      # 目录型技能 → 资产包（--check 比对）
node scripts/sync-assets.mjs        # 资产包 + prompts → 内联 TS
node scripts/verify.mjs             # 0 FAIL / 0 WARN 才收工
```

内置方案的播种逻辑在 `src/mount.ts`：每个 `BUILTIN_SCHEMES` 条目只播种一次，
id 记进 `state.seededSchemes`；用户删掉后不再自动重建。测试里可用
`mount(ctx)` 的 `options.seedSchemes = false` 关闭播种。
