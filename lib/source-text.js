/** Mask comments and quoted text in one forward pass, preserving UTF-16 offsets and CR/LF positions. */
function maskSource(source, dialect = 'java') {
  const buffer = Buffer.from(source, 'utf16le');
  function mask(start, end) { for (let p = start; p < end; p++) if (source[p] !== '\r' && source[p] !== '\n') buffer.writeUInt16LE(32, p * 2); }
  let cursor = 0;
  while (cursor < source.length) {
    const start = cursor, character = source[cursor], next = source[cursor + 1];
    if (character === '/' && next === '*' ) {
      const close = source.indexOf('*/', cursor + 2);
      if (close < 0) throw Error('源码有未闭合的块注释，检查未完成');
      cursor = close + 2; mask(start, cursor); continue;
    }
    if (dialect === 'java' && character === '/' && next === '/' || dialect === 'sql' && character === '-' && next === '-') {
      cursor += 2; while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor++;
      mask(start, cursor); continue;
    }
    if (character === '"' || character === "'" || dialect === 'sql' && character === '`') {
      const quote = character; cursor++; let closed = false;
      while (cursor < source.length) {
        if (dialect === 'java' && (source[cursor] === '\r' || source[cursor] === '\n')) break;
        if (source[cursor] === '\\') { cursor += 2; continue; }
        if (source[cursor] === quote) {
          if (dialect === 'sql' && source[cursor + 1] === quote) { cursor += 2; continue; }
          cursor++; closed = true; break;
        }
        cursor++;
      }
      if (!closed) throw Error('源码有未闭合的字符串或标识符，检查未完成');
      mask(start, cursor); continue;
    }
    cursor++;
  }
  return buffer.toString('utf16le');
}

/** Locate empty Java catch bodies without retrying a long malformed signature from every catch token. */
function* emptyCatches(code) {
  const tokens = /\bcatch\b/g;
  for (let match; (match = tokens.exec(code));) {
    let cursor = tokens.lastIndex;
    while (/\s/.test(code[cursor] || '') && cursor < code.length) cursor++;
    if (code[cursor] !== '(') continue;
    cursor++; let depth = 1;
    while (cursor < code.length && depth) {
      const character = code[cursor++];
      if (character === '(') depth++;
      else if (character === ')') depth--;
      else if (character === '{' || character === '}' || character === ';') break;
    }
    tokens.lastIndex = cursor;
    if (depth) continue;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
    if (code[cursor] !== '{') continue;
    cursor++; while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
    if (code[cursor] === '}') yield { index: match.index, end: cursor };
    // Consumed whitespace cannot contain another catch token, so never rescan that span.
    tokens.lastIndex = cursor;
  }
}

/** Match credential assignments by a single identifier token and its literal, rather than nested greedy searches. */
function* credentialAssignments(source, code) {
  const identifiers = /[A-Za-z_$][\w$]*/g;
  for (let match; (match = identifiers.exec(code));) {
    if (!/(?:password|passwd|secret|token|api_?key)/i.test(match[0])) continue;
    let cursor = identifiers.lastIndex;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
    if (code[cursor] !== '=') continue;
    cursor++; while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
    if (source[cursor] !== '"') continue;
    const start = ++cursor;
    while (cursor < source.length && source[cursor] !== '"' && source[cursor] !== '\r' && source[cursor] !== '\n') { if (source[cursor] === '\\') cursor++; cursor++; }
    if (source[cursor] !== '"' || cursor - start < 4) continue;
    const prefix = source.slice(start, Math.min(cursor, start + 64));
    if (/^(?:\$\{|<|your[-_ ]|example|placeholder|test|dummy)/i.test(prefix)) continue;
    yield { index: match.index };
  }
}
module.exports = { maskSource, emptyCatches, credentialAssignments };
