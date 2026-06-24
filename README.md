# 游戏王 OCG 裁定 QA 助手

这是一个游戏王 OCG 裁定 QA 助手。它的目标不是让 AI 直接回答规则问题，而是把玩家问题变成可追踪、可降级、可复查的结构化裁定流程。

当前阶段：**安全可追踪原型 / conservative ruling pipeline prototype**。

现阶段优先目标不是提高 `confirmed` 数量，而是避免 `unsafe confirmed`：没有直接证据、没有明确 verdict、条件分支未选中、依赖未解决时，都不能给确定结论。

## 项目定位

完整链路是：

```text
玩家自然语言问题
-> 形式化解析 FormalRulingQuery
-> 卡名 / ID 解析
-> 数据健康检查和按需同步
-> Q&A / FAQ / 卡片资料检索
-> direct / similar / rejected evidence 分类
-> verdict extractor
-> condition branch 选择
-> gameState / eventTimeline 推理
-> subQuestion dependency / transitionRules
-> final gate
-> AI 只负责 explanationText
```

重要约束：

- AI 不能覆盖程序生成的 `status` / `verdict` / `evidenceIds`。
- 卡片文本只能作为 `cardTextEvidence`，不能单独支撑 `confirmed`。
- Q&A / FAQ 必须回答当前 `subQuestion.askedResult`，才可能进入 `directEvidence`。
- 相关但不能直接回答的问题，只能进入 `similarEvidence` 或 `rejectedEvidence`。

## 当前测试结果

最近一次本地检查：

- Node tests: 137/137 passing
- Legacy engine regressions: 9/9 passing
- Data health: `ok`
- Readiness level: `production_ready`

Benchmark：

- total cases: 10
- total subQuestions: 13
- confirmedCount: 3
- inferredCount: 1
- unknownCount: 6
- unsafeConfirmedCount: 0
- missingReasonCount: 0
- verdict_extraction_unknown: 0
- no_direct_evidence: 4

当前 benchmark 的结论是：系统安全门槛有效；大数据快照增加了覆盖，但多语言 matcher 和问题解析仍限制 `confirmed` 数量。

## 数据状态

当前本地数据是 `production_ready` 级别快照，但这只表示卡片与 Q&A / FAQ 覆盖达到较大规模；具体裁定仍必须经过 evidence gate 和 final gate。

当前数据健康检查结果：

- cardsCount: 14237
- cardAliasCount: 35634
- qaCount: 3000
- faqCount: 24484
- qaIndexCount: 27484
- aliasWithoutCardIdCount: 0

核心数据文件：

- `data/cards.json`
- `data/rulings.json`
- `data/card-alias-index.json`
- `data/qa-index.json`
- `data/tracked-cards.json`
- `data/snapshot-meta.json`

数据脚本：

- `scripts/check-data.mjs`：检查 cards / alias / Q&A / FAQ / QA index 是否可用。
- `scripts/sync-data.mjs`：同步或生成本地数据快照，并在结束后检查数据。
- `scripts/debug-retrieval.mjs`：针对单个问题输出 parser、卡名解析、检索和 evidence trace。
- `scripts/benchmark-report.mjs`：输出 benchmark 安全性和 unknown reason 报告。
- `scripts/audit-no-direct.mjs`：审计 benchmark 中的 `no_direct_evidence` 原因。

运行时如果发现本地缺少卡片或该卡 Q&A / FAQ，会尝试 on-demand sync 并更新缓存；如果实时来源不可用，会在 trace 中显示 `live_source_unavailable`，并保守降级。

## 运行方式

初始化或检查数据：

```bash
node scripts/check-data.mjs
node scripts/sync-data.mjs
```

调试单个问题：

```bash
node scripts/debug-retrieval.mjs "玩家问题"
```

运行 benchmark：

```bash
node scripts/benchmark-report.mjs
node scripts/audit-no-direct.mjs
```

运行测试：

```bash
npm test
```

如果当前 shell 没有 `npm`，可以用 Node 直接运行 `package.json` 里 `test` script 列出的测试文件；旧回归入口是：

```bash
node tests/engine-regression.mjs
```

本地启动后端：

```bash
npm run dev:backend
```

请求接口：

```http
POST http://localhost:8787/api/answer
Content-Type: application/json

{
  "question": "输入规则疑问"
}
```

## 可信度等级

- `confirmed`：必须有 `directEvidence`，`evidenceIds` 非空，抽出的 `verdict` 非 `unknown`，并通过 final gate。
- `inferred`：有相似证据或规则来源，但缺少足以 confirmed 的直接条件。
- `unknown`：资料不足、条件缺失、证据冲突、依赖未解、只有卡片文本，或 verdict 无法明确抽出。
- `parse_failed`：只用于 JSON 完全无法解析，或整个 `FormalRulingQuery` 为空。

