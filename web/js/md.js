/// A deliberately small Markdown renderer for the doc tab: headings, lists,
/// tables, quotes, fenced code and the usual inline marks. Everything is
/// escaped before any tag is added, and link hrefs are filtered, so pasted
/// content can never inject markup.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
}

function safeHref(href) {
  const value = String(href || '').trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(value)) return value;
  return '#';
}

function inline(text) {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?: "[^"]*")?\)/g, (_, alt, src) => `<img alt="${alt}" src="${safeHref(src)}">`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?: "[^"]*")?\)/g, (_, label, href) => `<a href="${safeHref(href)}" target="_blank" rel="noreferrer">${label}</a>`);
  out = out.replace(/(^|[^"'>=])\b(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${safeHref(url)}" target="_blank" rel="noreferrer">${url}</a>`);
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

function splitRow(line) {
  const text=line.trim().replace(/^\|/,'').replace(/(?<!\\)\|$/,'');
  const cells=[];let cell='',codeFence='';
  for(let i=0;i<text.length;i++) {
    if(text[i]==='\\'&&text[i+1]==='|'){cell+='|';i++;continue;}
    if(text[i]==='`') {
      let end=i;while(text[end]==='`')end++;
      const marker=text.slice(i,end);codeFence=codeFence===marker?'':codeFence || marker;cell+=marker;i=end-1;continue;
    }
    if(text[i]==='|'&&!codeFence){cells.push(cell.trim());cell='';}else cell+=text[i];
  }
  cells.push(cell.trim());return cells;
}

function list(items, ordered, indent) {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag} class="md-list md-indent-${Math.min(indent, 2)}">` + items.map((item) => `<li>${item}</li>`).join('') + `</${tag}>`;
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let listItems = [];
  let listOrdered = false;
  let listIndent = 0;
  let fence = null;
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    html.push(list(listItems, listOrdered, listIndent));
    listItems = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map((line) => `<p>${inline(line)}</p>`).join('')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      if (new RegExp(`^${fence.marker[0]}{${fence.marker.length},}\\s*$`).test(line.trim())) {
        html.push(`<pre class="md-pre"><code class="language-${esc(fence.lang)}">${esc(fence.body.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }

    const fenceOpen = line.match(/^\s*(`{3,}|~{3,})([a-zA-Z0-9_-]*)\s*$/);
    if (fenceOpen) {
      flushAll();
      fence = { marker: fenceOpen[1], lang: fenceOpen[2] || '', body: [] };
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushAll();
      html.push('<hr>');
      continue;
    }

    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    if (/^\|.*\|\s*$/.test(line.trim()) && index + 1 < lines.length && /^[\s|:-]+$/.test(lines[index + 1]) && lines[index + 1].includes('|')) {
      flushAll();
      const head = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /\|/.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push(
        `<table class="md-table"><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      const ordered = /\d/.test(bullet[2]);
      const indent = Math.floor(bullet[1].length / 2);
      if (listItems.length && (ordered !== listOrdered || indent !== listIndent)) flushList();
      listOrdered = ordered;
      listIndent = indent;
      listItems.push(inline(bullet[3]));
      continue;
    }

    paragraph.push(line.trim());
  }

  if (fence) html.push(`<pre class="md-pre"><code>${esc(fence.body.join('\n'))}</code></pre>`);
  flushAll();
  return html.join('\n');
}

/// Fenced ```curl / ```bash blocks and bare `curl …` lines are the two shapes a
/// pasted command arrives in.
export function extractCurl(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  const fenced = text.match(/```(?:curl|bash|sh|shell)?\s*\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  return /^curl(\s|$)/i.test(body) ? body : '';
}

/// The editor keeps a transparent textarea over this output, so the caret stays
/// on the raw Markdown while you still see it light up as you type. Line counts
/// must match the source exactly and every line keeps the same height, or the
/// caret drifts — so headings get weight and colour here, never a bigger size.
function highlightInline(text) {
  let out = esc(text);
  out = out.replace(/(`[^`]+`)/g, '<span class="hl-code">$1</span>');
  out = out.replace(/(\*\*[^*]+\*\*)/g, '<span class="hl-strong">$1</span>');
  out = out.replace(/(\[[^\]]+\]\([^)]*\))/g, '<span class="hl-link">$1</span>');
  return out;
}

export function highlightMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return `<div class="hl hl-fence">${esc(line) || '&nbsp;'}</div>`;
    }
    if (inFence) return `<div class="hl hl-codeblock">${highlightInline(line) || '&nbsp;'}</div>`;
    const marker = line.match(/^(\s*)(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/);
    const prefix = marker ? marker[1] + marker[2] : '';
    const rest = marker ? line.slice(prefix.length) : line;
    let cls = 'hl';
    if (prefix.startsWith('#')) cls = 'hl hl-h';
    else if (prefix.startsWith('>')) cls = 'hl hl-quote';
    else if (prefix.trim()) cls = 'hl hl-list';
    const body = `${prefix ? `<span class="hl-mark">${esc(prefix)}</span>` : ''}${highlightInline(rest)}`;
    if (/^\s*\|.*\|\s*$/.test(line)) cls = 'hl hl-table';
    return `<div class="${cls}">${body || '&nbsp;'}</div>`;
  });
  return out.join('');
}
