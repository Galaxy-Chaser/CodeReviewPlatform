$ErrorActionPreference = 'Stop'
# Build a portable source package without local credentials, scan data or installed runtimes.
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDir = Join-Path $root 'dist'
[IO.Directory]::CreateDirectory($outputDir) | Out-Null
$output = Join-Path $outputDir 'CodeHealth-portable.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$files = @('server.js', 'package.json', 'pnpm-lock.yaml', 'README.md', '.gitignore', 'start.cmd', 'deploy\docker-compose.yml') | ForEach-Object { Get-Item -LiteralPath (Join-Path $root $_) }
foreach ($directory in @('lib', 'public', 'scripts', 'examples', 'test', 'docs', '.github')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $root $directory) -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](target|node_modules|data|\.git)[\\/]' -and $_.Name -ne '.env' }
}
# Add each file with its repository-relative path, including the deploy folder.
$stream = [IO.File]::Open($output, [IO.FileMode]::Create)
$archive = $null
try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative) | Out-Null
    }
} finally { if ($null -ne $archive) { $archive.Dispose() }; $stream.Dispose() }
Write-Host "Portable package ready: $output"
