const fs = require('node:fs');
const results = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
(async () => {
  const c = await import('data:text/javascript;base64,' + fs.readFileSync('web/js/checks.js').toString('base64'));
  const f = await import('data:text/javascript;base64,' + fs.readFileSync('web/js/import-formats.js').toString('base64'));
  const response = { status: 200, timeMs: 12, bodyText: '{"data":{"token":"fresh","count":0,"valid":false,"nil":null,"a.b":[{"id":3}]}}' };
  const evaluate = (checks = [], extractors = [], res = response, scope = new Map()) => c.evaluateChecks(c.prepareChecks({ checks, extractors }), res, scope);
  for (const [path, value] of [['$.data.count', 0], ['$.data.valid', false], ['$.data.nil', null], ['$["data"]["a.b"][0].id', 3]]) check(`path ${path}`, c.readPath(JSON.parse(response.bodyText), path).value === value);
  check('missing is distinct from null', !c.readPath({}, '$.nil').exists);
  check('inherited properties excluded', !c.readPath({}, '$.toString').exists);
  for (const path of ['data.x', '$..x', '$[*]', '$[0];globalThis.bad=true', '$["broken]']) { let failed = false; try { c.readPath({}, path); } catch { failed = true; } check(`reject ${path}`, failed); }
  // The field-name pattern used to be ASCII-only, which silently made every
  // Chinese-keyed response unaddressable with the dot form. Widening it must not
  // turn the structural characters back into ordinary name characters.
  const cjk = JSON.parse('{"数据":{"条目":[{"机构":"上海"}]}}');
  check('path with CJK field names', c.readPath(cjk, '$.数据.条目[0].机构').value === '上海');
  check('CJK path still stops at a bracket', c.readPath(cjk, '$.数据.条目').exists && Array.isArray(c.readPath(cjk, '$.数据.条目').value));
  check('CJK miss is still a miss', !c.readPath(cjk, '$.数据.没有').exists);
  // probePath has to say where it broke and what was there, which is what makes a
  // wrong path fixable without another execution.
  const probe = c.probePath(cjk, '$.数据.没有.更深');
  check('probe names the segment that broke', !probe.exists && probe.missing === '没有' && probe.at === '$.数据', JSON.stringify(probe));
  check('probe lists sibling keys', probe.available.join(',') === '条目', probe.available);
  check('probe still resolves hits', c.probePath(cjk, '$.数据.条目[0].机构').value === '上海');
  let probeRejected = false; try { c.probePath(cjk, '$..x'); } catch { probeRejected = true; } check('probe rejects bad grammar', probeRejected);
  check('legacy HTTP success', evaluate().ok);
  check('legacy HTTP failure', !evaluate([], [], { ...response, status: 401 }).ok);
  check('explicit expected 401 passes', evaluate([{ kind: 'status', expected: '401' }], [], { ...response, status: 401, ok: false }).ok);
  check('multiple allowed status codes', evaluate([{ kind: 'status', expected: '200, 201' }]).ok);
  check('invalid status range fails', !evaluate([{ kind: 'status', expected: '200-299' }]).ok);
  check('200 business mismatch fails', !evaluate([{ kind: 'json', path: '$.data.valid', operator: 'equals', expected: 'true' }]).ok);
  check('JSON false exists', evaluate([{ kind: 'json', path: '$.data.valid', operator: 'exists' }]).ok);
  check('JSON null equals', evaluate([{ kind: 'json', path: '$.data.nil', operator: 'equals', expected: 'null' }]).ok);
  check('JSON equality ignores object key order', evaluate([{ kind: 'json', path: '$', operator: 'equals', expected: '{"b":2,"a":1}' }], [], { ...response, bodyText: '{"a":1,"b":2}' }).ok);
  check('JSON equality distinguishes types', !evaluate([{ kind: 'json', path: '$.data.count', operator: 'equals', expected: '"0"' }]).ok);
  check('JSON type null', evaluate([{ kind: 'json', path: '$.data.nil', operator: 'type', expected: 'null' }]).ok);
  check('invalid JSON expectation fails clearly', evaluate([{ kind: 'json', path: '$', operator: 'equals', expected: 'plain' }]).checks[0].error.includes('JSON'));
  check('slow response fails limit', !evaluate([{ kind: 'time', expected: '5' }]).ok);
  check('negative time rejected', !evaluate([{ kind: 'time', expected: '-1' }]).ok);
  check('disabled rules ignored', evaluate([{ kind: 'status', expected: '500', enabled: false }]).ok);
  check('truncated JSON rejected', !evaluate([{ kind: 'json', operator: 'exists', path: '$' }], [], { ...response, truncated: true }).ok);
  check('invalid JSON rejected', !evaluate([{ kind: 'json', operator: 'exists', path: '$' }], [], { ...response, bodyText: 'not JSON' }).ok);
  const scope = new Map();
  check('token extraction works', evaluate([], [{ name: 'token', path: '$.data.token' }], response, scope).ok && scope.get('token') === 'fresh');
  check('failed extraction tombstones previous value', !evaluate([], [{ name: 'token', path: '$.absent' }], response, scope).ok && scope.get('token') === null);
  check('failed checks do not promote extracted token', !evaluate([{ kind: 'status', expected: '201' }], [{ name: 'token', path: '$.data.token' }], response, scope).ok && scope.get('token') === null);
  check('duplicate extractor names both fail', evaluate([], [{ name: 'token', path: '$.data.token' }, { name: ' token ', path: '$.data.count' }]).extractions.every(row => !row.ok));
  check('builtin variable names rejected', !evaluate([], [{ name: '$guid', path: '$.data.token' }]).ok);
  check('large extracted values fail', !evaluate([], [{ name: 'x', path: '$' }], { ...response, bodyText: JSON.stringify('x'.repeat(65537)) }).ok);
  check('headers extracted case-insensitively', evaluate([], [{ name: 'token', source: 'header', path: 'X-TOKEN' }], { ...response, headers: [{ name: 'x-token', value: 'abc' }] }).extractions[0].value === 'abc');
  check('network failure cannot pass status rule', !evaluate([{ kind: 'status', expected: '200' }], [], { ...response, error: 'reset' }).ok);
  check('cancellation separate outcome', evaluate([], [], { status: 0, error: 'cancelled', errorKind: 'cancelled' }).outcome === 'cancelled');
  const prepared = c.prepareChecks({ checks: [{ kind: 'json', operator: 'equals', expected: '{{missing}}', path: '$' }] }, text => ({ text: '', missing: new Set(['missing']) }));
  check('missing expectation variable explicit error', c.evaluateChecks(prepared, response).checks[0].error.includes('missing'));
  const api = { openapi: '3.1.0', info: { title: 'Service' }, servers: [{ url: 'https://api.test/v1' }], paths: {
    '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true }], get: { summary: 'Read item', parameters: [{ name: 'q', in: 'query', example: 'a' }, { name: 'Authorization', in: 'header', example: 'secret' }], responses: { 200: { content: { 'application/json': {} } } } } },
    '/events': { get: { responses: { 200: { content: { 'text/event-stream': {} } } } } },
    '/ref': { $ref: '#/components/pathItems/Example' },
    '/external': { $ref: 'https://remote.invalid/item' },
  }, components: { pathItems: { Example: { post: { requestBody: { content: { 'application/json': { example: { value: 1 } } } }, responses: {} } } } } };
  const imported = f.parseImport(JSON.stringify(api), 'openapi');
  check('OpenAPI paths + local refs', imported.items.length === 3);
  check('OpenAPI title preserved', imported.name === 'Service' && imported.items[0].name === 'Read item');
  check('OpenAPI path placeholders preserved', imported.items[0].draft.url === 'https://api.test/v1/items/{{id}}');
  check('OpenAPI default strips secrets', !imported.items[0].draft.headers.some(row => row.key === 'Authorization'));
  check('OpenAPI internal refs + body example', imported.items[2].draft.body.raw.content.includes('"value": 1'));
  check('OpenAPI SSE inferred from response', imported.items[1].protocol === 'sse');
  check('external refs reported', imported.warnings.some(text => text.includes('外部')));
  const formSpec={openapi:'3.0.3',paths:{'/upload':{post:{requestBody:{content:{'multipart/form-data':{
    schema:{type:'object',properties:{note:{type:'string',example:'hello'},file:{type:'string',format:'binary'}}}
  }}},responses:{}}}}};
  const multipart=f.parseImport(JSON.stringify(formSpec),'openapi');
  check('OpenAPI multipart uses form rows',multipart.items[0].draft.body.mode==='form'&&multipart.items[0].draft.body.form[0].value==='hello');
  check('OpenAPI multipart leaves boundary to engine',!multipart.items[0].draft.headers.some(row=>row.key==='Content-Type'));
  check('OpenAPI file fields reported for manual selection',multipart.warnings.some(text=>text.includes('文件字段')));
  const fileOnly=structuredClone(formSpec);fileOnly.paths['/upload'].post.requestBody.content['multipart/form-data']={schema:{properties:{file:{type:'string',format:'binary'}}},example:{file:'sample.bin'}};
  check('binary file examples are not converted into text fields',f.parseImport(JSON.stringify(fileOnly),'openapi').items[0].draft.body.form.length===0);
  const withUndeclared={openapi:'3.0.3',paths:{'/items/{itemId}':{get:{responses:{}}}}};
  check('undeclared path argument remains editable variable',f.parseImport(JSON.stringify(withUndeclared),'openapi').items[0].draft.url.endsWith('/items/{{itemId}}'));
  const har = { log: { entries: [{ request: { method: 'POST', url: 'https://api.test/x?token=secret&q=ok', headers: [{ name: 'Cookie', value: 'secret' }], postData: { text: '{"stream":true}', mimeType: 'application/json' } }, response: { content: { mimeType: 'text/event-stream' } } }, { request: { method: 'GET', url: 'wss://api.test/ws', headers: [] } }] } };
  const h = f.parseImport(JSON.stringify(har), 'har');
  check('HAR URL query not duplicated', !h.items[0].draft.url.includes('?') && h.items[0].draft.params.length === 1 && h.items[0].draft.params[0].key === 'q');
  check('HAR cookies stripped', !h.items[0].draft.headers.some(row => row.key === 'Cookie'));
  check('HAR SSE and WS protocols', h.items[0].protocol === 'sse' && h.items[1].protocol === 'ws');
  check('HAR explicit keep sensitive', f.parseImport(JSON.stringify(har), 'har', { keepSensitive: true }).items[0].draft.headers.some(row => row.key === 'Cookie'));
  check('HAR body privacy warning', h.warnings.some(text => text.includes('请求体')));
  const harForm={log:{entries:[{request:{method:'POST',url:'https://api.test/form',headers:[{name:'Content-Type',value:'multipart/form-data; boundary=old'}],postData:{mimeType:'multipart/form-data',params:[{name:'title',value:'test'}]}}}]}};
  const hf=f.parseImport(JSON.stringify(harForm),'har').items[0].draft;
  check('HAR rebuilt form regenerates multipart boundary',hf.body.mode==='form'&&hf.body.form[0].value==='test'&&!hf.headers.some(row=>row.key==='Content-Type'));
  for (const [text, format] of [['openapi: 3.0.0', 'openapi'], ['{}', 'har'], ['{"openapi":"2.0","paths":{}}', 'openapi']]) { let failed = false; try { f.parseImport(text, format); } catch { failed = true; } check(`invalid import ${format} ${text}`, failed); }
  console.log(`${results.filter(row => row.ok).length}/${results.length} passed`);
  process.exitCode = results.every(row => row.ok) ? 0 : 1;
})();
