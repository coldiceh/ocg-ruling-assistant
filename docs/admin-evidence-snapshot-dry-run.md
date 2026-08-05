# 四题本地 Evidence Snapshot dry-run

这个工具只回答一个前置问题：在付费最终模型调用之前，本地流程是否已经把题目中的
全部候选卡解析出来，并把完整卡文放进最终模型实际可见的冻结资料包。

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

需要同时核验社区卡名时可额外加入 `--allow-community-card-network`。该开关只允许匿名
GET 到 `https://ygocdb.com/api/v0/`，不会开放最终模型传输。

输出逐题记录：

- 已解析卡片与卡片 ID；
- 未解析卡名、缺失或被截断的模型可见卡文；
- FAQ、机制规则和最终可见证据数量；
- Legacy Lua 的 typed 状态、候选数量和序列化字节；
- Lua 来源模式（不可用或显式注入的本地内核）；
- Evidence Snapshot 的 ID、SHA-256、字节与冻结状态；
- 最终模型输入的 SHA-256 与字节；
- 证据准备、Lua、快照生成和本地付费门的阶段耗时；
- 是否被付费门阻止，以及任何潜在外部 fetch 是否被 sentinel 拦截。

门禁规则是通用的，不含卡名、题号或答案分支。每张候选卡必须满足以下一种情况：

1. 唯一绑定到本地卡库记录，并且其未截断卡文实际出现在最终模型可见
   `evidenceDecisionPacket`；
2. 题面明确给出带卡名绑定的完整卡文，并且该未截断文本实际出现在最终模型可见资料包。

任何候选卡未解析、绑定有歧义、卡文缺失或卡文被截断时，sentinel 都会在真实
provider transport 之前抛出 `admin_dry_run_paid_gate_blocked`。这代表“资料不完整，
禁止开始付费测试”，不代表该卡不能发动，也不代表最终裁定为否。

测试：

```powershell
node --test tests/admin-evidence-snapshot-dry-run.test.mjs
```

测试还会检查标准答案与 `leakCanary` 没有进入快照或最终输入，并扫描 helper/CLI
源码，确保没有四道题的卡名或 case ID 特判。
