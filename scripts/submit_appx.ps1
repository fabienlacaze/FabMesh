# submit_appx.ps1
# Automated Microsoft Store submission for MyFabmesh.AI.
# See docs/MS_STORE_AUTOMATION.md for the one-time Azure AD setup.
#
# Usage:
#   powershell -File scripts/submit_appx.ps1 -AppxPath "dist/installer/MyFabmesh.AI 1.0.1.appx"
#   powershell -File scripts/submit_appx.ps1 -AppxPath "..." -DryRun
#   powershell -File scripts/submit_appx.ps1 -AppxPath "..." -EnvFile ".env.staging"

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AppxPath,

    [Parameter(Mandatory = $false)]
    [string]$EnvFile = ".env",

    [switch]$DryRun
)

# ---------------------------------------------------------------------------
# TLS — older WinPS defaults to 1.0 which Microsoft rejects.
# ---------------------------------------------------------------------------
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
function Write-Phase {
    param([int]$Step, [string]$Message)
    Write-Host ""
    Write-Host ("==> Step {0}: {1}" -f $Step, $Message) -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message"
}

function Write-WarnLine {
    param([string]$Message)
    Write-Host "    WARN: $Message" -ForegroundColor Yellow
}

function Write-ErrLine {
    param([string]$Message)
    Write-Host "    ERROR: $Message" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# Step 1 — Load .env
# ---------------------------------------------------------------------------
Write-Phase 1 "Loading credentials from $EnvFile"

if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-ErrLine "Env file not found: $EnvFile"
    Write-ErrLine "Copy .env.example to .env and fill the values (see docs/MS_STORE_AUTOMATION.md)."
    exit 1
}

$envValues = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $trim = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trim)) { continue }
    if ($trim -match '^#') { continue }
    $idx = $trim.IndexOf('=')
    if ($idx -lt 1) { continue }
    $k = $trim.Substring(0, $idx).Trim()
    $v = $trim.Substring($idx + 1).Trim()
    # Strip surrounding quotes if present.
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or
        ($v.StartsWith("'") -and $v.EndsWith("'"))) {
        $v = $v.Substring(1, $v.Length - 2)
    }
    $envValues[$k] = $v
}

$required = @("MS_STORE_TENANT_ID", "MS_STORE_CLIENT_ID", "MS_STORE_CLIENT_SECRET", "MS_STORE_APPLICATION_ID")
$missing = @()
foreach ($k in $required) {
    if (-not $envValues.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($envValues[$k])) {
        $missing += $k
    }
}
if ($missing.Count -gt 0) {
    Write-ErrLine "Missing required env keys: $($missing -join ', ')"
    Write-ErrLine "See docs/MS_STORE_AUTOMATION.md."
    exit 1
}

$TenantId     = $envValues["MS_STORE_TENANT_ID"]
$ClientId     = $envValues["MS_STORE_CLIENT_ID"]
$ClientSecret = $envValues["MS_STORE_CLIENT_SECRET"]
$AppId        = $envValues["MS_STORE_APPLICATION_ID"]

Write-Info "Tenant:      $TenantId"
Write-Info "Client:      $ClientId"
Write-Info "Application: $AppId"

# ---------------------------------------------------------------------------
# Step 2 — Verify the .appx exists
# ---------------------------------------------------------------------------
Write-Phase 2 "Verifying appx package"

if (-not (Test-Path -LiteralPath $AppxPath)) {
    Write-ErrLine "Appx package not found: $AppxPath"
    exit 1
}

$appxFile = Get-Item -LiteralPath $AppxPath
$appxName = $appxFile.Name
$appxSizeMB = [math]::Round($appxFile.Length / 1MB, 2)
Write-Info "Package: $appxName ($appxSizeMB MB)"

# ---------------------------------------------------------------------------
# Step 3 — OAuth token
# ---------------------------------------------------------------------------
Write-Phase 3 "Requesting OAuth token from login.microsoftonline.com"

$tokenUrl = "https://login.microsoftonline.com/$TenantId/oauth2/token"
$tokenBody = @{
    grant_type    = "client_credentials"
    client_id     = $ClientId
    client_secret = $ClientSecret
    resource      = "https://manage.devcenter.microsoft.com"
}

try {
    $tokenResp = Invoke-RestMethod -Method Post -Uri $tokenUrl -Body $tokenBody -ErrorAction Stop
}
catch {
    Write-ErrLine "OAuth request failed: $($_.Exception.Message)"
    Write-ErrLine "Check MS_STORE_TENANT_ID / MS_STORE_CLIENT_ID / MS_STORE_CLIENT_SECRET."
    exit 1
}

$accessToken = $tokenResp.access_token
if ([string]::IsNullOrWhiteSpace($accessToken)) {
    Write-ErrLine "Token response had no access_token field."
    exit 1
}
Write-Info "Token acquired (expires in $($tokenResp.expires_in) s)."

