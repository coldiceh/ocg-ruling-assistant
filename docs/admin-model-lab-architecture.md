# 管理模型实验室架构

## 目标

管理模型实验室用于在不改变公开问答路径的前提下，对同一问题、同一证据条件下的 GPT-5.6、DeepSeek、GLM、Kimi 模型和推理档位进行可复现实验。

公开路径仍为：

`公开页面 → /api/answer → 现有 DeepSeek RAG`

管理实验路径为：

`管理员登录 → DeepSeek V4 Flash 准备检索提示 → 完整检索并冻结 Evidence Snapshot → 选定模型独立裁定 → 确定性校验 → 保存结果与计量`

关键约束：

- 资料准备阶段固定使用 DeepSeek V4 Flash；它的准备输出不能替最终模型给出裁定，也不能决定是否升级。
- 国产模型只在隔离后台充当实验最终模型，服务器强制标记为 `experimental_non_authoritative`、仅管理员可见且不可进入公开回答。
- OpenAI Key 可用时仍可选择允许列表中的 GPT-5.6；没有 OpenAI Key 时实验室可只运行国产模型。
- 便宜模型不能静默删除候选；未解析卡名、歧义候选、冲突资料和原始检索结果都必须进入快照。
- Evidence Snapshot 创建后不可变，以内容哈希标识。
- 最终结果必须通过严格 JSON Schema 和语义校验；不使用第二个模型润色，也不修补宽松 JSON。
- 管理实验路径不调用另一个游戏模拟器项目，不因模拟器缺席返回 UNKNOWN。
- `?admin=1` 只显示界面，不代表认证成功。

## 默认关闭与付费调用边界

管理实验室在没有显式配置时保持关闭：

```text
ADMIN_MODEL_LAB_ENABLED=false
ADMIN_OPENAI_ENABLED=false
```

仓库中的默认检查、单元测试和离线题集只使用 Mock 或本地资料，不调用付费模型。现阶段不会为了发布验证自动发起真实 DeepSeek、GLM、Kimi 或 OpenAI 请求。国产模型实验只需显式打开 `ADMIN_MODEL_LAB_ENABLED` 并设置相应服务端密钥；只有选择 GPT-5.6 时才需要再打开 `ADMIN_OPENAI_ENABLED` 并设置 `OPENAI_API_KEY`。可复制的安全起始配置见仓库根目录 `.env.example`。

## Run 生命周期

Run 使用以下状态：

- `QUEUED`
- `RUNNING`
- `CANCEL_REQUESTED`
- `CANCELLED`
- `SUCCEEDED`
- `FAILED`

服务端保存递增事件序号。客户端断线后使用 `afterSequence` 恢复，不依赖浏览器本地计时推断真实状态。

浏览器会把当前 `runId` 保存到会话存储中。刷新页面后会重新打开该 Run；若仍为 `QUEUED`，或为没有提交记录且执行租约已经缺失/过期的 `RUNNING`，才会重新触发执行。活跃租约、`SUBMITTING`、`SUBMITTED` 和 `OUTCOME_UNKNOWN` 都禁止前端重提；但服务端轮询会对租约已过期的 `SUBMITTING` 做安全接管，将其收敛为 `OUTCOME_UNKNOWN` 失败，而不会再次创建上游请求。该规则同样适用于 `CANCEL_REQUESTED`。

服务端使用持久化 execution epoch、带过期时间的租约和哈希执行令牌进行 fencing。只有当前租约持有者能推进阶段或冻结证据；准备、创建、轮询与取消等长操作期间周期续租，并把 fencing 失败通过 `AbortSignal` 传给请求层。创建上游请求前必须先以 CAS 写入 `SUBMITTING`。如果网络错误、408、429 或 5xx 使“上游是否接受”无法确定，或上游已接受但请求编号未能持久化，Run 会进入明确的 `OUTCOME_UNKNOWN` 失败状态，后续不会自动重新付费提交；只有能证明请求未被接受的 4xx 才记录为 `REJECTED`。

创建 Run 成功但历史索引登记失败时，接口仍返回已创建的 `runId` 和有界登记状态；后续读取、执行、取消、回放、评分或导出会幂等补登记。因此历史登记故障不会再用 500 隐藏已经存在的 Run。

