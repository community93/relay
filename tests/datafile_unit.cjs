// 数据文件解析器的单元测试：直接从磁盘 import，不经过界面。
// 运行：node tests/datafile_unit.cjs（run_all.py 也会带它）。
const fs = require('node:fs');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const d = await import('data:text/javascript;base64,' + fs.readFileSync('web/js/datafile.js').toString('base64'));

  // RFC 4180：引号、转义引号、字段里的逗号与换行、CRLF/LF/CR、结尾换行
  const basic = d.parseCsvText('user,city\n tom , 上海 \r\n"li, sir","BJ"\r\n"multi\r\nline",x\n');
  check('splits rows on CRLF', basic.length === 4, basic);
  check('keeps spaces inside unquoted cells', basic[1][0] === ' tom ', JSON.stringify(basic[1]));
  check('quoted comma stays in one field', basic[2][0] === 'li, sir', JSON.stringify(basic[2]));
  check('quoted newline stays in one field', basic[3][0] === 'multi\r\nline', JSON.stringify(basic[3]));
  const escaped = d.parseCsvText('"he said ""hi""",ok');
  check('doubled quote unescapes', escaped[0][0] === 'he said "hi"', JSON.stringify(escaped[0]));
  const cr = d.parseCsvText('a,b\rc,d');
  check('bare CR is a row separator', cr.length === 2, cr);
  const trailing = d.parseCsvText('a,b\n1,2\n');
  check('trailing newline does not add an empty row', trailing.length === 2, trailing);

  // buildDataFile：表头归一化、空行剔除、短行补空、上限报错
  const parsed = d.buildDataFile('users.csv', Buffer.from('\uFEFFuser,city\n tom ,上海\n\n\nli,\n'));
  check('BOM stripped', parsed.header.join(',') === 'user,city', parsed.header);
  check('blank rows removed', parsed.rows.length === 2, parsed.rows);
  check('short row pads with empty string', parsed.rows[1].join('|') === 'li|', JSON.stringify(parsed.rows[1]));
  check('utf-8 encoding reported', parsed.encoding === 'utf-8');

  // 列名：空的给"列N"，重复的加序号
  const dup = d.buildDataFile('d.csv', Buffer.from('id,,id\n1,2,3\n'));
  check('empty header becomes 列N, duplicate gets _2', dup.header.join(',') === 'id,列2,id_2', dup.header);

  // Excel 导出的中文 CSV 是 GBK：UTF-8 解会出 U+FFFD，必须回退 GBK
  const gbk = d.buildDataFile('gbk.csv', Buffer.from('user,city\ntom,\xc9\xcf\xba\xa3\n', 'binary'));
  check('GBK bytes decode to 上海', gbk.rows[0][1] === '上海', gbk.rows[0]);
  check('GBK encoding reported', gbk.encoding === 'gbk');

  // 上限报错要说清现状与上限
  const big = 'a\n1\n' + '1\n'.repeat(2100);
  let tooBig = null; try { d.buildDataFile('big.csv', Buffer.from(big)); } catch (e) { tooBig = e.message; }
  check('row limit error names current and cap', /最多 2000 行/.test(tooBig) && /2101/.test(tooBig), tooBig);
  const wide = [...Array(60)].map((_, i) => `c${i}`).join(',') + '\n' + [...Array(60)].map((_, i) => i).join(',');
  let tooWide = null; try { d.buildDataFile('wide.csv', Buffer.from(wide)); } catch (e) { tooWide = e.message; }
  check('column limit error names current and cap', /最多 50 列/.test(tooWide) && /60 列/.test(tooWide), tooWide);
  let empty = null; try { d.buildDataFile('empty.csv', Buffer.from('\n\n')); } catch (e) { empty = e.message; }
  check('empty file error says what a header is', /列名/.test(empty), empty);

  // dataFileOf / dataMapOf：缺行、短行按空串
  const data = d.buildDataFile('m.csv', Buffer.from('user,city\ntom,上海\nli,\n'));
  check('dataFileOf accepts parsed shape', !!d.dataFileOf({ data }));
  check('dataFileOf rejects empty rows', !d.dataFileOf({ data: { ...data, rows: [] } }));
  const row0 = d.dataMapOf(data, 0), row1 = d.dataMapOf(data, 1);
  check('row map by header', row0.get('user') === 'tom' && row0.get('city') === '上海');
  check('missing cell maps to empty string', row1.get('city') === '');
  check('out-of-range row maps all empty', d.dataMapOf(data, 9).get('user') === '');

  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
