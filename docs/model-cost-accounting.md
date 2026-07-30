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

## 限制与计量分离

当前管理实验不执行应用层预算、Token、运行时间或并发上限，但计量始终开启。`null` 表示未配置上限，不是 0。

## 测试费用边界

默认 `check`、`test:admin` 和 `test` 均不得调用真实付费模型。它们使用 Mock 响应和本地证据验证模型边界、结构校验、计量与导出格式。真实 DeepSeek/OpenAI 质量和费用测试只在管理员明确批准后手工执行，并且必须保留真实 usage、价格版本和汇率版本。
