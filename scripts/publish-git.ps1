param(
  [string]$RepoUrl = "https://github.com/coldiceh/ocg-ruling-assistant.git",
  [string]$Branch = "main",
  [string]$Message = "chore: update ocg ruling assistant",
  [string]$GitPath = ""
)

$ErrorActionPreference = "Stop"

function Resolve-GitCommand {
  param([string]$PreferredPath)

  if ($PreferredPath -and (Test-Path $PreferredPath)) {
    return (Resolve-Path $PreferredPath).Path
  }

  $command = Get-Command git -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $commonPaths = @(
    "C:\Program Files\Git\cmd\git.exe",
    "C:\Program Files\Git\bin\git.exe",
    "C:\Program Files (x86)\Git\cmd\git.exe",
    "D:\Git\cmd\git.exe",
    "D:\git\cmd\git.exe"
  )

  foreach ($path in $commonPaths) {
    if (Test-Path $path) {
      return $path
    }
  }

  return $null
}

$git = Resolve-GitCommand -PreferredPath $GitPath
if (-not $git) {
  throw "Git is not installed. Install Git for Windows from https://git-scm.com/download/win, then reopen PowerShell."
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

function Invoke-Git {
  & $git -c "safe.directory=$root" @args
}

if (-not (Test-Path (Join-Path $root ".git"))) {
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "setup-git.ps1") -RepoUrl $RepoUrl -Branch $Branch -GitPath $git
}

Invoke-Git remote set-url origin $RepoUrl
Invoke-Git checkout -B $Branch

if (-not (Invoke-Git config user.name)) {
  Invoke-Git config user.name "coldiceh"
}

if (-not (Invoke-Git config user.email)) {
  Invoke-Git config user.email "coldiceh@users.noreply.github.com"
}

Invoke-Git add -A
$status = Invoke-Git status --porcelain
if (-not $status) {
  Write-Host "No local changes to publish."
  exit 0
}

Invoke-Git commit -m $Message
Invoke-Git push -u origin $Branch

Write-Host "Published to $RepoUrl on branch $Branch."
