const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { maskSource, emptyCatches, credentialAssignments } = require('./source-text');
const limits = { files: 50000, fileBytes: 5 * 1024 * 1024, findings: 10000, evidenceCharacters: 500 };

const catalog = [
  { id: 'java8-api', name: 'Java 8 兼容性', severity: 'HIGH', description: '发现 List.of、Map.of、Set.of、String.isBlank 等常见新版 API，需人工确认。' },
  { id: 'empty-catch', name: '空异常处理', severity: 'HIGH', description: '异常被直接忽略，可能隐藏故障。' },
  { id: 'debug-output', name: '调试输出', severity: 'LOW', description: '使用日志框架替代 System.out / System.err。' },
  { id: 'migration-version', name: '重复迁移版本', severity: 'HIGH', description: '同一迁移目录的 Flyway 版本不可重复。' },
  { id: 'large-service', name: '过长 Service', severity: 'MEDIUM', description: 'Service 超过 500 行时建议拆分职责。' },
  { id: 'todo', name: '待办标记', severity: 'INFO', description: '跟踪 TODO / FIXME，避免遗漏。' },
  { id: 'hardcoded-secret', name: '硬编码凭据', severity: 'HIGH', description: '提示 Java 字符串中的密码、Token 和 API Key；报告中的字符串证据会脱敏。' },
  { id: 'process-execution', name: '外部命令执行', severity: 'MEDIUM', description: 'Runtime.exec / ProcessBuilder 需要人工检查输入来源和权限。' },
  { id: 'destructive-sql', name: '破坏性数据库操作', severity: 'HIGH', description: 'DROP TABLE / TRUNCATE TABLE 必须确认影响、备份及恢复方案。' }
];

/** Walk a project without following links or reading build, VCS or dependency folders. */
async function filesUnder(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (['.git', '.idea', '.codegraph', 'target', 'node_modules', 'data', 'build'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(java|sql)$/i.test(entry.name)) result.push(file);
      if (result.length > limits.files) throw new Error('项目超过 50,000 个源文件，请缩小扫描目录。');
    }
  }
  await visit(root);
  return result.sort();
}

/** Replace comments and strings with spaces while retaining line positions for rule matching. */
function codeOnly(source) {
  return maskSource(source);
}

/** Build compact line offsets once for source; lookup accepts a UTF-16 match offset and returns a one-based line. */
function lineIndex(source) {
  let count = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) count++;
  const starts = new Uint32Array(count); let at = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts[at++] = i + 1;
  const cache = new Map();
  return {
    count,
    line(offset) {
      let low = 0, high = starts.length;
      while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid + 1; else high = mid; }
      return low;
    },
    // Bound text before redaction; an unfinished quoted literal is also masked, preventing cutoff leaks.
    evidence(line) {
      if (!cache.has(line)) {
        const end = line < starts.length ? starts[line] - 1 : source.length;
        cache.set(line, redactEvidence(source.slice(starts[line - 1], Math.min(end, starts[line - 1] + 2000)).trim()).slice(0, limits.evidenceCharacters));
      }
      return cache.get(line);
    }
  };
}

