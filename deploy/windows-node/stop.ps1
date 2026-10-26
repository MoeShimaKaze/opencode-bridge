$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot
$recordFile = Join-Path $runtimeRoot 'processes.json'
if (-not (Test-Path -LiteralPath $recordFile)) { Write-Output 'No managed process record.'; return }
$managed = Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
foreach ($entry in @($managed | Sort-Object { if ($_.role -eq 'bridge') { 0 } else { 1 } })) {
    $proc = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.Path -ne $entry.executable) { throw "Process identity changed for PID $($entry.pid)" }
    if ($entry.role -eq 'bridge') {
        $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.pid)"
        if (-not $details.CommandLine.Contains((Join-Path $runtimeRoot 'admin.mjs'))) { throw 'Bridge process identity changed' }
    }
    Stop-Process -Id $entry.pid
}
Remove-Item -LiteralPath $recordFile
Write-Output 'Managed Bridge and OpenCode processes stopped.'
