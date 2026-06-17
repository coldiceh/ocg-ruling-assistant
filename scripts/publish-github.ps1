param(
  [string]$Repo = "coldiceh/ocg-ruling-assistant",
  [string]$Branch = "main",
  [string]$Message = "chore: publish static site",
  [string]$GhPath = "gh"
)

$ErrorActionPreference = "Stop"
$script:GhCommand = $GhPath

function Invoke-GhJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [object]$Body = $null,
    [switch]$AllowFailure
  )

  $tempFile = $null
  try {
    $args = @("api") + $Arguments
    if ($null -ne $Body) {
      $tempFile = New-TemporaryFile
      $json = $Body | ConvertTo-Json -Depth 30 -Compress
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($tempFile.FullName, $json, $utf8NoBom)
      $args += @("--input", $tempFile.FullName)
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & $script:GhCommand @args 2>&1
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }

    $text = ($output | Out-String).Trim()
    if ($exitCode -ne 0) {
      if ($AllowFailure) {
        return [pscustomobject]@{ failed = $true; text = $text }
      }
      throw "gh api failed: gh $($args -join ' ')`n$text"
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
      return $null
    }
    return $text | ConvertFrom-Json
  } finally {
    if ($tempFile -and (Test-Path $tempFile.FullName)) {
      Remove-Item -LiteralPath $tempFile.FullName -Force
    }
  }
}

function Get-RelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )
  return $Path.Substring($Root.Length + 1).Replace("\", "/")
}

function Get-UploadFiles {
  param([string]$Root)

  return Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object {
    $relative = Get-RelativePath -Root $Root -Path $_.FullName
    $relative -notmatch "^\.git/" -and
    $relative -notmatch "^node_modules/" -and
    $relative -ne "preview.png" -and
    $_.Extension -notin @(".zip", ".log")
  }
}

function Ensure-Branch {
  param(
    [string]$RepoName,
    [string]$BranchName
  )

  $ref = Invoke-GhJson -Arguments @("repos/$RepoName/git/ref/heads/$BranchName") -AllowFailure
  if (-not $ref.failed) {
    return $ref
  }

  Write-Host "Branch $BranchName not found; initializing repository..."
  $readme = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("# OCG Ruling Assistant`n"))
  Invoke-GhJson -Arguments @("-X", "PUT", "repos/$RepoName/contents/README.md") -Body @{
    message = "chore: initialize repository"
    content = $readme
    branch = $BranchName
  } | Out-Null

  return Invoke-GhJson -Arguments @("repos/$RepoName/git/ref/heads/$BranchName")
}

if (-not (Get-Command $script:GhCommand -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI was not found. Pass -GhPath with the full path to gh.exe."
}

& $script:GhCommand auth status | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI is not logged in. Run: gh auth login -h github.com -s repo,workflow -w"
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Invoke-GhJson -Arguments @("repos/$Repo") | Out-Null

$files = Get-UploadFiles -Root $root
Write-Host "Preparing $($files.Count) files for $Repo@$Branch..."

$ref = Ensure-Branch -RepoName $Repo -BranchName $Branch
$baseSha = $ref.object.sha
$baseCommit = Invoke-GhJson -Arguments @("repos/$Repo/git/commits/$baseSha")
$baseTreeSha = $baseCommit.tree.sha

$treeEntries = @()
foreach ($file in $files) {
  $relative = Get-RelativePath -Root $root -Path $file.FullName
  $content = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($file.FullName))
  $blob = Invoke-GhJson -Arguments @("-X", "POST", "repos/$Repo/git/blobs") -Body @{
    content = $content
    encoding = "base64"
  }

  $treeEntries += @{
    path = $relative
    mode = "100644"
    type = "blob"
    sha = $blob.sha
  }
  Write-Host "Prepared $relative"
}

$tree = Invoke-GhJson -Arguments @("-X", "POST", "repos/$Repo/git/trees") -Body @{
  base_tree = $baseTreeSha
  tree = $treeEntries
}

$commit = Invoke-GhJson -Arguments @("-X", "POST", "repos/$Repo/git/commits") -Body @{
  message = $Message
  tree = $tree.sha
  parents = @($baseSha)
}

Invoke-GhJson -Arguments @("-X", "PATCH", "repos/$Repo/git/refs/heads/$Branch") -Body @{
  sha = $commit.sha
  force = $false
} | Out-Null

Write-Host "Published $($files.Count) files to https://github.com/$Repo/tree/$Branch"
