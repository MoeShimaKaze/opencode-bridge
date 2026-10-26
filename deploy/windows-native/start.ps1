param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [string]$SourceRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [int]$Port=4098,
    [switch]$NoPlatforms
)
$ErrorActionPreference='Stop'
$RuntimeRoot=[System.IO.Path]::GetFullPath($RuntimeRoot)
$SourceRoot=[System.IO.Path]::GetFullPath($SourceRoot)
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$recordFile=Join-Path $RuntimeRoot 'native-process.json'
if(Test-Path -LiteralPath $recordFile){
    $record=Get-Content -Raw -LiteralPath $recordFile | ConvertFrom-Json
    $proc=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if($proc -and $proc.Path -eq $record.executable){
        $details=Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
        if($details.CommandLine.Contains((Join-Path $SourceRoot 'deploy\windows-native\admin.mjs'))){
            $status=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/admin/bridge" -TimeoutSec 10
            if($status.running){Write-Output 'Native Bridge is already running.';return}
            $restart=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/admin/restart" -TimeoutSec 30
            if($restart.ok){Write-Output 'Native Bridge resumed in the existing management panel.';return}
            throw 'Unable to resume the managed Bridge'
        }
    }
}
if(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue){throw "Bridge port $Port is already occupied"}
if(-not(Test-Path -LiteralPath (Join-Path $SourceRoot 'dist\opencode\transport.js'))){throw 'Build the shared-session feature branch first'}
$nativeCli=Join-Path $env:APPDATA 'npm\opencode.cmd'
if(-not(Test-Path -LiteralPath $nativeCli)){$nativeCli=(Get-Command opencode.cmd -ErrorAction Stop).Source}
$version=(& $nativeCli --version | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $version -notmatch '2\.'){throw 'The native launcher requires the global OpenCode 2 CLI'}
$nativeUrl=(& $nativeCli service status | Out-String).Trim()
if($nativeUrl -eq 'stopped'){$nativeUrl=(& $nativeCli service start | Out-String).Trim()}
if($LASTEXITCODE -ne 0 -or $nativeUrl -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\]):\d+/?$'){throw 'Unable to discover the native OpenCode service URL'}
$serviceConfig=Join-Path $env:USERPROFILE '.config\opencode\service.json'
$credential=Get-Content -Raw -LiteralPath $serviceConfig | ConvertFrom-Json
if(-not $credential.password){throw 'The native OpenCode service password is missing'}
$env:OPENCODE_SERVER_PASSWORD=$credential.password
$env:OPENCODE_SERVER_USERNAME='opencode'
$env:NATIVE_OPENCODE_URL=$nativeUrl
$env:BRIDGE_RUNTIME_ROOT=$RuntimeRoot
$env:BRIDGE_SOURCE_ROOT=$SourceRoot
$env:OPENCODE_BRIDGE_CONFIG_DIR=Join-Path $RuntimeRoot 'data'
$env:OPENCODE_BRIDGE_DATA_ROOT=Join-Path $RuntimeRoot 'data'
$env:OPENCODE_BRIDGE_USER_DATA_ROOT=Join-Path $RuntimeRoot 'data\user-resources'
$env:ADMIN_PORT=[string]$Port
$env:ADMIN_HOST='127.0.0.1'
if($NoPlatforms){$env:DINGTALK_ENABLED='false';$env:FEISHU_ENABLED='false';$env:DISCORD_ENABLED='false';$env:WECOM_ENABLED='false';$env:TELEGRAM_ENABLED='false';$env:QQ_ENABLED='false';$env:WHATSAPP_ENABLED='false';$env:WEIXIN_ENABLED='false'}
$env:XDG_CONFIG_HOME=Join-Path $RuntimeRoot 'profile\config'
$env:XDG_DATA_HOME=Join-Path $RuntimeRoot 'profile\data'
$env:XDG_CACHE_HOME=Join-Path $RuntimeRoot 'profile\cache'
$env:XDG_STATE_HOME=Join-Path $RuntimeRoot 'profile\state'
$nodeExe=(Get-Command node.exe).Source
& $nodeExe (Join-Path $PSScriptRoot 'prepare.mjs')
if($LASTEXITCODE -ne 0){throw 'Native Bridge configuration failed'}
$adminEntry=Join-Path $PSScriptRoot 'admin.mjs'
$process=Start-Process -FilePath $nodeExe -ArgumentList ('"'+$adminEntry+'"') -WorkingDirectory $RuntimeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot 'logs\bridge.log') -RedirectStandardError (Join-Path $RuntimeRoot 'logs\bridge.err') -PassThru
@{pid=$process.Id;executable=$nodeExe;source=$SourceRoot;port=$Port} | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding utf8
for($attempt=0;$attempt -lt 60;$attempt++){
    if($process.HasExited){throw 'Native Bridge exited; inspect logs/bridge.err'}
    try{$status=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/admin/bridge" -TimeoutSec 2;if($status.running){Write-Output "Native Bridge is running at http://127.0.0.1:$Port";return}}catch{}
    Start-Sleep -Milliseconds 500
}
throw 'Native Bridge did not become ready within 30 seconds'
