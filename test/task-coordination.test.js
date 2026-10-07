const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { saveRecord, changeTask, taskCoordination } = require('../lib/workspace');
const human = { type: 'human', id: '', name: 'Human' }, owner = { type: 'agent', id: crypto.randomUUID(), name: 'Owner' }, other = { ...owner, id: crypto.randomUUID(), name: 'Other' };
const now = 2000000, projectId = crypto.randomUUID(), scope = () => {};
const submission = { summary: 'Actually handled representative inputs', tests: 'Executed real representative checks', changedFiles: ['docs/result.md'] };

/** Independent expected actions describe the public task lifecycle, rather than recomputing helper rules. */
test('handoff actions match real writes across human/agent ownership, exact expiry, changed requirements and task states', () => {
  const cases = [
    ['ready', human, null, false, ['claim', 'block', 'edit']], ['ready', owner, null, false, ['claim']],
    ['blocked', human, null, false, ['unblock', 'edit']], ['blocked', owner, null, false, []],
    ['in_progress', human, owner, false, ['release']], ['in_progress', owner, owner, false, ['release', 'heartbeat', 'submit']],
    ['in_progress', other, owner, false, []], ['in_progress', human, human, false, ['release', 'submit']],
    ['in_progress', owner, human, false, []], ['review', human, null, false, ['approve', 'reject']],
    ['review', owner, null, false, []], ['done', human, null, false, ['reopen']], ['done', owner, null, false, []],
    ['ready', human, null, true, ['block', 'edit']], ['ready', owner, null, true, []],
    ['in_progress', owner, owner, true, ['release']], ['in_progress', human, human, true, ['release']],
    ['review', human, null, true, ['reject']], ['done', human, null, true, ['reopen']],
    ['in_progress', owner, owner, false, ['claim', 'release'], true], ['in_progress', other, owner, false, ['claim'], true]
  ];
  const all = ['claim', 'heartbeat', 'release', 'submit', 'approve', 'reject', 'block', 'unblock', 'reopen', 'edit'];
  for (const [status, actor, claimant, changed, expected, expired] of cases) {
    const doc = { requirements: [], tasks: [], knowledge: [] };
    const requirement = saveRecord(doc, 'requirements', { projectId, title: 'Requirement', description: 'Current target', criteria: 'Real acceptance', allowedPaths: 'docs only' }, human, scope);
    const task = saveRecord(doc, 'tasks', { projectId, requirementId: requirement.id, title: 'Task', description: 'Current work', criteria: 'Real checks', requireReport: false }, human, scope);
    task.status = status; task.claim = claimant ? { actor: claimant, expiresAt: claimant.type === 'human' ? null : new Date(now + (expired ? 0 : 1)).toISOString() } : null;
    if (['review', 'done'].includes(status)) task.submission = submission;
    if (changed) requirement.version++;
    const c = taskCoordination(doc, task, actor, false, now);
    assert.deepEqual(c.actions.sort(), expected.slice().sort(), `${status}/${actor.name}/${changed}/${expired}`);
    assert.equal(c.requirement.status, changed ? 'CHANGED' : 'CURRENT');
    for (const action of all) {
      const cloned = structuredClone(doc), row = cloned.tasks[0]; let allowed = true;
      try {
        if (action === 'edit') saveRecord(cloned, 'tasks', { ...row, expectedVersion: row.version }, actor, scope);
        else changeTask(cloned, { id: row.id, expectedVersion: row.version, action, reason: 'Actual review or handoff reason', submission }, actor, scope, now);
      } catch { allowed = false; }
      assert.equal(allowed, expected.includes(action), `${status}/${actor.name}/${changed}/${expired}: ${action}`);
    }
  }
});

test('archived or history-full handoffs give no write actions and preserve the original record', () => {
  const task = { id: crypto.randomUUID(), version: 1, projectId, requirementId: '', status: 'ready', claim: null, history: Array(100).fill({ action: 'old' }) };
  const doc = { tasks: [task], requirements: [] }, before = JSON.stringify(doc);
  const limit = taskCoordination(doc, task, owner, false, now); assert.deepEqual(limit.actions, []);
  assert.equal(limit.blockers[0].code, 'HISTORY_LIMIT'); assert.match(limit.nextStep, /后续任务/);
  const archive = taskCoordination(doc, task, human, true, now); assert.deepEqual(archive.actions, []);
  assert.equal(archive.blockers[0].code, 'PROJECT_ARCHIVED'); assert.match(archive.nextStep, /恢复/);
  assert.equal(JSON.stringify(doc), before);
});

test('changed requirements reject heartbeat without altering the lease, task version or history', () => {
  const doc = { tasks: [], requirements: [] };
  const r = saveRecord(doc, 'requirements', { projectId, title: 'Requirement', description: 'Current target', criteria: 'Real acceptance', allowedPaths: 'docs' }, human, scope);
  const t = saveRecord(doc, 'tasks', { projectId, requirementId: r.id, title: 'Task', description: 'Current work', criteria: 'Real checks', requireReport: false }, human, scope);
  changeTask(doc, { id: t.id, expectedVersion: t.version, action: 'claim' }, owner, scope, now);
  r.version++; const before = JSON.stringify(t);
  assert.throws(() => changeTask(doc, { id: t.id, expectedVersion: t.version, action: 'heartbeat' }, owner, scope, now + 1), /需求已变化/);
  assert.equal(JSON.stringify(t), before);
  assert.deepEqual(taskCoordination(doc, t, owner, false, now + 1).actions, ['release']);
});
