// 运行计划的数据文件：一个 CSV 就是一次循环 —— 每行跑一遍计划，列名成为
// {{变量}}。文件在浏览器里读真实字节（WebView2 的文件选择器给的是 File 句柄，
// 不是只有文件名），解析也在这里完成，结果随计划一起持久化，定时运行因此不
// 依赖那个文件还在不在原位。

export const DATA_LIMITS = { rows: 2000, columns: 50, chars: 1000000 };

/// Excel 导出的中文 CSV 是 GBK；浏览器按 UTF-8 解会得到一串 U+FFFD。先按
/// UTF-8 解，看见替换符就换 GBK 再来一遍 —— 真正的 UTF-8 文件不会进这条分支。
export function decodeCsvBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let text = new TextDecoder('utf-8').decode(bytes);
  if (!text.includes('\uFFFD')) return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  try {
    text = new TextDecoder('gbk').decode(bytes);
    return { text: text.replace(/^\uFEFF/, ''), encoding: 'gbk' };
  } catch {
    return { text, encoding: 'utf-8' };
  }
}

/// RFC 4180：引号包裹的字段里可以带逗号、换行和转义的 `""`。行分隔兼容
/// CRLF / LF / CR。解析本身不设上限（文件大小已在调用处限制），上限检查交给
/// 结果一步，报错能说清"多在哪里"。
export function parseCsvText(raw) {
  const text = String(raw ?? '');
  const fields = [];
  let field = '';
  let row = [];
  let quoted = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); fields.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) pushRow();
  return fields;
}

function normalizeHeader(cells) {
  const header = [];
  const seen = new Map();
  for (let i = 0; i < cells.length; i += 1) {
    let name = String(cells[i] ?? '').trim();
    if (!name) name = `列${i + 1}`;
    if (seen.has(name)) {
      let n = 2;
      while (seen.has(`${name}_${n}`)) n += 1;
      name = `${name}_${n}`;
    }
    seen.set(name, true);
    header.push(name);
  }
  return header;
}

/// 读进来的整个文件 → 计划上要持久化的数据结构。超限在这里报错，报错带现状
/// 与上限（"最多 2000 行，当前 5413 行"），让用户知道该拆文件还是删列。
export function buildDataFile(fileName, buffer) {
  const { text, encoding } = decodeCsvBytes(buffer);
  if (text.length > DATA_LIMITS.chars) throw new Error(`文件太大：最多 ${DATA_LIMITS.chars / 10000} 万字符，这个文件有 ${text.length} 个字符，请拆分后再选`);
  const table = parseCsvText(text).filter((row) => row.some((cell) => String(cell).trim() !== ''));
  if (!table.length) throw new Error('这个 CSV 是空的：第一行是列名，从第二行开始每行跑一轮');
  const [headerRow, ...rows] = table;
  if (headerRow.length > DATA_LIMITS.columns) throw new Error(`列太多：最多 ${DATA_LIMITS.columns} 列，这个文件有 ${headerRow.length} 列`);
  if (rows.length > DATA_LIMITS.rows) throw new Error(`行太多：最多 ${DATA_LIMITS.rows} 行，这个文件有 ${rows.length} 行，请拆分后再选`);
  const header = normalizeHeader(headerRow);
  return {
    fileName: String(fileName || 'data.csv'),
    encoding,
    header,
    rows: rows.map((row) => header.map((_, i) => String(row[i] ?? ''))),
  };
}

export function dataFileOf(runner) {
  const data = runner && runner.data;
  return data && Array.isArray(data.header) && Array.isArray(data.rows) && data.rows.length ? data : null;
}

/// 每轮迭代的作用域覆盖层：列名 → 当前行的值。短行缺的格子按空串算。
export function dataMapOf(data, rowIndex) {
  const map = new Map();
  if (!data) return map;
  const row = data.rows[rowIndex] || [];
  data.header.forEach((name, i) => map.set(name, String(row[i] ?? '')));
  return map;
}
