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

function Invoke-GitChecked {
  & $git -c "safe.directory=$root" @args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($args -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Read-GitOutput {
  $output = & $git -c "safe.directory=$root" @args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($args -join ' ') failed with exit code $LASTEXITCODE."
  }
  return $output
}

function Read-GitOptional {
  $output = & $git -c "safe.directory=$root" @args
  if (($LASTEXITCODE -ne 0) -and ($LASTEXITCODE -ne 1)) {
    throw "git $($args -join ' ') failed with exit code $LASTEXITCODE."
  }
  return $output
}

if (-not (Test-Path (Join-Path $root ".git"))) {
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "setup-git.ps1") -RepoUrl $RepoUrl -Branch $Branch -GitPath $git
  if ($LASTEXITCODE -ne 0) {
    throw "Git setup failed with exit code $LASTEXITCODE."
  }
}

Invoke-GitChecked remote set-url origin $RepoUrl
Invoke-GitChecked checkout -B $Branch

if (-not (Read-GitOptional config user.name)) {
  Invoke-GitChecked config user.name "coldiceh"
}

if (-not (Read-GitOptional config user.email)) {
  Invoke-GitChecked config user.email "coldiceh@users.noreply.github.com"
}

Invoke-GitChecked add -A
$status = Read-GitOutput status --porcelain
if ($status) {
  Invoke-GitChecked commit -m $Message
} else {
  Write-Host "No local changes to commit. Trying to push the current branch..."
}

Invoke-GitChecked push -u origin $Branch

Write-Host "Published to $RepoUrl on branch $Branch."
