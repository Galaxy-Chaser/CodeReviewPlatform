$ErrorActionPreference = 'Stop'
# Initialize a random local database password once and preserve named volumes on every start.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop before using SonarQube. Local rule scans do not require Docker.' }
$deploy = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\deploy'))
$envFile = Join-Path $deploy '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $password = [Convert]::ToBase64String($bytes)
    [IO.File]::WriteAllText($envFile, "SONAR_DB_PASSWORD=$password`n", (New-Object Text.UTF8Encoding($false)))
}
docker compose --project-directory $deploy -f (Join-Path $deploy 'docker-compose.yml') up -d
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed. Check Docker Desktop and available memory.' }
Write-Host 'SonarQube is starting: http://127.0.0.1:9000. Allow a few minutes on first start.'
