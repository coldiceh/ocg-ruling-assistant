[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PublicKeyOutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$certificateSubject = "CN=YuGiOh Frozen Public RAG Review"
$certificateFriendlyName = "YuGiOh Frozen Public RAG Review"

function Join-ByteArrays {
  param([byte[][]] $Parts)
  $result = [System.Collections.Generic.List[byte]]::new()
  foreach ($part in $Parts) { $result.AddRange([byte[]] $part) }
  return ,$result.ToArray()
}

function Get-DerLength {
  param([int] $Length)
  if ($Length -lt 0x80) { return ,([byte[]]@($Length)) }
  $bytes = [System.Collections.Generic.List[byte]]::new()
  $remaining = $Length
  while ($remaining -gt 0) {
    $bytes.Insert(0, [byte]($remaining -band 0xff))
    $remaining = $remaining -shr 8
  }
  $prefix = [byte](0x80 -bor $bytes.Count)
  return ,(Join-ByteArrays -Parts ([byte[][]]@(([byte[]]@($prefix)), $bytes.ToArray())))
}

function New-DerObject {
  param([byte] $Tag, [byte[]] $Content)
  return ,(Join-ByteArrays -Parts ([byte[][]]@(
    ([byte[]]@($Tag)),
    (Get-DerLength -Length $Content.Length),
    $Content
  )))
}

function New-DerInteger {
  param([byte[]] $Value)
  $offset = 0
  while ($offset -lt ($Value.Length - 1) -and $Value[$offset] -eq 0) { $offset += 1 }
  [byte[]] $normalized = $Value[$offset..($Value.Length - 1)]
  if (($normalized[0] -band 0x80) -ne 0) {
    $normalized = Join-ByteArrays -Parts ([byte[][]]@(([byte[]]@(0)), $normalized))
  }
  return ,(New-DerObject -Tag 0x02 -Content $normalized)
}

function Convert-RsaPublicKeyToPem {
  param([System.Security.Cryptography.RSA] $Rsa)
  $parameters = $Rsa.ExportParameters($false)
  $rsaPublicKey = New-DerObject -Tag 0x30 -Content (
    Join-ByteArrays -Parts ([byte[][]]@(
      (New-DerInteger -Value $parameters.Modulus),
      (New-DerInteger -Value $parameters.Exponent)
    ))
  )
  [byte[]] $algorithmIdentifier = @(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  )
  $subjectPublicKey = New-DerObject -Tag 0x03 -Content (
    Join-ByteArrays -Parts ([byte[][]]@(([byte[]]@(0)), $rsaPublicKey))
  )
  $spki = New-DerObject -Tag 0x30 -Content (
    Join-ByteArrays -Parts ([byte[][]]@($algorithmIdentifier, $subjectPublicKey))
  )
  $base64 = [Convert]::ToBase64String($spki, [Base64FormattingOptions]::InsertLineBreaks)
  return "-----BEGIN PUBLIC KEY-----`r`n$base64`r`n-----END PUBLIC KEY-----`r`n"
}

$matches = @(Get-ChildItem -LiteralPath Cert:\CurrentUser\My | Where-Object {
  $_.Subject -eq $certificateSubject -and $_.HasPrivateKey
})
if ($matches.Count -gt 1) {
  throw "More than one long-term private evaluation certificate exists; select and remove the obsolete certificate manually."
}

$certificate = $matches | Select-Object -First 1
if (-not $certificate) {
  $certificate = New-SelfSignedCertificate `
    -Subject $certificateSubject `
    -FriendlyName $certificateFriendlyName `
    -CertStoreLocation Cert:\CurrentUser\My `
    -Provider "Microsoft Software Key Storage Provider" `
    -KeyProtection None `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -KeyUsage KeyEncipherment, DataEncipherment `
    -NotAfter (Get-Date).AddYears(10)
}

$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
try {
  if (-not $rsa -or $rsa.KeySize -lt 3072) {
    throw "The persisted certificate does not contain an RSA 3072-bit or stronger key."
  }
  $pem = Convert-RsaPublicKeyToPem -Rsa $rsa
} finally {
  if ($rsa) { $rsa.Dispose() }
}

$output = [IO.Path]::GetFullPath($PublicKeyOutputPath)
$parent = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
  [IO.Directory]::CreateDirectory($parent) | Out-Null
}
if (Test-Path -LiteralPath $output) {
  $existing = [IO.File]::ReadAllText($output)
  if ($existing -ne $pem) {
    throw "Public key output already exists with different content; choose another path for manual review."
  }
} else {
  [IO.File]::WriteAllText($output, $pem, [Text.UTF8Encoding]::new($false))
}

Write-Host "Long-term non-exportable RSA certificate is ready in Cert:\CurrentUser\My."
Write-Host "Public key exported for manual review: $output"
