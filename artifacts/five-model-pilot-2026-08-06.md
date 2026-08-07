# 两题多模型小实验：实际执行结果

执行日期：2026-08-06 至 2026-08-07
状态：**实验已停止，不再追加或重试请求**

本报告记录两道开发题在 DeepSeek Flash 及第三方 OpenAI-compatible Relay 上的实际执行结果。
标准答案只在调用结束后用于本地评分，没有进入 Evidence Snapshot、系统提示词或被测模型上下文。
报告不记录隐藏思维链，也不把未取得的 Run ID、returned model、Token 或费用补写成事实。

## 结论

- 本轮取得了 3 份可评分输出：DeepSeek Flash 2 份、Relay Terra 1 份，**全部不合格（0/3）**。
- 另外 4 次 Relay 尝试均以 `provider_submission_outcome_unknown` 结束。系统无法确认上游是否已经接受请求，
  因而保留保守预算预约且不自动重试；这些尝试没有可评分输出。
- Relay Sol 只在第一题尝试一次；结果未知后没有在第二题继续尝试。Relay Luna 两题均已尝试，
  不是“只测了 Terra”。
- 由于 Relay 上游仪表盘把截图中的 4 次调用全部记作 `gpt-5.6-terra`，而项目实际请求包含
  Sol、Terra 和 Luna，本轮**不能验证中转实际执行了哪个模型**，也不能据此比较 Sol / Terra / Luna 的能力。
- 两道题现有流程仍未达到可用正确率。首要失败仍在最终规则推理，而不是答案排版；增加模型名称本身
  没有形成可信的质量改进。

## 题目与评分标准

### 1. `double-tempest-impermanence`

场上没有其他魔法、陷阱卡时，以《绚岚之达维》为对象发动《无限泡影》，对方能否连锁发动
《天雷之双风神》。

合格答案必须明确：**不能发动**。正在发动且处理后通常送去墓地的《无限泡影》不能被返回手牌，
场上又没有其他能够返回手牌的魔法、陷阱卡，因此后续必要处理在发动时无法满足。

### 2. `unchained-replacement`

《破械冥官·篁》要破坏《破械焰魔天·阎摩》时，《完美电子多元驱动蛇·神龙》能否降低 1000
攻击力代替破坏，以及《篁》之后能否特殊召唤。

合格答案必须同时明确：**可以适用代替破坏并降低 1000 攻击力；《阎摩》最终没有被破坏，
所以《篁》不能特殊召唤。** 对关键对象、处理顺序或因果关系描述错误也判为不合格。

## 本轮逐次结果

下表中的“项目费用”来自项目本地价格表和 Token 记录，只是**未由上游账单逐次验证的估算值**；
不能当作 Relay 实际扣费。`—` 表示没有取得可信数据，而不是数值为零。

