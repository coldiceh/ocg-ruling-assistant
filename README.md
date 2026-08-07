# 游戏王 OCG 规则助手

这是一个面向 OCG 游戏王玩家的规则分析助手。项目通过检索卡片文本、卡片信息、公开规则资料和官方公开资料，构造可追踪的 RAG 上下文，再由大语言模型生成裁定分析。

本项目的目标是帮助用户整理问题、查找依据、给出分析思路和风险提示，而不是替代官方裁定或现场裁判。

## 项目简介

用户可以输入一个 OCG 裁定问题，例如卡片发动、连锁处理、效果适用、攻击宣言、处理时状态变化等场景。系统会尝试识别问题中的卡名和关键上下文，检索相关资料，并输出：

- 结论
- 理由
- 引用来源
- 风险提示
- 需要补充的信息

如果用户粘贴了未发售卡或数据库暂未收录卡片的完整效果文本，系统也可以基于用户提供的文本进行未确认分析。

## 工作原理

整体流程如下：

```text
用户输入问题
↓
卡名识别
↓
获取资料：
- 卡片文本
- 卡片信息
- 官方资料
- FAQ
- 公开规则书资料
↓
按段落检索规则书，并由轻量模型逐步绑定规则引文
↓
（已配置相邻引擎时）从资源锁中的旧 Lua 自动提取
操作、发动合法性依赖和底层 API 检查项
↓
归档完整 Evidence Archive
↓
确定性投影 Evidence Packet schema v2
（默认最多 28 KiB / 16 项）
↓
在 48 KiB 最终输入硬边界内由 LLM 生成裁定分析
↓
展示：
- 结论
- 理由
- 来源
- 风险
```

系统会区分不同证据来源的可信度。官方直接问答可以支持较高置信的结论；卡片文本、FAQ、相关资料和用户提供文本可以支持裁定分析，但不能被表述为官方确认。

旧 Lua 只是一条自动生成的兼容性发现旁路：它可以提醒模型某个效果含有
`RETURN_TO_HAND`、`CARD_CAN_RETURN_TO_HAND` 等操作或合法性依赖，但正式
`verdict` 永远是 `UNKNOWN`，不能被引用为官方资料，也不能直接决定“能/不能”。
脚本缺失、未知 API、超时、超限或版本/哈希不一致都会显式降级为 typed
`UNKNOWN`；多卡问题中单张脚本失败不会丢掉其他卡已经验证的语义候选。
冻结快照保留完整 Lua 审计包，最终模型只接收最多 8 KiB 的有界投影；源码、AST
和 source span 不进入模型输入。投影中的 `candidateVerdict` 只能作为待核查线索，
不能升级正式 `verdict`，也不能充当可引用的 evidence ID。

管理实验使用两层证据结构：完整、内容寻址的 Evidence Archive 保存检索器提供的
全部候选出现、正文、包装元数据、冲突与哈希；模型可见的 Evidence Packet schema
v2 则按固定的权威性与机制相关性顺序确定性选取，默认上限为 28 KiB 和 16 项。
最终裁定输入还有独立的 48 KiB UTF-8 硬上限。历史快照若保存的是旧版大 Packet，
系统不会修改原快照，而是从其中已经冻结且通过完整性校验的 Archive 按当前策略
重新投影，因此旧的约 80 KiB Packet 仍可在当前边界内用于 fork。

公开页面还会按裁定模型显示最近 20 次成功回答的真实平均耗时。统计使用可选的
Upstash Redis；未配置、没有样本或存储失败时会明确显示不可用，不会捏造数字，
也不会阻塞主回答。

## 管理模型实验室

公开问答由 DeepSeek V4 Flash 准备检索证据，并默认由 DeepSeek V4 Flash（思考 high）生成最终裁定；公开主页面不再提供 GLM 5.2、Kimi 或第三方中转选项。GLM、Kimi 与第三方中转 GPT-5.6 Sol/Terra/Luna 只保留在隔离的管理模型实验室中，中转结果始终标注“模型身份未验证”；设置中转 key 不会注册公开 profile，也不会改变公开默认模型。旧的 `PUBLIC_RULING_MODEL_PROFILE=glm-5.2-high` 不会被静默映射到 DeepSeek，部署时必须删除该变量或明确改为 `deepseek-v4-flash-high`，否则公开配置会 fail-closed。公开 API 继续受 `API_DAILY_BUDGET_CNY` 总池约束；管理实验中的 DeepSeek 证据准备和各模型最终调用另受持久化 `ADMIN_FINAL_BUDGET_*` 账本约束。DeepSeek Flash/Pro 共用 `DEEPSEEK` 日池；Relay Sol、Terra、Luna 分别使用 `RELAY_SOL`、`RELAY_TERRA`、`RELAY_LUNA`，不是一个共享 Relay 池。这些额度不会增加或替代公开额度。中转的临时本地配置和安全边界见 `docs/relay-provider.md`。

