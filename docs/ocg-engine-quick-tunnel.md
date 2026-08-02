# 本机模拟器接入线上规则助手（临时测试版）

这份说明用于 Windows + Vercel 的临时联调。它使用 Cloudflare Quick Tunnel，
不会把本机的 `8790` 端口直接开放到公网。Quick Tunnel 地址每次重启都会变化，
只适合测试，不适合长期生产部署。

## 1. 首次检查模拟器

打开 PowerShell 窗口 1：

```powershell
cd "D:\Documents\游戏王游戏引擎"
npm run smoke:real -- ygopro
```

如果首次运行提示尚未初始化，先执行：

```powershell
npm run setup:local
npm run smoke:real -- ygopro
```

## 2. 生成模拟器密码并启动

仍在窗口 1 执行：

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$EngineToken = [Convert]::ToBase64String($bytes)
$EngineToken
```

保存输出的密码，然后启动模拟器：

```powershell
$env:OCG_ENGINE_BIND = "127.0.0.1"
$env:OCG_ENGINE_PORT = "8790"
$env:OCG_ENGINE_TOKEN = $EngineToken
npm run serve -- --profile ygopro
```

保持窗口 1 开启。不要在 Windows 防火墙或路由器中开放 `8790` 端口。

## 3. 检查本机服务

打开 PowerShell 窗口 2：

```powershell
$EngineToken = Read-Host "粘贴刚才生成的模拟器密码"
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8790/health" `
  -Headers @{ Authorization = "Bearer $EngineToken" }
```

应看到 `ok=True`、`service=ocg-engine`、`profile=ygopro`。

## 4. 下载 cloudflared

仍在窗口 2 执行：

```powershell
$CloudflaredDir = Join-Path $env:LOCALAPPDATA "cloudflared-bin"
$CloudflaredExe = Join-Path $CloudflaredDir "cloudflared.exe"
New-Item -ItemType Directory -Force -Path $CloudflaredDir | Out-Null
Invoke-WebRequest `
  -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" `
  -OutFile $CloudflaredExe
Unblock-File -LiteralPath $CloudflaredExe
& $CloudflaredExe --version
```

如果启动 Tunnel 时报告本地配置冲突，先检查：

```powershell
Get-ChildItem `
  "$env:USERPROFILE\.cloudflared\config.yaml", `
  "$env:USERPROFILE\.cloudflared\config.yml" `
  -ErrorAction SilentlyContinue
```

仅在明确报冲突时临时改名，不要删除这些配置文件。

## 5. 建立临时 HTTPS Tunnel

在窗口 2 执行：

```powershell
& $CloudflaredExe tunnel --url http://127.0.0.1:8790
```

复制终端输出的 `https://随机单词.trycloudflare.com`，并保持窗口 2 开启。

## 6. 从公网验证

打开 PowerShell 窗口 3：

```powershell
$PublicEngineUrl = Read-Host "粘贴 trycloudflare 地址，不要带末尾斜杠"
$EngineToken = Read-Host "粘贴模拟器密码"
Invoke-RestMethod `
  -Uri "$PublicEngineUrl/health" `
  -Headers @{ Authorization = "Bearer $EngineToken" }
```

也应看到 `ok=True`。

## 7. 配置 Vercel Production

在 Vercel 项目的 **Production** 环境添加：

```text
OCG_ENGINE_URL=https://随机单词.trycloudflare.com
OCG_ENGINE_TOKEN=刚才的原始密码
OCG_ENGINE_TIMEOUT_MS=20000
RAG_AUTO_ENGINE_SIMULATION=false
RAG_FORMAL_ENGINE_MODE=off
```

`OCG_ENGINE_TOKEN` 不要带 `Bearer `，也不要添加多余空格。保存后重新部署
Production。

先检查 Vercel 后端（不要使用 GitHub Pages 地址）：

```powershell
$AssistantUrl = Read-Host "粘贴 Vercel 地址，例如 https://xxx.vercel.app"
Invoke-RestMethod -Uri "$AssistantUrl/api/engine"
```

确认返回 `ready` 后，把 `RAG_AUTO_ENGINE_SIMULATION` 改成 `true`，再次重新部署。

## 8. 测试一次规则回答

```powershell
$Question = "对方场上存在「千查万别」时，我方可以发动「闪刀姬=零露」的②效果吗"
$Body = @{ mode = "rag"; question = $Question } | ConvertTo-Json
$Result = Invoke-RestMethod -Method Post `
  -Uri "$AssistantUrl/api/answer" `
  -ContentType "application/json; charset=utf-8" `
  -Body $Body
$Result.engine
$Result.engineSimulation
```

## 9. 停止测试

1. 在窗口 2 按 `Ctrl+C` 停止 Tunnel。
2. 在窗口 1 按 `Ctrl+C` 停止模拟器。
3. 将 Vercel 的 `RAG_AUTO_ENGINE_SIMULATION` 改回 `false`。
4. 清空已经失效的 `OCG_ENGINE_URL`，重新部署 Production。

只要电脑关机、任一窗口关闭或 Quick Tunnel 重启，旧公网地址就会失效。
