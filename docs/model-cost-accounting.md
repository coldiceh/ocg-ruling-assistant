# 模型费用与 Token 统计

## 记录字段

每次实验至少记录：

- 模型和 canonical model ID；
- reasoning effort 与 mode；
- input tokens；
- cached input tokens；
- cache-write input tokens；
- output tokens；
- reasoning tokens；
- 总 Token；
- 美元费用；
- 人民币估算；
- 价格表版本；
- 汇率与汇率版本；
- 是否触发长上下文倍率；
- 各阶段耗时、总耗时与速度标签。

reasoning tokens 通常包含在 output token 统计中，费用计算不能再重复计费。

## 当前价格表

价格表保存在 `data/model-pricing.json`，单位为美元/百万 Token。价格属于带版本的数据，不应硬编码到 UI。

当前标准费率：

| 模型 | 输入 | 缓存输入 | 输出 |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol | 5.00 | 0.50 | 30.00 |
| GPT-5.6 Terra | 2.50 | 0.25 | 15.00 |
| GPT-5.6 Luna | 1.00 | 0.10 | 6.00 |

费用展示是估算，最终账单以供应商为准。

## 管理实验最终调用预算

计量与预算仍是两个概念：结果中的 Token/价格字段用于审计，真正阻止新付费请求的是
Redis 中的逐调用原子 reservation。每个 primary 或 directed repair 都在 provider
`create()` 之前以持久 `attemptId` 预约；同一 attempt 重入不会重复占用额度。

预算按 provider/model 池结算：DeepSeek Flash/Pro（包括 DeepSeek 证据准备）共用
`DEEPSEEK`；第三方中转的 Sol、Terra、Luna 分别使用 `RELAY_SOL`、`RELAY_TERRA`、
`RELAY_LUNA`，彼此不共享 Relay 额度；GLM、Kimi、官方 OpenAI 分别使用自己的池。
每个实际启用的池必须同时显式设置：

- `ADMIN_FINAL_BUDGET_<POOL>_DAILY_CNY`
- `ADMIN_FINAL_BUDGET_<POOL>_RESERVATION_CNY`

没有默认额度；缺少任一值时，该 provider 的真实最终调用会在网络提交前 fail closed。可靠
usage 与版本化人民币价格都存在时，reservation 按实际估价结算；中转价格未知、usage 缺失、
结算确认失败、超时、429/5xx 或网络结果不明时保留保守预约。只有能够确认请求没有被 provider
接受的失败才释放。开发/测试只能显式注入内存账本，生产必须使用持久 Redis 账本。

对应的生产环境变量是：

| 模型池 | 日额度 | 单次保守预约 |
| --- | --- | --- |
| DeepSeek Flash / Pro | `ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY` | `ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY` |
| Relay Sol | `ADMIN_FINAL_BUDGET_RELAY_SOL_DAILY_CNY` | `ADMIN_FINAL_BUDGET_RELAY_SOL_RESERVATION_CNY` |
| Relay Terra | `ADMIN_FINAL_BUDGET_RELAY_TERRA_DAILY_CNY` | `ADMIN_FINAL_BUDGET_RELAY_TERRA_RESERVATION_CNY` |
| Relay Luna | `ADMIN_FINAL_BUDGET_RELAY_LUNA_DAILY_CNY` | `ADMIN_FINAL_BUDGET_RELAY_LUNA_RESERVATION_CNY` |

`RELAY` 不是有效的三模型共享池；只设置
`ADMIN_FINAL_BUDGET_RELAY_DAILY_CNY` 不会给 Sol、Terra 或 Luna 开通额度。

仅在管理员明确批准了不受日额度限制的付费实验时，可在服务器环境设置
`ADMIN_MODEL_LAB_BYPASS_DAILY_BUDGET=true`。它默认关闭，只由已鉴权的管理模型实验室组合层读取，
不会进入公开问答的模型环境。开启后，管理实验的证据准备、primary 和 directed repair
都不创建或结算日额度 reservation；供应商返回的 Token、分阶段耗时与估算费用仍写入 run
和实验历史。该开关不会改变公开 API 的 `API_DAILY_BUDGET_CNY`，实验结束后应恢复为
`false`。

## DeepSeek 证据准备内容恢复

证据准备默认只有一次模型提交。唯一的自动恢复条件是 DeepSeek 已明确返回 HTTP 200，
但响应内容为空或无法解析为 JSON 对象；此时系统最多再发起一次专用 JSON 恢复请求。
恢复请求使用独立 attempt ID 和独立 reservation，并以 `standard / none` 执行；其 usage
与主请求分别记录后再汇总。恢复失败后不会提交第三次。

网络错误、超时、取消、HTTP 400、429、5xx，以及其他不能确认是“HTTP 200 内容失败”
的情形都不会触发该恢复。若 HTTP 200 空响应带有可靠 usage，则按 usage 结算；否则为
避免漏记已经发生的费用，保留原保守预约。该恢复只适用于证据准备，不改变管理矩阵
最终裁定的 `finalAttemptPolicy=single`。

## 第三方 Relay 费用边界

Relay 模型仅用于隔离的管理员实验。系统会同时记录 requested model 和 returned model，
但项目无法验证中转实际返回的模型身份；截图费率、Token 包络和人民币换算都只是实验
前估算，不是供应商账单。CLI 的请求数/估算费用上限与 Redis 的逐池日额度同时生效，
前者不能绕过后者，也不会修改公开页面默认模型。

## 测试费用边界

默认 `check`、`test:admin` 和 `test` 均不得调用真实付费模型。它们使用 Mock 响应和本地证据验证模型边界、结构校验、计量与导出格式。真实 DeepSeek/OpenAI 质量和费用测试只在管理员明确批准后手工执行，并且必须保留真实 usage、价格版本和汇率版本。
