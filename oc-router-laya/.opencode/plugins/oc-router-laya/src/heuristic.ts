// 启发式 judge — 替代上游 846MB 本地分类模型的确定性近似。
//
// 对 7 问协议逐问做信号检测（中英双语模式）, 输出布尔标签 + 命中证据。
// 与上游微调模型相比: 零依赖、零延迟、完全离线; 精度靠词典持续调优
// （上游也建议按自己的语料重训, 这里对应"改模式表"）。

import { QIDS, type QId } from "./tiers"

const PATTERNS: Record<QId, RegExp[]> = {
  Q1: [
    /修改|改动|创建|新建|新增|删除|移除|重命名|改名|实现|修复|重写|重构|部署|运行|执行|安装|升级|迁移|提交|发布|写入|写文件|更新(?:代码|配置|文件)?|打补丁|落地|上线/,
    /\b(?:add|create|modify|edit|delete|remove|rename|implement|fix|refactor|deploy|run|install|upgrade|migrate|commit|update|write|patch|apply)\b/i,
    /\.(?:ts|tsx|js|mjs|cjs|py|go|rs|java|c|cpp|h|cs|rb|php|sh|ps1|sql|json|ya?ml|toml)\b/,
  ],
  Q2: [
    /架构|模块|服务|接口|系统|跨(?:模块|服务|文件)|端到端|全链路|重构|迁移|整合|集成|管道|管线|协议|微服务|多个(?:组件|模块|服务)|框架/,
    /\b(?:architect|architecture|module|service|interface|system|cross[- ]?(?:module|service)|end[- ]to[- ]end|refactor|migrat|integrat|pipeline|framework)\w*/i,
  ],
  Q3: [
    /先.{0,8}(?:再|然后|之后)|步骤|流程|顺序|依赖|然后|接着(?:做|改|跑)|分步|逐步|阶段|流水线|依次|第一步|第二步/,
    /\b(?:step|steps|sequence|first.{0,30}then|pipeline|stage|stages|depends?\s+on|after\s+that|workflow)\b/i,
  ],
  Q4: [
    /为什么|原因|根因|设计|算法|优化|性能|推理|分析|权衡|取舍|排查|定位|调试|证明|数学|策略|评估|难点|复杂|瓶颈|竞态|死锁/,
    /\b(?:why|root\s*cause|design|algorithm|optimi[sz]e|performance|reason|reasoning|trade[- ]?off|analy[sz]e|debug|diagnos|prove|math|strategy|evaluate|bottleneck)\w*/i,
  ],
  Q5: [
    /代码|函数|类\b|接口|变量|编译|报错|异常|堆栈|源码|脚本|单元测试|测试(?:用例|失败)/,
    /\b(?:code|function|class|variable|compile|error|exception|stack\s*trace|bug|source|script|unit\s*test|test\s*fail)/i,
  ],
  Q6: [
    /写(?:一|个|份|段|代码|文档|报告|方案)|生成|输出|产出|起草|总结|报告|文档|方案|规划|设计(?:一|个|方案)|整理/,
    /\b(?:write|generate|draft|report|document|design|plan|summari[sz]e|compose|produce)\b/i,
  ],
  Q7: [
    /批量|全部(?:改|更新|替换|检查)|所有(?:文件|模块)|逐个|逐条|一一|每个(?:文件|模块|接口|任务)|多个(?:文件|模块|服务|接口|任务)|若干|一系列|统一修改|挨个/,
    /\b(?:batch|for\s+each|all\s+(?:files|modules|items)|every\s+(?:file|module|item)|several\s+files|series\s+of|rename\s+all|multiple\s+files)\b/i,
  ],
}

export interface HeuristicJudgeResult {
  readonly labels: Record<QId, boolean>
  readonly signals: Record<QId, string[]>
  /** 0-1: 命中面 / 问题总数, 供面板展示, 不参与规则。 */
  readonly density: number
}

export function judgeHeuristic(text: string): HeuristicJudgeResult {
  const labels = {} as Record<QId, boolean>
  const signals = {} as Record<QId, string[]>
  let hitQuestions = 0
  for (const qid of QIDS) {
    const hits: string[] = []
    for (const pattern of PATTERNS[qid]) {
      const match = pattern.exec(text)
      if (match) hits.push(match[0])
    }
    labels[qid] = hits.length > 0
    signals[qid] = hits.slice(0, 3)
    if (hits.length > 0) hitQuestions += 1
  }
  return { labels, signals, density: Math.round((hitQuestions / QIDS.length) * 100) / 100 }
}
