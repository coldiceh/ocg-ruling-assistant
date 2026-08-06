# 两题双模型小实验：预部署验收与执行计划

日期：2026-08-06
状态：**尚未执行本轮付费实验**

这份文件只记录预部署验收和待执行范围，不包含本轮模型质量结论。旧版报告中的
“四题 × 五模型、20 次最终请求、¥100 计划上界”以及其中未通过当前证据门禁的模型输出
已移除；它们不能作为正确率、速度或费用基线。

## 已完成的零费用验收

- 相关 mock / dry-run 回归已经运行；最终 provider 使用本地哨兵，不会连接付费模型。
- 四道开发题的 Evidence Snapshot 已通过匿名、只读且限定到百鸽卡片 API 的身份补全检查。
- dry-run 中冻结快照及最终模型输入均可计算 SHA-256，候选卡能够唯一绑定，模型可见资料中
  包含完整卡文。
- dry-run 观察到 `realProviderTransportCalls: 0`；本地 provider 的 `create()` 只用于验证
  付费前门禁，不代表发生了真实模型调用。
- 标准答案与泄漏探针不会进入 Evidence Snapshot 或最终模型输入。

正式实验开始前必须重新运行相同门禁。只有每题同时满足以下条件才可付费：

- `productionReadiness.ready: true`
- `paidGateBlocked: false`
- `allSnapshotsFrozen: true`
- 所有候选卡 `bindingStatus: RESOLVED`
- `localFinalProviderCreateCount: 1`
- `realProviderTransportCalls: 0`

本节不是付费实验结果，也不评价任何模型的裁定正确率。

## 待执行范围

只运行以下两道开发题，不自动扩大到其他题目：

1. `double-tempest-impermanence`：无限泡影与天雷之双风神的发动合法性。
2. `unchained-replacement`：破坏替代适用后，后续特殊召唤是否继续处理。

每道题先由 DeepSeek Flash 进行一次证据准备，生成并冻结一份 Evidence Snapshot；随后
两个最终模型必须复用同一份快照、系统提示词、输出结构和 Token 上限：

| 最终模型配置 | Provider | 模型 | 速度 | 思考模式 | 最终尝试策略 |
| --- | --- | --- | --- | --- | --- |
| DeepSeek Flash | DeepSeek | `deepseek-v4-flash` | `standard` | `none` | `single` |
| Relay Terra | 第三方 OpenAI-compatible 中转 | `relay-gpt-5.6-terra` | `pro` | `high` | `single` |

正常路径的计划调用量为：

- DeepSeek 证据准备：2 次（每题 1 次）。
- 最终裁定：4 次（2 题 × 2 个最终模型）。
- 合计：6 次模型请求，其中 4 次是最终模型请求。

最终裁定不允许自动重试、定向修复或模型式 JSON 修复。证据准备若遇到 HTTP 200
但正文为空或非法 JSON，现有管线最多允许一次受预算约束的恢复尝试；该尝试必须单独记账。
网络错误、超时、取消、HTTP 400、429 或 5xx，以及提交结果未知的请求，均不得自动重提。

## 预算硬边界

- DeepSeek Flash 的证据准备与最终裁定共用 `DEEPSEEK` 日池，硬上限 **¥10**。
- Relay Terra 使用独立的 `RELAY_TERRA` 日池，硬上限 **¥10**。
- 本轮所选两个池的合计日硬上限为 **¥20**，不是保证会消费的金额。
- 每次真实调用必须先通过持久化预算账本的原子 reservation；缺少账本、额度配置或余额时
  在 provider transport 前 fail closed。
- 不得通过修改 CLI 估算值、拆分运行或切换模型 ID 绕过日池。

DeepSeek Pro、Relay Sol、Relay Luna、GLM 和 Kimi 均不属于本轮范围，不得因某个配置失败
而自动切换到这些模型。

## 每次调用必须记录

| 类别 | 字段 |
| --- | --- |
| 题目与输入 | case ID、问题哈希、Evidence Snapshot ID / SHA-256、最终模型输入 SHA-256 |
| 模型身份 | provider、requested model、returned model、速度、思考模式、reasoning effort、attempt policy |
| 输出 | 状态、`conciseAnswer`、结构化 verdict、timeline、evidence usage、finish reason、错误信息 |
| Token | input、cached input、cache-write input、output、reasoning、total（以接口实际提供为准） |
| 耗时 | 卡名解析、卡文检索、规则 / Q&A 检索、Lua、Evidence Snapshot、最终模型、本地验证、总耗时 |
| 费用 | 预算池、reservation、实际或保守结算、价格表版本、币种、人民币费用 |
| 传输审计 | 请求序号、真实 transport 次数、是否触发证据恢复、submitted / unknown / rejected 状态 |
| 独立评分 | 是否符合标准答案，以及第一处失败阶段；评分只能在模型调用结束后本地进行 |

不记录、不索取也不展示隐藏思维链。标准答案只能用于调用后的本地评分，不能进入题目、
Evidence Snapshot、系统提示词或任何被测模型上下文。

## 停止条件

出现以下任一情况立即停止相应题目或整个实验，不扩大矩阵：

1. 任一付费前门禁不满足，或候选卡未解析、歧义、卡文缺失 / 截断。
2. Evidence Snapshot 未冻结、哈希不一致，或两个最终模型获得的快照、提示词或 Token 上限不同。
3. 标准答案、泄漏探针、API key、管理密码或其他服务端密钥出现在模型输入、浏览器响应、日志或报告中。
4. `DEEPSEEK` 或 `RELAY_TERRA` 预算缺失、reservation 失败或日池余额不足。
5. 最终请求发生失败、空响应、截断、格式错误、模型不可用或 returned model 不匹配：记录事实，
   但不自动重试、不修复调用、不换模型。
6. provider 是否已接受请求无法确认：保留保守预约，禁止重提相同 attempt。
7. 已完成 2 道题 × 2 个最终模型，或已达到 4 次最终模型请求。

并发固定为 1。本轮结果不会自动修改公开默认模型，也不会自动部署更多配置。

## 结果占位（未执行）

| Case | 最终模型配置 | 状态 | requested / returned model | 快照哈希 | 总耗时 | Token | 费用 | 独立评分 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `double-tempest-impermanence` | DeepSeek Flash / standard / none / single | 待执行 | — | — | — | — | — | — |
| `double-tempest-impermanence` | Relay Terra / pro / high / single | 待执行 | — | — | — | — | — | — |
| `unchained-replacement` | DeepSeek Flash / standard / none / single | 待执行 | — | — | — | — | — | — |
| `unchained-replacement` | Relay Terra / pro / high / single | 待执行 | — | — | — | — | — | — |

只有取得真实后端审计记录后才能填写本表。不得根据旧报告、聊天记录或预期答案补写
模型输出、Token、耗时、费用或评分。

## 实验结束后的收尾

- 用实际审计记录更新本报告，并保留失败和模型身份不匹配，不挑选性删除结果。
- 完成独立评分和第一失败阶段分析后停止，不自动追加题目或模型。
- 将 Production 的 `ADMIN_MODEL_LAB_ENABLED` 设回 `false` 并重新部署。
- 报告中只保留必要的哈希和审计元数据；不得写入 API key、管理密码或带凭据的 URL。
