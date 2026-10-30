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

## 官方规则书：只发布 ocg-rule 未覆盖的节

`data/fixed-rule-sources/` 里的 Konami 官方资料（《遊戯王OCG 公式ルールブック》2020-04-01 版转写、官方玩法页）每天照常原样并入 `data/ocg-rule-corpus.json`，源数据不删不改。

构建发布资产 `data/gemini-rule-qa-v1` 时，`konami:` 开头的来源只发布 `config/rule-sources/konami-rulebook-allowlist.json` 列出的节，其余节隐藏，不删除：

- 隐藏的节不进入规则词法检索、向量检索（`data/rule-embedding-v1`）、导航检索和导航记录，也不进入规则目录（ToC）。
- 发布的规则记录仍带完整原文，偏移和哈希不变；记录上的 `publication` 字段列出发布的节 id。保留节的阅读单元、导航描述和向量与全文构建时完全相同。
- 当前清单：规则书 30 节，都是 ocg-rule 没有对应内容的节，分为卡组构筑与赛制 19 节、基础程序和术语 9 节、同调的基本规则 2 节。不发布的有：速度决斗 6 节；ocg-rule 已覆盖或部分覆盖的节；与事务局答复冲突的 4 处（抽卡/伤害计数、“？”攻守、1 回合 1 次、伤害步骤可发动的卡）。官方玩法页整页隐藏（`mode: "withhold"`）。
- 出错就停，不会悄悄全部隐藏或全部放行：清单缺失、为空或格式错误，`konami:` 来源没有条目，节 id 不存在，或标题、标题路径与源结构对不上时，构建都会报错。canonical 和 release manifest 记录白名单的仓库相对路径、字节数、SHA-256、总节数及各来源的全部节 id，并记录实际发布的阅读单元 id。白名单固定使用 LF 换行，避免 Windows 检出改变文件哈希。
- release 和 `pnpm run verify:gemini-rule-qa` 会重新从完整同步语料和当前白名单构造预期集合，复核规则记录、结构映射、阅读单元、向量输入及导航输入/记录；多放、漏放或同数量换成别的单元都会报错，即使资产哈希已一起更新。verify 同时核对 canonical manifest 哈希和规则向量索引的完整有序条目集合；暂存重建时核对输出目录内的向量索引。
- 有 7 个保留节只有一行标题（例如「●同じ名前のカードは３枚まで」「●サイドデッキの枚数は15枚以下」），现行切分不会为它们生成阅读单元，所以检索不到这几行。要让它们可检索得改结构切分，而改切分需要为这些新单元生成导航描述。

### 增删节

只读检查：`node scripts/audit-rule-source-publication.mjs` 对 50 题逐题运行规则词法、规则向量及导航检索，检查完整候选队列和生产上限内候选，也检查三种导航分区及 `buildRuleToc` 实际目录。结果以 JSON 输出。向量查询使用由题面生成的本地确定性探针，不是语义嵌入；它只证明候选身份边界，不评价召回相关性。检查不调用模型、不写入资产。

1. 编辑白名单。在 `sources[].sections` 里增删条目：`sectionKey`、`title`、`titlePath` 从 `data/fixed-rule-sources/konami-ocg-rulebook-20200401.json` 的 `structure.sections` 原样抄（`titlePath` 是从顶层到本节的标题），`category` 用 `categories` 里的键，`reason` 写保留理由。要整份隐藏某个来源，用 `"mode": "withhold"` 加 `reason`。
2. 重建发布资产，有两种方式：
   - 提交白名单，下一次每日同步自动重建。
   - 本地重建：`node scripts/sync-bounded-evidence-assets.mjs --data-dir data --out-dir <新的空目录> --execute`，然后把输出目录里的 `gemini-rule-qa-v1`、`rule-embedding-v1`、`qa-embedding-v1` 换进 `data/`，再运行 `pnpm run verify:gemini-rule-qa`。
3. 费用：
   - 只删节时，导航描述和向量全部复用已有结果，不需要密钥，也没有任何付费调用。
   - 加回之前隐藏的节时，这些节的导航描述和向量已经不在发布资产里了。每日同步会先查付费结果缓存，命中不计费；没命中才在每日预算内为这些单元重新生成导航描述和嵌入，调用次数与加回的单元数相当。本地不带密钥重建时，遇到需要生成的内容会报错停下，不会花钱。
