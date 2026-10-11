// Local JSON only. References are resolved within this document; no remote fetches.
const pair = (key, value) => ({ id: crypto.randomUUID(), key, value: String(value ?? ''), enabled: true, description: '' });
const secret = key => /authorization|cookie|token|secret|password|credential|api[-_]?key/i.test(key);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
export function parseImport(text, format, { keepSensitive = false } = {}) {
  if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) throw Error('文件超过 16 MiB，请拆分后导入');
  let doc;
  try { doc = JSON.parse(text); } catch { throw Error('需要有效的 JSON 文件；OpenAPI YAML 请先转换为 JSON'); }
  const warnings = [], items = [];
  const warn = text => { if (!warnings.includes(text)) warnings.push(text); };
  const filter = list => list.filter(row => {
    if (!keepSensitive && secret(row.key)) { warn('已排除敏感请求头和参数；鉴权需重新配置'); return false; }
    return true;
  });
  if (format === 'har') {
    if (!Array.isArray(doc.log?.entries)) throw Error('不是有效的 HAR：缺少 log.entries');
    for (const entry of doc.log.entries) {
      const request = entry.request;
      if (!request?.url || !request.method) { warn('缺少 URL 或方法的记录已跳过'); continue; }
      let url;
      try { url = new URL(request.url); } catch { warn('无效 URL 的记录已跳过'); continue; }
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) { warn('不支持的 URL 协议已跳过'); continue; }
      let params = [...url.searchParams].map(([key, value]) => pair(key, value));
      for (const p of request.queryString || []) if (!params.some(row => row.key === p.name)) params.push(pair(p.name, p.value));
      params = filter(params); url.search = ''; url.hash = '';
      if (!keepSensitive && (url.username || url.password)) { url.username = ''; url.password = ''; warn('已排除 URL 中的账号和密码'); }
      const headers = filter((request.headers || []).filter(h => !h.name.startsWith(':') && !/^(content-length|host|connection)$/i.test(h.name)).map(h => pair(h.name, h.value)));
      const body = { mode: 'none' };
      const data = request.postData;
      if (data?.mimeType && !headers.some(row => row.key.toLowerCase() === 'content-type')) headers.push(pair('Content-Type', data.mimeType));
      if (data?.text !== undefined) {
        if (data.encoding === 'base64') warn('Base64 请求体未导入');
        else Object.assign(body, { mode: 'raw', raw: { language: /json/i.test(data.mimeType) ? 'json' : 'text', content: data.text } });
      } else if (data?.params?.length) {
        const mode = /multipart/i.test(data.mimeType) ? 'form' : 'urlencoded';
        body.mode = mode; body[mode] = filter(data.params.filter(p => {
          if (p.fileName) { warn('HAR 不含本地上传文件，文件字段已跳过'); return false; } return true;
        }).map(p => pair(p.name, p.value)));
      }
      if (body.mode !== 'none') warn('HAR 请求体可能包含业务数据或凭据，请在发送前检查');
      if (body.mode === 'form') {
        for (let i = headers.length - 1; i >= 0; i--) if (headers[i].key.toLowerCase() === 'content-type') headers.splice(i, 1);
        warn('Multipart boundary 由发送引擎生成');
      }
      const responseType = entry.response?.content?.mimeType || '';
      const protocol = /^wss?:/i.test(request.url) ? 'ws' : /text\/event-stream/i.test(responseType) ? 'sse' : 'http';
      items.push({ name: `${request.method} ${url.pathname}`, protocol, draft: { method: request.method.toUpperCase(), url: url.href.replace(/\/$/, url.pathname === '/' ? '/' : ''), params, headers, body } });
    }
    return { name: doc.log.creator?.name ? 'HAR 接口' : '导入的接口', items, warnings };
  }
  if (format !== 'openapi' || !/^3\.(0|1|2)\./.test(doc.openapi || '') || !doc.paths) throw Error('需要 OpenAPI 3.x 文档（JSON）');
  const ref = value => {
    const seen = new Set();
    while (value?.$ref) {
      const pointer = value.$ref;
      if (!pointer.startsWith('#/')) { warn('外部 $ref 未读取，请先合并文档'); return null; }
      if (seen.has(pointer)) { warn('循环 $ref 未展开'); return null; }
      seen.add(pointer);
      value = pointer.slice(2).split('/').reduce((current, key) => current && Object.prototype.hasOwnProperty.call(current, key.replace(/~1/g, '/').replace(/~0/g, '~')) ? current[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, doc);
      if (!value) { warn('未找到部分 $ref'); return null; }
    }
    return value;
  };
  const example = value => value?.example ?? (value?.examples ? ref(Object.values(value.examples)[0])?.value : undefined) ?? value?.schema?.default;
  for (const [path, pathValue] of Object.entries(doc.paths)) {
    const pathItem = ref(pathValue); if (!pathItem) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      const server = operation.servers?.[0] || pathItem.servers?.[0] || doc.servers?.[0];
      let base = server?.url || '{{baseUrl}}';
      if (server?.variables) base = base.replace(/\{([^{}]+)\}/g, (_, key) => server.variables[key]?.default ?? `{{${key}}}`);
      if (!/^(https?:\/\/|wss?:\/\/|\{\{)/i.test(base)) { warn('相对 server 地址需自行配置 baseUrl'); base = '{{baseUrl}}'; }
      if (!server) warn('未指定 server，使用 {{baseUrl}}');
      let requestPath = path; const params = [], headers = [];
      const merged = new Map();
      for (const raw of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
        const p = ref(raw); if (p) merged.set(`${p.in}:${p.name}`, p);
      }
      for (const p of merged.values()) {
        const value = example(p);
        if (p.in === 'path') requestPath = requestPath.replaceAll(`{${p.name}}`, value === undefined ? `{{${p.name}}}` : encodeURIComponent(String(value)));
        else if (p.in === 'query' || p.in === 'header') {
          const row = pair(p.name, value === undefined ? p.required ? `{{${p.name}}}` : '' : typeof value === 'object' ? JSON.stringify(value) : value);
          row.enabled = value !== undefined || !!p.required;
          (p.in === 'query' ? params : headers).push(row);
          if (p.style && !['form', 'simple'].includes(p.style) || p.schema?.type === 'array' || p.schema?.type === 'object') warn('复杂参数序列化需手动核对');
        } else warn('Cookie 参数需手动配置');
      }
      requestPath = requestPath.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (_, key) => { warn('部分路径参数缺少声明，已保留为变量'); return `{{${key}}}`; });
      const body = { mode: 'none' }, requestBody = ref(operation.requestBody);
      if (requestBody?.content) {
        const entries = Object.entries(requestBody.content), chosen = entries.find(([mime]) => /json/i.test(mime)) || entries[0];
        if (entries.length > 1) warn('多个请求体格式仅选取一种，可在 Body 中调整');
        if (chosen) {
          const [mime, media] = chosen;
          const sample = example(media);
          headers.push(pair('Content-Type', mime));
          if (/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(mime)) {
            const mode = /multipart/i.test(mime) ? 'form' : 'urlencoded'; body.mode = mode; body[mode] = [];
            const schema = ref(media.schema);
            for (const [key, property] of Object.entries(schema?.properties || {})) {
              const field = ref(property);
              if (field?.format === 'binary') { warn('文件字段需在 Body 中手动选择本地文件'); continue; }
              const value = sample && typeof sample === 'object' ? sample[key] : field?.example ?? field?.default;
              const row = pair(key, value === undefined ? `{{${key}}}` : typeof value === 'object' ? JSON.stringify(value) : value);
              row.enabled = value !== undefined || !!schema?.required?.includes(key); body[mode].push(row);
            }
            if (!schema?.properties && sample && typeof sample === 'object') body[mode] = Object.entries(sample).map(([key, value]) => pair(key, typeof value === 'object' ? JSON.stringify(value) : value));
            body[mode] = filter(body[mode]);
            if (mode === 'form') { headers.pop(); warn('Multipart boundary 由发送引擎生成'); }
          } else if (/octet-stream|^image\/|^audio\/|^video\//i.test(mime)) { headers.pop(); warn('二进制请求体未导入，请在 Body 中选择文件'); }
          else if (sample !== undefined) Object.assign(body, { mode: 'raw', raw: { language: /json/i.test(mime) ? 'json' : 'text', content: typeof sample === 'object' || /json/i.test(mime) ? JSON.stringify(sample, null, 2) : String(sample) } });
          else { warn('部分请求体没有示例，需手动填写；未从 schema 伪造值'); Object.assign(body, { mode: 'raw', raw: { language: /json/i.test(mime) ? 'json' : 'text', content: '' } }); }
        }
      }
      if ((operation.security || doc.security)?.length) warn('安全方案未自动填入凭据，请在 Auth 中配置');
      if (operation.callbacks) warn('Callback 未导入');
      const stream = Object.values(operation.responses || {}).some(raw => ref(raw)?.content?.['text/event-stream']);
      items.push({ name: operation.summary || operation.operationId || `${method.toUpperCase()} ${path}`, description: operation.description || '', protocol: /^wss?:/i.test(base) ? 'ws' : stream ? 'sse' : 'http',
        draft: { method: method.toUpperCase(), url: base.replace(/\/$/, '') + requestPath, params: filter(params), headers: filter(headers), body } });
    }
  }
  if (doc.webhooks || doc.callbacks) warn('Webhook / Callback 未导入');
  return { name: doc.info?.title || 'OpenAPI 接口', items, warnings };
}
