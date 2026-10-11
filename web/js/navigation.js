import { el, icon, duration, prettyTime } from './ui.js';
import { state, openRequest, openRunner, openDoc, newEnvironment, newTab, emit, touch } from './state.js';
import { createCollection, collectionInfo } from './tree.js';
import { createRunner } from './runner.js';
import { createDoc } from './doc.js';
import { openEnvironment } from './env.js';
import { endpointStatus } from './delivery.js';
import { renderMarkdown } from './md.js';

export function renderSection(pane) {
  const config = {
    collections: ['集合', 'collections', state.collections, '新建集合', () => createCollection('新建集合')],
    runner: ['运行计划', 'play', state.runners, '新建计划', () => createRunner()],
    docs: ['文档', 'file', state.docs, '新建文档', () => createDoc()],
    environments: ['环境', 'env', state.environments, '新建环境', () => {
      const env = newEnvironment();state.environments.push(env);touch('environments');emit('pane');openEnvironment(env);
    }],
    history: ['历史记录', 'history', state.history, null, null],
  }[pane];
  const [title, glyph, items, action, create] = config;
  const open = item => {
    if (pane === 'runner') openRunner(item);
    else if (pane === 'docs') openDoc(item);
    else if (pane === 'environments') openEnvironment(item);
    else if (pane === 'collections') {
      const requests = [];
      const walk = nodes => nodes.forEach(node => {if (node.children) walk(node.children);else requests.push(node);});
      walk(item.children || []);
      state.expanded[item.id] = true;state.selectedNodeIds = [item.id];emit('tree');
      collectionInfo(item);
    } else {
      const tab = newTab(item.protocol || 'http');
      tab.draft = JSON.parse(JSON.stringify(item.snapshot || tab.draft));tab.auth = JSON.parse(JSON.stringify(item.auth || {kind: 'inherit'}));tab.title = item.name || item.url;
      emit('tabs');emit('rerender');
    }
  };
  const detail = item => {
    if (pane === 'collections') {
      let count = 0;const walk = nodes => nodes.forEach(node => node.children ? walk(node.children) : count++);walk(item.children || []);
      return `${count} 个请求`;
    }
    if (pane === 'runner') return `${(item.sources || []).length} 个步骤`;
    if (pane === 'docs') return `${(item.blocks || []).filter(block=>block.type==='req').length} 个接口 · 交付文档`;
    if (pane === 'environments') return item.defaults?.baseUrl || `${(item.variables || []).filter(row => row.enabled !== false && row.key).length} 个变量`;
    return `${item.status || '—'} · ${duration(item.timeMs || 0)}`;
  };
  if(pane==='docs'&&items.length)return el('div',{class:'pane-scroll section-page document-library',dataset:{section:pane}},[
    el('div',{class:'section-heading'},[el('div',{class:'section-title'},[el('span',{class:'section-glyph'},[icon(glyph)]),el('h1',{text:title}),el('span',{class:'count',text:String(items.length)})]),el('button',{class:'btn primary',onclick:create},[icon('plus'),action])]),
    el('div',{class:'document-library-grid'},items.map(doc=>{
      const requests=(doc.blocks || []).filter(b=>b.type==='req'),ready=requests.filter(b=>endpointStatus(b).kind==='ready').length;
      return el('button',{class:'document-library-card',onclick:()=>open(doc)},[
        el('div',{class:'document-library-top'},[el('span',{class:'document-library-icon'},[icon('file')]),el('span',{class:'mono',text:`v${doc.version || '1.0.0'}`}),icon('chevR')]),
        el('h2',{text:doc.name || '未命名文档'}),el('p',{text:doc.overview?el('div',{html:renderMarkdown(doc.overview)}).textContent:'暂无概述'}),
        el('div',{class:'document-library-meter','aria-hidden':'true'},[el('span',{style:{width:`${requests.length?ready/requests.length*100:0}%`}})]),
        el('div',{class:'document-library-meta'},[el('span',{text:`${requests.length} 个接口 · ${ready} 可交付`}),el('span',{text:doc.updatedAt?prettyTime(doc.updatedAt):''})]),
      ]);
    })),
  ]);
  return el('div', { class: 'pane-scroll section-page', dataset: { section: pane } }, [
    el('div', { class: 'section-heading' }, [
      el('div', { class: 'section-title' }, [el('span', { class: 'section-glyph' }, [icon(glyph)]), el('h1', { text: title }), el('span', { class: 'count', text: String(items.length) })]),
      action ? el('button', { class: 'btn primary', onclick: () => {create();if (state.overviewPane) emit('rerender');} }, [icon('plus'), action]) : null,
    ]),
    items.length ? el('div', { class: 'section-list' }, items.map(item => el('button', { class: 'section-item', onclick: () => open(item) }, [
      pane === 'environments' ? el('span', { class: 'section-item-color', style: { background: item.color } }) : icon(glyph),
      el('div', { class: 'section-item-title' }, [el('span', { text: item.name || item.url || '未命名' }), el('span', { class: 'section-item-detail', text: detail(item) })]),
      pane === 'environments' && item.id === state.settings.activeEnvironmentId ? el('span', { class: 'tag', text: '当前' }) : null,
      pane === 'history' ? el('span', { class: 'section-item-time', text: prettyTime(item.at) }) : null,
      icon('chevR'),
    ]))) : el('div', { class: 'section-empty' }, [icon(glyph), el('span', { text: `暂无${title}` }), action ? el('button', { class: 'btn', text: action, onclick: create }) : null]),
  ]);
}
