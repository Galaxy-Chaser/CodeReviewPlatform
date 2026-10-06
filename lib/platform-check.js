const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sourceSnapshot, compareSnapshot } = require('./source-snapshot');
const execute = promisify(execFile);

/** 解析 Node 官方 TAP 汇总；只接受完整、数量一致且没有失败、跳过或待办的测试结果。 */
function testCounts(output) {
  const result = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...String(output).matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    result[key] = matches.length ? Number(matches.at(-1)[1]) : NaN;
  }
  result.complete = Object.values(result).every(Number.isSafeInteger) && result.tests > 0 && result.tests === result.pass + result.fail + result.cancelled + result.skipped + result.todo;
  result.passed = result.complete && result.pass === result.tests;
  return result;
}

/** root 为平台安装目录；仅执行当前 Node 和固定检查参数，不读取项目命令或调用 shell。 */
async function runPlatformCheck(root) {
  const report = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), status: 'FAILED', node: process.version,
    checks: [], limits: ['只验证平台自身的语法、自动测试和纳入范围的文件版本。', '业务场景、视觉体验、真实 JDK/Maven/Sonar 和外部环境仍需单独验收。'] };
  try {
    // 独立测试进程不能继承父测试运行器的内部标记，否则 Node 会跳过测试。
    const testEnvironment = { ...process.env }; delete testEnvironment.NODE_TEST_CONTEXT;
    const before = await sourceSnapshot(root); report.sourceSnapshot = before;
    const sourceFiles = before.files.filter(f => /\.[cm]?js$/i.test(f.file)).map(f => f.file);
    if (!sourceFiles.length) throw Error('没有找到平台 JavaScript 文件');
    // 有界批次避免一次创建大量子进程；语法检查不执行被检查文件。
    for (let offset = 0; offset < sourceFiles.length; offset += 4) {
      await Promise.all(sourceFiles.slice(offset, offset + 4).map(async file => {
        try { await execute(process.execPath, ['--check', path.join(root, file)], { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 65536 }); }
        catch (error) { throw Error(`${file} 语法检查失败：${String(error.stderr || error.message).slice(0, 2000)}`); }
      }));
    }
    report.checks.push({ name: 'JavaScript 语法', passed: true, detail: `${sourceFiles.length} 个文件检查通过` });
    const tests = before.files.filter(f => /^test\/[^/]+\.test\.js$/.test(f.file)).map(f => f.file);
    if (!tests.length) throw Error('没有找到平台自动测试');
    let stdout = '', stderr = '', exited = true;
    try {
      ({ stdout, stderr } = await execute(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: root, env: testEnvironment, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (error) {
      exited = false; stdout = String(error.stdout || ''); stderr = String(error.stderr || error.message);
    }
    report.tests = testCounts(stdout); report.testOutput = (stdout + '\n' + stderr).slice(-64000);
    report.checks.push({ name: '全部自动测试', passed: exited && report.tests.passed, detail: report.tests.complete ? `执行 ${report.tests.tests}，通过 ${report.tests.pass}，失败 ${report.tests.fail}，取消 ${report.tests.cancelled}，跳过 ${report.tests.skipped}，待办 ${report.tests.todo}` : '测试未成功完成或汇总无法核实；请查看输出' });
    const after = await sourceSnapshot(root); report.sourceCheck = compareSnapshot(before, after);
    report.checks.push({ name: '执行期间代码版本', passed: report.sourceCheck.status === 'CURRENT', detail: report.sourceCheck.reason });
    report.status = report.checks.every(c => c.passed) ? 'PASSED' : 'FAILED';
  } catch (error) { report.error = error.message; report.checks.push({ name: '检查完整性', passed: false, detail: error.message }); }
  report.finishedAt = new Date().toISOString(); return report;
}

/** 显示报告时重新核对源码，历史通过不会证明后来改动的版本通过。 */
async function platformCheckView(root, report) {
  if (!report) return { status: 'NOT_CHECKED', report: null };
  let current;
  try { current = compareSnapshot(report.sourceSnapshot, await sourceSnapshot(root)); }
  catch (error) { current = { status: 'UNKNOWN', reason: error.message }; }
  const { sourceSnapshot: ignored, ...detail } = report;
  return { status: current.status !== 'CURRENT' ? 'STALE' : report.status, sourceCheck: current, report: detail };
}

module.exports = { testCounts, runPlatformCheck, platformCheckView };
