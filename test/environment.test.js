const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mavenProbeArgs } = require('../lib/environment');

test('Windows missing Maven produces nonzero exit and no garbled raw error', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', mavenProbeArgs('codehealth_missing_maven_782431.cmd'), { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
test('Windows UTF-8 console correctly transmits Chinese text to Node', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); Write-Output '中文环境检查'"], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '中文环境检查');
  assert.ok(!result.stdout.includes('\uFFFD'));
});
