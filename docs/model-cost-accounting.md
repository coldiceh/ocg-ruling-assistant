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

预算按 provider 共池：DeepSeek Flash/Pro 共用 `DEEPSEEK`，第三方中转的
Sol/Terra/Luna 共用 `RELAY`，GLM、Kimi、官方 OpenAI 分别使用自己的池。每个池必须同时
显式设置：

- `ADMIN_FINAL_BUDGET_<POOL>_DAILY_CNY`
- `ADMIN_FINAL_BUDGET_<POOL>_RESERVATION_CNY`

没有默认额度；缺少任一值时，该 provider 的真实最终调用会在网络提交前 fail closed。可靠
usage 与版本化人民币价格都存在时，reservation 按实际估价结算；中转价格未知、usage 缺失、
结算确认失败、超时、429/5xx 或网络结果不明时保留保守预约。只有能够确认请求没有被 provider
接受的失败才释放。开发/测试只能显式注入内存账本，生产必须使用持久 Redis 账本。

## 测试费用边界

默认 `check`、`test:admin` 和 `test` 均不得调用真实付费模型。它们使用 Mock 响应和本地证据验证模型边界、结构校验、计量与导出格式。真实 DeepSeek/OpenAI 质量和费用测试只在管理员明确批准后手工执行，并且必须保留真实 usage、价格版本和汇率版本。
