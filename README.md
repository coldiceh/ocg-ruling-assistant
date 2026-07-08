# 游戏王 OCG 裁定分析助手

这是一个面向 OCG 游戏王玩家的裁定分析助手。项目通过检索卡片文本、卡片信息、公开规则资料和官方公开资料，构造可追踪的 RAG 上下文，再由大语言模型生成裁定分析。

本项目的目标是帮助用户整理问题、查找依据、给出分析思路和风险提示，而不是替代官方裁定或现场裁判。

## 项目简介

用户可以输入一个 OCG 裁定问题，例如卡片发动、连锁处理、效果适用、攻击宣言、处理时状态变化等场景。系统会尝试识别问题中的卡名和关键上下文，检索相关资料，并输出：

- 结论
- 理由
- 引用来源
- 风险提示
- 需要补充的信息

如果用户粘贴了未发售卡或数据库暂未收录卡片的完整效果文本，系统也可以基于用户提供的文本进行未确认分析。

## 工作原理

整体流程如下：

```text
用户输入问题
↓
卡名识别
↓
获取资料：
- 卡片文本
- 卡片信息
- 官方资料
- FAQ
↓
构造 RAG context
↓
LLM 生成裁定分析
↓
展示：
- 结论
- 理由
- 来源
- 风险
```

系统会区分不同证据来源的可信度。官方直接问答可以支持较高置信的结论；卡片文本、FAQ、相关资料和用户提供文本可以支持裁定分析，但不能被表述为官方确认。

## 数据来源

项目使用公开可访问资料构造检索上下文，包括：

- 百鸽卡片资料
- 公开卡片文本与卡片信息
- 官方公开资料
- 官方公开 Q&A / FAQ
- 用户在问题中提供的卡片文本

项目不会把用户提供文本或第三方卡片资料标记为官方直接裁定。

## 技术架构

### Frontend

前端提供单页裁定查询界面，负责：

- 输入裁定问题
- 展示模型结论
- 展示理由、来源和风险
- 展示 Card Dossier，包括卡名、卡图、卡片文本和资料来源
- 展示需要补充的信息

### Backend

后端负责 RAG 分析链路：

- 从问题中抽取卡名和用户提供的卡片文本
- 检索卡片资料、FAQ 和官方公开资料
- 归一化证据来源
- 构造 RAG prompt
- 调用模型 provider
- 归一化模型输出，避免把非官方资料误标为官方确认

### AI

模型用于生成裁定分析。当前支持的 provider 包括：

- DeepSeek
- Gemini
- Mock / dry-run

模型输出会被归一化为几个层级：

- `official_confirmed`：存在官方直接资料时使用。
- `rule_analysis`：没有官方直接资料，但有卡片文本、FAQ 或相关资料，可以给出分析。
- `low_confidence_analysis`：资料较少或场景仍有关键不确定性，只能给出低置信分析。
- `needs_more_info`：缺少足够资料或问题本身缺少关键条件。
- `budget_limited`：模型调用被预算守卫阻止。

## 本地运行

安装依赖：

```bash
pnpm install
```

运行测试：

```bash
pnpm test
pnpm smoke:official-qa
git diff --check
```

常用环境变量：

```text
MODEL_PROVIDER=auto
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_CARD_MODEL=deepseek-v4-flash
GEMINI_API_KEY=
GEMINI_MODEL=
GEMINI_CARD_MODEL=
API_DAILY_BUDGET_CNY=10
```

推荐配置方式：

- `DEEPSEEK_CARD_MODEL` / `GEMINI_CARD_MODEL`：用于从玩家自然语言里提取卡名候选，建议使用 flash / 轻量模型。
- `DEEPSEEK_MODEL` / `GEMINI_MODEL`：用于最终 RAG 裁定分析，建议使用推理能力更强的模型。
- `RAG_CARD_EXTRACTOR_ENABLED=false`：需要临时关闭 AI 卡名提取时使用。

API key 应只配置在后端环境变量中，不应写入前端代码、日志或仓库。

## 未来计划

后续可以继续增强：

- 更强 validator
- 多模型 critic
- 模拟器验证
- 更强规则分析
- 更完整的卡片别名和多语言卡名识别
- 更细的证据可信度分层

## Disclaimer

本项目不是 KONAMI 官方项目。

本项目输出不代表官方裁定。AI 生成内容可能存在错误、遗漏或误判。

正式比赛、店赛和官方活动中的裁定，请以官方规则、官方数据库、赛事主办方和现场裁判为准。

本项目不声称替代裁判，也不声称任何结论 100% 正确。
