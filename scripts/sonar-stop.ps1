$ErrorActionPreference = 'Stop'
# Stop containers without removing the database or analysis volumes.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is not installed.' }
$deploy = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\deploy'))
docker compose --project-directory $deploy -f (Join-Path $deploy 'docker-compose.yml') stop
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose stop failed.' }
