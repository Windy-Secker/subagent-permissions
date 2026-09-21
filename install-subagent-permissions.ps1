# install-subagent-permissions.ps1 - install per-subagent file permissions into dsh.
#
# Two halves, both required (see README.zh.md for the full design):
#
#   1. a code patch to two installed dsh packages
#        @deepseek-ai/dsh-subagent       (choose the child's cwd, append its sandbox mode)
#        @deepseek-ai/dsh-tool-subagent  (advertise + validate delegate_permissions)
#      applied in place, from pristine backups kept in this workspace;
#   2. a plugin mounted in the profile (dsh-subagent-permissions) that owns the
#      audit trail, the deployment-level containment policy and the feature switch.
#
# NOTHING happens without -Apply. The default is a dry run that only reports.
# After -Apply you MUST restart the dsh process: patchReload re-imports nothing.
#
# Usage:
#   pwsh -File install-subagent-permissions.ps1                 # dry run: report what would change
#   pwsh -File install-subagent-permissions.ps1 -Apply          # patch + mount, then restart dsh
#   pwsh -File install-subagent-permissions.ps1 -Verify         # check the installed state, change nothing
#   pwsh -File install-subagent-permissions.ps1 -Test           # offline test suite, change nothing
#   pwsh -File install-subagent-permissions.ps1 -FilesOnly      # ship new plugin code, leave the mount alone
#   pwsh -File install-subagent-permissions.ps1 -Restore        # put the ORIGINAL packages back
#   pwsh -File install-subagent-permissions.ps1 -Remove         # unmount the plugin (code patch stays)
param(
    [switch]$Apply,
    [switch]$Verify,
    [switch]$Test,
    [switch]$FilesOnly,
    [switch]$Restore,
    [switch]$Remove,
    [string]$Profile = 'web',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell's Get-Content/Set-Content default to the ANSI code page, which
# silently mangles non-ASCII text. Every read and write here goes through UTF-8
# explicitly, and THIS FILE is deliberately ASCII-only so it survives any codepage.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8) }

$here = $PSScriptRoot
$pluginSource = Join-Path $here 'dsh-subagent-permissions'
$patchScript = Join-Path $here 'patch.mjs'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$pluginTarget = Join-Path $profileDir 'node_modules\dsh-subagent-permissions'
$mountId = 'subagent-permissions'

if (-not (Test-Path $pluginSource)) { throw "plugin source not found: $pluginSource" }
if (-not (Test-Path $patchScript)) { throw "patch script not found: $patchScript" }

# ---------------------------------------------------------------------------
# locate every installed copy of the two packages that could get loaded
# ---------------------------------------------------------------------------

# Every file the patch table touches, with the string that proves it is patched.
# Keep in sync with patch.mjs PATCHES. The marker differs per file: the two
# call-site-only edits add no carrier identifier, so a single global marker would
# under-count them (which is exactly what an early -Verify did: 3/5).
$patchedFiles = [ordered]@{
    'dsh-subagent\lib\index.js'                          = 'DELEGATED_PERMISSIONS_KEY'
    'dsh-subagent\lib\types\child-agent.js'              = 'DELEGATED_PERMISSIONS_KEY'
    'dsh-subagent\lib\types\continuation-activation.js'  = 'applyChildComposition(childCtx, parent, inputs.composition, child.session)'
    'dsh-tool-subagent\lib\index.js'                     = 'DELEGATED_PERMISSIONS_KEY'
    'dsh-subagent-in-process-driver\lib\index.js'        = 'child.session);'
}
$patchFileCount = $patchedFiles.Count

function Get-CandidateSites {
    $sites = New-Object System.Collections.Generic.List[string]
    $roots = @()
    if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh') }
    if ($env:USERPROFILE) { $roots += (Join-Path $env:USERPROFILE 'AppData\Roaming\npm\node_modules\@deepseek-ai\dsh') }
    $roots += (Join-Path $profileDir '.dsh-module-fallback')
    $roots += $profileDir
    foreach ($root in $roots) {
        $candidate = Join-Path $root 'node_modules\@deepseek-ai'
        # A site qualifies only when every package this patch targets is present:
        # patching half a site is exactly the partial state -Verify refuses.
        $complete = $true
        foreach ($package in @('dsh-subagent', 'dsh-tool-subagent', 'dsh-subagent-in-process-driver')) {
            if (-not (Test-Path (Join-Path $candidate "$package\lib\index.js"))) { $complete = $false; break }
        }
        if (-not $complete) { continue }
        # APPDATA and USERPROFILE usually name the same npm prefix; do not report
        # (or patch) one installation twice.
        $full = (Resolve-Path $candidate).Path
        if (-not $sites.Contains($full)) { $sites.Add($full) }
    }
    return $sites
}

function Get-PatchState([string]$scope) {
    $patched = 0
    foreach ($relative in $patchedFiles.Keys) {
        $path = Join-Path $scope $relative
        if (-not (Test-Path $path)) { continue }
        if ((Read-Text $path).Contains($patchedFiles[$relative])) { $patched++ }
    }
    return $patched
}

function Invoke-PatchScript([string]$scope, [string[]]$arguments) {
    $previous = $env:DSH_NODE_MODULES
    $env:DSH_NODE_MODULES = $scope
    try {
        & node $patchScript @arguments
        if ($LASTEXITCODE -ne 0) { throw "patch.mjs failed for $scope" }
    } finally {
        $env:DSH_NODE_MODULES = $previous
    }
}

# ---------------------------------------------------------------------------
# the plugin mount in cordis.patch.yml
# ---------------------------------------------------------------------------

function Get-MountBlock {
    $auditPath = (Join-Path $DshHome 'subagent-permissions.audit.jsonl')
    $lines = @(
        '- insert:',
        '    - id: subagent-permissions',
        "      name: 'dsh-subagent-permissions'",
        '      config:',
        '        # The plugin claims the carrier sink, which is what makes the patched',
        '        # subagent tool advertise the delegate_permissions arguments at all.',
        '        delegatePermissions: true',
        '        # Append one JSONL record per delegation. Set false to keep it silent.',
        '        auditLog: true',
        "        auditFile: '$auditPath'",
        '        # Optional: fence every delegated writable_root under one base directory.',
        '        # When omitted, the patch only requires the root to be inside a root the',
        '        # delegating session may itself write under.',
        '        # writableRootBase: D:/path/to/delegation-base'
    )
    return ($lines -join "`n")
}

function Set-Mount([bool]$present) {
    if (-not (Test-Path $patchPath)) { throw "profile patch not found: $patchPath" }
    $text = Read-Text $patchPath
    $block = Get-MountBlock
    $hasBlock = $text.Contains("id: $mountId")
    if ($present -and -not $hasBlock) {
        $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $patchPath $backup
        Write-Text $patchPath (($text.TrimEnd()) + "`n`n" + $block + "`n")
        Write-Output "mounted   $mountId in $patchPath (backup $backup)"
        return
    }
    if ((-not $present) -and $hasBlock) {
        $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $patchPath $backup
        $kept = New-Object System.Collections.Generic.List[string]
        $skipping = $false
        foreach ($line in ($text -split "`n")) {
            if ($line -match "^\s*-\s*insert:\s*$") { $skipping = $false }
            if ($line -match "^\s*-\s*id:\s*$mountId\s*$") { $skipping = $true; continue }
            if ($skipping -and $line -match "^\s*-\s") { $skipping = $false }
            if (-not $skipping) { $kept.Add($line) }
        }
        Write-Text $patchPath (($kept -join "`n").TrimEnd() + "`n")
        Write-Output "unmounted $mountId from $patchPath (backup $backup)"
        return
    }
    Write-Output "mount     $mountId already $(if ($present) { 'present' } else { 'absent' })"
}

# ---------------------------------------------------------------------------
# modes
# ---------------------------------------------------------------------------

if ($Test) {
    Push-Location $here
    try {
        Write-Output '--- patch anchors'
        & node $patchScript --check
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Output '--- seam behaviour'
        & node (Join-Path $here 'test\plant.mjs')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & node (Join-Path $here 'test\seam.test.mjs')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally { Pop-Location }
    exit 0
}

$sites = Get-CandidateSites
if ($sites.Count -eq 0) { throw 'no installed @deepseek-ai/dsh-subagent found; is dsh installed for this user?' }

if ($Verify) {
    $ok = $true
    foreach ($scope in $sites) {
        $patched = Get-PatchState $scope
        Write-Output "packages  $scope -> $patched/$patchFileCount patched"
        if ($patched -ne $patchFileCount) { $ok = $false }
    }
    if (Test-Path (Join-Path $pluginTarget 'lib\index.js')) { Write-Output "plugin    installed at $pluginTarget" }
    else { Write-Output "plugin    MISSING at $pluginTarget"; $ok = $false }
    if ((Test-Path $patchPath) -and (Read-Text $patchPath).Contains("id: $mountId")) { Write-Output "mount     present in $patchPath" }
    else { Write-Output "mount     MISSING in $patchPath"; $ok = $false }
    exit ([int](-not $ok))
}

if ($Restore) {
    foreach ($scope in $sites) {
        Invoke-PatchScript $scope @('--revert')
    }
    Write-Output 'restored. Restart dsh for the original code to take effect.'
    exit 0
}

if ($Remove) {
    Set-Mount $false
    if (Test-Path $pluginTarget) { Remove-Item -Recurse -Force $pluginTarget; Write-Output "removed   $pluginTarget" }
    Write-Output 'restart dsh to unload the plugin. The code patch stays applied until -Restore.'
    exit 0
}

# default path: report, or apply when -Apply is given
if ($Apply) {
    # The plugin first: it claims the carrier sink, which is what makes the patch
    # advertise the arguments.
    if (-not $FilesOnly) {
        New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
        Copy-Item (Join-Path $pluginSource 'lib') $pluginTarget -Recurse -Force
        Copy-Item (Join-Path $pluginSource 'package.json') $pluginTarget -Force
        Write-Output "plugin    installed at $pluginTarget"
        Set-Mount $true
    } else {
        Write-Output 'plugin    -FilesOnly: profile patch left untouched'
    }
    foreach ($scope in $sites) {
        $patched = Get-PatchState $scope
        if ($patched -eq 2) { Write-Output "packages  $scope -> already patched"; continue }
        if ($patched -ne 0) {
            Write-Output "packages  $scope -> PARTIALLY patched ($patched/$patchFileCount); restore with -Restore before applying again"
            continue
        }
        Invoke-PatchScript $scope @()
    }
    Write-Output ''
    Write-Output 'NEXT: restart the dsh process. patchReload does NOT re-import modules, so the'
    Write-Output 'patched packages and this plugin only take effect on a fresh start.'
    Write-Output 'Then verify with:  pwsh -File install-subagent-permissions.ps1 -Verify'
    exit 0
}

foreach ($scope in $sites) {
    $patched = Get-PatchState $scope
    $state = switch ($patched) { 0 { "would patch $patchFileCount/$patchFileCount file(s)" } $patchFileCount { 'already patched' } default { "PARTIALLY patched ($patched/$patchFileCount)" } }
    Write-Output "packages  $scope -> $state"
}
if (Test-Path (Join-Path $pluginTarget 'lib\index.js')) { Write-Output "plugin    already installed at $pluginTarget" }
else { Write-Output "plugin    would install to $pluginTarget" }
if ((Test-Path $patchPath) -and (Read-Text $patchPath).Contains("id: $mountId")) { Write-Output "mount     already present in $patchPath" }
else { Write-Output "mount     would add id: $mountId to $patchPath" }

Write-Output ''
Write-Output 'dry run: nothing was changed. Re-run with -Apply to patch and mount.'
