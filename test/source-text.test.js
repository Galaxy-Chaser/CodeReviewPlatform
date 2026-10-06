const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { maskSource, emptyCatches, credentialAssignments } = require('../lib/source-text');
const { scanInWorker } = require('../lib/scanner');

test('single-pass masking preserves Unicode offsets and CRLF, including quoted SQL identifiers and escaped literals', () => {
  const source = 'class 中文 {\r\n String text = "a\\\"b"; // catch(e) {}\r\n /* 多行\n注释 */ try {} catch (@A(v=1) Exception e) { /* empty */ }\r\n}';
  const code = maskSource(source);
  assert.equal(code.length, source.length);
  for (let n = 0; n < source.length; n++) if ('\r\n'.includes(source[n])) assert.equal(code[n], source[n]);
  assert.equal([...emptyCatches(code)].length, 1);
  assert.equal([...emptyCatches(code)][0].index, source.indexOf('catch (@A'));
  const sql = maskSource("-- DROP TABLE ignored\nSELECT 'it''s DROP TABLE text', \"DROP TABLE quoted\", `TRUNCATE TABLE identifier`;\nDROP TABLE actual;", 'sql');
  assert.equal([...sql.matchAll(/DROP TABLE/g)].length, 1);
  assert.ok(sql.includes('DROP TABLE actual'));
});

test('empty catches preserve body boundaries, multi-catch and later catches following malformed signatures', () => {
  const source = 'catch (A | B e) {\n } catch (C e) { handle(); } catch (broken; catch (D e) { }';
  const matches = [...emptyCatches(source)];
  assert.equal(matches.length, 2); assert.equal(matches[0].end, source.indexOf('}'));
  assert.equal(matches[1].index, source.indexOf('catch (D'));
});

test('credential token inspection supports escaped literals, ignores placeholders, comments and assignments inside strings', () => {
  const source = 'String token = "real\\\"value"; String password = "placeholder"; // String secret = "private";\n String example = "apiKey = \\"fakeValue\\"";';
  const matches = [...credentialAssignments(source, maskSource(source))];
  assert.equal(matches.length, 1); assert.equal(matches[0].index, source.indexOf('token'));
  for (const text of ['/* unterminated', '"unterminated', "'unterminated"]) assert.throws(() => maskSource(text), /未闭合/);
});

test('pathological malformed tokens finish in bounded worker time, unclosed comments fail explicitly', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-linear-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Pathological.java');
  for (const [source, rules] of [['catch ('.repeat(300000), ['empty-catch']], ['String ' + 'password'.repeat(150000) + ';', ['hardcoded-secret']]]) {
    await fs.writeFile(file, source);
    assert.equal((await scanInWorker(root, rules, { timeoutMs: 5000 })).issues.length, 0);
  }
  await fs.writeFile(file, '/* '.repeat(300000));
  await assert.rejects(scanInWorker(root, ['java8-api'], { timeoutMs: 5000 }), /未闭合.*未完成/);
  await fs.writeFile(path.join(root, 'Invalid.sql'), "SELECT '" + 'a'.repeat(1000000));
  await fs.writeFile(file, 'class Safe {}');
  await assert.rejects(scanInWorker(root, ['destructive-sql'], { timeoutMs: 5000 }), /未闭合.*未完成/);
});
