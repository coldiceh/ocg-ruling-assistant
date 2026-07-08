# 游戏王 OCG RAG 裁定分析助手

这是一个面向中文 / OCG 环境的最小可用 RAG 裁定分析助手。当前目标不是完整规则引擎，也不是自动替代裁判，而是把玩家问题接到可追踪的资料检索和模型分析链路上。

当前主路径：

```text
用户裁定问题
-> 抽取卡名和书名号中的候选卡名
-> 检索本地卡片资料、百鸽卡片页、官方 Q&A / FAQ 和相关资料
-> 构造 RAG prompt
-> DeepSeek / Gemini / mock 生成裁定分析
-> UI 展示答案、卡图、卡文、资料依据和风险提示
```

## 当前阶段

当前为 **RAG baseline**：

- `official_confirmed`：只允许由 official direct Q&A / FAQ 支撑。
- `rule_analysis`：没有 direct Q&A，但有卡片文本、FAQ、官方相似案例或相关资料，可以给未确认分析。
- `low_confidence_analysis`：只有弱相关资料或卡片文本时的低置信分析。
- `needs_more_info`：没有可用资料，或场景缺失到无法分析。
- `budget_limited`：每日 API 预算守卫阻止调用。

相关资料、FAQ 和卡片文本不能伪装成 official direct。没有 official direct 时，系统仍应给出未确认分析，而不是因为缺 effect template 直接拒答。

## 保留和隔离

保留在当前生产主路径：

- `backend/ragCardExtractor.mjs`
- `backend/cardDataProvider.mjs`
- `backend/ragEvidenceRetriever.mjs`
- `backend/ragRulingPrompt.mjs`
- `backend/ragModelClient.mjs`
- `backend/ragRulingPipeline.mjs`
- `/api/answer` 默认 RAG baseline
- `/api/card` 百鸽卡片资料查询
- `/api/card-image` 卡图代理
- Card Dossier / 卡图 / 卡片文本 UI

保留给未来 validator，但不作为默认主裁判：

- Fast Judge / rule-derived answer
- effect templates / primitives
- blocker、damage step、timing miss、chain safety
- final gate、evidence scope / freshness guard

这些模块后续可用于 claim extraction、validator、YGOPro / MyCard engine validator 或多模型 critic。本阶段不让它们拦截默认 RAG 回答。

## API

`POST /api/answer` 默认走 RAG baseline。显式 legacy 入口只用于内部调试：

```json
{
  "question": "「宇宙耀变龙」的攻击无效效果在这个场景能否结算？"
}
```

等价于：

```json
{
  "question": "问题文本",
  "mode": "rag"
}
```

旧路径只在显式设置时启用：

```json
{ "question": "问题文本", "mode": "legacy" }
{ "question": "问题文本", "mode": "fastjudge" }
```

## 模型 Provider

支持：

- `MODEL_PROVIDER=auto`
- `MODEL_PROVIDER=deepseek`
- `MODEL_PROVIDER=gemini`
- `MODEL_PROVIDER=mock`

默认 `auto`：

1. 有 DeepSeek key 时使用 DeepSeek。
2. 否则有 Gemini key 时使用 Gemini。
3. 否则使用 mock / dry-run。

Vercel 必填环境变量：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL=https://api.deepseek.com`
- `DEEPSEEK_MODEL=deepseek-v4-flash`

可选环境变量：

- `MODEL_PROVIDER=auto`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `GEMINI_TEMPERATURE`
- `GEMINI_MAX_OUTPUT_TOKENS`
- `API_DAILY_BUDGET_CNY=10`
- `API_BUDGET_TIMEZONE=Asia/Tokyo`
- `API_BUDGET_MODE=soft`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

API key 只应配置在后端环境变量中，不应写入前端、README、日志或仓库。

## 预算守卫

默认每日预算：

```text
API_DAILY_BUDGET_CNY=10
API_BUDGET_TIMEZONE=Asia/Tokyo
API_BUDGET_MODE=soft
```

未配置 Upstash Redis 时，Vercel 上预算限制是 per-instance 软限制，不是全局硬上限。配置 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 后，预算计数会走共享 Redis。

真正硬控成本仍建议结合 DeepSeek 低余额充值。

## 卡片资料和卡图

当前资料顺序：

1. 本地 `data/cards.json` / `data/qa-index.json` / `data/evidence-index.json`
2. `/api/card` 查询百鸽卡片资料
3. `/api/card-image` 和候选 CDN URL 显示卡图
4. raw query / fuzzy fallback

`backend/cardDataProvider.mjs` 预留轻量 provider interface：

- `searchCardByName(name)`
- `getCardProfile(cardId)`
- `getCardText(cardId)`
- `getCardImage(cardId)`
- `getCardFaq(cardId)`

当前实现先包住本地 cache / Card Dossier 数据；百鸽实时查询保留在 API 和 UI 层，不在 RAG retriever 中硬编码不可控远程 URL。

## UI

普通用户界面只有一个主按钮：`查询`。

默认只走 RAG baseline。管线调试默认隐藏，只在 `?debug=1` 或本地开发地址显示。Card Dossier、卡图、卡片文本和依据展示保留。

网页 debug 中确认真实模型调用：

- DeepSeek：`providerUsed = "deepseek"`，`dryRun = false`
- Gemini：`providerUsed = "gemini"`，`dryRun = false`
- mock：`providerUsed = "mock"`，`dryRun = true`

可同时查看 `modelUsed`、`tokenUsage`、`estimatedCostCny`、`budgetStatus`。

## 测试

默认测试只覆盖当前 RAG baseline 和普通 UI：

```bash
pnpm test
pnpm smoke:official-qa
git diff --check
```

如果当前 shell 没有 pnpm，可用 bundled pnpm 或：

```bash
npx pnpm@11.7.0 test
npx pnpm@11.7.0 smoke:official-qa
```

默认测试不包含旧规则引擎验收集。

## Related Work

Yugi-AI 展示了一个清晰的最小裁定助手架构：抽取卡名、获取卡片文本、把卡文注入裁定 prompt、调用主模型，并对少量高频问题使用已验证 canned response。本项目只参考这种产品形态和工程边界，不复制其代码或 prompt。

## Roadmap

下一步可以在 RAG baseline 稳定后加入：

1. claim extraction
2. validator
3. YGOPro / MyCard engine validator
4. 多模型 critic
5. 更严格的官方 direct / related evidence 验证层

## 免责声明

本项目不是 Konami 官方产品。对局裁定如有争议，应以官方数据库、赛事主办方和裁判最终判断为准。
