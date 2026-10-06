const test = require('node:test');
const assert = require('node:assert/strict');
const { suiteCases } = require('../lib/test-evidence');
const { template, validatePlan, applyAutomaticCases, setCaseResult, pipelineGaps } = require('../lib/acceptance-pipeline');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { collectTestEvidence } = require('../lib/test-evidence');

const xml = '<testsuite tests="3" failures="1" errors="0" skipped="1"><testcase classname="demo.FlowTest" name="normal"/><testcase classname="demo.FlowTest" name="fail"><failure>private failure text</failure></testcase><testcase classname="demo.FlowTest" name="skip"><skipped/></testcase><system-out><![CDATA[<testcase classname="fake.Test" name="fake"/>]]></system-out></testsuite>';

test('Maven case evidence distinguishes actual pass, failure and skip, ignoring log text', () => {
  const cases = suiteCases(xml); assert.equal(cases.length, 3);
  assert.deepEqual(cases.map(c => c.status), ['passed', 'failed', 'skipped']);
  assert.ok(!JSON.stringify(cases).includes('private failure text'));
  for (const text of [xml.replace('tests="3"', 'tests="4"'), xml.replace('</testcase>', ''), '<!DOCTYPE x>' + xml]) assert.throws(() => suiteCases(text));
});

test('bound scenarios require exact fresh execution and cannot be overridden by manual success', () => {
  const plan = { ...template(), confirmed: true, cases: [{ ...template().cases[0], testRef: 'demo.FlowTest#normal' }] };
  assert.equal(validatePlan(plan).cases[0].testRef, 'demo.FlowTest#normal');
  assert.throws(() => validatePlan({ ...plan, requireFull: false, minTests: 0 }));
  assert.throws(() => validatePlan({ ...plan, cases: [{ ...plan.cases[0], testRef: '../invalid' }] }));
  const r = { status: 'completed', mode: 'full', scope: 'project', sourceSnapshot: { digest: 'code' }, acceptancePipeline: { plan: { ...plan, requireBrief: false }, results: {} }, build: { status: 'completed' },
    buildTests: { available: true, executed: 3, failures: 0, errors: 0, skipped: 0, caseEvidence: { available: true, results: [{ testRef: 'demo.FlowTest#normal', status: 'passed', report: 'target/surefire-reports/TEST-FlowTest.xml' }] } } };
  applyAutomaticCases(r, { status: 'CURRENT', digest: 'code' });
  assert.equal(pipelineGaps(r).counts.passed, 1); assert.equal(r.acceptancePipeline.results.normal.origin, 'automatic');
  assert.throws(() => setCaseResult(r, 'normal', { status: 'passed', actual: 'manual statement', evidence: 'manual evidence' }, { status: 'CURRENT', digest: 'code' }), /自动/);
  for (const evidence of [{ available: false }, { available: true, results: [] }, { available: true, results: [{ testRef: 'demo.FlowTest#normal', status: 'skipped', report: 'test.xml' }] }]) {
    r.buildTests.caseEvidence = evidence; applyAutomaticCases(r, { status: 'CURRENT', digest: 'code' }); assert.equal(pipelineGaps(r).counts.passed, 0);
  }
  r.buildTests.caseEvidence = { available: true, results: [{ testRef: 'demo.FlowTest#normal', status: 'failed', report: 'test.xml' }] };
  applyAutomaticCases(r, { status: 'CURRENT', digest: 'code' }); assert.equal(pipelineGaps(r).counts.failed, 1);
});

test('real report collection binds only exact tests from this build; stale and malformed case details stay unverified', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-bound-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'target', 'surefire-reports'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'TEST-FlowTest.xml'); await fs.writeFile(file, xml);
  const evidence = await collectTestEvidence(root, 1, { testRefs: ['demo.FlowTest#normal'] });
  assert.equal(evidence.caseEvidence.available, true); assert.equal(evidence.caseEvidence.results.length, 1); assert.equal(evidence.caseEvidence.results[0].status, 'passed');
  assert.equal((await collectTestEvidence(root, 1, { testRefs: ['demo.OtherTest#normal'] })).caseEvidence.results.length, 0);
  await fs.utimes(file, new Date(0), new Date(0)); assert.equal((await collectTestEvidence(root, Date.now(), { testRefs: ['demo.FlowTest#normal'] })).available, false);
  await fs.writeFile(file, xml.replace('classname="demo.FlowTest"', 'other="demo.FlowTest"'));
  const broken = await collectTestEvidence(root, 1, { testRefs: ['demo.FlowTest#normal'] }); assert.equal(broken.caseEvidence.available, false); assert.equal(broken.caseEvidence.results.length, 0);
});
