# Upstash 存储占用与只读审计

管理实验的完整 Evidence Snapshot 是 Redis 中最大的对象。新写入的完整
Snapshot 使用确定性的 `gzip+base64` envelope；fork 的引用记录仍是轻量
JSON。运行状态、事件和 TTL 规则没有改变。

## Snapshot 存储格式

完整 Snapshot 的 Redis 值是以下 JSON envelope：

```json
{
  "recordType": "admin_evidence_snapshot_gzip",
  "schemaVersion": 1,
  "encoding": "gzip+base64",
  "snapshotId": "evidence_...",
  "contentSha256": "...",
  "uncompressedBytes": 123456,
  "compressedBytes": 12345,
  "payload": "..."
}
```

编码输入是已通过 `parseAdminEvidenceSnapshot()` 完整性校验的 JSON：UTF-8
序列化后，以 gzip level 9、固定 mtime 0 压缩，再进行标准 base64 编码。
因此同一 Snapshot 会产生 byte-exact 的相同 Redis 值，现有幂等比较和 CAS
语义保持不变。

读取端同时支持：

- 新的 gzip envelope；
- 旧版本写入的裸 Snapshot JSON；
- `admin_evidence_snapshot_reference` 轻量引用。

无论格式如何，解码后仍必须通过 Snapshot ID、内容 SHA-256 和规范化内容
校验。非法 base64、损坏 gzip、长度不符或超出解压上限都会 fail-closed，
不会降级成未验证证据。默认上限为：

- 未压缩：32 MiB；
- gzip：16 MiB。

必要时可通过 `ADMIN_RUN_SNAPSHOT_MAX_UNCOMPRESSED_BYTES` 和
`ADMIN_RUN_SNAPSHOT_MAX_COMPRESSED_BYTES` 收紧，但不能低于 1024 字节。

这次改动只压缩以后写入的完整 Snapshot。旧裸 JSON 不会在普通读取时被
静默改写，也不会自动删除；它们会继续保持可读，直到原 TTL 到期或未来由
单独、显式的迁移工具处理。

## 只读容量审计

在已配置 Redis REST 环境变量的终端运行：

```powershell
pnpm run audit:upstash-storage
```

审计器的命令白名单只有：

- `SCAN`
- `TYPE`
- `PTTL`
- `MEMORY USAGE`
- `STRLEN`（仅在 `MEMORY USAGE` 不可用时估算字符串值长度）

它不会调用 `GET`、`LRANGE`、`SET`、`DEL`、`EXPIRE` 或任何其他写命令，
也没有迁移或清理功能。输出只包含 namespace 汇总、TTL 计数、已知字节数和
不可逆的 key SHA-256 短指纹；不会输出 Redis URL、token、原始 key 或值。

`knownBytes` 的含义取决于 Redis 能力：

- 支持 `MEMORY USAGE` 时，是包含 Redis 对象开销的近似内存占用；
- 不支持时，仅字符串键可由 `STRLEN` 统计，列表、哈希和有序集合会计入
  `unmeasuredKeyCount`，不会被假装成 0 字节。

脚本识别当前配置中的共享 Redis、Admin Run、Admin Lab History 和公开回答
延迟的独立 REST endpoint，并按实际环境变量前缀扫描。最多审计 20,000 个
键，超过上限会停止，不会扩大扫描或写入任何数据。

## 当前边界

- 没有自动清理、迁移或删除逻辑；
- 没有更改默认 30 天 Admin Run TTL；
- 只读审计也会消耗少量 Redis command quota；
- 容量已经耗尽时，新格式不能自动释放旧 Snapshot 占用，仍需在确认备份和
  引用关系后另行设计显式迁移或清理流程。
