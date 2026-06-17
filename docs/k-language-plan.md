# K 语言 / 裁定中间表示计划

目标不是让模型像玩家一样思考下一步怎么打，而是把自然语言场面翻译成可检查的裁定程序。

## 中间表示

每张卡和每个问题都尽量拆成以下字段：

- `activation_condition`：发动条件。
- `timing`：发动或适用时点。
- `cost`：发动时支付的代价。
- `target`：取对象或适用范围。
- `operation`：效果处理。
- `continuous_constraint`：持续适用的限制或名称变化。
- `replacement`：代替破坏、代替送墓等。
- `temporary_move`：一时除外、处理后返回等。
- `legality_question`：问“能否发动/能否适用/是否合法”。
- `resolution_question`：问“这样处理会发生什么”。

## 回答流程

1. 先把用户问题解析成 `legality_question` 或 `resolution_question`。
2. 再把相关卡片效果文本拆成 K 语言字段。
3. 对发动合法性问题，只检查发动条件、时点、区域、次数和限制。
4. 对处理结果问题，只检查正在适用的效果、被处理卡是否仍在原位置、是否有代替或一时移动、剩余处理如何执行。
5. 数据库 Q&A 完全命中时优先使用数据库结论。
6. 没有原题时，规则推理必须标注为推理，并列出缺失事实。

## 测试集

`scripts/sync-ocg-rule.mjs` 会把 OCG Rule 的规则页和测试页同步到：

- `data/ocg-rule-corpus.json`
- `data/ocg-rule-tests.json`

后续应把测试页拆成可执行回归用例，避免修一个例子坏另一个例子。
