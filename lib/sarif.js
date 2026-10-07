const { writeText } = require('./json-export');
const { states: reviewStates } = require('./issue-review');
const exporterVersion = require('../package.json').version;
const levels = { BLOCKER: 'error', CRITICAL: 'error', HIGH: 'error', MAJOR: 'warning', MEDIUM: 'warning', MINOR: 'note', LOW: 'note', INFO: 'note' };
const sonarTypes = ['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT'];
const maxResults = 20000, maxBytes = 16 * 1024 * 1024;
const schema = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json';

/** value/name/max 定义有界文本字段；lines 允许问题说明的正常换行，其余控制字符被拒绝。 */
function text(value, name, max, lines = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (lines ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw Error(`SARIF ${name}不正确`);
  try { encodeURIComponent(value); } catch { throw Error(`SARIF ${name}包含无效字符`); }
  return value;
}
/** file 是声明的项目相对路径；按段编码保留 #、?、% 和 Unicode，不读取文件。 */
function fileUri(file) {
  file = text(file, '文件路径', 1000).replace(/\\/g, '/');
  const parts = file.split('/');
  if (file.includes(':') || parts.some(part => !part || part === '.' || part === '..')) throw Error('SARIF 文件路径必须是安全的项目内相对路径');
  return parts.map(encodeURIComponent).join('/');
}
/** 检查完整记录后才开始写入，不推断丢失行号、未知分析器或未知风险等级。 */
function validateReport(scan) {
  if (!scan || scan.status !== 'completed') throw Error('请等待检查完成后导出 SARIF');
  const scope = scan.scope === undefined ? 'project' : scan.scope;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(scan.id || '') || !['local', 'full'].includes(scan.mode) || !['project', 'changed', 'github'].includes(scope)) throw Error('SARIF 报告记录不正确');
  if (['changed', 'github'].includes(scan.scope) && scan.mode !== 'local') throw Error('SARIF 检查方式与范围不一致');
  if (scan.gate?.status !== undefined && !['PASSED', 'FAILED', 'UNKNOWN'].includes(scan.gate.status)) throw Error('SARIF 原始门禁记录不正确');
  if (scan.sonarGate?.status !== undefined && !['OK', 'ERROR', 'WARN', 'NONE', 'UNKNOWN'].includes(scan.sonarGate.status)) throw Error('SARIF SonarQube 门禁记录不正确');
  if (!Array.isArray(scan.issues) || scan.issues.length > maxResults) throw Error('SARIF 最多支持 20,000 条完整问题');
  if (scan.scope === 'github' && (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(scan.repository || '') || ['.', '..'].includes(scan.repository.split('/')[1]) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scan.headSha || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scan.baseSha || ''))) throw Error('SARIF PR 固定提交记录不正确');
  for (const issue of scan.issues) {
    if (!issue || !(issue.type === 'LOCAL' || (scan.mode === 'full' && sonarTypes.includes(issue.type)))) throw Error('SARIF 问题来源不正确');
    if (!Object.hasOwn(levels, issue.severity)) throw Error('SARIF 风险等级不正确');
    text(issue.rule, '规则编号', 500); text(issue.message, '问题说明', 10000, true); fileUri(issue.file);
    if (issue.line !== undefined && (!Number.isSafeInteger(issue.line) || issue.line < 1)) throw Error('SARIF 问题行号不正确');
    if (issue.endLine !== undefined && (!Number.isSafeInteger(issue.endLine) || issue.line === undefined || issue.endLine < issue.line)) throw Error('SARIF 结束行号不正确');
    if (issue.review && !reviewStates.includes(issue.review.status)) throw Error('SARIF 审查状态不正确');
  }
}

