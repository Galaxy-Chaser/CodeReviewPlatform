param([ValidateRange(1, 65535)][int]$Port = 4310)
$ErrorActionPreference = 'Stop'
# Read the running platform's actual status. Does not install dependencies or launch containers.
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
    if ($health.status -ne 'UP' -or $health.storage.strategy -ne 'details-on-demand') { throw 'Unexpected service response.' }
    Write-Host "CodeHealth $($health.version): UP"
    Write-Host "Node: $($health.node), uptime: $($health.uptimeSeconds) seconds"
    Write-Host "Platform RSS: $($health.memory.rssMB) MB, JavaScript heap: $($health.memory.heapMB) MB"
    Write-Host "Data: $($health.storage.path)"
    Write-Host "History: $($health.storage.scans) scans, $($health.storage.githubReviews) GitHub reviews"
} catch { Write-Error "No healthy CodeHealth platform at port $Port. Start scripts\start.ps1 or check its terminal output. $($_.Exception.Message)"; exit 1 }
