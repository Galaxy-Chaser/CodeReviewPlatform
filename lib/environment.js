/** Build the Windows Maven probe. A missing command must exit nonzero without raw localized errors. */
function mavenProbeArgs(command = 'mvn.cmd') {
  if (!/^[a-zA-Z0-9_.-]+$/.test(command)) throw new Error('Invalid executable name');
  return ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); try { $mavenCommand = Get-Command ${command} -ErrorAction Stop; & $mavenCommand.Source -version; exit $LASTEXITCODE } catch { exit 1 }`];
}
module.exports = { mavenProbeArgs };