| Case | 请求配置 | 状态 | Run / 快照记录 | 耗时 | Token | 项目费用估算 | 独立评分 |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| `double-tempest-impermanence` | DeepSeek Flash / `standard` / `none` / `single` | 成功返回；returned model 为 `deepseek-v4-flash` | Run `ab2625d7-25fa-46b6-9951-cc90cbb4382e`；Snapshot `evidence_025fd9d82bfde157ffb03d30` | 总计 57.488 s；证据准备 31.363 s；最终模型 26.125 s；provider 11.498 s | input 10,598；cached 3,072；uncached 7,526；output 1,521；total 12,119 | ¥0.01062944 | **不合格**：错误回答“可以发动”；首个失败阶段为规则推理 |
| `double-tempest-impermanence` | Relay Sol / `pro` / `high` / `single` | `OUTCOME_UNKNOWN`；`relay_http_error`；Cloudflare 524；禁止重试 | Run `4543d1e0-f8e7-4cca-b529-064326cec466`；Snapshot `evidence_92b17bc87916511c12e31ff6` | intent 2026-08-06 18:59:40.815Z；524 于 19:01:48Z | `usage: null` | — | 不可评分 |
| `double-tempest-impermanence` | Relay Terra / `pro` / `high` / `single` | 成功返回；实际上游模型身份未验证 | Run ID 与快照 ID 未从 UI 记录中取得 | 总计约 96 s；最终模型约 89 s | total 19,325 | ¥0.777647 | **不合格**：结论错误；首个失败阶段为规则推理 |
| `double-tempest-impermanence` | Relay Luna / `pro` / `high` / `single` | `OUTCOME_UNKNOWN`；`relay_http_error`；Cloudflare 524；禁止重试 | Run `fork_ad7f2626a9a9b8a3c45ed185cb3302aa161bc748` | intent 2026-08-06 20:33:19.927Z；524 于 20:35:27Z | `usage: null` | — | 不可评分 |
| `unchained-replacement` | DeepSeek Flash / `standard` / `none` / `single` | 成功返回；returned model 未从交接记录中取得 | Run `03f76550-ec17-48c8-b333-e45a21a2a4dc`；Snapshot `evidence_a121d3e70670601044834cd2` | 总计约 76.670 s；最终模型 35.225 s；provider 18.389 s | total 12,336 | ¥0.01175344 | **不合格**：最终结论不符合完整标准答案；评分阶段标记为规则推理 |
| `unchained-replacement` | Relay Sol / `pro` / `high` / `single` | 未发起；第一题提交结果未知后停止 | — | — | — | — | 不可评分 |
| `unchained-replacement` | Relay Terra / `pro` / `high` / `single` | `OUTCOME_UNKNOWN`；`relay_http_error`；Cloudflare 524；禁止重试 | Run `fork_f66a87a787bf938598dd70c7b8f5daec89d34b4e` | intent 2026-08-06 21:28:41.492Z；524 于 21:30:49Z | `usage: null` | — | 不可评分 |
| `unchained-replacement` | Relay Luna / `pro` / `high` / `single` | `OUTCOME_UNKNOWN`；`relay_http_error`；Cloudflare 524；禁止重试 | Run `fork_eed4d996dd3abd5323bf5a8f6a86d3882e72b27b` | intent 2026-08-06 21:31:48.142Z；524 于 21:33:56Z | `usage: null` | — | 不可评分 |

这里没有把较早的 `fork_238108e4e99110f77cb82f5da4c8350429bfbdd2` Terra 输出或
`791b1cb7-1262-4b47-a776-4550b26b521f` DeepSeek 输出混入本轮矩阵；它们属于历史运行，
不能替代本轮缺失或失败的请求。

### Production 传输审计

Production 持久化记录补齐了上述四次未知提交。四条记录的 `providerSubmission.state` 均为
`OUTCOME_UNKNOWN`，错误类型均为 `relay_http_error`，上游错误页均为
`986310.xyz | 524: A timeout occurred`：

| Case / 请求配置 | Run ID | intent（UTC） | 收到 524（UTC） | usage |
| --- | --- | --- | --- | --- |
| 双风神 / Sol | `4543d1e0-f8e7-4cca-b529-064326cec466` | 2026-08-06T18:59:40.815Z | 2026-08-06T19:01:48Z | `null` |
| 双风神 / Luna | `fork_ad7f2626a9a9b8a3c45ed185cb3302aa161bc748` | 2026-08-06T20:33:19.927Z | 2026-08-06T20:35:27Z | `null` |
| 破坏替代 / Terra | `fork_f66a87a787bf938598dd70c7b8f5daec89d34b4e` | 2026-08-06T21:28:41.492Z | 2026-08-06T21:30:49Z | `null` |
| 破坏替代 / Luna | `fork_eed4d996dd3abd5323bf5a8f6a86d3882e72b27b` | 2026-08-06T21:31:48.142Z | 2026-08-06T21:33:56Z | `null` |

`usage: null` 表示没有取得可核对的用量，必须显示为“未知”，不能按 0 Token 或零费用处理。524
也不能证明上游没有接收或执行请求；因此四次均禁止自动重试，以免重复运行和重复计费。

## Relay 计费与模型身份审计

