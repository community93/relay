import { contractOf, endpointStatus, endpointMarkdown, requestSecrets, scrub } from './delivery.js';
import { renderMarkdown } from './md.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// The preview and standalone export share markup and styles. No request data is
// interpolated as markup; examples use the same redaction as Markdown export.
export function publicationMarkup(doc) {
  const requests=doc.blocks.filter(block=>block.type==='req');
  const ready=requests.filter(block=>endpointStatus(block).kind==='ready').length;
  const heading=block=>contractOf(block).summary || block.draft?.name || '接口草稿';
  const contents=requests.map((block,index)=>`<a href="#endpoint-${index+1}"><span>${String(index+1).padStart(2,'0')}</span><span>${esc(heading(block))}</span></a>`).join('');
  let index=0;
  const sections=doc.blocks.map(block=>{
    if(block.type!=='req')return `<section class="pub-note">${renderMarkdown(block.text || '')}</section>`;
    const number=++index,status=endpointStatus(block),method=block.draft?.method || 'cURL';
    const url=scrub(block.draft?.url || '未解析请求',requestSecrets(block.draft || {}));
    const stamp=block.verified?`<div class="pub-stamp">验证环境 <b>${esc(block.verified.environment)}</b><span>HTTP ${esc(block.verified.response.status)}</span><span>${esc(new Date(block.verified.at).toLocaleString('zh-CN',{hour12:false}))}</span></div>`:'';
    return `<article id="endpoint-${number}" class="pub-endpoint"><header class="pub-endpoint-head"><span class="pub-number">${String(number).padStart(2,'0')}</span><h2>${esc(heading(block))}</h2><span class="pub-state ${esc(status.kind)}">${esc(status.label)}</span></header><div class="pub-route"><span class="pub-method ${esc(method.toLowerCase())}">${esc(method)}</span><code>${esc(url)}</code></div>${stamp}<div class="pub-content">${renderMarkdown(endpointMarkdown(block,number-1,{bodyOnly:true}))}</div></article>`;
  }).join('');
  return `<div class="delivery-publication"><header class="pub-cover"><div class="pub-eyebrow"><span>API REFERENCE</span><span>RELAY</span></div><h1>${esc(doc.name || '接口交付文档')}</h1>${doc.overview?`<div class="pub-overview">${renderMarkdown(doc.overview)}</div>`:''}<div class="pub-metadata"><span class="pub-version">v${esc(doc.version || '1.0.0')}</span><span>${requests.length} 个接口</span><span>${ready} 可交付</span></div></header><div class="pub-layout">${requests.length?`<nav class="pub-toc" aria-label="交付目录"><div class="pub-toc-title">CONTENTS <span>接口目录</span></div>${contents}</nav>`:''}<main class="pub-main">${sections || '<div class="pub-empty">暂无接口内容</div>'}</main></div><footer class="pub-footer"><span>Relay · API Reference</span><span>${requests.length} endpoints · v${esc(doc.version || '1.0.0')}</span></footer></div>`;
}

