const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

/** Parse one Surefire/Failsafe single-suite report, requiring numeric counts; never evaluate XML entities or external resources. */
function suiteCounts(xml) {
  const start = /^\s*(?:<\?xml[^?]*\?>\s*)?<testsuite\b([^>]{0,10000})>/.exec(xml);
  if (!start || !/<\/testsuite>\s*$/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('测试 XML 格式不支持或不完整');
  const counts = {};
  for (const name of ['tests', 'failures', 'errors', 'skipped']) {
    const attributes = [...start[1].matchAll(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["'](\\d+)["']`, 'g'))];
    if (attributes.length !== 1 || !Number.isSafeInteger(Number(attributes[0][1]))) throw new Error('测试 XML 缺少有效统计或有重复属性');
    counts[name] = Number(attributes[0][1]);
  }
  if (counts.skipped > counts.tests || counts.failures + counts.errors > counts.tests - counts.skipped) throw new Error('测试 XML 统计不一致');
  return { ...counts, executed: counts.tests - counts.skipped };
}

/** xml 为本次 Maven 单套件报告；仅返回测试标识和状态，不保存日志或异常正文。 */
function suiteCases(xml) {
  let XMLParser, XMLValidator;
  try { ({ XMLParser, XMLValidator } = require('fast-xml-parser')); }
  catch { throw Error('请先安装平台依赖，再采集逐测试结果（npm install）'); }
  const counts = suiteCounts(xml);
  if (XMLValidator.validate(xml) !== true) throw Error('逐测试 XML 不完整');
  const tree = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: false, maxNestedTags: 32 }).parse(xml);
  const raw = tree.testsuite?.testcase;
  const rows = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (rows.length > 50000 || rows.length !== counts.tests) throw Error('逐测试数量与套件统计不一致');
  const totals = { failures: 0, errors: 0, skipped: 0 };
  const result = rows.map(c => {
    if (!c || typeof c['@_classname'] !== 'string' || typeof c['@_name'] !== 'string' || !c['@_classname'] || !c['@_name'] || c['@_classname'].length + c['@_name'].length > 400) throw Error('逐测试标识缺失或过长');
    const flags = ['failure', 'error', 'skipped'].filter(k => Object.hasOwn(c, k));
    if (flags.length > 1) throw Error('逐测试状态冲突');
    if (flags[0] === 'failure') totals.failures++; if (flags[0] === 'error') totals.errors++; if (flags[0] === 'skipped') totals.skipped++;
    return { testRef: c['@_classname'] + '#' + c['@_name'], status: flags[0] === 'skipped' ? 'skipped' : flags.length ? 'failed' : 'passed' };
  });
  if (Object.keys(totals).some(k => totals[k] !== counts[k])) throw Error('逐测试状态与套件统计不一致');
  return result;
}

/** Read Maven reports modified since buildStartedAt (epoch milliseconds); retain counts/paths, never XML/log content. */
async function collectTestEvidence(root, buildStartedAt = 0, options = {}) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ['.git', '.idea', 'node_modules', 'data', 'build', '.codegraph'].includes(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === 'target') {
        for (const folder of ['surefire-reports', 'failsafe-reports']) {
          const reportRoot = path.join(child, folder);
          const stat = await fs.lstat(reportRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
          for (const file of await fs.readdir(reportRoot, { withFileTypes: true })) if (file.isFile() && /^TEST-.+\.xml$/i.test(file.name)) {
            files.push(path.join(reportRoot, file.name)); if (files.length > 5000) throw new Error('测试报告超过 5,000 个');
          }
        }
      } else await walk(child);
    }
  }
  try {
    await walk(root);
    if (!files.length) return { available: false, reason: '未找到 Surefire / Failsafe 测试报告，不能证明实际执行的测试数量' };
    const totals = { available: true, tests: 0, executed: 0, skipped: 0, failures: 0, errors: 0, reports: [] };
    const requested = new Set(options.testRefs || []), matched = [];
    let caseError = '', totalBytes = 0;
    for (const file of files.sort()) {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.mtimeMs < buildStartedAt) continue;
      const parts = []; let bytes = 0;
      for await (const part of createReadStream(file, { highWaterMark: 65536 })) { bytes += part.length; totalBytes += part.length; if (bytes > 5 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('测试报告超过单份 5 MB 或总计 32 MB 上限'); parts.push(part); }
      const xml = Buffer.concat(parts).toString('utf8'), counts = suiteCounts(xml);
      const after = await fs.lstat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间测试报告发生变化');
      for (const name of ['tests', 'executed', 'skipped', 'failures', 'errors']) { totals[name] += counts[name]; if (!Number.isSafeInteger(totals[name])) throw new Error('测试统计超出有效数值范围'); }
      totals.reports.push(path.relative(root, file).split(path.sep).join('/'));
      if (requested.size && !caseError) {
        try { for (const c of suiteCases(xml)) if (requested.has(c.testRef)) { matched.push({ ...c, report: totals.reports.at(-1) }); if (matched.length > 10000) throw Error('绑定测试匹配超过 10,000 个'); } }
        catch (error) { caseError = error.message; }
      }
    }
    if (requested.size) totals.caseEvidence = caseError ? { available: false, reason: caseError, results: [] } : { available: true, results: matched };
    return totals.reports.length ? { ...totals, ...(buildStartedAt ? { buildStartedAt: new Date(buildStartedAt).toISOString() } : {}) } : { available: false, reason: '未找到本次构建的新测试报告，旧报告不计入测试数量' };
  } catch (error) { return { available: false, reason: '测试报告无法完整核实：' + error.message }; }
}
module.exports = { suiteCounts, suiteCases, collectTestEvidence };
