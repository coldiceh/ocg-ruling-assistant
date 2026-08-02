# 模型与付款路线（2026-08-02）

## 结论

ChatGPT 订阅和 OpenAI API 是两套独立计费系统。Apple Gift Card/Apple 账户余额最多用于 App Store 内的 ChatGPT 订阅，不能变成 OpenAI API credit。OpenAI API 预付额度目前以美元购买，最低预付金额和账户上限由账户层级决定；余额有有效期且不可退款。官方说明：

- https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api
- https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform
- https://help.openai.com/en/articles/8264778-what-is-prepaid-billing
- https://help.openai.com/en/articles/10421635-multi-currency-billing

此外，OpenAI 自助 API 要求用户位于受支持国家/地区，支付卡也必须由受支持地区的银行发行；预付卡不能用于购买 API credits。中国大陆目前不在官方支持地区列表中，所以只有中国大陆地址和银行卡时，没有合规的 OpenAI API 自助充值路径。不要使用虚拟卡、代充、共享密钥、非官方中转或伪装地区来绕过限制。官方说明：

- https://platform.openai.com/docs/supported-countries
- https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories
- https://help.openai.com/en/articles/7232916-why-was-my-credit-card-declined
- https://help.openai.com/en/articles/8264778-what-is-prepaid-billing

在无法给 OpenAI API 充值时，建议先采用“本地证据冻结 → 低价模型整理资料 → 较强模型读取原始证据并裁定 → 程序验证”的两阶段路线，而不是让便宜模型独立给最终答案。

## 可选供应商

### DeepSeek

官方价格页：https://api-docs.deepseek.com/quick_start/pricing/

- `deepseek-v4-flash`：1M context；每百万 token cache hit input $0.0028、cache miss input $0.14、output $0.28。
- `deepseek-v4-pro`：1M context；每百万 token cache hit input $0.003625、cache miss input $0.435、output $0.87。
- 支持 JSON Output 和 Tool Calls，但 JSON 模式不是严格 JSON Schema，且官方提醒可能偶发空 content，必须由服务端校验和有限重试。
- 官方 FAQ 列出 PayPal、银行卡、支付宝和微信支付：https://api-docs.deepseek.com/faq

管理实验中，Flash/Pro 都只能做卡名候选、检索词、证据逐字摘取、冲突列表和 ScenarioDraft；不能作出最终裁定，也不能决定是否升级。每次最终裁定仍固定交给 OpenAI GPT-5.6。

### Kimi

官方首页和账户说明：

- https://platform.kimi.ai/
- https://platform.kimi.ai/docs/guide/account-and-payments
- https://platform.kimi.ai/docs/guide/response_format

国际站当前标价（美元/百万 token）：

- `kimi-k2.6`：cache hit $0.16、cache miss input $0.95、output $4，256K context。
- `kimi-k2.7-code`：cache hit $0.19、cache miss input $0.95、output $4，256K context。
- `kimi-k3`：cache hit $0.30、cache miss input $3、output $15，1M context。

K3/K2.7 Code 对严格 JSON Schema 的支持更适合高风险结构化任务；K2.6 在复杂 schema 上仍需二次校验。国际个人账户官方列微信/支付宝二维码充值，中国站按人民币计费，付款前应在账户控制台再次确认实际渠道和地区限制。

### 智谱 GLM

- `GLM-4.7-Flash` 官方明确免费，200K context、最大输出 128K，支持思考、Function Call、缓存和 JSON 输出：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash
- `GLM-5.2` 为 1M context 的高阶候选：https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2
- 官方结构化输出目前仍需业务侧 JSON Schema 校验：https://docs.bigmodel.cn/cn/guide/capabilities/struct-output
- 个人充值协议列明支付宝、微信；企业认证账号还可按官方流程使用对公打款：https://docs.bigmodel.cn/cn/terms/recharge-agreement 、https://docs.bigmodel.cn/cn/faq/authentication-issues

当前管理实验仅将官方明确的 `glm-5.2` 加入资料准备白名单。它不能作出最终裁定；是否适合资料整理仍要用同一 Evidence Snapshot 做盲测。

## 管理实验配置

所有密钥只设置在后端部署环境，不要填进网页、请求体或 Git 仓库：

- 必需：`ADMIN_MODEL_LAB_ENABLED=true`、`ADMIN_OPENAI_ENABLED=true`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`。
- 可选智谱：设置 `GLM_API_KEY`；默认使用中国站 `https://open.bigmodel.cn/api/paas/v4`，必要时只能由服务器用 `ADMIN_GLM_BASE_URL` 覆盖。
- 可选 Kimi：设置 `KIMI_API_KEY`；默认使用官方当前端点 `https://api.moonshot.ai/v1`，必要时只能由服务器用 `ADMIN_KIMI_BASE_URL` 覆盖。

网页只能从后端返回的白名单中选择资料准备模型：`deepseek-v4-flash`、`deepseek-v4-pro`、`glm-5.2`、`kimi-k2.6`、`kimi-k3`。DeepSeek Flash/Pro 可分别测试关闭思考，或开启思考并选择 `high|max`；GLM-5.2 与 Kimi K2.6 可按能力切换思考；Kimi K3 固定开启思考，并只发送官方支持的顶层 `reasoning_effort=low|high|max`。任意 Base URL、API key、未列模型或 provider/model 不匹配都会被后端忽略或拒绝。公开 `/api/answer` 仍固定使用原有 DeepSeek 流程，不受管理实验选择影响。

## 推荐运行策略

1. 本地确定性层冻结 Evidence Snapshot：卡片 ID、原文、FAQ、规则段落、哈希和版本。
2. 便宜模型只输出证据包：实体候选、原文 span、事实、待证明事件、冲突和 UNKNOWN；不得输出受信 verdict。
3. 服务端逐条回查引文并做 JSON Schema 校验；空内容、越界字段或假引文重试后仍失败则升级。
4. 强模型必须同时读取原始 Snapshot 和证据包，不能只看便宜模型摘要。
5. 触发升级的信号包括：无直接 FAQ、多子问、手续/移动归因/诱发窗口、证据冲突、形式证明缺事件、输出 schema 失败或答案与引用不蕴含。
6. 最终答案仍受官方 direct evidence、verified formal proof 和引用校验约束；模型自报 confidence 不能当门禁。

## 评测要求

同一个冻结 Snapshot、匿名随机模型顺序、每配置至少 3 次。记录原子准确率、关键错误率、引文蕴含率、Schema 合格率、UNKNOWN 合理率、费用和 p50/p95 延迟。真实 API 尚未调用，因此本文件不声称任何国内模型已经达到 GPT-5.6 Sol；必须在管理员明确授权、设置预算上限并提供密钥后再测。
