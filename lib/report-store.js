const fs = require('node:fs/promises');
const path = require('node:path');
const { acceptanceStatus } = require('./acceptance');

/** Retain only small, explicit dashboard fields; logs, findings and evidence stay on disk. */
function summarize(report) {
  const result = {};
  for (const key of ['id', 'projectId', 'mode', 'scope', 'status', 'stage', 'startedAt', 'finishedAt', 'gate', 'metrics', 'checkedFiles',
    'repository', 'number', 'title', 'url', 'headSha', 'baseSha', 'changedFiles', 'touchedTests', 'acceptanceAt', 'error', 'fileProgress', 'stopRequested']) {
    if (report[key] !== undefined) result[key] = report[key];
  }
  result.issueCount = report.issues?.length ?? report.issueCount ?? 0;
  result.severityCounts = report.severityCounts || {};
  if (report.issues) {
    result.severityCounts = {};
    for (const issue of report.issues) result.severityCounts[issue.severity] = (result.severityCounts[issue.severity] || 0) + 1;
  }
  result.acceptanceStatus = report.acceptance ? acceptanceStatus(report) : report.acceptanceStatus || acceptanceStatus(report);
  if (report.acceptancePipeline) {
    result.pipelinePlanId = report.acceptancePipeline.plan.id;
    result.pipelineCounts = require('./acceptance-pipeline').pipelineGaps(report).counts;
  }
  return result;
}

/** Atomic local report storage with no retained report cache. dataDirectory is the configured data root. */
class ReportStore {
  constructor(dataDirectory) { this.directory = path.join(dataDirectory, 'details'); this.queue = Promise.resolve(); }
  /** Validate report IDs before converting them into file paths, including IDs received from HTTP. */
  file(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('报告编号不正确');
    return path.join(this.directory, id + '.json');
  }
  /** Write one complete report before returning its compact index record. Writes remain ordered. */
  put(report) {
    const file = this.file(report.id), json = JSON.stringify(report);
    const work = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(file + '.tmp', json); await fs.rename(file + '.tmp', file);
      return summarize(report);
    });
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }
  /** Load only the requested report. There is no in-memory history of source findings or logs. */
  async get(id) { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
  /** Migrate legacy inline reports without deleting the original state backup or any report history. */
  async migrate(state) {
    for (const key of ['scans', 'githubReviews']) {
      const reports = state[key] || [];
      for (let i = 0; i < reports.length; i++) {
        const report = reports[i];
        if (Array.isArray(report.issues)) reports[i] = await this.put(report.status === 'running' ? { ...report, status: 'failed', error: '平台重启，先前扫描已中断' } : report);
        else if (report.status === 'running') {
          // Restarted scans have no complete persisted details yet; retain an explicit interrupted result.
          reports[i] = await this.put({ ...report, status: 'failed', issues: [], logs: '', error: '平台重启，先前扫描已中断' });
        }
      }
    }
    state.storageVersion = 1;
    return state;
  }
}
module.exports = { ReportStore, summarize };
