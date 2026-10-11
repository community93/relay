import { el } from './ui.js';
import { selectField } from './menu.js';
import { effectiveAuth } from './state.js';

const KINDS = [
  ['inherit', '继承自集合'],
  ['noauth', '无鉴权'],
  ['bearer', 'Bearer Token'],
  ['basic', 'Basic Auth'],
  ['apikey', 'API Key'],
];

/// Renders the auth chooser + its fields for anything holding `{ auth }`.
export function renderAuthPicker(host, holder, onChange, { allowInherit = true } = {}) {
  const auth = holder.auth || (holder.auth = { kind: 'noauth', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', addTo: 'header' } });
  if (!auth.bearer) auth.bearer = { token: '' };
  if (!auth.basic) auth.basic = { username: '', password: '' };
  if (!auth.apikey) auth.apikey = { key: '', value: '', addTo: 'header' };

  const select = selectField({
    className: 'auth-kind',
    value: auth.kind,
    options: KINDS.filter(([value]) => allowInherit || value !== 'inherit').map(([value, label]) => ({ value, label })),
    onChange: (next) => {
      auth.kind = next;
      onChange();
      draw();
    },
  });
  // A card like every other object on the pane: the chooser is the card's own
  // header, the fields it reveals are the body. Previously both floated directly
  // on the sheet, so Auth was the one sub-page with no box around its content.
  const fields = el('div', { class: 'stack' });
  host.replaceChildren(
    el('div', { class: 'group' }, [
      el('div', { class: 'group-head' }, [el('span', { text: '鉴权方式' }), select]),
      el('div', { class: 'group-body' }, [fields]),
    ])
  );

  function draw() {
    const rows = [];
    if (auth.kind === 'bearer') {
      rows.push(
        field('Token', el('input', { class: 'input mono', value: auth.bearer.token, placeholder: 'eyJhbGciOi…', oninput: (e) => { auth.bearer.token = e.target.value; onChange(); } }))
      );
    } else if (auth.kind === 'basic') {
      rows.push(
        el('div', { class: 'inline' }, [
          field('用户名', el('input', { class: 'input', dataset: { variables: 'true' }, value: auth.basic.username, oninput: (e) => { auth.basic.username = e.target.value; onChange(); } })),
          field('密码', el('input', { class: 'input', dataset: { variables: 'true' }, type: 'password', value: auth.basic.password, oninput: (e) => { auth.basic.password = e.target.value; onChange(); } })),
        ])
      );
    } else if (auth.kind === 'apikey') {
      const addTo = selectField({
        className: 'apikey-into',
        value: auth.apikey.addTo === 'query' ? 'query' : 'header',
        options: [
          { value: 'header', label: 'Header' },
          { value: 'query', label: 'Query' },
        ],
        onChange: (next) => {
          auth.apikey.addTo = next;
          onChange();
        },
      });
      rows.push(
        el('div', { class: 'inline' }, [
          field('Key', el('input', { class: 'input mono', value: auth.apikey.key, placeholder: 'X-Api-Key', oninput: (e) => { auth.apikey.key = e.target.value; onChange(); } })),
          field('Value', el('input', { class: 'input mono', value: auth.apikey.value, oninput: (e) => { auth.apikey.value = e.target.value; onChange(); } })),
          field('添加到', addTo),
        ])
      );
    } else if (auth.kind === 'inherit') {
      rows.push(el('p', { class: 'hint', text: '沿用集合的鉴权配置。' }));
    } else {
      rows.push(el('p', { class: 'hint', text: '不附加鉴权头，即使集合已配置。' }));
    }
    fields.replaceChildren(...rows);
  }
  draw();
}

function field(label, control) {
  return el('div', { class: 'field', style: { flex: '1', minWidth: '140px' } }, [el('label', { text: label }), control]);
}

export function authSummary(holder, tab) {
  const auth = tab ? effectiveAuth(tab) : holder.auth;
  const label = (KINDS.find(([value]) => value === (auth && auth.kind)) || ['', '未配置'])[1];
  return label;
}
