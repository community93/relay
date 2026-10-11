import { el, icon, toast } from './ui.js';
import { selectField } from './menu.js';
import { state, touch, kv, flushDomain } from './state.js';

export function renderCheckEditor(host, draft, changed) {
  draft.checks ||= []; draft.extractors ||= [];
  const field = (label, value, update, placeholder = '') => el('label', { class: 'rule-field' }, [
    el('span', { text: label }), el('input', { class: 'input mono', value, placeholder, spellcheck: false,
      dataset: {variables:label==='预期值 · JSON'?'true':'false'},
      oninput: event => { update(event.target.value); changed(); } }),
  ]);
  const redraw = () => { host.replaceChildren(); renderCheckEditor(host, draft, changed); };
  const section = (title, list, make, draw, note) => {
    const box = el('section', { class: 'rules-section' }, [
      el('div', { class: 'rules-heading' }, [el('h4', { text: title }), el('span', { class: 'count', text: list.length }),
        el('button', { class: 'btn sm right', onclick: () => { list.push(make()); changed(); redraw(); } }, [icon('plus'), '添加'])]),
      note ? el('p', { class: 'rules-note', text: note }) : null,
    ]);
    if (!list.length) box.append(el('div', { class: 'rules-empty', text: title === '响应检查' ? '未配置检查 · 使用 HTTP 状态判断结果' : '未配置提取' }));
    list.forEach((rule, index) => {
      const content = draw(rule);
      const row = el('div', { class: `rule-row ${rule.enabled === false ? 'disabled' : ''}` }, [
        el('input', { type: 'checkbox', checked: rule.enabled !== false, 'aria-label': `启用${title} ${index + 1}`,
          onchange: event => { rule.enabled = event.target.checked; changed(); row.classList.toggle('disabled', !rule.enabled); } }),
        el('div', { class: 'rule-fields' }, content),
        el('button', { class: 'btn sm ghost rule-delete', title: '删除规则', 'aria-label': `删除${title} ${index + 1}`,
          onclick: () => { list.splice(index, 1); changed(); redraw(); } }, [icon('trash')]),
      ]);
      box.append(row);
    });
    host.append(box);
  };
  section('响应检查', draft.checks, () => ({ kind: 'status', expected: '200', enabled: true }), rule => {
    const fields = [el('label', { class: 'rule-field' }, [el('span', { text: '检查项' }), selectField({
      value: rule.kind, options: [['status', '状态码'], ['json', 'JSON 字段'], ['time', '响应耗时']],
      title: '检查项', onChange: kind => { Object.assign(rule, { kind, operator: 'exists', path: '$.data', expected: kind === 'status' ? '200' : kind === 'time' ? '1000' : '' }); changed(); redraw(); },
    })])];
    if (rule.kind === 'json') {
      fields.push(field('JSON 路径', rule.path, value => rule.path = value, '$.data.id'));
      fields.push(el('label', { class: 'rule-field' }, [el('span', { text: '条件' }), selectField({ title: '条件', value: rule.operator,
        options: [['exists', '存在'], ['equals', '等于'], ['type', '类型']], onChange: value => { rule.operator = value; rule.expected = value === 'type' ? 'string' : ''; changed(); redraw(); } })]));
      if (rule.operator === 'type') fields.push(el('label', { class: 'rule-field' }, [el('span', { text: '预期类型' }), selectField({ title: '预期类型', value: rule.expected,
        options: ['string', 'number', 'boolean', 'null', 'object', 'array'].map(value => [value, value]), onChange: value => { rule.expected = value; changed(); } })]));
      else if (rule.operator === 'equals') fields.push(field('预期值 · JSON', rule.expected, value => rule.expected = value, 'true / 0 / "文本"'));
    } else fields.push(field(rule.kind === 'time' ? '上限 · ms' : '允许的状态码', rule.expected, value => rule.expected = value, rule.kind === 'time' ? '1000' : '200, 201'));
    return fields;
  });
  section('变量提取', draft.extractors, () => ({ name: 'token', source: 'json', path: '$.token', enabled: true }), rule => [
    field('变量名', rule.name, value => rule.name = value, 'token'),
    el('label', { class: 'rule-field' }, [el('span', { text: '来源' }), selectField({ title: '提取来源', value: rule.source || 'json',
      options: [['json', 'JSON 字段'], ['header', '响应头']], onChange: value => { rule.source = value; rule.path = value === 'header' ? 'X-Token' : '$.token'; changed(); redraw(); } })]),
    field(rule.source === 'header' ? '响应头名称' : 'JSON 路径', rule.path, value => rule.path = value, rule.source === 'header' ? 'X-Token' : '$.data.token'),
  ], '计划中供后续请求使用 {{变量名}}；仅本次运行生效。提取失败会停用旧值。');
}

