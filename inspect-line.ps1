# inspect-line.ps1 - show the exact characters of one line, for parser debugging.
param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][int]$Line)
$lines = [System.IO.File]::ReadAllLines((Resolve-Path $Path).Path, [System.Text.Encoding]::UTF8)
$text = $lines[$Line - 1]
Write-Output ("length {0}" -f $text.Length)
for ($i = 0; $i -lt $text.Length; $i++) {
    $code = [int][char]$text[$i]
    Write-Output ("{0,3}  {1,5}  {2}  {3}" -f ($i + 1), $code, $text[$i], $(if ($code -lt 32 -or $code -gt 126) { '<-- non-ASCII/control' } else { '' }))
}
