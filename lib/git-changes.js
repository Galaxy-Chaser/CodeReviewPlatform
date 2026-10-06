const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const execute = promisify(execFile);

/** Run read-only Git commands in projectPath; neither staging nor checkout is modified. */
async function git(projectPath, args) {
  return (await execute(process.env.GIT_EXECUTABLE || 'git', ['-C', projectPath, ...args],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout;
}

/** Return Java/SQL changes against HEAD, including staged, unstaged and untracked files. */
async function changedLines(projectPath) {
  try { await git(projectPath, ['rev-parse', '--show-toplevel']); }
  catch { throw new Error('未检测到 Git 仓库或 Git 工具，请先初始化仓库，或选择整个项目检查。'); }
  let head = null;
  try { head = (await git(projectPath, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch { /* An initial repository has no HEAD yet. */ }
  const names = head ? await git(projectPath, ['diff', '--relative', '--name-only', '-z', '--no-renames', '--diff-filter=ACMR', 'HEAD', '--', '.']) : await git(projectPath, ['ls-files', '-z', '--', '.']);
  const untracked = (await git(projectPath, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).split('\0').filter(Boolean);
  const all = [...new Set([...names.split('\0'), ...untracked])].filter(name => /\.(java|sql)$/i.test(name));
  const ranges = {};
  for (const name of all) {
    // Paths from Git are project-relative; reject anything escaping the registered root.
    const normalized = name.split(path.sep).join('/');
    if (normalized.startsWith('../') || path.isAbsolute(name)) throw new Error('Git 返回了项目目录外的路径。');
    if (!head || untracked.includes(name)) { ranges[normalized] = [[1, Number.MAX_SAFE_INTEGER]]; continue; }
    const patch = await git(projectPath, ['diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', 'HEAD', '--', name]);
    ranges[normalized] = [...patch.matchAll(/^@@ .*?\+(\d+)(?:,(\d+))? @@/gm)].flatMap(match => {
      const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
      // Pure deletions can create an empty catch; inspect the surviving adjacent line as well.
      return count ? [[start, start + count - 1]] : [[Math.max(1, start), Math.max(1, start)]];
    });
  }
  return { head, ranges, files: Object.keys(ranges), description: '当前 HEAD 之后的暂存、未暂存与未跟踪改动；不包含已提交的改动' };
}

/** Match findings to modified lines; file-level rules retain cross-file migration context. */
function filterChanged(issues, changes) {
  return issues.filter(issue => {
    if (['large-service', 'migration-version'].includes(issue.rule)) return [issue.file, ...(issue.relatedFiles || [])].some(file => changes.files.includes(file));
    return (changes.ranges[issue.file] || []).some(([start, end]) => issue.line <= end && (issue.endLine || issue.line) >= start);
  });
}
module.exports = { changedLines, filterChanged };
