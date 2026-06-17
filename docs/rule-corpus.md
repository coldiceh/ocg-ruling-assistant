# OCG Rule 资料接入

本项目把 `https://ocg-rule.readthedocs.io/zh-cn/latest/` 作为规则学习资料和裁判训练测试来源。

它的定位不是官方数据库替代品：

- 官方数据库 Q&A / FAQ 仍然是确认裁定的优先来源。
- OCG Rule 页面作为规则书学习、处理原则和测试题来源。
- 来自 OCG Rule 的资料在后端中标记为 `rule-doc` 或 `rule-test`，只能作为规则依据或回归测试材料。
- 没有数据库原题时，基于规则资料的回答必须显示为“规则推理”或“不能确定”，不能显示为“已确认资料”。

同步方式：

```bash
npm run sync:rules
```

同步会生成：

- `data/ocg-rule-corpus.json`：规则页语料。
- `data/ocg-rule-tests.json`：测试/检定页，用作后续回归测试集。

GitHub Actions 的 `Sync ruling data` 会同时同步 YGOResources 和 OCG Rule。