/** scan 为同一已保存报告，sonar 区分原始分析器；只构建规则索引，不复制整批结果。 */
function runMetadata(scan, sonar) {
  const indices = new Map(), rules = [];
  for (const issue of scan.issues) if ((issue.type !== 'LOCAL') === sonar && !indices.has(issue.rule)) {
    indices.set(issue.rule, rules.length);
    rules.push({ id: issue.rule, shortDescription: { text: issue.rule }, ...(sonar ? {} : { properties: { precision: 'low' } }) });
  }
  const driver = { name: sonar ? 'SonarQube' : 'CodeHealth local rules', rules };
  if (!sonar && Number.isSafeInteger(scan.settings?.localRuleVersion) && scan.settings.localRuleVersion > 0) driver.version = String(scan.settings.localRuleVersion);
  const scope = scan.scope || 'project';
  const properties = { reportId: scan.id, scanScope: scope, scanMode: scan.mode, gateStatus: scan.gate?.status || 'UNKNOWN', exporterVersion,
    limits: '导出保存时的发现与范围，不证明当前代码、构建、测试或业务验收通过；人工排除不会隐藏问题。' };
  if (/^[a-f0-9]{64}$/.test(scan.sourceSnapshot?.digest || '')) properties.recordedSourceDigest = scan.sourceSnapshot.digest;
  if (scan.sonarGate?.status !== undefined) properties.sonarGateStatus = scan.sonarGate.status;
  if (scope === 'github') properties.baseSha = scan.baseSha;
  const run = { tool: { driver }, language: 'zh-CN', automationDetails: { id: `codehealth/${scope}/${scan.id}` },
    originalUriBaseIds: { '%SRCROOT%': { description: { text: '项目或仓库源码根目录；绝对本机路径已省略，请在使用工具中映射此根目录。' } } }, properties };
  if (sonar) run.conversion = { tool: { driver: { name: 'CodeHealth SARIF exporter', semanticVersion: exporterVersion } } };
  if (scope === 'github') run.versionControlProvenance = [{ repositoryUri: `https://github.com/${scan.repository}`, revisionId: scan.headSha }];
  return { run, indices };
}

/** issue/indices 来自已校验记录；字段白名单避免复制源码片段、审查正文与配置。 */
function finding(issue, indices) {
  const physicalLocation = { artifactLocation: { uri: fileUri(issue.file), uriBaseId: '%SRCROOT%' } };
  if (issue.line !== undefined) physicalLocation.region = { startLine: issue.line, ...(issue.endLine !== undefined ? { endLine: issue.endLine } : {}) };
  return { ruleId: issue.rule, ruleIndex: indices.get(issue.rule), level: levels[issue.severity], message: { text: issue.message },
    locations: [{ physicalLocation }], properties: { originalSeverity: issue.severity, originalType: issue.type, reviewStatus: issue.review?.status || 'open' } };
}

/** handle 为调用者拥有的临时文件，scan 为完整已保存报告。逐条输出，超限/失败由调用者撤销临时文件。 */
async function writeSarif(handle, scan) {
  validateReport(scan);
  let bytes = 0;
  const write = async fragment => {
    bytes += Buffer.byteLength(fragment, 'utf8');
    if (bytes > maxBytes) throw Error('SARIF 输出超过 16 MiB，请缩小检查范围后重新扫描');
    await writeText(handle, fragment);
  };
  await write(`{"$schema":${JSON.stringify(schema)},"version":"2.1.0","runs":[`);
  for (const sonar of scan.mode === 'full' ? [false, true] : [false]) {
    if (sonar) await write(',');
    const { run, indices } = runMetadata(scan, sonar);
    await write(JSON.stringify(run).slice(0, -1) + ',"results":[');
    let first = true;
    for (const issue of scan.issues) if ((issue.type !== 'LOCAL') === sonar) {
      await write((first ? '' : ',') + JSON.stringify(finding(issue, indices))); first = false;
    }
    await write(']}');
  }
  await write(']}\n');
  return { bytes, findings: scan.issues.length };
}

module.exports = { writeSarif };