export const PUBLICATION_CSS = `
.delivery-publication{--pub-paper:var(--bg-panel,#fff);--pub-ink:var(--text,#23332f);--pub-muted:var(--text-dim,#63736e);--pub-line:var(--line,#e2e9e6);--pub-soft:var(--bg-inset,#f5f8f7);--pub-teal:var(--current-ink,#08776b);background:var(--pub-paper);color:var(--pub-ink);font:14px/1.8 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;border:1px solid var(--pub-line);border-radius:12px;overflow:clip;max-width:1200px;margin:auto;box-sizing:border-box}
.delivery-publication *{box-sizing:border-box}.delivery-publication a{color:var(--pub-teal)}
.pub-cover{padding:38px 44px 30px;border-top:4px solid var(--pub-teal);border-bottom:1px solid var(--pub-line)}
.pub-eyebrow{display:flex;justify-content:space-between;font:12px/1.5 ui-monospace,Consolas,monospace;letter-spacing:2px;color:var(--pub-teal);margin-bottom:22px}
.pub-cover h1{font-size:32px;line-height:1.3;font-weight:650;letter-spacing:-1px;margin:0 0 14px;overflow-wrap:anywhere}
.pub-overview{max-width:780px;color:var(--pub-muted)}.pub-overview p{margin:8px 0}
.pub-metadata{display:flex;gap:22px;align-items:center;font-size:12px;color:var(--pub-muted);margin-top:22px;flex-wrap:wrap}
.pub-version{border:1px solid var(--pub-line);border-radius:4px;font:12px/1.6 ui-monospace,monospace;padding:2px 8px;color:var(--pub-teal)}
.pub-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:34px;padding:34px 44px 44px;align-items:start}
.pub-toc{position:sticky;top:18px;max-height:65vh;overflow:auto;min-width:0}.pub-toc-title{font:12px/1.8 ui-monospace,monospace;letter-spacing:1px;color:var(--pub-muted);padding:0 0 14px;border-bottom:1px solid var(--pub-line);margin-bottom:10px}.pub-toc-title span{float:right;letter-spacing:0;font:12px/1.8 system-ui}
.pub-toc a{display:flex;gap:10px;padding:9px 4px;text-decoration:none;font-size:12px;border-radius:4px;color:var(--pub-muted)}.pub-toc a:hover,.pub-toc a:focus-visible{background:var(--pub-soft);color:var(--pub-teal)}.pub-toc a span:first-child{font:12px/2 ui-monospace,monospace;color:var(--pub-teal)}.pub-toc a span:last-child{min-width:0;overflow-wrap:anywhere}
.pub-main{min-width:0}.pub-endpoint{padding-bottom:38px;scroll-margin-top:24px}.pub-endpoint+.pub-endpoint,.pub-note+.pub-endpoint{border-top:1px solid var(--pub-line);padding-top:34px}
.pub-endpoint-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.pub-endpoint-head h2{font-size:21px;letter-spacing:-.5px;line-height:1.5;margin:0;flex:1;min-width:120px;overflow-wrap:anywhere}.pub-number{font:12px/1.8 ui-monospace,monospace;color:var(--pub-teal)}
.pub-state{font-size:12px;color:var(--pub-muted);white-space:nowrap}.pub-state.ready,.pub-state.verified{color:var(--pub-teal)}.pub-state.failed{color:var(--err-ink,#b83b4b)}.pub-state.stale{color:var(--warn-ink,#986516)}
.pub-route{display:flex;align-items:flex-start;gap:12px;margin:18px 0 12px;padding:12px 14px;border:1px solid var(--pub-line);border-radius:6px;background:var(--pub-soft)}.pub-method{font:600 12px/2 ui-monospace,monospace;flex:none;color:var(--pub-teal)}.pub-method.post{color:var(--m-post,#87581d)}.pub-method.delete{color:var(--m-delete,#a4363b)}.pub-method.put,.pub-method.patch{color:var(--m-put,#326995)}.pub-route code{background:none;padding:0;min-width:0;overflow-wrap:anywhere;font-size:12px}
.pub-stamp{display:flex;gap:12px;flex-wrap:wrap;color:var(--pub-muted);font-size:12px;margin-bottom:20px}.pub-stamp b{font-weight:500;color:var(--pub-teal);margin-left:5px}
.pub-content p{margin:12px 0;overflow-wrap:anywhere}.pub-content h3,.pub-note h3{font-size:13px;font-weight:600;margin:28px 0 10px}.pub-content h4{font-size:12px;margin:20px 0 8px}
.delivery-publication table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px;margin:12px 0 22px}.delivery-publication td,.delivery-publication th{padding:10px 9px;text-align:left;border:0;border-bottom:1px solid var(--pub-line);vertical-align:top;overflow-wrap:anywhere}.delivery-publication th{font-weight:500;background:var(--pub-soft);color:var(--pub-muted)}.delivery-publication th:first-child{width:23%}.delivery-publication th:nth-child(2){width:13%}.delivery-publication th:nth-child(3){width:10%}.delivery-publication th:last-child{width:30%}
.delivery-publication pre{position:relative;background:#132f32;color:#d8ebe6;border:1px solid #27474a;border-radius:7px;padding:18px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.9 ui-monospace,Consolas,monospace;margin:12px 0 22px;box-shadow:none}.delivery-publication code{font-family:ui-monospace,Consolas,monospace}.delivery-publication p code,.delivery-publication li code{padding:2px 5px;border-radius:3px;background:var(--pub-soft);font-size:12px}.delivery-publication pre code{background:none;font:inherit;color:inherit;padding:0;border:0}
.pub-note{margin-bottom:30px;overflow-wrap:anywhere}.pub-note h2{font-size:20px}.pub-note blockquote{border-left:2px solid var(--pub-teal);margin:16px 0;padding-left:16px;color:var(--pub-muted)}.delivery-publication img{max-width:100%;height:auto}
.pub-footer{display:flex;justify-content:space-between;gap:12px;padding:18px 44px;border-top:1px solid var(--pub-line);font:12px/1.6 ui-monospace,monospace;color:var(--pub-muted)}.pub-empty{padding:30px 0;color:var(--pub-muted)}
@media(max-width:1050px){.pub-layout{grid-template-columns:145px minmax(0,1fr);gap:22px;padding:26px}.pub-cover{padding:30px 26px}.pub-footer{padding-inline:26px}}
@media(max-width:850px){.pub-layout{grid-template-columns:minmax(0,1fr)}.pub-toc{position:static;max-height:180px;padding-bottom:12px;border-bottom:1px solid var(--pub-line)}.pub-cover h1{font-size:26px}.pub-endpoint-head h2{font-size:19px}}
@media print{.delivery-publication{border:none;--pub-paper:#fff;--pub-ink:#23332f;--pub-muted:#63736e;--pub-line:#e2e9e6;--pub-soft:#f5f8f7;--pub-teal:#08776b}.pub-layout{display:block;padding:24px 0}.pub-toc{display:none}.pub-cover{padding:24px 0}.pub-footer{padding-inline:0}.delivery-publication pre{background:#f5f8f7;color:#23332f;border-color:#e2e9e6}.pub-endpoint{break-inside:auto}h2,h3,.pub-route{break-after:avoid}}
`;
