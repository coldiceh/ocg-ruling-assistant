param(
  [string]$RepoUrl = "https://github.com/coldiceh/ocg-ruling-assistant.git",
  [string]$Branch = "main",
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
  Write-Host "Git is not installed or not in PATH."
  Write-Host "Install Git for Windows from: https://git-scm.com/download/win"
  Write-Host "Then close and reopen PowerShell, and run this script again."
  exit 1
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

function Invoke-Git {
  & $git -c "safe.directory=$root" @args
}

Write-Host "Using Git: $git"
Invoke-Git --version

if (-not (Test-Path (Join-Path $root ".git"))) {
  Write-Host "Initializing local Git repository..."
  Invoke-Git init -b $Branch
  if ($LASTEXITCODE -ne 0) {
    Invoke-Git init
    Invoke-Git checkout -B $Branch
  }
}

$remote = Invoke-Git remote 2>$null
if ($remote -contains "origin") {
  Invoke-Git remote set-url origin $RepoUrl
} else {
  Invoke-Git remote add origin $RepoUrl
}

Invoke-Git fetch origin $Branch
if ($LASTEXITCODE -eq 0) {
  Write-Host "Linking local branch to origin/$Branch without overwriting working files..."
  Invoke-Git checkout -B $Branch
  Invoke-Git reset --mixed "origin/$Branch"
} else {
  Write-Host "Remote branch was not fetched. This is okay if the remote repository is still empty."
  Invoke-Git checkout -B $Branch
}

if (-not (Invoke-Git config user.name)) {
  Invoke-Git config user.name "coldiceh"
}

if (-not (Invoke-Git config user.email)) {
  Invoke-Git config user.email "coldiceh@users.noreply.github.com"
}

Write-Host ""
Write-Host "Git setup finished."
Write-Host "Next upload command:"
Write-Host "powershell -ExecutionPolicy Bypass -File .\scripts\publish-git.ps1"
