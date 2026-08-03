# 管理实验室模型矩阵 CLI

这个工具只在管理员实验室运行，不会改变公开回答所使用的模型。它先用
DeepSeek V4 Flash（standard / none）建立并执行一个源运行，再用后端的
`fork` 接口让其他模型复用完全相同的冻结证据。这样比较的是最终裁定模型，
不会为每个模型重复检索资料。

## 运行

PowerShell：

```powershell
$env:ADMIN_MODEL_LAB_BASE_URL = "https://你的后端域名"
$env:ADMIN_MODEL_LAB_ORIGIN = "https://管理页面所在域名"
$env:ADMIN_MODEL_LAB_PASSWORD = "在本机输入或临时设置；不要写进仓库"
node scripts/admin-model-matrix.mjs --question "被禁止令宣言的怪兽能被仪式魔法解放吗？" --format markdown --output matrix.md
```

`ADMIN_MODEL_LAB_ORIGIN` 必须与后端允许的管理页面 Origin 完全一致。密码也可以
不设置；在交互式终端运行时，工具会隐藏输入并询问密码。不要把密码放在命令行
参数、配置文件或提交记录中。

默认矩阵只覆盖 DeepSeek Flash、GLM 5.2、Kimi K2.6 的低成本配置，不会自动
调用 DeepSeek Pro 或 Kimi K3。高价模型仍可用 `--config` 显式加入。
后端 capabilities 中不可用的模型会标为 `SKIPPED`，不会发起调用；某一个模型
失败不会终止其他模型。可以重复使用 `--config` 缩小测试范围：

```powershell
node scripts/admin-model-matrix.mjs `
  --question-file .\question.txt `
  --config deepseek:deepseek-v4-flash:pro:high `
  --config glm:glm-5.2:standard:none `
  --config kimi:kimi-k2.6:standard:none `
  --format json
```

其他常用选项：

- `--poll-ms 1500`：轮询间隔。
- `--timeout-ms 600000`：每个运行的最长等待时间。
- `--concurrency 2`：fork 后的模型并发数，避免同时产生过多费用。
- `--output report.json`：写入文件；省略时输出到终端。

报告包含每个模型的 `conciseAnswer`、`verdicts`、`timeline`、运行总耗时、最终
裁定耗时、Token 用量和后端可计算的费用。CLI 不自动判断答案对错；应使用固定
题集的期望答案做人工或独立评分，避免用被测模型给自己打分。
