// A deliberately small JSON path grammar: $.user.id, $[0], $["a.b"]. No eval.
function pathParts(path) {
  let rest = String(path || '').trim();
  if (!rest.startsWith('$')) throw Error('路径需以 $ 开头');
  rest = rest.slice(1);
  const parts = [];
  while (rest) {
    // Anything that is not a structural character is a field name. `\w` is
    // ASCII-only in JavaScript, and the responses this product checks are keyed in
    // Chinese, so `$.data.items[0].机构` has to parse as well as `$.data.items[0]`.
    let match = /^\.([^\s.[\]$]+)/.exec(rest);
    if (match) { parts.push(match[1]); rest = rest.slice(match[0].length); continue; }
    match = /^\[(0|[1-9]\d*)\]/.exec(rest);
    if (match) { parts.push(match[1]); rest = rest.slice(match[0].length); continue; }
    match = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    if (match) { parts.push(JSON.parse(match[1])); rest = rest.slice(match[0].length); continue; }
    throw Error('路径仅支持字段、数组下标和双引号键名');
  }
  return parts;
}

export function readPath(value, path) {
  for (const key of pathParts(path)) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return { exists: false };
    value = value[key];
  }
  return { exists: true, value };
}

/// Same grammar, but a miss says what was actually there. `$.data.token not found`
/// leaves a caller guessing whether the shape changed, the request failed, or the
/// path was simply wrong; naming the segment that broke and listing its siblings
/// answers all three without another round trip.
export function probePath(value, path) {
  const parts = pathParts(path);
  const walked = [];
  for (const key of parts) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) {
      const isIndex = typeof key === 'number' || /^\d+$/.test(String(key));
      const available = value && typeof value === 'object'
        ? Object.keys(value).slice(0, 40) : [];
      return {
        exists: false,
        at: `$${walked.map(part => (typeof part === 'number' || /^\d+$/.test(String(part)) ? `[${part}]` : `.${part}`)).join('')}`,
        missing: String(key),
        isIndex,
        available,
        actualType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      };
    }
    walked.push(key);
    value = value[key];
  }
  return { exists: true, value };
}

export const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (valueType(a) !== valueType(b) || !a || typeof a !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
};
const show = value => {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  return text === undefined ? '未找到' : text.length > 2048 ? text.slice(0, 2048) + '…（已截断）' : text;
};

// Resolve expectations before sending, using the same dynamic variables as the request.
export function prepareChecks(draft, resolve = text => ({ text, missing: new Set() })) {
  const checks = structuredClone(draft.checks || []).filter(row => row.enabled !== false);
  for (const row of checks) {
    if (row.kind === 'json' && row.operator === 'equals') {
      const resolved = resolve(String(row.expected ?? ''));
      row.expected = resolved.text;
      if (resolved.missing.size) row.configError = `预期值缺少变量：${[...resolved.missing].join('、')}`;
    }
  }
  return { checks, extractors: structuredClone(draft.extractors || []).filter(row => row.enabled !== false) };
}

