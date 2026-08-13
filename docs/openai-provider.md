# OpenAI 最终裁定 Provider

## 调用约束

管理实验室使用 OpenAI Responses API，且只用于最终裁定：

- `background: true`
- `store: false`
- `text.format.type: "json_schema"`
- `text.format.strict: true`
- 服务端模型允许列表
- 服务端 API Key

创建响应后保存 OpenAI response ID。后续状态查询使用 retrieve，人工取消使用 cancel；浏览器断线不会要求重新创建付费请求。

官方参考：

- [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Background mode](https://developers.openai.com/api/docs/guides/background)
- [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)

## 允许模型

- `gpt-5.6`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

`gpt-5.6` 由服务端解析为当前别名目标，客户端不能提交任意 OpenAI 模型 ID。

允许 reasoning effort：

- `none`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

允许 mode：

- `standard`
- `pro`

最终组合仍需通过服务端 capability 过滤。未经允许的组合直接拒绝，不自动换成另一个模型。

## 输出校验

最终输出必须符合 `ModelRulingResult`：

- 每个子问题各有 verdict；
- 决定性 claim 引用 Evidence Snapshot 中真实存在的 evidence ID；
- 只有直接回答当前题目的官方资料才能标为 `DIRECT_OFFICIAL`；
- 没找到 FAQ 不能推出“不能发动”；
- 系统未知不能转换为规则禁止；
- TRUE/FALSE 不能依赖决定性的 UNKNOWN；
- 反向核对只记录与当前问题相关的检查，没有相关项时可以为空；
- 时间线中的互斥操作分类不能混写。

校验失败保留原始失败信息并把 Run 标为失败或待审，不调用第二个模型润色。

## 测试政策

普通单元测试和 CI 只使用 mock，不进行真实付费调用。真实模型实验必须由管理员显式启动，并在界面中记录模型、档位、Token、费用、延迟和 Evidence Snapshot ID。