安全规则：

- card text alone 不能 `confirmed`。
- manual / heuristic rule 不能 `confirmed`。
- pending_adjustment 不能 `confirmed`。
- parserWarnings 非空时不能直接升级为 `confirmed`。
- AI explanation 不能修改程序 verdict。

## Evidence 分类

- `directEvidence`：直接回答当前 `askedResult`，且卡名、问题类型、效果编号/场景没有明显冲突。
- `similarEvidence`：同卡或同类问题相关，但不能直接回答当前问题。
- `rejectedEvidence`：问题不同、场景冲突、卡片不同、效果编号不符、证据冲突或类型不匹配。

本轮质量门槛：

- `directEvidence` 必须覆盖 `askedResult`。
- 只提到动作但没有回答当前问题，会降级为 `similarEvidence` 或 `rejectedEvidence`。
- 多个 direct candidates 结论冲突时不能 confirmed。

已覆盖的回归例：

- `ygoresources-qa-24339` -> `different_question`
- `ygoresources-qa-24069` -> `different_question`
- I:P case conflicting evidence -> `conflicting_direct_evidence`

## 已完成核对表

- parser / formal query：已实现
- card resolution：已实现
- data health / sync-data / check-data：已实现
- retrieval debug：已实现
- directEvidence quality gate：已实现
- multilingual verdict extractor：已实现
- condition branches：已实现
- gameState：已实现
- eventTimeline：已实现
- subQuestion dependencies：已实现
- transitionRules：已实现
- benchmark report：已实现
- no_direct_evidence audit：基础审计已实现，后续仍需按诊断优化
- on-demand sync / cache：已实现
- final gate 防止 AI 覆盖 verdict：已实现
- README：已更新

## 未完成 / Roadmap

下一步优先级：

1. no_direct_evidence audit 后续优化：区分数据缺失、query missed、matcher 多语言类型识别、ranking issue。
2. conditional answer / clarification question：当条件分支缺状态时，生成要追问的关键状态。
3. manual-rulings.json curated ruling source：人工整理裁定源，但不能默认当 official confirmed。
4. pending_adjustment / probable answer support：只允许 pending / unknown 或有限 inferred。
5. answer revalidation after database update：数据更新后重新验证旧答案。
6. larger real ruling benchmark：扩大真实问题集。
7. data coverage expansion：扩大 Q&A / FAQ 覆盖，接近生产可用。
8. user feedback -> regression case：用户反馈转成固定回归测试。

当前明确未实现或只处于计划阶段：

- conditional answer / clarification question
- probable answer for pending_adjustment
- manual-rulings.json curated ruling source
- answer history / revalidation after database update
- larger data coverage / production readiness

## 最新裁定 / 调整中支持计划

未来可以支持最新裁定，但必须区分来源等级：

- `official_qa` / `card_faq` / `official_database`：在满足 direct evidence 和 verdict 条件时 may confirm。
- `official_response`：取决于来源可信度、可引用性和时间戳。
- `community_verified`：最高 `inferred`。
- `manual_curated`：默认最高 `inferred`，除非另有可审计官方来源。
- `pending_adjustment`：只能 `unknown` / `pending`，不能 confirmed。
- `heuristic`：最高 `inferred` 或 `unknown`。

不要把用户手动输入的裁定默认当作 official confirmed。

## 后端模块

- `backend/formalQuery.mjs`：FormalRulingQuery schema、normalize、validate、deterministic split。
- `backend/openai.mjs`：AI parser，只输出 compact JSON。
- `backend/engine.mjs`：主流程、检索、evidence trace、answer gate。
- `backend/dataHealth.mjs`：数据健康检查。
- `backend/dataIndex.mjs`：数据加载和索引。
- `backend/verdictExtractor.mjs`：多语言 verdict 抽取。
- `backend/conditionBranches.mjs`：条件分支抽取。
- `backend/gameState.mjs`：静态状态建模。
- `backend/eventTimeline.mjs`：事件时间线和 pending transition。
- `backend/branchSelector.mjs`：条件分支选择。
- `backend/subQuestionDependencies.mjs`：子问题依赖图。
- `backend/transitionRules.mjs`：保守状态转移规则。

## 部署

静态前端可部署到 GitHub Pages；后端可部署到 Vercel、Render、Cloudflare Worker 或自己的服务器。

GitHub CLI 登录后可使用：

```powershell
D:\githubcli\gh.exe auth login -h github.com -s repo,workflow -w
D:\githubcli\gh.exe auth setup-git
```

标准 Git 推送：

```powershell
git status
git log --oneline -5
git push origin main
```

## 免责声明

本项目不是 Konami 官方产品。对局裁定如有争议，应以官方数据库、赛事主办方和裁判最终判断为准。