# ---------------------------------------------------------------------------
# Header builder
# ---------------------------------------------------------------------------
function New-AuthHeaders {
    return @{
        Authorization  = "Bearer $accessToken"
        "Content-Type" = "application/json"
    }
}

$apiBase = "https://manage.devcenter.microsoft.com/v1.0/my/applications/$AppId"

# ---------------------------------------------------------------------------
# Step 4 — Fetch app metadata
# ---------------------------------------------------------------------------
Write-Phase 4 "Fetching application metadata"

try {
    $appMeta = Invoke-RestMethod -Method Get -Uri $apiBase -Headers (New-AuthHeaders) -ErrorAction Stop
}
catch {
    Write-ErrLine "Failed to fetch app metadata: $($_.Exception.Message)"
    if ($_.Exception.Response.StatusCode.value__ -eq 403) {
        Write-ErrLine "403 — Partner Center role is probably too low. Must be Manager."
    }
    exit 1
}

Write-Info "App: $($appMeta.primaryName)"

$pendingId = $null
if ($appMeta.pendingApplicationSubmission -and $appMeta.pendingApplicationSubmission.id) {
    $pendingId = $appMeta.pendingApplicationSubmission.id
    Write-WarnLine "An in-progress submission already exists: $pendingId"
}
else {
    Write-Info "No pending submission."
}

# ---------------------------------------------------------------------------
# Step 5 — Handle pending submission
# ---------------------------------------------------------------------------
if ($pendingId) {
    Write-Phase 5 "Handling existing pending submission"

    if ($DryRun) {
        Write-Info "[DryRun] Would prompt the user to delete pending submission $pendingId."
    }
    else {
        $answer = Read-Host "Delete pending submission $pendingId and create a fresh one? (y/N)"
        if ($answer -notmatch '^[Yy]') {
            Write-ErrLine "Aborted by user."
            exit 1
        }
        try {
            Invoke-RestMethod -Method Delete -Uri "$apiBase/submissions/$pendingId" -Headers (New-AuthHeaders) -ErrorAction Stop | Out-Null
            Write-Info "Pending submission deleted."
        }
        catch {
            Write-ErrLine "Failed to delete pending submission: $($_.Exception.Message)"
            exit 1
        }
    }
}

# ---------------------------------------------------------------------------
# DryRun short-circuit
# ---------------------------------------------------------------------------
if ($DryRun) {
    Write-Phase 6 "[DryRun] Would create a new submission"
    Write-Info "Would upload: $appxName ($appxSizeMB MB)"
    Write-Info "Would target application: $AppId"
    Write-Info "Stopping here (DryRun mode). No submission was created."
    Write-Host ""
    Write-Host "Credentials and Partner Center role look healthy." -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# Step 6 — Create new submission
# ---------------------------------------------------------------------------
Write-Phase 6 "Creating new submission"

try {
    $submission = Invoke-RestMethod -Method Post -Uri "$apiBase/submissions" -Headers (New-AuthHeaders) -ErrorAction Stop
}
catch {
    Write-ErrLine "Failed to create submission: $($_.Exception.Message)"
    if ($_.Exception.Response.StatusCode.value__ -eq 409) {
        Write-ErrLine "409 — a submission is still in progress. Re-run; the script will offer to delete it."
    }
    exit 1
}

$submissionId   = $submission.id
$fileUploadUrl  = $submission.fileUploadUrl
Write-Info "Submission ID:   $submissionId"
Write-Info "File upload URL: (SAS, $($fileUploadUrl.Length) chars)"

# ---------------------------------------------------------------------------
# Step 7 — Download the previous submission zip (clone-from-last basis)
# ---------------------------------------------------------------------------
Write-Phase 7 "Downloading previous submission zip"

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("msstore_" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$zipPath = Join-Path $tmpDir "submission.zip"

$zipDownloaded = $false
try {
    Invoke-WebRequest -Uri $fileUploadUrl -OutFile $zipPath -ErrorAction Stop | Out-Null
    if ((Get-Item -LiteralPath $zipPath).Length -gt 0) {
        $zipDownloaded = $true
        Write-Info "Previous zip downloaded ($([math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)) MB)."
    }
}
catch {
    Write-WarnLine "Could not download previous zip (likely first submission): $($_.Exception.Message)"
}

if (-not $zipDownloaded) {
    Write-Info "Building a fresh zip from scratch."
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    $fs = [System.IO.File]::Create($zipPath)
    $newZip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    $newZip.Dispose()
    $fs.Dispose()
}

# ---------------------------------------------------------------------------
# Step 8 — Replace .appx inside the zip
# ---------------------------------------------------------------------------
Write-Phase 8 "Patching zip with new appx"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
$zip = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    $toRemove = @()
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName -match '\.appx(bundle)?$') {
            $toRemove += $entry
        }
    }
    foreach ($entry in $toRemove) {
        Write-Info "Removing old entry: $($entry.FullName)"
        $entry.Delete()
    }

    $newEntry = $zip.CreateEntry($appxName, [System.IO.Compression.CompressionLevel]::Optimal)
    $newEntryStream = $newEntry.Open()
    $sourceStream = [System.IO.File]::OpenRead($appxFile.FullName)
    try {
        $sourceStream.CopyTo($newEntryStream)
    }
    finally {
        $sourceStream.Dispose()
        $newEntryStream.Dispose()
    }
    Write-Info "Added entry: $appxName"
}
finally {
    $zip.Dispose()
    $zipStream.Dispose()
}

