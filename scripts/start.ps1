param(
    [ValidateRange(1, 65535)][int]$Port = 4310,
    [string]$DataDirectory = '',
    [string]$NodePath = '',
    [ValidateRange(128, 4096)][int]$HeapLimitMB = 256
)
$ErrorActionPreference = 'Stop'
# Start locally. Parameters select port, persistent data, optional portable Node, and JS heap limit.
$platformRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:PORT = "$Port"
if ($DataDirectory) { $env:HEALTH_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory) }
if (-not $NodePath) {
    $portableNode = Join-Path $platformRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $portableNode -PathType Leaf) { $NodePath = $portableNode }
    else { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue; if ($nodeCommand) { $NodePath = $nodeCommand.Source } }
}
if (-not $NodePath) { throw 'Node.js 20+ is required. Install Node.js, or place official node.exe in runtime\node.exe.' }
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20+ is required.' }
Write-Host "CodeHealth: http://127.0.0.1:$Port (Ctrl+C to stop)"
& $NodePath "--max-old-space-size=$HeapLimitMB" (Join-Path $platformRoot 'server.js')
exit $LASTEXITCODE
