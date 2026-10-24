param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'codex-context-pruner'),
    [string[]]$ProfilePaths = @(
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PowerShell\profile.ps1'),
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\profile.ps1')
    )
)

$ErrorActionPreference = 'Stop'
$prunerBuildDirectory = Join-Path $PSScriptRoot 'dist'
$prunerEntryPath = Join-Path $prunerBuildDirectory 'stock-launch.mjs'
if (-not (Test-Path -LiteralPath $prunerEntryPath)) {
    throw 'Build apps/codex before installing the launcher.'
}
$prunerStockCommand = Get-Command codex.cmd -CommandType Application -ErrorAction Stop
$prunerStockEntry = Join-Path (Split-Path -Parent $prunerStockCommand.Path) 'node_modules\@openai\codex\bin\codex.js'
if (-not (Test-Path -LiteralPath $prunerStockEntry)) {
    throw 'The canonical npm Codex launcher was not found.'
}
$prunerResolvedInstall = [System.IO.Path]::GetFullPath($InstallDirectory)
if ($prunerResolvedInstall -eq [System.IO.Path]::GetPathRoot($prunerResolvedInstall)) {
    throw 'InstallDirectory must be a dedicated user directory.'
}
[void](New-Item -ItemType Directory -Path $prunerResolvedInstall -Force)
$prunerFiles = @(Get-ChildItem -LiteralPath $prunerBuildDirectory -File -Filter '*.mjs')
foreach ($prunerFile in $prunerFiles) {
    Copy-Item -LiteralPath $prunerFile.FullName -Destination (Join-Path $prunerResolvedInstall $prunerFile.Name) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.txt') -Destination (Join-Path $prunerResolvedInstall 'THIRD_PARTY_NOTICES.txt') -Force
$prunerInstalledEntry = (Join-Path $prunerResolvedInstall 'stock-launch.mjs').Replace("'", "''")
$prunerManagedBlock = @'
# BEGIN agent-context-pruner stock Codex launcher
function global:codex {
    $prunerStockShim = Get-Command codex.cmd -CommandType Application -ErrorAction Stop
    $prunerStockScript = Join-Path (Split-Path -Parent $prunerStockShim.Path) 'node_modules\@openai\codex\bin\codex.js'
    $prunerInstalledLauncher = '__PRUNER_ENTRY__'
    if (Test-Path -LiteralPath $prunerInstalledLauncher) {
        & node $prunerInstalledLauncher $prunerStockScript @args
    } else {
        & $prunerStockShim.Path @args
    }
}
# END agent-context-pruner stock Codex launcher
'@
$prunerManagedBlock = $prunerManagedBlock.Replace('__PRUNER_ENTRY__', $prunerInstalledEntry)
$prunerBlockPattern = '(?ms)^# BEGIN agent-context-pruner stock Codex launcher\r?\n.*?^# END agent-context-pruner stock Codex launcher\r?\n?'
$prunerUtf8 = New-Object System.Text.UTF8Encoding($true)
$prunerStrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$prunerPlans = foreach ($prunerProfilePath in $ProfilePaths) {
    $prunerResolvedProfile = [System.IO.Path]::GetFullPath($prunerProfilePath)
    if (Test-Path -LiteralPath $prunerResolvedProfile -PathType Container) { throw 'A profile path points to a directory.' }
    $prunerExistingProfile = ''
    $prunerOriginalBytes = $null
    if (Test-Path -LiteralPath $prunerResolvedProfile) {
        $prunerOriginalBytes = [System.IO.File]::ReadAllBytes($prunerResolvedProfile)
        $prunerReader = New-Object System.IO.StreamReader($prunerResolvedProfile, $prunerStrictUtf8, $true)
        try { $prunerExistingProfile = $prunerReader.ReadToEnd() } catch { throw ('Convert this profile to UTF-8 with BOM before installing: ' + $prunerResolvedProfile) } finally { $prunerReader.Dispose() }
    }
    $prunerHasStart = $prunerExistingProfile.Contains('# BEGIN agent-context-pruner stock Codex launcher')
    $prunerHasEnd = $prunerExistingProfile.Contains('# END agent-context-pruner stock Codex launcher')
    if ($prunerHasStart -ne $prunerHasEnd) { throw 'The existing launcher block is incomplete; inspect the profile before replacing it.' }
    $prunerOutsideBlock = [regex]::Replace($prunerExistingProfile, $prunerBlockPattern, '')
    $prunerSavedProfile = $prunerOutsideBlock.TrimEnd([char]13, [char]10) + "`r`n`r`n" + $prunerManagedBlock + "`r`n"
    $prunerTokens = $null
    $prunerParseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($prunerSavedProfile, [ref]$prunerTokens, [ref]$prunerParseErrors)
    if ($prunerParseErrors.Count -gt 0) { throw 'The modified PowerShell profile did not parse.' }
    [pscustomobject]@{ Path = $prunerResolvedProfile; Original = $prunerOriginalBytes; Existing = $prunerExistingProfile; Text = $prunerSavedProfile; Backup = $null }
}
$prunerWrittenProfiles = @()
try {
    foreach ($prunerPlan in $prunerPlans) {
        [void](New-Item -ItemType Directory -Path (Split-Path -Parent $prunerPlan.Path) -Force)
        if ($null -ne $prunerPlan.Original -and $prunerPlan.Text -ne $prunerPlan.Existing) {
            $prunerPlan.Backup = $prunerPlan.Path + '.before-context-pruner-' + [guid]::NewGuid().ToString('N') + '.bak'
            Copy-Item -LiteralPath $prunerPlan.Path -Destination $prunerPlan.Backup
        }
        $prunerWrittenProfiles += $prunerPlan
        [System.IO.File]::WriteAllText($prunerPlan.Path, $prunerPlan.Text, $prunerUtf8)
        $prunerReadBack = [System.IO.File]::ReadAllText($prunerPlan.Path)
        if ($prunerReadBack -ne $prunerPlan.Text -or ([regex]::Matches($prunerReadBack, $prunerBlockPattern)).Count -ne 1) {
            throw 'Profile installation verification failed.'
        }
    }
} catch {
    foreach ($prunerPlan in $prunerWrittenProfiles) {
        if ($null -ne $prunerPlan.Original) {
            [System.IO.File]::WriteAllBytes($prunerPlan.Path, $prunerPlan.Original)
        } else {
            [System.IO.File]::Delete($prunerPlan.Path)
        }
    }
    throw
}
$prunerReceipts = foreach ($prunerPlan in $prunerPlans) {
    [pscustomobject]@{ Profile = $prunerPlan.Path; Backup = $prunerPlan.Backup; Verified = $true }
}
$prunerReceipts | ConvertTo-Json -Depth 3
