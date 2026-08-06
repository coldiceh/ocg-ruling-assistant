# 管理实验室模型矩阵 CLI

这个工具只在管理员实验室运行，不会改变公开回答所使用的模型。每道题只准备
一次证据，再通过后端 `fork` 接口让其他最终模型复用完全相同、带哈希校验的
冻结 Evidence Snapshot。标准答案文件不会被读取，也不会进入模型输入。

正式运行前，CLI 会登录并读取后端 capabilities；只有后端明确报告已配置
**持久化**管理模型预算账本，且证据准备池和所选最终模型池都有足够余额时，才允许创建运行。每个最终模型固定使用
`finalAttemptPolicy=single`，CLI 不进行模型重试或 JSON 修复调用；并发硬上限默认为
1。后端 Redis 预算账本仍是实际支出的最终硬门槛，CLI 的估算上限只是额外预检。

## 单题默认矩阵

默认只测试第三方中转的 Sol、Terra、Luna，DeepSeek V4 Flash（standard / none）
负责准备检索提示。中转模型身份和费率都未经本项目验证；报告会保留 requested model
与 returned model。

PowerShell：

```powershell
$env:ADMIN_MODEL_LAB_BASE_URL = "https://ocg-ruling-assistant.vercel.app"
$env:ADMIN_MODEL_LAB_ORIGIN = "https://coldiceh.github.io"
$Node = "C:\Users\11953\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

& $Node scripts/admin-model-matrix.mjs `
  --question "被禁止令宣言的怪兽能被仪式魔法解放吗？" `
  --format markdown `
  --output matrix.md
```

`$Node` 是可用的 Node.js 可执行文件。管理密码可以临时放在
`ADMIN_MODEL_LAB_PASSWORD`，也可以不设置；交互式终端会隐藏输入并询问密码。不要把
密码放在命令行参数、配置文件或提交记录中。

## 四题、五模型显式试验

四题文件是
`tests/fixtures/admin-evidence-dry-run-cases.json`，只包含题面和候选卡，不包含标准
答案。标准答案位于另一个文件，模型矩阵不会加载它。

以下矩阵一共计划 20 次最终模型请求：每题分别测试 DeepSeek V4 Flash 思考 high、
DeepSeek V4 Pro 思考 max，以及中转 Sol/Terra/Luna 思考 high。后端 capabilities 中
未配置的模型会记为 `SKIPPED`，不会发起请求。

```powershell
& $Node scripts/admin-model-matrix.mjs `
  --cases-file tests/fixtures/admin-evidence-dry-run-cases.json `
  --config relay:relay-gpt-5.6-sol:pro:high `
  --config relay:relay-gpt-5.6-terra:pro:high `
  --config relay:relay-gpt-5.6-luna:pro:high `
  --config deepseek:deepseek-v4-flash:pro:high `
  --config deepseek:deepseek-v4-pro:pro:max `
  --concurrency 1 `
  --max-final-requests 20 `
  --estimated-cny-per-request 5 `
  --max-cost-cny 100 `
  --format markdown `
  --output artifacts/five-model-pilot.md
```

这里的 `5 × 20 = 100 元` 是保守的 CLI 计划估算上界，不是允许实际消费 100 元。
实际调用仍必须先通过 Vercel 上的 Redis 日额度和逐次预留：证据准备与
DeepSeek Flash/Pro 最终裁定共用 10 元 DeepSeek 池，中转 Sol、Terra、Luna 各自使用
独立 10 元池，因此本轮所有管理模型调用的实际总硬上限为 40 元。余额不足时，后续
请求会在连接模型前失败。正式执行前仍要核对
中转截图费率与 DeepSeek 官方费率；不要通过降低 CLI 估算来绕过这个检查。

## 零费用证据验收

正式模型测试前先运行：

```powershell
& $Node scripts/admin-evidence-snapshot-dry-run.mjs `
  --cases tests/fixtures/admin-evidence-dry-run-cases.json `
  --allow-community-card-network `
  --compact
```

这个命令只允许向 `https://ygocdb.com/api/v0/` 发 GET 请求来补卡片身份，并用本地
sentinel 阻止所有最终模型 transport。验收时应看到：

- `realProviderTransportCalls: 0`
- `allSnapshotsFrozen: true`
- 每题 `paidGateBlocked: false`
- 所有候选卡 `bindingStatus: RESOLVED`

## 报告内容与边界

报告记录每个模型的 `conciseAnswer`、`verdicts`、`timeline`、requested/returned model、
Evidence Snapshot 哈希、运行总耗时、最终裁定耗时、Token、finish reason 和后端可计算
的费用。某个模型失败不会自动调用第二次，也不会阻止后续可用模型。

CLI 不让被测模型给自己评分。运行完成后可将报告与独立 golden 文件进行人工或本地
结构化检查；不得把 golden、正确答案或 canary 合并进 cases 文件后发送给模型。

其他常用选项：

- `--poll-ms 1500`：轮询间隔。
- `--timeout-ms 600000`：每个运行的最长等待时间。
- `--source-run-id ID`：单题模式复用严格匹配的已冻结 Sol 源运行。
- `--output report.json`：写入文件；省略时输出到终端。
- `--estimated-input-tokens` / `--estimated-output-tokens`：默认中转费率估算的 Token 包络。
- `--budget-usd-to-cny`：预算换算因子，不是实时汇率。
