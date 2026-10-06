# SPDX-License-Identifier: MPL-2.0
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appRoot

function Test-NodeRuntime([string]$nodePath) {
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'))) { return $false }
    try {
        $supported = & $nodePath -p "const [a,b]=process.versions.node.split('.').map(Number); (a>22||(a===22&&b>=12))&&['x64','arm64'].includes(process.arch)" 2>$null
        return $LASTEXITCODE -eq 0 -and "$supported".Trim() -eq 'true'
    } catch { return $false }
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'SparkWright requires 64-bit Windows.' }
    $runtimeRoot = Join-Path $appRoot '.runtime'
    $portableDir = Join-Path $runtimeRoot 'node'
    $nodeExe = Join-Path $portableDir 'node.exe'
    if (-not (Test-NodeRuntime $nodeExe)) {
        $installed = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($installed -and (Test-NodeRuntime $installed.Source)) {
            $nodeExe = $installed.Source
        } else {
            $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
            $arch = if ($architecture -eq 'ARM64') { 'arm64' } elseif ($architecture -eq 'AMD64') { 'x64' } else { throw 'Unsupported Windows architecture.' }
            $version = '22.23.3'
            $hashes = @{
                x64 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
                arm64 = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'
            }
            Write-Host '[Setup] Downloading official portable Node.js. No administrator rights are needed.'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            $stage = Join-Path $runtimeRoot ('install-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $stage -Force | Out-Null
            $fileName = "node-v$version-win-$arch.zip"
            $archivePath = Join-Path $stage $fileName
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$fileName" -OutFile $archivePath
            if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$arch]) {
                throw 'Node.js download failed its SHA-256 check. The file will not be executed.'
            }
            Expand-Archive -LiteralPath $archivePath -DestinationPath $stage
            $extracted = Join-Path $stage "node-v$version-win-$arch"
            if (-not (Test-NodeRuntime (Join-Path $extracted 'node.exe'))) { throw 'Downloaded Node.js or npm could not run.' }
            if (Test-Path -LiteralPath $portableDir) {
                # Preserve a damaged cache rather than deleting unknown files.
                $previousDir = Join-Path $runtimeRoot ('node.previous-' + [guid]::NewGuid().ToString('N'))
                if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($portableDir)) -ne [IO.Path]::GetFullPath($runtimeRoot)) { throw 'Invalid runtime directory.' }
                Move-Item -LiteralPath $portableDir -Destination $previousDir
            }
            Move-Item -LiteralPath $extracted -Destination $portableDir
            Remove-Item -LiteralPath $archivePath
            Remove-Item -LiteralPath $stage
            Write-Host '[Setup] Portable Node.js and npm are ready.'
        }
    }
    # Only this launcher and its child processes use the portable runtime.
    $env:Path = (Split-Path -Parent $nodeExe) + ';' + (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0') + ';' + $env:Path
    & $nodeExe (Join-Path $appRoot 'scripts/start-personal.mjs')
    exit $LASTEXITCODE
} catch {
    Write-Host ('[ERROR] ' + $_.Exception.Message)
    Write-Host 'Check the network and retry. Manual Node.js download: https://nodejs.org/zh-cn/download'
    exit 1
}
