param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("freeze", "run")]
  [string] $Mode,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RunnerArguments
)

$ErrorActionPreference = "Stop"
$availableMb = (Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
$availableGb = [Math]::Round($availableMb / 1024, 2)
$nodeProcesses = @(Get-Process -Name node -ErrorAction SilentlyContinue)
$nodeWorkingSetGb = [Math]::Round((($nodeProcesses | Measure-Object WorkingSet64 -Sum).Sum) / 1GB, 2)
Write-Host "Node preflight: available RAM ${availableGb} GB; existing Node $($nodeProcesses.Count); Node working set ${nodeWorkingSetGb} GB"
if ($availableGb -lt 1.5) {
  throw "Available RAM is below 1.5 GB; refusing to start another Node process"
}

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
    $env:RELAY_BASE_URL = Read-Host -Prompt "粘贴与待测网页环境完全相同的 RELAY_BASE_URL"
  }
  if ([string]::IsNullOrWhiteSpace($env:RELAY_BASE_URL)) {
    throw "RELAY_BASE_URL 不能为空；实验不得自行猜测网页使用的中转地址"
  }

  $node = $env:npm_node_execpath
  if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    $node = (Get-Command node -ErrorAction Stop).Source
  }
  & $node (Join-Path $PSScriptRoot "frozen-public-rag-final-effort.mjs") $Mode @RunnerArguments
  $exitCode = $LASTEXITCODE
} finally {
  if ($hadKey) { $env:RELAY_API_KEY = $oldKey } else { Remove-Item Env:RELAY_API_KEY -ErrorAction SilentlyContinue }
  if ($hadBase) { $env:RELAY_BASE_URL = $oldBase } else { Remove-Item Env:RELAY_BASE_URL -ErrorAction SilentlyContinue }
  $relayCredential = $null
  $relaySecret = $null
}

exit $exitCode
