$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:RELAY_API_KEY)) {
  $relaySecret = Read-Host -Prompt "粘贴中转站签发的 API key（输入不会显示）" -AsSecureString
  $relayCredential = [System.Management.Automation.PSCredential]::new("relay", $relaySecret)
  $env:RELAY_API_KEY = $relayCredential.GetNetworkCredential().Password
  if ([string]::IsNullOrWhiteSpace($env:RELAY_API_KEY)) {
    throw "RELAY_API_KEY 不能为空"
  }
}

if ([string]::IsNullOrWhiteSpace($env:RELAY_BASE_URL)) {
  $env:RELAY_BASE_URL = (Read-Host -Prompt "输入朋友提供的中转 Base URL（必须为 https://.../v1）").Trim()
  if ([string]::IsNullOrWhiteSpace($env:RELAY_BASE_URL)) {
    throw "RELAY_BASE_URL 不能为空"
  }
}

# Invoking dev:relay explicitly opts this child process into the isolated admin
# lab. This still does not change PUBLIC_RULING_MODEL_PROFILE.
$env:ADMIN_MODEL_LAB_ENABLED = "true"

# Local-only budget defaults. Sol/Terra/Luna each have an independent 10 CNY
# pool. Each request reserves 5 CNY before transport, so two ambiguous or
# unmetered calls stop that model's pool. Successful calls with reliable usage
# are settled from the versioned,
# explicitly unverified relay-dashboard rates. The relay account itself remains
# the authoritative hard spending limit.
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_RELAY_SOL_DAILY_CNY)) {
  $env:ADMIN_FINAL_BUDGET_RELAY_SOL_DAILY_CNY = "10"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_RELAY_SOL_RESERVATION_CNY)) {
  $env:ADMIN_FINAL_BUDGET_RELAY_SOL_RESERVATION_CNY = "5"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_RELAY_TERRA_DAILY_CNY)) {
  $env:ADMIN_FINAL_BUDGET_RELAY_TERRA_DAILY_CNY = "10"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_RELAY_TERRA_RESERVATION_CNY)) {
  $env:ADMIN_FINAL_BUDGET_RELAY_TERRA_RESERVATION_CNY = "5"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_RELAY_LUNA_DAILY_CNY)) {
  $env:ADMIN_FINAL_BUDGET_RELAY_LUNA_DAILY_CNY = "10"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_RELAY_LUNA_RESERVATION_CNY)) {
  $env:ADMIN_FINAL_BUDGET_RELAY_LUNA_RESERVATION_CNY = "5"
}
if ([string]::IsNullOrWhiteSpace($env:RELAY_MAX_COMPLETION_TOKENS)) {
  $env:RELAY_MAX_COMPLETION_TOKENS = "8192"
}
if ([string]::IsNullOrWhiteSpace($env:RELAY_STREAM)) {
  $env:RELAY_STREAM = "true"
}
if ([string]::IsNullOrWhiteSpace($env:RELAY_STREAM_TIMEOUT_MS)) {
  $env:RELAY_STREAM_TIMEOUT_MS = "270000"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_SYNC_FINAL_TIMEOUT_MS)) {
  $env:ADMIN_MODEL_LAB_SYNC_FINAL_TIMEOUT_MS = "290000"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_USD_TO_CNY_RATE)) {
  $env:ADMIN_MODEL_LAB_USD_TO_CNY_RATE = "7.5"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_EXCHANGE_RATE_VERSION)) {
  $env:ADMIN_MODEL_LAB_EXCHANGE_RATE_VERSION = "pilot-budget-factor-v1"
}
if ([string]::IsNullOrWhiteSpace($env:RELAY_PRICING_MULTIPLIER)) {
  # Applies only to the token group shown in the user-provided 2026-08-07
  # screenshot. Use an explicit override for any other relay token group.
  $env:RELAY_PRICING_MULTIPLIER = "0.27"
}

# DeepSeek Flash and Pro share one deliberately conservative local final-call
# pool. The 2 CNY reservation conservatively covers this application's bounded
# final input and 64K output envelope at the official V4 rates checked on
# 2026-08-06; reported usage settles the smaller actual estimate.
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY)) {
  $env:ADMIN_FINAL_BUDGET_DEEPSEEK_DAILY_CNY = "10"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY)) {
  $env:ADMIN_FINAL_BUDGET_DEEPSEEK_RESERVATION_CNY = "2"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_PRICING_VERSION = "deepseek-official-cny-2026-08-06"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_PRICING_EFFECTIVE_DATE = "2026-08-06"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_FLASH_CACHED_INPUT_CNY_PER_MTOK)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_FLASH_CACHED_INPUT_CNY_PER_MTOK = "0.02"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_FLASH_INPUT_CNY_PER_MTOK = "1"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_FLASH_OUTPUT_CNY_PER_MTOK = "2"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_PRO_CACHED_INPUT_CNY_PER_MTOK)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_PRO_CACHED_INPUT_CNY_PER_MTOK = "0.025"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_PRO_INPUT_CNY_PER_MTOK)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_PRO_INPUT_CNY_PER_MTOK = "3"
}
if ([string]::IsNullOrWhiteSpace($env:ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK)) {
  $env:ADMIN_MODEL_LAB_DEEPSEEK_PRO_OUTPUT_CNY_PER_MTOK = "6"
}

if ([string]::IsNullOrWhiteSpace($env:ADMIN_SESSION_PASSWORD)) {
  $existingAdminPassword = $env:API_ADMIN_PASSWORD
  if ([string]::IsNullOrWhiteSpace($existingAdminPassword)) {
    $existingAdminPassword = $env:ADMIN_MODEL_LAB_PASSWORD
  }
  if ([string]::IsNullOrWhiteSpace($existingAdminPassword)) {
    $existingAdminPassword = $env:ADMIN_PASSWORD
  }

  if (-not [string]::IsNullOrWhiteSpace($existingAdminPassword)) {
    $env:ADMIN_SESSION_PASSWORD = $existingAdminPassword
  } else {
    $adminSecret = Read-Host -Prompt "输入本地管理实验室密码（输入不会显示）" -AsSecureString
    $adminCredential = [System.Management.Automation.PSCredential]::new("admin", $adminSecret)
    $env:ADMIN_SESSION_PASSWORD = $adminCredential.GetNetworkCredential().Password
  }
  if ([string]::IsNullOrWhiteSpace($env:ADMIN_SESSION_PASSWORD)) {
    throw "管理实验室密码不能为空"
  }
}

$node = $env:npm_node_execpath
if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
  $node = (Get-Command node -ErrorAction Stop).Source
}

try {
  & $node (Join-Path $PSScriptRoot "start-with-ocg-engine.mjs")
  exit $LASTEXITCODE
} finally {
  # The key was scoped to this PowerShell process. Explicitly clear it before
  # exit as defence in depth; it is never written to disk by this script.
  Remove-Item Env:RELAY_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:RELAY_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:ADMIN_SESSION_PASSWORD -ErrorAction SilentlyContinue
}
