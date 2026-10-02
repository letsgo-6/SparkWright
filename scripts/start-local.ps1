$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appRoot
if (-not (Test-Path -LiteralPath 'node_modules/tsx/dist/cli.mjs')) {
    throw 'Dependencies are missing. Install Node.js 24, then run npm ci in the SparkWright folder.'
}
& node scripts/setup-local.mjs
if ($LASTEXITCODE -ne 0) { throw 'Local configuration failed.' }
$portLine = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
$appPort = if ($env:PORT) { [int]$env:PORT } elseif ($portLine) { [int](($portLine -split '=',2)[1].Trim(' ', '"', "'")) } else { 5318 }
$appUrl = "http://127.0.0.1:$appPort"
$health = $null
try { $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2 } catch {}
if ($health -and $health.app -eq 'SparkWright') { Start-Process $appUrl; return }
if (Get-NetTCPConnection -State Listen -LocalPort $appPort -ErrorAction SilentlyContinue) {
    throw "Port $appPort is already in use. Update PORT in .env before starting."
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
New-Item -ItemType Directory -Force -Path 'data/logs' | Out-Null
$nodeExe = (Get-Command node.exe).Source
$loaderUrl = ([System.Uri](Join-Path $appRoot 'node_modules/tsx/dist/loader.mjs')).AbsoluteUri
$serverPath = Join-Path $appRoot 'server/index.ts'
$serverProcess = Start-Process -FilePath $nodeExe -ArgumentList "--import `"$loaderUrl`" `"$serverPath`"" -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot 'data/logs/server.out.log') -RedirectStandardError (Join-Path $appRoot 'data/logs/server.err.log') -PassThru
@{ pid = $serverProcess.Id; url = $appUrl } | ConvertTo-Json | Set-Content -LiteralPath 'data/local-server.json' -Encoding UTF8
for ($attempt = 0; $attempt -lt 80; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1
        if ($health.app -eq 'SparkWright') { Start-Process $appUrl; Write-Host "SparkWright: $appUrl"; return }
    } catch {}
    if ($serverProcess.HasExited) { throw 'Server stopped. See data/logs/server.err.log.' }
    Start-Sleep -Milliseconds 350
}
throw 'Startup timed out. See data/logs/server.err.log.'