/** Read bounded source bytes, including files that grow after stat; fail rather than inspect a truncated file. */
async function readSource(file, relative) {
  const parts = []; let size = 0;
  for await (const part of createReadStream(file, { highWaterMark: 65536 })) {
    size += part.length;
    if (size > limits.fileBytes) throw new Error(`源文件过大：${relative}（最多 5 MB，检查未完成）`);
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Scan root using enabled IDs; onProgress receives completed/total files. Limits fail without a passing partial report. */
async function scanLocal(root, enabled = catalog.map(rule => rule.id), onProgress = () => {}) {
  const files = await filesUnder(root);
  const issues = [];
  let lines = 0;
  const migrations = new Map();
  const enabledSet = new Set(enabled);
  const add = (ruleId, file, line, message, excerpt, extra = {}) => {
    if (!enabledSet.has(ruleId)) return;
    if (issues.length >= limits.findings) throw new Error('项目问题超过 10,000 条，本次检查未完成；请缩小项目目录或分模块检查。');
    issues.push({ id: `${ruleId}:${file}:${line}`, rule: ruleId, file, line, message, excerpt: redactEvidence(excerpt),
      severity: catalog.find(rule => rule.id === ruleId).severity, type: 'LOCAL', status: 'OPEN', ...extra });
  };
  let completed = 0;
  onProgress({ completed, total: files.length });
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const stat = await fs.stat(file);
    if (stat.size > limits.fileBytes) throw new Error(`源文件过大：${relative}（最多 5 MB，检查未完成）`);
    const source = await readSource(file, relative);
    const index = lineIndex(source);
    const masked = dialect => {
      try { return maskSource(source, dialect); }
      catch (error) { throw new Error(`源文件 ${relative}：${error.message}`); }
    };
    lines += index.count;
    if (/\.sql$/i.test(file)) {
      const sql = enabledSet.has('destructive-sql') ? masked('sql') : '';
      for (const match of enabledSet.has('destructive-sql') ? sql.matchAll(/\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE)\b/gi) : []) {
        const line = index.line(match.index);
        add('destructive-sql', relative, line, '破坏性数据库操作：请确认数据影响与恢复方案', index.evidence(line));
      }
      const match = /^V([0-9][0-9._]*)__.+\.sql$/i.exec(path.basename(file));
      if (match) {
        const version = match[1].replace(/_/g, '.').split('.').map(x => x.replace(/^0+(?=\d)/, '')).join('.').replace(/(?:\.0)+$/, '');
        const key = `${path.dirname(relative)}:${version}`;
        if (migrations.has(key)) add('migration-version', relative, 1, `迁移版本 ${version} 与 ${migrations.get(key)} 重复`, index.evidence(1), { relatedFiles: [migrations.get(key)] });
        else migrations.set(key, relative);
      }
      completed++; if (completed % 25 === 0 || completed === files.length) onProgress({ completed, total: files.length });
      continue;
    }
    const code = ['java8-api', 'empty-catch', 'debug-output', 'process-execution', 'hardcoded-secret'].some(id => enabledSet.has(id)) ? masked('java') : '';
    const matchRules = [
      ['java8-api', /\b(?:List|Map|Set)\s*\.\s*(?:of|copyOf)\s*\(|\.(?:isBlank|strip|stripLeading|stripTrailing|repeat|toList)\s*\(|\b(?:var\s+\w+\s*=|record\s+\w+\s*\()/g, '可能使用 Java 9+ 语法或 API，请确认 Java 8 兼容性'],
      ['empty-catch', null, '异常处理为空，请记录或处理异常'],
      ['debug-output', /\bSystem\s*\.\s*(?:out|err)\s*\.\s*(?:print|println|printf)\s*\(/g, '发现控制台调试输出，建议使用日志框架'],
      ['process-execution', /\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(|\bnew\s+ProcessBuilder\s*\(/g, '外部命令执行：检查输入来源、参数和最小权限']
    ];
    for (const [id, regex, message] of matchRules) {
      if (!enabledSet.has(id)) continue;
      for (const match of id === 'empty-catch' ? emptyCatches(code) : code.matchAll(regex)) {
        const line = index.line(match.index);
        add(id, relative, line, message, index.evidence(line), { endLine: index.line(match.end ?? match.index + match[0].length - 1) });
      }
    }
    for (const match of enabledSet.has('hardcoded-secret') ? credentialAssignments(source, code) : []) {
      const line = index.line(match.index);
      add('hardcoded-secret', relative, line, '可能的硬编码凭据：改用受控配置，并确认是否需要轮换', index.evidence(line));
    }
    let previousTodoLine = 0;
    for (const match of enabledSet.has('todo') ? source.matchAll(/\b(?:TODO|FIXME)\b/g) : []) {
      const line = index.line(match.index);
      if (line !== previousTodoLine) add('todo', relative, line, '发现待办事项', index.evidence(line));
      previousTodoLine = line;
    }
    if (/Service\.java$/i.test(file) && index.count > 500) add('large-service', relative, 1, `Service 共 ${index.count} 行，建议拆分职责`, index.evidence(1));
    completed++; if (completed % 25 === 0 || completed === files.length) onProgress({ completed, total: files.length });
  }
  return { issues, files: files.length, lines };
}

/** Redact all string literals in persisted evidence; source viewing remains an explicit local action. */
function redactEvidence(value) { return String(value || '').replace(/"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/g, '"[REDACTED]"'); }

module.exports = { catalog, filesUnder, codeOnly, scanLocal, redactEvidence, lineIndex, limits };
