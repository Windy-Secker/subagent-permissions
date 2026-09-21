# parse-check.ps1 - report every syntax error in one PowerShell file, without running it.
param([Parameter(Mandatory = $true)][string]$Path)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Path).Path, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { Write-Output 'syntax OK'; exit 0 }
foreach ($item in $errors) {
    Write-Output ("{0}:{1}  {2}" -f $item.Extent.StartLineNumber, $item.Extent.StartColumnNumber, $item.Message)
}
exit 1
