# revert-subagent-permissions.ps1 - put dsh back exactly the way it was, in the
# ONE order that recovers a broken boot.
#
# WHEN TO RUN THIS
#   dsh fails to start, or a session shows "Session failed to resume" / a loader
#   error, and you want the previous state back right now.
#
# WHAT IT DOES
#   1. unmounts the plugin and deletes it from the profile;
#   2. restores every patched package file from the pristine copies in backup\;
#   3. tells you to restart dsh.
#   Both steps are idempotent: a missing mount, a missing plugin directory or a
#   missing backup is reported, not treated as a failure.
#
# Usage:
#   pwsh -File revert-subagent-permissions.ps1            # do it
#   pwsh -File revert-subagent-permissions.ps1 -DryRun    # show what would happen
#
# Read install-subagent-permissions.ps1's own switches for the finer-grained modes
# (-Remove only unmounts, -Restore only restores the packages).
param(
    [switch]$DryRun,
    [string]$Profile = 'web',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$installer = Join-Path $here 'install-subagent-permissions.ps1'
if (-not (Test-Path $installer)) { throw "installer not found next to this script: $installer" }

function Invoke-Step([string]$label, [string[]]$arguments) {
    if ($DryRun) {
        Write-Output "WOULD $label  (would run: powershell -File install-subagent-permissions.ps1 $($arguments -join ' '))"
        return
    }
    Write-Output "--- $label"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installer @arguments
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

Write-Output 'Reverting per-subagent file permissions to the pre-install state.'
Write-Output "  profile : $DshHome\profiles\$Profile"
Write-Output "  backups : $here\backup"
Write-Output ''

# Unmount FIRST: while the mount row exists, dsh would load a plugin whose patch
# is already gone (or whose schema it may reject); removing the row and the plugin
# directory makes the next boot independent of both.
Invoke-Step 'unmount the plugin and delete it' @('-Remove', '-Profile', $Profile, '-DshHome', $DshHome)
Invoke-Step 'restore every patched package file from backup' @('-Restore', '-Profile', $Profile, '-DshHome', $DshHome)

Write-Output ''
if ($DryRun) {
    Write-Output 'dry run: nothing changed. Re-run without -DryRun to revert.'
    exit 0
}
Write-Output 'RESTART dsh now. The patched modules were already loaded by the running'
Write-Output 'process, so nothing changes until the process restarts.'
Write-Output ''
Write-Output 'After the restart, confirm the revert with:'
Write-Output '  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-subagent-permissions.ps1 -Verify'
Write-Output '  (expect: 0/5 patched, plugin MISSING, mount MISSING)'