这里的“恢复”仍然不是独立的持久任务队列，也没有事务型 outbox。它需要浏览器或运维请求再次触发执行，因此无人重新触发时不会自行续跑。若客户端在收到首次创建响应和 `runId` 前断线后主动重发 create，在没有客户端幂等键或 Run Store 持久 outbox 的情况下仍不能保证跨请求 exactly-once。文档与界面不得宣称“进程丢失后一定自动恢复”。

固定顶层阶段：

1. `understand`
2. `extract_card_names`
3. `retrieve_card_texts`
4. `retrieve_rulings_evidence`
5. `generate_ruling`

阶段可以重叠，总耗时是墙钟跨度，不是各阶段耗时之和。10 秒与 30 秒只产生 `FAST`、`NORMAL`、`SLOW` 统计标签，不触发取消。

## 应用限制

管理实验阶段默认不启用应用层运行时间、Token、费用或并发限制：

```text
ADMIN_MODEL_LAB_LIMITS_ENABLED=false
```

各限制缺省值必须为 `null`；`null` 不得解释为 0。即使限制关闭，仍完整记录 Token、费用、阶段耗时和总耗时。

## 持久化

生产环境使用 Upstash/KV Redis REST：

- 会话仅保存随机会话 Token 的哈希。
- Run 状态与对应事件使用 revision CAS 原子提交；成功、失败、取消及最终阶段快照一次提交。
- 事件使用连续 sequence，可按游标重放。
- Evidence Snapshot 以内容寻址的独立 Redis 键保存并在写入、缓存和读取时校验 ID、哈希及 canonical 内容；Run 状态只保存引用，阶段 CAS 不再重复上传完整归档。
- 新快照先以 300 秒候选 TTL 暂存；只有 Run CREATE/COMMIT 成功后才转为正式 TTL 或永久键，因此 CAS 失败不会留下永久孤儿。
- 执行租约、epoch 和上游提交状态持久化；仅保存执行令牌的 SHA-256，不保存原始令牌。持久模式使用 Redis `TIME`，不依赖各应用实例可能偏移的本地墙钟。
- 历史 record、rating 与全局索引键共享同一 Redis Cluster hash slot；已确认登记的记录若后来缺失，导出和评分会强制重新登记。
- Run TTL 默认不配置；运行限制关闭不能隐式删除记录。
- 历史导出在下载时按 `runId` 读取对应 Run，并包含最终 `result`、`evidenceSnapshotId` 和两阶段 `metering`；历史索引本身仍只保存安全摘要，避免重复保存大型结果。

生产缺少 Redis 配置时失败关闭。仅当使用 `backend/server.mjs`、运行环境不是 production/Vercel、监听地址是本机回环地址，并且没有显式配置 Run/历史存储时，才启用代码级隔离的本地开发内存组合；环境变量不能让生产工厂降级为内存。

## 最终模型资料边界

- 完整候选、完整正文、完整冲突与所有原始 ID 保存在冻结归档和审计 sidecar。
- 给最终裁定模型的决策资料包默认硬限制为 120 KiB（按 UTF-8 JSON 字节计算），卡文/FAQ 正文、等价 ID、遗漏目录和冲突目录分别有独立上限。
- 包含题面、已解析卡片字段、资料包及外围元数据在内的最终模型输入另有 512 KiB UTF-8 总字节硬边界；超出时失败关闭，不发送截断后可能改变语义的请求。这是输入安全边界，不是 Token、费用或运行时间预算。
- 异常长 ID 使用可追溯的 SHA-256 别名；资料包保存完整数量、完整清单哈希和截断标志。
- 最终校验只允许引用资料包中实际可见的 ID；正文被节选的资料不能声明为“直接官方完整蕴含”。
- DeepSeek 补充检索词只能在确定性结果之后追加，不能重排确定性证据前缀。

管理实验默认不设置应用层预算、运行时长或 DeepSeek 输出 Token 上限；模型自身能力、上游接口限制和托管平台执行时限仍然存在，不能表述成基础设施层面的“无限”。

管理接口的请求正文按 UTF-8 字节计最多 256 KiB。本地 Node 适配器在读取流时即停止继续缓冲；Serverless 适配器也会在解析后、调用服务前校验。这是防止异常请求耗尽内存的接口安全边界，不是模型实验额度。
