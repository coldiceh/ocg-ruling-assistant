# 四题本地 Evidence Snapshot dry-run

这个工具只回答一个前置问题：在付费最终模型调用之前，本地流程是否已经把题目中的
全部候选卡解析出来，并把完整卡文放进最终模型实际可见的冻结资料包。

每题快照同时保存完整、内容寻址的 Evidence Archive 和确定性模型投影。新投影采用
Evidence Packet schema v2，默认最多 28 KiB、16 项；最终模型输入另有 48 KiB UTF-8
硬上限。完整 Archive 不因投影省略或节选而丢失候选，旧快照中的大 Packet 也可在不
改写历史快照的前提下从已验证 Archive 确定性重投影。

默认模式不会调用真实模型、不会联网、不会读取当前进程里的 API key，也不会评价答案正确率。
四道题的题面与候选卡位于独立 cases fixture；标准答案和泄漏探针位于另一份 golden
fixture。runner 与 CLI 从不加载 golden fixture。

运行：

```powershell
node scripts/admin-evidence-snapshot-dry-run.mjs
```

只运行一个 case：

```powershell
node scripts/admin-evidence-snapshot-dry-run.mjs --case <case-id>
```

如果本机内核已经启动，可显式加入实时 Legacy Lua 结构化摘要：

```powershell
$env:OCG_ENGINE_TOKEN = "与本地内核一致的临时 token（未启用鉴权时可不设）"
node scripts/admin-evidence-snapshot-dry-run.mjs --engine-url http://127.0.0.1:8790
```

`--engine-url` 只接受 `http://127.0.0.1:<port>` 或
`http://localhost:<port>`，拒绝 HTTPS、远程主机、URL 凭据、路径、查询参数和片段，
并禁止 HTTP 重定向。未提供该参数时仍固定生成
`LOCAL_DRY_RUN_LUA_UNAVAILABLE`。即使连接本地内核，Legacy Lua 的正式 verdict 也必须保持
`UNKNOWN`；它只作为非权威辅助摘要进入冻结资料包。
完整 Lua 审计包保留在快照中；最终输入只包含最多 8 KiB 的模型投影，且不含源码、
AST 或 source span。投影内的 `candidateVerdict` 不会升级正式 `verdict`，也不能成为
可引用证据。

需要同时核验社区卡名时可额外加入 `--allow-community-card-network`。该开关只允许匿名
GET 到 `https://ygocdb.com/api/v0/`，不会开放最终模型传输。

输出逐题记录：

- 已解析卡片与卡片 ID；
- 未解析卡名、缺失或被截断的模型可见卡文；
- FAQ、机制规则和最终可见证据数量；
- Evidence Archive 的候选类别计数，以及 schema v2 Packet 的项目数；
- Legacy Lua 的 typed 状态、候选数量和序列化字节；
- Lua 来源模式（不可用或显式注入的本地内核）；
- Evidence Snapshot 的 ID、SHA-256、字节与冻结状态；
- 最终模型输入的 SHA-256 与字节；
- 证据准备、Lua、快照生成和本地付费门的阶段耗时；
- 是否被付费门阻止，以及任何潜在外部 fetch 是否被 sentinel 拦截。
- `productionReadiness` 的候选总数、未解析/歧义/省略项及缺失/节选卡文。

报告区分 fixture inspection 和与真实管理运行共用的 `productionReadiness` transport
门禁；只有两者都 ready，`paidGateBlocked` 才为 `false`。门禁规则是通用的，不含
卡名、题号或答案分支。每张候选卡必须满足以下一种情况：

1. 唯一绑定到本地卡库记录，并且其未截断卡文实际出现在最终模型可见
   `evidenceDecisionPacket`；
2. 题面明确给出带卡名绑定的完整卡文，并且该未截断文本实际出现在最终模型可见资料包。

任何候选卡未解析、绑定有歧义、卡文缺失或卡文被截断时，sentinel 都会在真实
provider transport 之前抛出 `admin_dry_run_paid_gate_blocked`。这代表“资料不完整，
禁止开始付费测试”，不代表该卡不能发动，也不代表最终裁定为否。

本地卡库的唯一近似名称匹配不自动视为稳定身份验证。遇到译名差异时，离线模式可能
有意 fail-closed；`--allow-community-card-network` 只允许百鸽匿名只读身份请求核对
CID/passcode，仍不会开放模型 transport、携带 API key 或产生模型费用。

dry-run 不测试 DeepSeek 内容恢复。真实管理运行中，只有证据准备已确认收到 HTTP 200
且内容为空或非法 JSON 时，才允许一次独立预算的恢复；网络错误、超时、取消、400、
429、5xx 和恢复请求再次失败都不重试。

测试：

```powershell
node --test tests/admin-evidence-snapshot-dry-run.test.mjs
```

测试还会检查标准答案与 `leakCanary` 没有进入快照或最终输入，并扫描 helper/CLI
源码，确保没有四道题的卡名或 case ID 特判。
