param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$')][string]$ProjectKey,
    [string]$SonarUrl = 'http://127.0.0.1:9000',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
# ProjectPath is the Maven root; ProjectKey identifies SonarQube's local project.
# Tokens are read from SONAR_TOKEN, never interpolated into command arguments.
function Assert-Jdk([string]$JdkPath, [string]$ExpectedVersion) {
    $java = Join-Path $JdkPath 'bin\java.exe'
    $javac = Join-Path $JdkPath 'bin\javac.exe'
    if (-not (Test-Path -LiteralPath $java) -or -not (Test-Path -LiteralPath $javac)) { throw "A complete JDK is required at $JdkPath" }
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $info = & $java -version 2>&1 | ForEach-Object { "$_" }
        if ($LASTEXITCODE -ne 0) { throw "Unable to run Java at $JdkPath" }
    } finally { $ErrorActionPreference = $oldPreference }
    if (($info -join ' ') -notmatch $ExpectedVersion) { throw "Unexpected JDK version at $JdkPath : $($info -join ' ')" }
}
function Invoke-Maven([string[]]$Goals) {
    & $script:maven @Goals
    if ($LASTEXITCODE -ne 0) { throw "Maven failed with exit code $LASTEXITCODE" }
}
if (-not $env:JAVA8_HOME -or -not $env:JAVA21_HOME) { throw 'Configure JAVA8_HOME and JAVA21_HOME.' }
if (-not $env:SONAR_TOKEN) { throw 'Configure SONAR_TOKEN.' }
Assert-Jdk $env:JAVA8_HOME 'version "1\.8\.'
Assert-Jdk $env:JAVA21_HOME 'version "21(?:\.|\")'
$uri = [Uri]$SonarUrl
if ($uri.Host -notin @('localhost', '127.0.0.1', '::1') -or $uri.Scheme -ne 'http') { throw 'Only local HTTP SonarQube servers are supported.' }
$status = Invoke-RestMethod "$SonarUrl/api/system/status" -TimeoutSec 15
if ($status.status -ne 'UP') { throw "SonarQube is not ready: $($status.status)" }
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath 'pom.xml'))) { throw 'ProjectPath must contain pom.xml.' }
# Prefer the project's wrapper; fall back to Maven on PATH.
$script:maven = Join-Path $ProjectPath 'mvnw.cmd'
if (-not (Test-Path -LiteralPath $script:maven)) {
    $command = Get-Command mvn.cmd -ErrorAction SilentlyContinue
    if (-not $command) { throw 'Maven or mvnw.cmd is required.' }
    $script:maven = $command.Source
}
$previousJava = $env:JAVA_HOME
$previousPath = $env:Path
Push-Location -LiteralPath $ProjectPath
try {
    Write-Host '[1/3] Build, tests and JaCoCo under JDK 8'
    $env:JAVA_HOME = $env:JAVA8_HOME
    $env:Path = "$env:JAVA_HOME\bin;$previousPath"
    # install supports a separate scanner invocation in multi-module projects.
    Invoke-Maven -Goals @('-B', 'clean', 'org.jacoco:jacoco-maven-plugin:0.8.14:prepare-agent', 'install', 'org.jacoco:jacoco-maven-plugin:0.8.14:report', '-Dmaven.test.skip=false', '-DskipTests=false', '-DskipITs=false')
    $reports = @(Get-ChildItem -LiteralPath $ProjectPath -Filter jacoco.xml -Recurse | Where-Object { $_.FullName -match '[\\/]target[\\/]site[\\/]jacoco[\\/]' })
    if ($reports.Count -eq 0) { throw 'No JaCoCo XML generated. Add tests and the documented JaCoCo configuration; no coverage will be fabricated.' }
    Write-Host '[2/3] SonarScanner under JDK 21'
    $env:JAVA_HOME = $env:JAVA21_HOME
    $env:Path = "$env:JAVA_HOME\bin;$previousPath"
    $taskFile = Join-Path $ProjectPath 'target\sonar\report-task.txt'
    if (Test-Path -LiteralPath $taskFile) { Remove-Item -LiteralPath $taskFile }
    Invoke-Maven -Goals @('-B', 'org.sonarsource.scanner.maven:sonar-maven-plugin:5.8.0.7211:sonar', "-Dsonar.host.url=$SonarUrl", "-Dsonar.projectKey=$ProjectKey", '-Dsonar.java.source=8', "-Dsonar.java.jdkHome=$env:JAVA8_HOME", '-Dsonar.scanner.skipJreProvisioning=true', "-Dsonar.coverage.jacoco.xmlReportPaths=$($reports.FullName -join ',')")
    if (-not (Test-Path -LiteralPath $taskFile)) { throw 'Scanner did not produce target/sonar/report-task.txt.' }
    $task = Get-Content -LiteralPath $taskFile | ConvertFrom-StringData
    if (-not $task.ceTaskId) { throw 'Scanner report is missing ceTaskId.' }
    Write-Host '[3/3] Waiting for THIS analysis to finish'
    $headers = @{ Authorization = "Bearer $env:SONAR_TOKEN" }
    $deadline = (Get-Date).AddMinutes(10)
    do {
        $result = Invoke-RestMethod "$SonarUrl/api/ce/task?id=$([Uri]::EscapeDataString($task.ceTaskId))" -Headers $headers -TimeoutSec 15
        if ($result.task.status -in @('FAILED', 'CANCELED')) { throw "SonarQube processing failed: $($result.task.status)" }
        if ($result.task.status -eq 'SUCCESS') { break }
        if ((Get-Date) -gt $deadline) { throw 'SonarQube processing timed out after 10 minutes.' }
        Start-Sleep -Seconds 2
    } while ($true)
    Write-Host 'Analysis completed. Review issues and the quality gate in your dashboard.'
    if (-not $NoBrowser) { Start-Process "$SonarUrl/dashboard?id=$([Uri]::EscapeDataString($ProjectKey))" }
}
finally {
    $env:JAVA_HOME = $previousJava
    $env:Path = $previousPath
    Pop-Location
}
