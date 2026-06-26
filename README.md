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

- Node tests: 181/181 passing
- Legacy engine regressions: 9/9 passing
- Data health: `ok`
- Readiness level: `production_ready`

Benchmark：

- total cases: 10
- total subQuestions: 13
- confirmedCount: 5
- inferredCount: 0
- unknownCount: 5
- unsafeConfirmedCount: 0
- missingReasonCount: 0
- conditionalAnswerCount: 1
- clarificationQuestionCount: 1
- verdict_extraction_unknown: 0
- no_direct_evidence: 3

当前 benchmark 的结论是：系统安全门槛有效；多语言 evidence question type classifier 修复了一部分 Q&A 类型误判，conditional answer 能解释缺状态的条件分支，但没有放宽 `directEvidence` 或 `confirmed` 门槛。

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
- `data/official-responses.json`
- `data/answer-history.json`
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
- `scripts/audit-evidence-types.mjs`：审计 no-direct case 中候选 Q&A 的多语言问题类型识别。
- `scripts/revalidate-official-responses.mjs`：检查 provisional official response 是否已有官方 DB direct evidence。
- `scripts/revalidate-answers.mjs`：重评估 answer history watch queue 中的 unknown / provisional 问题。

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
node scripts/audit-evidence-types.mjs
node scripts/revalidate-official-responses.mjs
node scripts/revalidate-answers.mjs
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
- `official_response_unverified` 不能 `confirmed`。
- `pending_adjustment` 不能 `confirmed`。
- 内部 heuristic 状态转移不能 `confirmed`。
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

## Evidence question type classifier

系统现在会在 matcher 层识别中 / 日 / 英 Q&A 的问题类型，用于判断候选资料是否可能回答当前 `askedResult`。当前识别的类型包括：

- `activation_condition`
- `activation_timing`
- `damage_step_activation`
- `temporary_banish`
- `banish_applicability`
- `effect_applicability`
- `resolution_handling`
- `activation_location`

这不是放宽 `directEvidence`。它只让 matcher 更准确地区分“同卡同动作但问题不同”和“确实回答当前 askedResult”的 Q&A。进入 `directEvidence` 仍必须同时满足卡名 / 问题类型 / askedResult 覆盖 / verdict 或条件分支 / 场景无冲突等门槛。

## Conditional answers

当系统已经找到条件分支证据，但玩家问题缺少必要状态时，最终结构化结果仍保持 `unknown`，不会提升为 `confirmed`。系统会列出所有有证据支持的分支，并生成需要玩家补充的信息。

示例：

```text
当前无法确定唯一结论。
可能分支：
- 如果仍在怪兽区域：在怪兽区域发动。
- 如果已经送去墓地：在墓地发动。
- 如果已经被除外：在除外状态发动。
请补充：这个时点该卡是仍在怪兽区域、已经送去墓地，还是已经被除外？
```

`conditionalAnswer` 只是解释层字段，不能修改 `status` / `verdict` / `evidenceIds`。AI explanation 仍只能解释程序给出的结构化结果。

## Official responses

事务局回答、官方客服回答、官方邮件或其他官方渠道确认可以作为 `official_response`，但必须可追溯。可追溯信息至少包括 `sourceUrl`、`sourceNote`、`officialText` / `evidenceText`、`collectedAt` / `updatedAt` 或 response id 之一。

当前支持的来源等级：

- `official_qa`：官方 Q&A / YGOResources Q&A；满足 direct evidence 和 verdict 条件时可 `confirmed`。
- `card_faq`：卡片 FAQ；满足 direct evidence 和 verdict 条件时可 `confirmed`。
- `official_database`：官方数据库公开裁定；满足 direct evidence 和 verdict 条件时可 `confirmed`。
- `official_database_card_page`：官方数据库卡片页面；只能作为 cardReferenceEvidence，不能单独 `confirmed`。
- `official_response`：可追溯事务局 / 官方渠道回答；必须继续通过 card、question type、askedResultCoverage、verdict extractor 和 final gate，才可 `confirmed`。
- `official_response_screenshot`：事务局回答截图；当前阶段只生成 `provisionalAnswer`，显示“事务局回答截图，官方数据库未收录”，不能 `confirmed`。
- `official_response_unverified`：只有玩家转述或无法追溯来源；当前阶段不能 `confirmed`。
- `pending_adjustment`：调整中；保持 `unknown`，不能 `confirmed`。

玩家整理、社区转述、无来源 probable answer 暂不作为数据源。即使内容看似正确，也不能进入 `directEvidence` 或影响 `confirmed`。

`official_response_screenshot` 的显示规则：

```text
未确认处理方式（事务局回答截图，官方数据库未收录）：
可以发动并支付 cost，但后续处理不进行。

注意：
该回答目前未在官方数据库中找到直接 Q&A。后续如果数据库更新，系统会优先改用官方数据库裁定。
```

结构上它会挂在子答案的 `provisionalAnswer` 字段中，`status` / `verdict` / `evidenceIds` 仍保持程序最终结果。截图回答不能进入 `directEvidence`，也不能被 AI explanation 提升为 `confirmed`。