export function renderCheckResults(result, { secrets = [], environmentId } = {}) {
  if (!result) return el('div', { class: 'rules-empty', text: '没有检查结果' });
  let revealed = false;
  const wrap = el('div', { class: 'check-results' });
  const mask = text => {
    text = String(text ?? '—');
    if (!revealed) for (const secret of [...secrets, ...result.extractions.filter(row => row.ok).map(row => row.value)].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('••••••');
    return text;
  };
  const draw = () => {
    const hasRules = result.checks.length || result.extractions.length;
    wrap.replaceChildren(el('div', { class: 'checks-summary' }, [
      el('span', { class: `pill ${result.ok ? 'ok' : 'err'}`, text: result.ok ? '通过' : result.outcome === 'cancelled' ? '已取消' : '未通过' }),
      el('span', { text: hasRules ? `检查 ${result.passed}/${result.checks.length} · 提取 ${result.extractions.filter(row => row.ok).length}/${result.extractions.length}` : '未配置规则 · HTTP 状态判断' }),
      el('button', { class: 'btn sm ghost right', text: revealed ? '隐藏值' : '显示值', onclick: () => { revealed = !revealed; draw(); } }),
    ]));
    if (result.reason) wrap.append(el('p', { class: 'check-error', text: mask(result.reason) }));
    for (const row of result.checks) wrap.append(el('div', { class: `check-result-row ${row.ok ? 'pass' : 'fail'}` }, [
      el('span', { class: 'check-result-state', text: row.ok ? '通过' : '失败' }),
      el('div', { class: 'check-result-main' }, [el('strong', { text: row.label || '检查配置' }), row.path ? el('code', { text: row.path }) : null,
        el('div', { class: 'check-evidence' }, [el('span', { text: '预期' }), el('code', { text: mask(row.expected) }), el('span', { text: '实际' }), el('code', { text: mask(row.actual) })]),
        row.error ? el('p', { class: 'check-error', text: mask(row.error) }) : null]),
    ]));
    for (const row of result.extractions) wrap.append(el('div', { class: `check-result-row ${row.ok ? 'pass' : 'fail'}` }, [
      el('span', { class: 'check-result-state', text: row.ok ? '已提取' : '失败' }),
      el('div', { class: 'check-result-main' }, [el('strong', { text: `{{${row.name}}}` }), el('code', { text: row.path }),
        el('code', { class: 'extraction-value', text: row.ok ? revealed ? row.value : '••••••' : row.error }),
        row.ok && !result.ok ? el('p', { class: 'rules-note', text: '本次检查未通过，此值未传给后续请求' }) : null]),
      row.ok && result.ok && environmentId ? el('button', { class: 'btn sm', text: '写入环境', title: `写入执行时环境「${state.environments.find(item => item.id === environmentId)?.name || '已删除'}」`, onclick: async event => {
        const env = state.environments.find(item => item.id === environmentId);
        if (!env) { toast('执行时的环境已删除', 'err'); return; }
        const existing = env.variables.find(item => item.key.trim() === row.name);
        if (existing) { existing.value = row.value; existing.enabled = true; } else env.variables.push(kv(row.name, row.value));
        const button = event.currentTarget;
        touch('environments');
        try { await flushDomain('environments', { strict: true }); toast(`已写入「${env.name}」`, 'ok'); button.textContent = '已写入'; }
        catch { button.textContent = '重试写入'; }
      } }) : null,
    ]));
  };
  draw(); return wrap;
}