管理员明确批准付费模型实验不受项目日额度限制时，可仅在服务器环境设置
`ADMIN_MODEL_LAB_BYPASS_DAILY_BUDGET=true`。该开关默认关闭，只作用于已鉴权的管理实验室，
不改变公开 API 的 `API_DAILY_BUDGET_CNY`。开启后，证据准备、primary 和 directed repair
不占用 `ADMIN_FINAL_BUDGET_*` reservation，但仍保留供应商返回的 Token、真实耗时和费用记录；
Relay 费用仍是未验证估算，最终扣费以供应商后台为准。这是短期实验开关，实验结束后应恢复为 `false`。

付费最终请求前还会运行 `productionReadiness`：每个已发现的候选卡名必须唯一绑定
到稳定身份，并且对应完整、未节选的卡文确实出现在模型可见 Packet 中；未解析、
歧义、被省略、卡文缺失或卡文被截断都会在 provider transport 之前 fail-closed。
这是资料完备性门禁，不是裁定引擎，也不会把缺资料解释成“不能发动”。

DeepSeek 证据准备只有一个窄恢复例外：若 provider 已明确返回 HTTP 200，但内容为空
或不是合法 JSON，系统可再提交一次专用 JSON 恢复请求。恢复请求有独立 attempt、
预算预约、usage 与审计记录；第二次失败不会触发第三次。网络错误、超时、取消、
HTTP 400、429 或 5xx 均不走该内容恢复路径，以免在提交结果不明确时重复收费。

管理实验室的额度卡现在分开显示“实际结算”和“保留预约”。前者只统计收到可靠
usage 后按版本化费率结算的费用；后者是提交结果未知或计费信息不完整时暂时保留的
预算占用，不能当作供应商账单。`usedCny` 继续表示两者合计的账本占用，以保持旧接口
兼容；实际扣费仍须以相应供应商后台为准。

隔离的管理实验路径用于在冻结证据下比较其他模型配置，不会改变公开问答选择。它默认关闭，默认测试也不会调用付费模型。部署、安全配置和当前进程恢复边界见：

- `docs/admin-model-lab-architecture.md`
- `docs/admin-auth-security.md`
- `.env.example`

同一组模型分叉会复用内容哈希一致的 Evidence Snapshot，其中 Evidence Archive、
schema v2 Decision Packet 与 Lua 语义包均只在源运行生成一次。模型看到的是同一份
有界投影；完整候选和 Lua 审计资料只保留在冻结快照中。这样可以比较模型本身的
裁定差异，而不是让每个模型拿到不同资料。第三方 Relay 只用于管理员明确发起的
实验，并分别记录项目别名 `requestedModel`、请求体中的 canonical
`submittedModel` 和响应自报的 `reportedModel`；中转控制台的模型归因属于第四个
外部口径。任何一个字段都不能单独证明真实上游模型，缺失或不一致时实验结果会
fail-closed，也不会自动切换公开默认模型。Relay 费用始终标为未验证估算；当前令牌组
截图中的 `0.27x` 倍率会进入版本化估算，但实际扣费仍以中转后台为准。Relay 最终裁定
现在默认使用 SSE，并分别记录响应头、首字节、首个有效事件、首个可见正文及完成耗时；
隐藏推理增量只消费、不保存。流中断仍标记为提交结果未知并禁止自动重试，朋友的反向
代理也必须关闭响应缓冲并及时 flush，否则仅设置 `stream: true` 仍可能收到 524。

管理员矩阵还支持 `full`、`card_text_only`、`without_lua` 三种通用 Evidence 视图。
它们复用同一冻结 Snapshot；标准答案只用于调用后的评分，不进入模型输入。由此可以分别
测量“完整流程相对仅题面和准确卡文的收益”以及 Lua 语义包的增量价值，而无需添加卡名、
题目 ID 或 passcode 特判。

完整 Snapshot 的新写入采用确定性 gzip+base64；旧裸 JSON 保持可读，但不会自动
迁移、压缩或删除。Upstash 容量告警的原因与只读审计方法见
`docs/upstash-storage-audit.md`。

## 相邻规则引擎