用于后续重评估的命令：

```bash
node scripts/revalidate-official-responses.mjs
```

该脚本只报告是否已经在官方 Q&A / FAQ / database 中找到覆盖 `expectedAskedResult` 的 direct evidence，不会自动覆盖原始截图记录。

## Answer history and revalidation

默认不会记录回答历史。只有显式设置：

```bash
RECORD_ANSWER_HISTORY=true
```

系统才会把可重评估的结构化结果写入 `data/answer-history.json`。记录内容只包括 `originalText`、`formalQuery`、watch cards / terms、最终 `status` / `verdict`、unknown reasons、`provisionalAnswer` 和 evidence IDs；不记录 AI explanation，也不允许 AI explanation 参与后续重评估。

进入 watch queue 的情况：

- `confirmed` 默认不进入 watch queue。
- `provisionalAnswer` 一定进入 watch queue。
- `unknown` 且原因是 `no_direct_evidence`、`pending_adjustment`、`provisional_official_response` 或 `condition_branch_missing_state` 时，可以进入 watch queue。

重评估命令：

```bash
node scripts/revalidate-answers.mjs
```

重评估会用保存的 `formalQuery` 重新跑 retrieval -> matcher -> verdict extractor -> final gate。找到官方 Q&A / FAQ / official database direct evidence 后，可以报告 `upgraded_to_confirmed`；否则报告 `unchanged`、`new_related_evidence` 或 `live_source_timeout`。脚本当前只报告结果，不会自动改旧答案。

重要约束：

- 截图、provisional、pending 或推测不会自动变成 `confirmed`。
- official DB evidence 永远优先于 `provisionalAnswer`。
- final gate 仍是确认结论的唯一出口。

## 已完成核对表

- parser / formal query：已实现
- card resolution：已实现
- data health / sync-data / check-data：已实现
- retrieval debug：已实现
- directEvidence quality gate：已实现
- evidence question type classifier：已实现
- multilingual verdict extractor：已实现
- condition branches：已实现
- gameState：已实现
- eventTimeline：已实现
- subQuestion dependencies：已实现
- transitionRules：已实现
- conditional answer / clarification question：已实现（仅用于条件分支缺状态或多分支不唯一时的 unknown 解释）
- official response source gate：已实现（可追溯 `official_response` 可进入 ruling evidence；`official_response_screenshot` 仅生成 provisionalAnswer）
- official response revalidation skeleton：已实现（只报告 DB direct evidence 是否出现，不自动覆盖）
- answer history / revalidation queue：已实现（默认关闭，只记录结构化 unknown / provisional watch item）
- benchmark report：已实现
- no_direct_evidence audit：已实现
- on-demand sync / cache：已实现
- final gate 防止 AI 覆盖 verdict：已实现
- README：已更新

## 未完成 / Roadmap

下一步优先级：

1. no_direct_evidence 后续优化：针对 `all_candidates_different_question` / `all_candidates_conflicting` 补充更精确官方数据源。
2. pending_adjustment support：只允许 `unknown`，并清楚提示调整中。
3. official response ingestion：补充可追溯字段采集、去重和更新流程。
4. answer revalidation after database update：将当前 report-only 脚本接入定时同步、前端提醒和历史答案复核。
5. larger real ruling benchmark：扩大真实问题集。
6. data coverage expansion：扩大 Q&A / FAQ 覆盖，接近生产可用。
7. user feedback -> regression case：用户反馈转成固定回归测试。

当前明确未实现或只处于计划阶段：

- probable answer for pending_adjustment
- answer history UI reminder / automatic notification after database update
- larger data coverage / production readiness

## 最新裁定 / 调整中支持计划

未来可以支持最新裁定，但必须区分来源等级：

- `official_qa` / `card_faq` / `official_database`：在满足 direct evidence 和 verdict 条件时 may confirm。
- `official_response`：必须可追溯，并通过 directEvidence 和 final gate 后才 may confirm。
- `official_response_screenshot`：只能作为 provisional official response 展示；当前不能 confirmed。
- `official_response_unverified`：只有转述或缺少可追溯信息时，不能 confirmed。
- `pending_adjustment`：只能 `unknown`，不能 confirmed。

不要把用户手动输入、玩家整理或社区转述的裁定默认当作 official confirmed。

## 后端模块

- `backend/formalQuery.mjs`：FormalRulingQuery schema、normalize、validate、deterministic split。
- `backend/openai.mjs`：AI parser，只输出 compact JSON。
- `backend/engine.mjs`：主流程、检索、evidence trace、answer gate。
- `backend/dataHealth.mjs`：数据健康检查。
- `backend/dataIndex.mjs`：数据加载和索引。
- `backend/evidenceQuestionTypeClassifier.mjs`：中 / 日 / 英 Q&A 问题类型识别。
- `backend/officialResponses.mjs`：官方事务局回答 / 调整中记录的来源等级和可追溯校验。
- `backend/answerHistory.mjs`：unknown / provisional 回答历史和 watch queue 生成。
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