用户提供的 Relay 上游仪表盘截图在截取时显示：

- 调用次数：**4**；
- 模型标签：4 次全部为 **`gpt-5.6-terra`**；
- Token 合计：**122,852**；
- 金额合计：**$0.1062**。

这些是上游仪表盘的**聚合值**，截图没有提供能够与本报告各 Run 一一对应的请求 ID 或逐次账单。
它与项目侧记录存在以下无法消解的口径差异：

1. 项目请求配置包括 Sol、Terra、Luna，但上游 4 次调用全部显示为 Terra。
2. 项目逐次 Token 与费用来自 API 返回字段及本地价格表；仪表盘只给出 4 次调用的聚合 Token
   和美元金额，无法逐次对账。
3. `provider_submission_outcome_unknown` 只表示客户端无法确认提交结果，不表示上游一定没有接收、
   运行或计费。

中转令牌分组另显示 **0.27× 倍率**。这基本解释了项目按 1.0× 静态价格估算为何高于后台：
以本轮 Terra 的本地估算为例，¥0.777647 按项目使用的 7.5 汇率约为 $0.103686；应用 0.27× 后约为
$0.027995。若只为理解量级而假设 4 次调用费用相近，则约为 $0.11198，与仪表盘聚合的 $0.1062
接近。这是费率倍率对差异的合理解释，**不是精确逐次对账**：四次请求的逐次 usage 缺失，缓存、
折扣和各次输出长度也可能不同，不能从聚合值反推出每次实际费用。

这里的人民币与美元也不是两笔重复收费。人民币数值是项目本地静态估算，美元数值是该估算按汇率
换算后的同一金额；真正可作为中转聚合扣费依据的仍是仪表盘显示的 $0.1062。

因此，报告中的 requested model 只代表**项目请求的路由配置**：requested model 是管理实验室选择的
别名，submitted model 才是请求体发送的 canonical 值，reported model 仍只是 API 响应的自报字段，
dashboard-attributed model 则是上游仪表盘的第四种外部归因。四者都不能互相推导，也不能单独证明
真实上游模型。项目表中的人民币逐次费用只是不经上游验证的估算，不是实际账单。当前唯一可引用的 Relay
账单事实是上述截图聚合值。除非中转提供带请求 ID、实际模型、逐次 Token 和逐次金额的可核对日志，
否则不能计算每个 Sol / Terra / Luna 请求的真实成本或准确率，也不能声称已经验证了这些模型的身份。

## 公平性与数据边界

- DeepSeek 成功输出和 Relay 尝试没有全部留下可核对的相同 Snapshot ID；第一题 Sol 记录的 Snapshot
  与成功 DeepSeek Run 的 Snapshot 也不同。因此本轮不满足严格的“同一冻结快照下完整模型矩阵”条件。
- Relay 的 4 次未知提交失败没有返回可评分答案。把它们按错误答案计入模型正确率或按成功调用计入
  速度统计都不合理。
- 成功样本只有 3 份，且 Relay 实际模型身份未验证；本轮只能定位系统问题，不能形成模型排名或
  具有统计意义的正确率结论。
- 标准答案仅用于事后独立评分；具体卡名和正确答案没有被写入生产分支逻辑，也没有添加单题特判。

## 后续处理

1. 本轮已经停止，不对提交结果未知的请求重试，也不继续付费扩大矩阵。
2. 在再次测试 Relay 前，要求中转返回或提供可对账的 request ID、实际模型 ID、逐次 Token 与费用；
   否则只把它当作身份未验证的单一 Relay 服务，不再把 Sol / Terra / Luna 当作三个可信模型比较。
3. 保留 DeepSeek 与 Relay 的失败输出作为回归案例，优先检查最终提示词能否让模型识别“必要后续处理
   在发动时必须可执行”和“代替破坏后原卡没有被破坏”这两类通用机制，但不得按卡名写特殊分支。
4. 关闭 Production 管理实验室；历史管理记录只在确认清理范围后按 dry-run 审计，不执行破坏性清理。
