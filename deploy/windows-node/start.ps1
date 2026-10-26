$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot
Set-Location -LiteralPath $runtimeRoot
$recordFile = Join-Path $runtimeRoot 'processes.json'
if (Test-Path -LiteralPath $recordFile) {
    $managed = Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
    $verified = @($managed | Where-Object {
        $proc = Get-Process -Id $_.pid -ErrorAction SilentlyContinue
        $proc -and $proc.Path -eq $_.executable
    })
    if ($verified.Count -eq 2 -and ($verified.role -contains 'opencode') -and ($verified.role -contains 'bridge')) {
        $bridgeDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $(($verified | Where-Object { $_.role -eq 'bridge' }).pid)"
        if ($bridgeDetails.CommandLine.Contains((Join-Path $runtimeRoot 'admin.mjs'))) {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:4098/api/admin/bridge' -TimeoutSec 10
            if ($status.running) { Write-Output 'Bridge is already running.'; return }
        }
    }
}
& node (Join-Path $runtimeRoot 'prepare.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Bridge preparation failed' }
$env:OPENCODE_BRIDGE_CONFIG_DIR = Join-Path $runtimeRoot 'data'
$env:OPENCODE_BRIDGE_DATA_ROOT = Join-Path $runtimeRoot 'data'
$env:OPENCODE_BRIDGE_USER_DATA_ROOT = Join-Path $runtimeRoot 'data\user-resources'
$env:OPENCODE_CONFIG = Join-Path $runtimeRoot 'profile\opencode.json'
$env:OPENCODE_CONFIG_DIR = Join-Path $runtimeRoot 'profile'
$env:XDG_CONFIG_HOME = Join-Path $runtimeRoot 'profile\config'
$env:XDG_DATA_HOME = Join-Path $runtimeRoot 'profile\data'
$env:XDG_CACHE_HOME = Join-Path $runtimeRoot 'profile\cache'
$env:XDG_STATE_HOME = Join-Path $runtimeRoot 'profile\state'
$env:PATH = (Join-Path $runtimeRoot 'bin') + ';' + $env:PATH
$env:OPENCODE_SERVER_USERNAME = 'opencode'
$passwordOutput = & node (Join-Path $runtimeRoot 'read-server-password.cjs')
if ($LASTEXITCODE -ne 0 -or -not $passwordOutput) { throw 'Unable to load OpenCode server credentials' }
$env:OPENCODE_SERVER_PASSWORD = $passwordOutput.Trim()
$env:BRIDGE_EMBEDDED_MODE = '1'
$env:BRIDGE_SPAWNED_BY_ADMIN = '1'
$runtimeProcesses = @()
foreach ($port in @(4096,4098)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Do not start a second instance."
    }
}
$opencodeExe = Join-Path $runtimeRoot 'node_modules\opencode-windows-x64\bin\opencode.exe'
$oc = Start-Process -FilePath $opencodeExe -ArgumentList @('serve','--hostname','127.0.0.1','--port','4096') -WorkingDirectory $runtimeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'logs\opencode.log') -RedirectStandardError (Join-Path $runtimeRoot 'logs\opencode.err') -PassThru
$runtimeProcesses += @{ role='opencode'; pid=$oc.Id; executable=$opencodeExe }
ConvertTo-Json -InputObject @($runtimeProcesses) | Set-Content -LiteralPath (Join-Path $runtimeRoot 'processes.json') -Encoding utf8
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($oc.HasExited) { throw 'OpenCode exited. Check logs/opencode.err' }
    if (Get-NetTCPConnection -State Listen -LocalPort 4096 -ErrorAction SilentlyContinue) { $ready=$true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'OpenCode did not become ready. Check logs.' }
$nodeExe = (Get-Command node.exe).Source
$adminEntry = Join-Path $runtimeRoot 'admin.mjs'
$bridge = Start-Process -FilePath $nodeExe -ArgumentList ('"' + $adminEntry + '"') -WorkingDirectory $runtimeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'logs\bridge.log') -RedirectStandardError (Join-Path $runtimeRoot 'logs\bridge.err') -PassThru
$runtimeProcesses += @{ role='bridge'; pid=$bridge.Id; executable=$nodeExe }
ConvertTo-Json -InputObject @($runtimeProcesses) | Set-Content -LiteralPath (Join-Path $runtimeRoot 'processes.json') -Encoding utf8
Write-Output 'Started. Open http://127.0.0.1:4098 and add the DingTalk AppKey and AppSecret.'