# ---------------------------------------------------------------------------
# Step 9 — Patch submission JSON (applicationPackages)
# ---------------------------------------------------------------------------
Write-Phase 9 "Updating submission package list"

$existingPackages = @()
if ($submission.applicationPackages) {
    $existingPackages = $submission.applicationPackages
}

# Mark every existing entry as PendingDelete so the new build replaces them.
foreach ($pkg in $existingPackages) {
    if ($pkg.fileStatus -ne "PendingDelete") {
        $pkg.fileStatus = "PendingDelete"
    }
}

$newPkg = @{
    fileName   = $appxName
    fileStatus = "PendingUpload"
    languages  = @("en-us")
}

# Convert to a plain array so we can append.
$updatedPackages = @()
foreach ($pkg in $existingPackages) { $updatedPackages += $pkg }
$updatedPackages += $newPkg

$submission.applicationPackages = $updatedPackages

$submissionJson = $submission | ConvertTo-Json -Depth 20

try {
    Invoke-RestMethod -Method Put -Uri "$apiBase/submissions/$submissionId" `
        -Headers (New-AuthHeaders) -Body $submissionJson -ErrorAction Stop | Out-Null
    Write-Info "Submission JSON patched."
}
catch {
    Write-ErrLine "Failed to PUT submission update: $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------
# Step 10 — Upload the zip
# ---------------------------------------------------------------------------
Write-Phase 10 "Uploading zip to Azure Blob"

$uploadHeaders = @{ "x-ms-blob-type" = "BlockBlob" }
try {
    Invoke-WebRequest -Method Put -Uri $fileUploadUrl -InFile $zipPath `
        -Headers $uploadHeaders -ContentType "application/zip" -ErrorAction Stop | Out-Null
    Write-Info "Upload complete."
}
catch {
    Write-ErrLine "Zip upload failed: $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------
# Step 11 — Commit the submission
# ---------------------------------------------------------------------------
Write-Phase 11 "Committing submission"

try {
    $commitResp = Invoke-RestMethod -Method Post -Uri "$apiBase/submissions/$submissionId/commit" `
        -Headers (New-AuthHeaders) -ErrorAction Stop
    Write-Info "Commit accepted. Initial status: $($commitResp.status)"
}
catch {
    Write-ErrLine "Commit failed: $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------
# Step 12 — Poll status
# ---------------------------------------------------------------------------
Write-Phase 12 "Polling submission status (every 30 s)"

$terminalStates = @("Certification", "Release", "Published", "Failed", "Canceled")
$maxPolls = 40   # ~20 minutes hard cap; cert itself takes 24-48 h.
$poll = 0
$lastStatus = ""
while ($true) {
    Start-Sleep -Seconds 30
    $poll++
    try {
        $statusResp = Invoke-RestMethod -Method Get -Uri "$apiBase/submissions/$submissionId/status" `
            -Headers (New-AuthHeaders) -ErrorAction Stop
    }
    catch {
        Write-WarnLine "Status poll $poll failed: $($_.Exception.Message). Retrying."
        continue
    }
    $current = $statusResp.status
    if ($current -ne $lastStatus) {
        Write-Info "Status: $current"
        $lastStatus = $current
    }
    if ($terminalStates -contains $current) {
        Write-Info "Reached terminal/handed-off state: $current"
        break
    }
    if ($poll -ge $maxPolls) {
        Write-WarnLine "Reached polling cap ($maxPolls iterations). Submission is still progressing — check the dashboard."
        break
    }
}

# ---------------------------------------------------------------------------
# Step 13 — Final URL
# ---------------------------------------------------------------------------
Write-Phase 13 "Done"

$dashUrl = "https://partner.microsoft.com/dashboard/products/$AppId/overview"
Write-Host ""
Write-Host "Submission $submissionId committed for application $AppId." -ForegroundColor Green
Write-Host "Monitor certification at:" -ForegroundColor Green
Write-Host "  $dashUrl" -ForegroundColor Green
Write-Host ""

# Cleanup temp.
try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
