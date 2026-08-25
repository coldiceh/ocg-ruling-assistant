[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [long]::MaxValue)]
  [long] $RunId,

  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory,

  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
  [string] $Repository = "coldiceh/ocg-ruling-assistant",

  [string] $ArtifactName,

  [ValidateRange(1, 9999)]
  [int] $RunAttempt,

  [ValidatePattern('^[A-Fa-f0-9]{40}$')]
  [string] $CertificateThumbprint
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$certificateSubject = "CN=YuGiOh Frozen Public RAG Review"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("frozen-rag-review-" + [Guid]::NewGuid().ToString("N"))
$downloadDirectory = Join-Path $temporaryRoot "download"
$extractDirectory = Join-Path $temporaryRoot "extract"
$plaintextArchive = Join-Path $temporaryRoot "review.tar.gz"
$outputStagingPath = $null

function Get-Sha256Hex {
  param([string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-NoReparsePointAncestor {
  param([string] $Path)
  $current = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "OutputDirectory must not use a reparse-point ancestor."
      }
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or
        $parent.Equals($current, [StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $current = $parent
  }
}

function Read-ExactKeyValueFile {
  param(
    [string] $Path,
    [string[]] $RequiredKeys,
    [string[]] $OptionalKeys = @(),
    [string[]] $AllowEmptyKeys = @()
  )
  $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($key in @($RequiredKeys) + @($OptionalKeys)) { [void]$allowed.Add($key) }
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $separator = $line.IndexOf("=")
    if ($separator -le 0) { throw "Invalid key/value metadata line."
    }
    $key = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    if (-not $allowed.Contains($key) -or $values.ContainsKey($key)) {
      throw "Metadata contains an unknown or duplicate key."
    }
    $values[$key] = $value
  }
  foreach ($key in $RequiredKeys) {
    if (-not $values.ContainsKey($key) -or
        ([string]::IsNullOrWhiteSpace($values[$key]) -and $key -notin $AllowEmptyKeys)) {
      throw "Metadata is missing a required key."
    }
  }
  return $values
}

function Invoke-GhRawDownload {
  param([string] $GhPath, [string] $ApiPath, [string] $Destination)
  $stderrPath = "$Destination.stderr"
  $process = Start-Process -FilePath $GhPath -ArgumentList @(
    "api", $ApiPath, "-H", "Accept:application/vnd.github.raw"
  ) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $Destination -RedirectStandardError $stderrPath
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
    throw "GitHub encrypted-results download failed."
  }
  Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
}

function Invoke-OpenSslCompatibleAesDecrypt {
  param([string] $InputPath, [string] $OutputPath, [string] $Password)
  $input = [IO.File]::OpenRead($InputPath)
  $output = $null
  $derive = $null
  $aes = $null
  $decryptor = $null
  $crypto = $null
  try {
    [byte[]] $header = [byte[]]::new(16)
    if ($input.Read($header, 0, $header.Length) -ne $header.Length) {
      throw "Encrypted archive is shorter than the OpenSSL salt header."
    }
    $magic = [Text.Encoding]::ASCII.GetString($header, 0, 8)
    if ($magic -ne "Salted__") { throw "Encrypted archive has no OpenSSL salt header." }
    [byte[]] $salt = $header[8..15]
    $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
      [Text.Encoding]::UTF8.GetBytes($Password),
      $salt,
      200000,
      [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    [byte[]] $key = $derive.GetBytes(32)
    [byte[]] $iv = $derive.GetBytes(16)
    $aes = [Security.Cryptography.Aes]::Create()
    $aes.Mode = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $decryptor = $aes.CreateDecryptor($key, $iv)
    $output = [IO.File]::Create($OutputPath)
    $crypto = [Security.Cryptography.CryptoStream]::new(
      $output,
      $decryptor,
      [Security.Cryptography.CryptoStreamMode]::Write
    )
    [byte[]] $buffer = [byte[]]::new(65536)
    while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $crypto.Write($buffer, 0, $read)
    }
    $crypto.FlushFinalBlock()
  } finally {
    if ($crypto) { $crypto.Dispose() }
    if ($output) { $output.Dispose() }
    if ($decryptor) { $decryptor.Dispose() }
    if ($aes) { $aes.Dispose() }
    if ($derive) { $derive.Dispose() }
    $input.Dispose()
  }
}

function Assert-SafeReviewArchive {
  param([string] $ArchivePath, [string] $TarPath)
  $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($name in @(
    "frozen-eight-private-output",
    "frozen-eight-private-output/stage.txt",
    "frozen-eight-private-output/snapshot.json",
    "frozen-eight-private-output/results.json",
    "frozen-eight-private-output/runner.log",
    "frozen-eight-private-output/exit-code.txt",
    "frozen-eight-private-output/binding.txt"
  )) { [void]$allowed.Add($name) }

  $entries = @(& $TarPath -tzf $ArchivePath)
  if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) { throw "Decrypted archive cannot be listed." }
  foreach ($entryValue in $entries) {
    $entry = ([string]$entryValue).Replace("\", "/").TrimEnd("/")
    if ([string]::IsNullOrWhiteSpace($entry) -or
        $entry.StartsWith("/") -or
        $entry -match '^[A-Za-z]:' -or
        $entry.Split("/") -contains ".." -or
        -not $allowed.Contains($entry)) {
      throw "Decrypted archive contains an unsafe or unexpected path."
    }
  }
  $verbose = @(& $TarPath -tvzf $ArchivePath)
  if ($LASTEXITCODE -ne 0 -or $verbose.Count -ne $entries.Count) {
    throw "Decrypted archive type listing failed."
  }
  if ($verbose | Where-Object { $_ -notmatch '^[d-]' }) {
    throw "Decrypted archive contains a link or unsupported entry type."
  }
}

$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) `
  + [IO.Path]::DirectorySeparatorChar
if ($outputPath.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $outputPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDirectory must be outside the repository to prevent accidental plaintext commits."
}
Assert-NoReparsePointAncestor -Path $outputPath
if (Test-Path -LiteralPath $outputPath) {
  throw "OutputDirectory already exists; refusing to overwrite plaintext review data."
}

[IO.Directory]::CreateDirectory($downloadDirectory) | Out-Null
[IO.Directory]::CreateDirectory($extractDirectory) | Out-Null
$operationFailure = $null
$cleanupFailures = [System.Collections.Generic.List[Exception]]::new()
try {
  $gh = (Get-Command gh -ErrorAction Stop).Source
  if ($RunAttempt -le 0) {
    $runResponse = & $gh api "repos/$Repository/actions/runs/$RunId"
    if ($LASTEXITCODE -ne 0) { throw "GitHub run-attempt lookup failed." }
    $RunAttempt = [int](ConvertFrom-Json ($runResponse -join "`n")).run_attempt
  }
  if ($RunAttempt -le 0) { throw "A positive run attempt is required." }
  $artifactResponse = & $gh api "repos/$Repository/actions/runs/$RunId/artifacts?per_page=100"
  if ($LASTEXITCODE -ne 0) { throw "GitHub artifact lookup failed." }
  $artifacts = @((ConvertFrom-Json ($artifactResponse -join "`n")).artifacts)
  if ($ArtifactName) {
    $matches = @($artifacts | Where-Object { $_.name -ceq $ArtifactName -and -not $_.expired })
  } else {
    $pattern = "^frozen-eight-(?:capture|freeze|low|medium)-$RunId-$RunAttempt$"
    $matches = @($artifacts | Where-Object { $_.name -match $pattern -and -not $_.expired })
  }
  if ($matches.Count -gt 1) {
    throw "More than one live encrypted frozen-eight artifact matched the run."
  }
  if ($matches.Count -eq 1) {
    $selectedArtifact = $matches[0]
    & $gh run download ([string]$RunId) --repo $Repository --name $selectedArtifact.name --dir $downloadDirectory
    if ($LASTEXITCODE -ne 0) { throw "GitHub artifact download failed." }
  } else {
    $remoteRoot = "runs/frozen-eight/$RunId-$RunAttempt"
    foreach ($name in @(
      "metadata.txt",
      "frozen-public-rag-review.tar.gz.enc",
      "frozen-public-rag-review.key-envelope.rsa-oaep"
    )) {
      Invoke-GhRawDownload `
        -GhPath $gh `
        -ApiPath "repos/$Repository/contents/$remoteRoot/$name`?ref=private-evaluation-results" `
        -Destination (Join-Path $downloadDirectory $name)
    }
  }

  $metadataFiles = @(Get-ChildItem -LiteralPath $downloadDirectory -Recurse -File -Filter metadata.txt)
  $cipherFiles = @(Get-ChildItem -LiteralPath $downloadDirectory -Recurse -File -Filter frozen-public-rag-review.tar.gz.enc)
  $envelopeFiles = @(Get-ChildItem -LiteralPath $downloadDirectory -Recurse -File -Filter frozen-public-rag-review.key-envelope.rsa-oaep)
  if ($metadataFiles.Count -ne 1 -or $cipherFiles.Count -ne 1 -or $envelopeFiles.Count -ne 1) {
    throw "Artifact must contain exactly one metadata, review cipher, and key envelope file."
  }
  $metadata = Read-ExactKeyValueFile -Path $metadataFiles[0].FullName -RequiredKeys @(
    "schema_version", "archive_cipher", "key_envelope", "source_sha", "stage",
    "source_key", "case_ids", "run_id", "run_attempt", "replay_allowed",
    "runner_exit_code", "review_cipher_sha256", "review_envelope_sha256"
  ) -OptionalKeys @("reusable_cipher_sha256", "reusable_hmac_sha256") -AllowEmptyKeys @("source_key", "case_ids")
  if ($metadata.schema_version -ne "1" -or
      $metadata.archive_cipher -ne "aes-256-cbc-pbkdf2-sha256-iter200000-saltlen8" -or
      $metadata.key_envelope -ne "rsa-oaep-sha256-mgf1-sha256" -or
      $metadata.source_sha -notmatch '^[a-f0-9]{40,64}$' -or
      $metadata.stage -notmatch '^(capture|freeze|low|medium)$' -or
      ($metadata.stage -match '^(capture|freeze)$' -and $metadata.source_key -ne "") -or
      ($metadata.stage -match '^(low|medium)$' -and $metadata.source_key -notmatch '^[1-9][0-9]*-[1-9][0-9]*$') -or
      ($metadata.stage -eq "capture" -and $metadata.case_ids -ne "") -or
      ($metadata.stage -ne "capture" -and $metadata.case_ids -notmatch '^case-[0-9]{3,}(,case-[0-9]{3,})*$') -or
      $metadata.run_id -ne ([string]$RunId) -or
      $metadata.run_attempt -ne ([string]$RunAttempt) -or
      $metadata.replay_allowed -notmatch '^(true|false)$' -or
      $metadata.runner_exit_code -notmatch '^[0-9]+$' -or
      $metadata.review_cipher_sha256 -notmatch '^[a-f0-9]{64}$' -or
      $metadata.review_envelope_sha256 -notmatch '^[a-f0-9]{64}$') {
    throw "Artifact metadata value validation failed."
  }
  if ((Get-Sha256Hex $cipherFiles[0].FullName) -cne $metadata.review_cipher_sha256 -or
      (Get-Sha256Hex $envelopeFiles[0].FullName) -cne $metadata.review_envelope_sha256) {
    throw "Artifact cipher or envelope digest does not match metadata."
  }

  if ($CertificateThumbprint) {
    $certificates = @(Get-ChildItem -LiteralPath Cert:\CurrentUser\My | Where-Object {
      $_.Thumbprint -ieq $CertificateThumbprint -and $_.HasPrivateKey
    })
  } else {
    $certificates = @(Get-ChildItem -LiteralPath Cert:\CurrentUser\My | Where-Object {
      $_.Subject -eq $certificateSubject -and $_.HasPrivateKey
    })
  }
  if ($certificates.Count -ne 1) { throw "Expected exactly one matching CurrentUser private evaluation certificate." }
  $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificates[0])
  try {
    if (-not $rsa -or $rsa.KeySize -lt 3072) { throw "Private evaluation RSA key is missing or too small." }
    $envelopeBytes = [IO.File]::ReadAllBytes($envelopeFiles[0].FullName)
    $envelopePlain = $rsa.Decrypt(
      $envelopeBytes,
      [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256
    )
  } finally {
    if ($rsa) { $rsa.Dispose() }
  }
  $envelopeText = [Text.Encoding]::UTF8.GetString($envelopePlain)
  $envelopePath = Join-Path $temporaryRoot "envelope.txt"
  [IO.File]::WriteAllText($envelopePath, $envelopeText, [Text.UTF8Encoding]::new($false))
  $envelope = Read-ExactKeyValueFile -Path $envelopePath -RequiredKeys @(
    "schema_version", "password", "cipher_sha256", "source_sha", "stage"
  )
  if ($envelope.schema_version -ne "1" -or
      $envelope.password -notmatch '^[a-f0-9]{64}$' -or
      $envelope.cipher_sha256 -cne $metadata.review_cipher_sha256 -or
      $envelope.source_sha -cne $metadata.source_sha -or
      $envelope.stage -cne $metadata.stage) {
    throw "Decrypted key envelope does not match the validated artifact metadata."
  }

  Invoke-OpenSslCompatibleAesDecrypt `
    -InputPath $cipherFiles[0].FullName `
    -OutputPath $plaintextArchive `
    -Password $envelope.password
  $tar = (Get-Command tar.exe -ErrorAction Stop).Source
  Assert-SafeReviewArchive -ArchivePath $plaintextArchive -TarPath $tar
  & $tar -xzf $plaintextArchive -C $extractDirectory
  if ($LASTEXITCODE -ne 0) { throw "Validated review archive extraction failed." }
  $reviewRoot = Join-Path $extractDirectory "frozen-eight-private-output"
  if (-not (Test-Path -LiteralPath $reviewRoot -PathType Container)) {
    throw "Validated review archive did not contain its expected root directory."
  }
  if (Get-ChildItem -LiteralPath $reviewRoot -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  }) {
    throw "Extracted review archive contains a reparse point."
  }
  $requiredReviewFiles = @("stage.txt", "runner.log", "exit-code.txt")
  $checkpointName = if ($metadata.stage -match '^(capture|freeze)$') { "snapshot.json" } else { "results.json" }
  if ([int]$metadata.runner_exit_code -eq 0) {
    $requiredReviewFiles += @("binding.txt", $checkpointName)
  }
  foreach ($name in $requiredReviewFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $reviewRoot $name) -PathType Leaf)) {
      throw "Extracted review archive is missing a required review file."
    }
  }
  $storedStage = [IO.File]::ReadAllText((Join-Path $reviewRoot "stage.txt")).Trim()
  if ($storedStage -cne $metadata.stage) {
    throw "Extracted review stage does not match artifact metadata."
  }
  $storedExitCode = [IO.File]::ReadAllText((Join-Path $reviewRoot "exit-code.txt")).Trim()
  if ($storedExitCode -cne $metadata.runner_exit_code) {
    throw "Extracted review exit code does not match artifact metadata."
  }
  $bindingPath = Join-Path $reviewRoot "binding.txt"
  if (Test-Path -LiteralPath $bindingPath -PathType Leaf) {
    $binding = Read-ExactKeyValueFile -Path $bindingPath -RequiredKeys @(
      "schema_version", "source_sha", "stage", "source_key", "run_id",
      "run_attempt", "case_ids", "replay_allowed", "target_sha256"
    ) -AllowEmptyKeys @("source_key", "case_ids")
    $checkpointPath = Join-Path $reviewRoot $checkpointName
    if (-not (Test-Path -LiteralPath $checkpointPath -PathType Leaf) -or
        $binding.schema_version -ne "1" -or
        $binding.source_sha -cne $metadata.source_sha -or
        $binding.stage -cne $metadata.stage -or
        $binding.source_key -cne $metadata.source_key -or
        $binding.run_id -cne $metadata.run_id -or
        $binding.run_attempt -cne $metadata.run_attempt -or
        $binding.case_ids -cne $metadata.case_ids -or
        $binding.replay_allowed -cne $metadata.replay_allowed -or
        $binding.target_sha256 -cne (Get-Sha256Hex $checkpointPath)) {
      throw "Extracted review binding does not match the validated artifact."
    }
  }
  $outputParent = Split-Path -Parent $outputPath
  if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    [IO.Directory]::CreateDirectory($outputParent) | Out-Null
  }
  $outputStagingPath = Join-Path $outputParent (".frozen-rag-review-" + [Guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($outputStagingPath) | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $reviewRoot -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $outputStagingPath -Recurse
  }
  Move-Item -LiteralPath $outputStagingPath -Destination $outputPath
  $outputStagingPath = $null
  Write-Host "Private review package decrypted to: $outputPath"
} catch {
  $operationFailure = $_.Exception
} finally {
  try {
    if ($outputStagingPath -and (Test-Path -LiteralPath $outputStagingPath)) {
      Remove-Item -LiteralPath $outputStagingPath -Recurse -Force -ErrorAction Stop
    }
  } catch {
    [void]$cleanupFailures.Add($_.Exception)
  }
  try {
    if (Test-Path -LiteralPath $temporaryRoot) {
      Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction Stop
    }
  } catch {
    [void]$cleanupFailures.Add($_.Exception)
  }
}
if ($operationFailure -and $cleanupFailures.Count -eq 0) {
  throw $operationFailure
}
if ($cleanupFailures.Count -gt 0) {
  $failures = [System.Collections.Generic.List[Exception]]::new()
  if ($operationFailure) { [void]$failures.Add($operationFailure) }
  foreach ($failure in $cleanupFailures) { [void]$failures.Add($failure) }
  $message = if ($operationFailure -and $cleanupFailures.Count -gt 0) {
    "Private review operation failed and one or more plaintext cleanup steps also failed."
  } else {
    "One or more private review plaintext cleanup steps failed."
  }
  throw [System.AggregateException]::new($message, $failures.ToArray())
}