export function evaluateChecks(rules, response, runtime) {
  const checks = [], extractions = [];
  let parsed, parseError;
  const json = () => {
    if (parseError) throw Error(parseError);
    if (parsed !== undefined) return parsed;
    if (response.truncated || response.isText === false) throw Error('响应已截断或不是文本，无法检查完整 JSON');
    try { parsed = JSON.parse(response.bodyText || ''); return parsed; }
    catch { parseError = '响应体不是有效 JSON'; throw Error(parseError); }
  };
  const networkError = !!response.error || !response.status;
  for (const rule of rules.checks) {
    const row = { kind: rule.kind, path: rule.path || '', expected: '', actual: '', ok: false };
    try {
      if (rule.configError) throw Error(rule.configError);
      if (networkError) throw Error('未收到完整响应');
      if (rule.kind === 'status') {
        row.label = '状态码'; row.expected = String(rule.expected || ''); row.actual = String(response.status);
        if (!/^\s*[1-5]\d{2}(\s*,\s*[1-5]\d{2})*\s*$/.test(row.expected)) throw Error('状态码格式：200, 201');
        row.ok = row.expected.split(',').map(Number).includes(response.status);
      } else if (rule.kind === 'time') {
        row.label = '响应耗时'; row.expected = `≤ ${rule.expected} ms`; row.actual = `${response.timeMs} ms`;
        if (!String(rule.expected ?? '').trim() || !Number.isFinite(Number(rule.expected)) || Number(rule.expected) <= 0) throw Error('耗时上限需为正数');
        row.ok = Number.isFinite(response.timeMs) && response.timeMs <= Number(rule.expected);
      } else if (rule.kind === 'json') {
        row.label = { exists: '字段存在', equals: '字段相等', type: '字段类型' }[rule.operator] || 'JSON 字段';
        const found = readPath(json(), rule.path);
        row.actual = found.exists ? show(found.value) : '未找到';
        if (rule.operator === 'exists') { row.expected = '存在'; row.ok = found.exists; }
        else if (rule.operator === 'equals') {
          row.expected = String(rule.expected ?? '');
          let expected;
          try { expected = JSON.parse(row.expected); } catch { throw Error('预期值需为 JSON，例如 0、true 或 "文本"'); }
          row.ok = found.exists && equal(found.value, expected);
        } else if (rule.operator === 'type') {
          row.expected = rule.expected; row.actual = found.exists ? valueType(found.value) : '未找到';
          if (!['string', 'number', 'boolean', 'null', 'array', 'object'].includes(rule.expected)) throw Error('请选择有效类型');
          row.ok = found.exists && row.actual === rule.expected;
        } else throw Error('检查方式不支持');
      } else throw Error('检查类型不支持');
    } catch (error) { row.error = error.message; }
    checks.push(row);
  }
  const names = new Set();
  const duplicates = new Set();
  for (const rule of rules.extractors) { const name = String(rule.name || '').trim(); if (names.has(name)) duplicates.add(name); names.add(name); }
  for (const rule of rules.extractors) {
    const name = String(rule.name || '').trim();
    // A tombstone hides old environment/collection values when extraction fails.
    if (name) runtime?.set(name, null);
    const row = { name, path: rule.path || '', source: rule.source || 'json', ok: false };
    try {
      if (!name || /[{}\s]/.test(name) || name.startsWith('$')) throw Error('变量名不能为空，且不能含空白、花括号或以 $ 开头');
      if (duplicates.has(name)) throw Error('提取变量名重复');
      if (networkError) throw Error('未收到完整响应');
      let found;
      if (row.source === 'header') {
        const header = (response.headers || []).find(h => h.name.toLowerCase() === row.path.trim().toLowerCase());
        found = { exists: !!header, value: header?.value };
      } else if (row.source === 'json') found = readPath(json(), row.path);
      else throw Error('提取来源不支持');
      if (!found.exists) throw Error('未找到字段');
      row.value = typeof found.value === 'string' ? found.value : JSON.stringify(found.value);
      if (new TextEncoder().encode(row.value).length > 65536) { delete row.value; throw Error('提取值超过 64 KiB'); }
      row.ok = true;
    } catch (error) { row.error = error.message; }
    extractions.push(row);
  }
  const hasStatus = rules.checks.some(rule => rule.kind === 'status');
  const transportOk = !networkError;
  // 101 是 WebSocket 握手的成功状态：1xx 虽在普通 HTTP 成功区间之外，但对长连接
  // 步骤来说"握手完成"就是它的 200。
  const httpOk = transportOk && (response.status === 101 || (response.status >= 200 && response.status < 400));
  const ok = transportOk && (hasStatus || httpOk) && checks.every(row => row.ok) && extractions.every(row => row.ok);
  // A failed business check must not promote untrusted values into the next step.
  if (ok) for (const row of extractions) runtime?.set(row.name, row.value);
  return { ok, httpOk, transportOk, checks, extractions, passed: checks.filter(row => row.ok).length,
    reason: networkError ? response.error || '未收到响应' : !hasStatus && !httpOk ? `HTTP ${response.status} · 默认接受 101 或 200–399` : '',
    outcome: networkError ? response.errorKind === 'cancelled' ? 'cancelled' : 'network-error' : ok ? 'passed' : !hasStatus && !httpOk ? 'http-error' : 'check-failed' };
}
