# Upstash Admin Run 安全清理

Admin Model Lab 使用两套相互独立的数据：

- Admin Run 保存完整运行状态、事件和 Evidence Snapshot；默认键前缀是
  `admin-runs:v1`，通常也是存储占用的主要来源。
- Admin Lab History 保存轻量历史索引；默认键前缀是
  `admin-lab-records:v1`。

清理工具只会读取 History，并且只会删除 Admin Run 前缀下经过验证的精确键。
它不会删除或修改 History、问题审计、会话、预算账本或公开回答耗时数据。

## 保留和丢失的内容

只有对应 History record 已存在且包含非空 `questionSummary` 的 Run 才能成为
候选。History 中的问题经过空白归一化，最多保留 500 个字符，并不等于完整
题面备份。

执行清理后仍保留：

- History 列表中的问题摘要、创建时间和模型配置；
- 人工评分及当前轻量 repair provenance；
- Snapshot/Decision Packet 的 ID 和哈希。

执行清理后不再保留：

- 完整题面和 Evidence Snapshot；
- 最终回答、完整计量和阶段计时；
- Run state 和事件回放；
- 从已删除 Run 重新打开详情或创建新 fork 的能力。

因此，这个工具不是备份工具。需要完整题面或完整实验复现时，不应执行删除。

## 只读 dry-run

`--older-than-days` 必须显式提供，即使只是 dry-run：

```powershell
pnpm run cleanup:upstash-admin-runs --older-than-days 14
```

默认模式只会发出 `SCAN`、`TYPE`、`GET`、`MEMORY USAGE` 和必要时的
`STRLEN`。输出不包含 Redis URL、token、原始 key、runId、问题文本、state
或 Snapshot 值；只显示不可逆指纹、计数、已知字节数、保护关系和跳过原因。
输出中的 `planFingerprint` 是本次候选集合、精确键集合、state/History 版本和
整个 Admin Run 命名空间键集合的 SHA-256 审批指纹，不包含原始值。执行时
必须逐字复制这个指纹；计划发生任何变化都会拒绝删除。

候选必须同时满足：

- 状态为 `SUCCEEDED`、`FAILED` 或 `CANCELLED`；
- `endedAt` 和 `updatedAt` 都早于显式阈值；
- state 的 schema、runId、revision、sequence、Snapshot ID 和时间格式有效；
- 没有尚未过期的执行租约；
- state、events 和当前 Snapshot 精确存在且类型正确；
- current 或 legacy Admin Lab History record 存在，并含不超过 500 字的非空
  `questionSummary`；
- Snapshot 引用图完整、无环。

任意未知 Admin Run 键、损坏的 Snapshot 引用、缺失目标或超过安全上限都会
fail-closed，阻止整份计划执行。

默认硬上限：

- 待删 Run：25；
- 待删精确键：250；
- 已知字节数：128 MiB；
- SCAN 键数：20,000。

可以用 `--max-runs`、`--max-keys`、`--max-known-bytes` 和
`--max-scan-keys` 收紧或调整；超过上限只会得到被阻止的计划。

## fork 引用保护

fork 的 Snapshot 键可能只是对源 Run 完整 Snapshot 的轻量引用。工具会扫描
全部 Admin Run Snapshot 键并构建引用图。只要某个不在删除计划中的 Run 仍
引用一个完整 Snapshot，该完整 Snapshot 及引用链就不会被删除；源 Run 的
state/events 可以删除，但受保护 Snapshot 会暂时留下。

当前数据模型没有跨 Redis hash slot 的反向引用计数或全局删除锁。因此执行
期间必须暂停 Admin Model Lab 的新建和 fork，避免 dry-run 后出现新引用。

## 不可逆执行

先把 Production 的 `ADMIN_MODEL_LAB_ENABLED` 暂时设为 `false` 并重新部署，
确认管理实验 API 已不可创建或 fork Run，再等待正在运行的实验结束。不要只关闭
浏览器页面，因为其他标签页或请求仍可能写入 Redis。随后重新运行一次 dry-run。
确认计划后，必须同时提供执行开关、dry-run 指纹和精确确认短语：

```powershell
pnpm run cleanup:upstash-admin-runs --older-than-days 14 `
  --execute `
  --plan-fingerprint "<上一次 dry-run 输出的 planFingerprint>" `
  --confirm "DELETE TERMINAL ADMIN RUN DATA DURING MAINTENANCE"
```

执行器会在每个 Run 删除前：

1. 再次读取并逐字节比较 History record；
2. 确认整个 Admin Run 命名空间键集合仍与已审批计划一致；
3. 通过同一 Redis Cluster slot 的 Lua 事务，逐字节 CAS 当前 state；
4. 确认计划中的每一个精确键仍存在；
5. 只删除该事务显式列出的 state、events 和未受保护 Snapshot；
6. 校验实际删除键数，并再次确认 state 已消失且 History record 原样保留。

任一 Run 在计划后发生变化、History 消失或精确键缺失时，工具立即停止，不会
对该 Run 做部分删除。不同 Run 无法跨 slot 组成一个原子事务，因此先前已经
成功删除的 Run 不能自动恢复。

清理完成并核对 Upstash 容量后，再把 `ADMIN_MODEL_LAB_ENABLED` 恢复为 `true`
并重新部署。清理功能保持 CLI-only；不要把它接成公网或管理网页删除接口。

## 配置

工具沿用服务端现有环境变量，不接受命令行 URL 或 token：

- `ADMIN_RUN_REDIS_REST_URL` / `ADMIN_RUN_REDIS_REST_TOKEN`；
- `ADMIN_LAB_RECORD_REDIS_REST_URL` /
  `ADMIN_LAB_RECORD_REDIS_REST_TOKEN`；
- 未单独配置时，使用现有 `UPSTASH_REDIS_REST_*`、`KV_REST_API_*` 或
  `REDIS_REST_API_*` 回退。

不要把凭据写入命令参数、日志、截图或仓库。
