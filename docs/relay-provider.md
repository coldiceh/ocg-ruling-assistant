# 第三方中转临时配置

`relay` 是独立的第三方兼容服务，不是 `openai` provider，也不证明上游
实际模型身份。它目前先用于隔离的管理模型实验室，所有展示固定标注
“模型身份未验证”；配置 key 本身不会改变公开问答模型。

当前固定契约：

- Base URL：必须通过服务端 `RELAY_BASE_URL` 显式配置为朋友提供的 HTTPS `/v1`
  地址；公开仓库不保存该 endpoint
- 管理实验室选择 ID：`relay-gpt-5.6-sol`、`relay-gpt-5.6-terra`、
  `relay-gpt-5.6-luna`；发给中转上游的 canonical model 分别为
  `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`
- 接口：同步 `POST /chat/completions`
- 结构：`response_format: { "type": "json_object" }`
- 推理：固定 `reasoningMode: "pro"`；默认及预置矩阵使用
  `reasoning_effort: "high"`，管理实验室仍可在服务端允许的档位内手动选择
- 不使用 tools、后台 Responses、轮询、自动重试或官方 OpenAI key

中转调用必须由使用者另行提供中转站签发的 API key；当前管理实验的证据准备还
必须配置服务端 `DEEPSEEK_API_KEY`。缺少 DeepSeek key 时组合会明确失败，不会
伪装成已经准备好本地证据。不要把官方
`OPENAI_API_KEY` 给中转站，也不要把中转 key 写进 `config.json`、前端代码、
Git 或聊天记录。

## 本地 PowerShell 会话

下面的方式只把 key 放进当前 PowerShell 进程及其启动的后端进程，不写入仓库：

```powershell
$relaySecret = Read-Host -Prompt "Relay API key" -AsSecureString
$relayCredential = [System.Management.Automation.PSCredential]::new("relay", $relaySecret)
$env:RELAY_API_KEY = $relayCredential.GetNetworkCredential().Password
$env:RELAY_BASE_URL = (Read-Host -Prompt "Relay HTTPS /v1 Base URL").Trim()
$deepSeekSecret = Read-Host -Prompt "DeepSeek API key" -AsSecureString
$deepSeekCredential = [System.Management.Automation.PSCredential]::new("deepseek", $deepSeekSecret)
$env:DEEPSEEK_API_KEY = $deepSeekCredential.GetNetworkCredential().Password
$adminSecret = Read-Host -Prompt "Admin password" -AsSecureString
$adminCredential = [System.Management.Automation.PSCredential]::new("admin", $adminSecret)
$env:ADMIN_SESSION_PASSWORD = $adminCredential.GetNetworkCredential().Password
$env:ADMIN_MODEL_LAB_ENABLED = "true"
pnpm run dev
```

上面的手动示例只完成启动和能力检查；由于没有启用最终调用预算池，真实付费调用会
fail-closed。推荐的一条命令版本会在缺少中转 Base URL、key、DeepSeek key 或管理密码时分别显示
安全输入框，并额外配置本文所述的本地预算、输出上限和预算换算参数：

```powershell
pnpm run dev:relay
```

该命令不会把试运行估算冒充已经核验的中转价格，也不会自动放宽实验预算。真实批量
实验仍受矩阵工具的请求数和费用硬闸约束。启动器设置的本地默认值为：Relay 的
Sol/Terra/Luna 共用 10 CNY 日池、每次先预约 5 CNY、completion token 上限 8192；
DeepSeek Flash/Pro 共用 10 CNY 日池且每次预约 10 CNY。可靠 usage 会按版本化的
中转后台截图费率结算，差额才会释放；无 usage、无预算换算因子、超时、429/5xx 或
确认不完整时保留预约。因此两次不确定 Relay 调用就会耗尽应用内日池，且默认绝不
承诺能跑满 12 次。仍应在中转站后台给这把 API key 设置独立硬限额。

当前费率转录自 2026-08-06 用户提供的中转后台截图，单位为 USD/百万 Token：

| 模型 | 输入 | 缓存输入 | 输出 |
| --- | ---: | ---: | ---: |
| Sol | 7.3 | 0.73 | 43.8 |
| Terra | 2.92 | 0.292 | 17.52 |
| Luna | 0.3942 | 0.03942 | 2.3652 |

这些数值在 `data/relay-model-pricing.json` 中带版本保存并明确标记为未验证；每次正式
实验前必须以中转后台当前价格为准。启动器的 `7.5 CNY/USD` 只是保守预算换算因子，
不是实时汇率。

两种方式都会在同一个终端启动引擎、后端和网页。成功后直接访问
`http://127.0.0.1:4173/?admin=1`；不用再分别打开三个 PowerShell 窗口。启动器只把
中转 key 和管理密码传给后端，不会传给浏览器静态服务器或规则引擎。

在管理实验室中可手动选择 Sol、Terra、Luna，以及 DeepSeek Flash/Pro；冻结证据
网页对比也会列出这些已配置且可用的模型，但默认只勾选 Flash，不会自动产生多次
付费调用。12 请求的默认 CLI pilot 仍只包含三种 Relay，DeepSeek 可通过显式配置另行
加入。当前发布物没有注册任何公开 Relay profile，因此设置环境变量也不会让公开主页
展示或调用中转。若未来决定公开使用，
必须先通过新的代码审查和发布显式加入公开 allowlist；本地启动器不会代为进行。

关闭该 PowerShell 窗口会移除这组临时环境变量。若要在当前窗口立即清除：

```powershell
Remove-Item Env:RELAY_API_KEY
```

Base URL、模型 ID、推理级别和本地输出上限已由管理实验配置固定，不需要用户再次
提供。只有在中转站地址发生变化时才设置 `RELAY_BASE_URL`；如需覆盖矩阵的分模型
估算，可显式设置 `RELAY_ESTIMATED_CNY_PER_CALL`，但统一覆盖会隐藏模型价格差异，
一般不建议使用。

## 安全边界

- 中转站会看到发送给最终模型的题目与检索证据。
- 返回的 `model` 字段只能用于日志比对，不能证明真实上游模型。
- 每个最终裁定只发送一次；超时或 HTTP 失败不会自动重试，以免重复计费。
- HTTP 失败或本地超时不代表上游一定没有开始生成；第三方仍可能计费。只有能够
  证明请求在接收前被拒绝的 4xx 才释放应用内预约；超时、网络错误、429、5xx、
  响应确认不完整以及 HTTP 200 空内容都会保留预约。真正的硬额度应在中转站后台
  为该 API key 单独设置，并以中转站用量记录为准。
- `RELAY_BASE_URL` 必须是无用户名、密码、查询参数或片段的 HTTPS URL。
- 管理实验的最终调用使用独立 `ADMIN_FINAL_BUDGET_*` 账本；公开 API 的
  `API_DAILY_BUDGET_CNY` 不会替代它。当前本地 5 CNY/次是保守预约；应用内数字不能
  替代中转账户硬额度。
- DeepSeek 资料准备是当前管理实验组合的必需阶段；未配置 `DEEPSEEK_API_KEY` 时
  fail-closed，不会退回一个未经验证的本地资料流程。
