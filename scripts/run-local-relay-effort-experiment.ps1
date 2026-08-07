param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RunnerArguments
)

$ErrorActionPreference = "Stop"
$hadKey = Test-Path Env:RELAY_API_KEY
$oldKey = $env:RELAY_API_KEY
$hadBase = Test-Path Env:RELAY_BASE_URL
$oldBase = $env:RELAY_BASE_URL
$relaySecret = $null
$relayCredential = $null
$exitCode = 1

try {
  if ([string]::IsNullOrWhiteSpace($env:RELAY_API_KEY)) {
    $relaySecret = Read-Host -Prompt "粘贴中转站签发的 API key（输入不会显示）" -AsSecureString
    $relayCredential = [System.Management.Automation.PSCredential]::new("relay", $relaySecret)
    $env:RELAY_API_KEY = $relayCredential.GetNetworkCredential().Password
  }
  if ([string]::IsNullOrWhiteSpace($env:RELAY_API_KEY)) {
    throw "RELAY_API_KEY 不能为空"
  }
  if ([string]::IsNullOrWhiteSpace($env:RELAY_BASE_URL)) {
    $env:RELAY_BASE_URL = "https://api.986310.xyz/v1"
  }

  $node = $env:npm_node_execpath
  if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    $node = (Get-Command node -ErrorAction Stop).Source
  }

  # Starts one Node process only; no web, backend, engine, or worker process.
  & $node (Join-Path $PSScriptRoot "local-relay-effort-experiment.mjs") @RunnerArguments
  $exitCode = $LASTEXITCODE
} finally {
  if ($hadKey) { $env:RELAY_API_KEY = $oldKey } else { Remove-Item Env:RELAY_API_KEY -ErrorAction SilentlyContinue }
  if ($hadBase) { $env:RELAY_BASE_URL = $oldBase } else { Remove-Item Env:RELAY_BASE_URL -ErrorAction SilentlyContinue }
  $relayCredential = $null
  $relaySecret = $null
}

exit $exitCode