引擎项目通过六个版本化端点提供 Legacy Lua 静态发现：capabilities、card-identities、
source、effect-candidates、compile-plan 和 analyze-activation。助手会闭合校验资源锁、脚本
SHA-256、版本、能力清单与 Lua API 语义注册表，并限制卡数、候选数、响应字节和总
耗时。详细的本地、Windows 服务与 Cloudflare Tunnel 步骤见：

- `docs/ocg-engine-integration.md`
- `docs/ocg-engine-quick-tunnel.md`

助手已支持版本化 manifest、按 CID/passcode/精确别名索引及按题懒加载 shard 的 v2
静态 Lua 缓存。仓库只有在离线构建并提交
`data/legacy-lua-semantic-cache-v2/manifest.json` 与对应 shards 后才会启用它；未生成完整缓存时不会
退回少量测试卡 PoC，而是显式降级为 typed `UNKNOWN`。可先用
`pnpm run build:legacy-lua-cache -- --plan-only` 只生成规模与耗时估算，再在 CI/离线单进程中执行完整构建。
完成预编译后，本地电脑关机也不会让线上助手丢失已编译卡片的语义；实时内核只处理静态未命中、
新卡或脚本版本变化，以及必须运行对局状态的动态模拟。

### 本地一键联调

当本仓库与 `游戏王游戏引擎` 目录相邻，且引擎已经执行过一次
`pnpm run setup:local` 后，在本仓库运行：

```powershell
pnpm run dev
```

同一个终端会启动并管理规则引擎（8790）、问答后端（8787）和本地网页
（4173），网页地址为 `http://127.0.0.1:4173/`。本地静态服务器会在内存中
注入后端地址，不会改写 `config.json`。未显式设置 `OCG_ENGINE_TOKEN` 时，启动器
会生成仅供这次进程使用的随机 token，并同时交给引擎和后端；它不会显示或写入
文件。按一次 `Ctrl+C` 即可关闭这次启动器创建的全部进程。

若要临时在管理模型实验室测试第三方中转，并让启动器安全提示输入中转 Base URL、
key 和本地管理密码，只需运行：

```powershell
pnpm run dev:relay
```

中转 Base URL、key、DeepSeek key 和管理密码只存在于这次 PowerShell 及其后端子进程；不会
传给浏览器静态服务器或规则引擎，也不会改写公开模型默认值。启动时若缺少
`RELAY_BASE_URL` 会先询问朋友提供的 HTTPS `/v1` 地址；若缺少 `DEEPSEEK_API_KEY`，
会用隐藏输入框安全询问；管理实验始终由 DeepSeek 准备冻结证据，
不会伪装成本地资料降级。
启动器会为本地开发账本设置 Relay Sol、Terra、Luna 各自独立的 10 元日池、每次
5 元保守预约和 8192 completion-token 上限；DeepSeek Flash/Pro 共用 10 元日池，
每次预约 2 元。可靠 usage 会按版本化费率结算并释放差额；无 usage、无定价、超时或
确认不完整时保留预约。DeepSeek V4 的分模型费率按 2026-08-06 官方页面配置；中转
截图费率和 7.5 的预算换算因子仍不是供应商账单或实时汇率，付费前须重新核对并在
供应商侧设置硬限额。启动后访问
`http://127.0.0.1:4173/?admin=1`。4173 或 8787 已被旧进程占用时，启动器会在启动
新进程前明确报错，避免留下半启动的服务。8790 上已有 profile 一致且 token 匹配的
健康引擎时会安全复用，否则拒绝连接到错误内核。

## 数据来源

项目使用公开可访问资料构造检索上下文，包括：

- 百鸽卡片资料
- 公开卡片文本与卡片信息
- 官方公开资料
- 官方公开 Q&A / FAQ
- OCG Rule 等公开规则学习资料
- 用户在问题中提供的卡片文本

项目不会把用户提供文本或第三方卡片资料标记为官方直接裁定。

## 未来计划

- 模拟器验证：继续把范式化卡文编译为声明式卡片语义
- 扩展统一状态转移内核、时点/连锁/替代处理与效果实例生命周期
- 用冻结证据模型实验和真实问题集记录“第一处失败阶段”
- 支持日文版本
- 支持 TCG 版本

## Disclaimer

本项目不是 KONAMI 官方项目。

本项目输出不代表官方裁定。AI 生成内容可能存在错误、遗漏或误判。

正式比赛、店赛和官方活动中的裁定，请以官方规则、官方数据库、赛事主办方和现场裁判为准。

本项目不声称替代裁判，也不声称任何结论 100% 正确。
