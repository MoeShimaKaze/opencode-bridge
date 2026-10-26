param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference='Stop'
$recordFile=Join-Path $RuntimeRoot 'native-process.json'
if(-not(Test-Path -LiteralPath $recordFile)){Write-Output 'No native Bridge process recorded.';return}
$record=Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
$proc=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if($proc){
    $details=Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
    if($proc.Path -ne $record.executable -or -not $details.CommandLine.Contains((Join-Path $record.source 'deploy\windows-native\admin.mjs'))){throw 'Managed Bridge process identity changed'}
    Stop-Process -Id $record.pid
}
Remove-Item -LiteralPath $recordFile
Write-Output 'Bridge stopped. The native OpenCode service remains running.'
