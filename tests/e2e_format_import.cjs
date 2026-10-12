const { chromium } = require('./playwright.cjs');
const fs = require('node:fs'), path = require('node:path');
const results = [], check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const browser = await chromium.connectOverCDP(process.env.RELAY_CDP_URL), page = browser.contexts()[0].pages()[0], errors = [];
  page.on('pageerror', e => errors.push(e.message)); fs.mkdirSync('reports/phase1-0.1.14', { recursive: true });
  try {
    await page.waitForSelector('.rail-btn');
    if (path.resolve(await page.evaluate(async () => (await import('./js/api.js')).dataPath())).toLowerCase() !== path.resolve('.design-qa/native-data').toLowerCase()) throw Error('Requires isolated QA data');
    await page.evaluate(async () => { window.s = await import('./js/state.js'); window.t = await import('./js/tools.js'); s.state.collections = []; s.state.tabs = []; s.newTab(); s.emit('rerender'); });
    await page.locator('.topbar-import').click();
    check('导入菜单提供cURL/OpenAPI/HAR且无外部集合工具', await page.locator('.menu').innerText().then(text => text.includes('cURL') && text.includes('OpenAPI') && text.includes('HAR') && !/postman/i.test(text)));
    await page.locator('.menu').getByText('OpenAPI 3 · JSON', { exact: true }).click();
    const spec = { openapi: '3.0.3', info: { title: 'Service A' }, servers: [{ url: 'https://api.example.test' }], paths: {
      '/users/{id}': { get: { summary: '读取用户', parameters: [{ name: 'id', in: 'path', required: true, example: 7 }, { name: 'Authorization', in: 'header', example: 'private-auth' }], responses: { 200: { content: { 'application/json': {} } } } } },
      '/events': { get: { summary: '流事件', responses: { 200: { content: { 'text/event-stream': {} } } } } },
    } };
    const modal = page.locator('.format-import-dialog');
    await modal.getByRole('textbox', { name: '导入 JSON', exact: true }).fill(JSON.stringify(spec));
    await modal.locator('.format-import-row').first().waitFor();
    check('OpenAPI预览两条且协议正确', await modal.locator('.format-import-row').count() === 2 && await modal.locator('.format-import-row').last().innerText().then(text => text.includes('SSE')));
    check('敏感头默认排除且说明原因', !(await modal.innerText()).includes('private-auth') && (await modal.innerText()).includes('已排除敏感'));
    await modal.getByRole('textbox', { name: '请求名称', exact: true }).first().fill('我修改的标题');
    await modal.getByRole('textbox', { name: '新集合名称', exact: true }).fill('交付接口');
    await page.screenshot({ path: 'reports/phase1-0.1.14/openapi-preview-light.png' });
    await modal.getByRole('button', { name: '导入', exact: true }).click(); await page.waitForTimeout(300);
    check('导入采用修改后的请求与集合标题', await page.evaluate(() => s.state.collections[0].name === '交付接口' && s.state.collections[0].children[0].name === '我修改的标题' && s.activeTab().draft.name === '我修改的标题'));
    check('导入不会自动发送', await page.evaluate(() => s.state.collections[0].children.length === 2 && !s.activeTab().response && !s.activeTab().running));
    check('SSE导入保存协议', await page.evaluate(() => s.state.collections[0].children[1].protocol === 'sse'));
    await page.evaluate(async () => { const persisted = await (await import('./js/api.js')).loadDoc('collections'); window.persistedImport = persisted; });
    check('导入内容已写入本地文件', await page.evaluate(() => JSON.stringify(persistedImport).includes('我修改的标题')));
    const har = { log: { entries: [{ request: { method: 'GET', url: 'wss://socket.example.test/ws', headers: [{ name: 'Cookie', value: 'private-cookie' }] } }, { request: { method: 'POST', url: 'https://api.example.test/chat', headers: [{ name: 'Content-Type', value: 'application/json' }], postData: { text: '{"stream":true}', mimeType: 'application/json' } } }] } };
    await page.evaluate(har => t.importFormatDialog('har', null, har), JSON.stringify(har));
    check('HAR预览识别WS及流式请求', await modal.locator('.format-import-row').first().innerText().then(text => text.includes('WS')) && await modal.locator('.format-import-row').last().innerText().then(text => text.includes('SSE')));
    await modal.locator('.format-import-row input[type=checkbox]').last().uncheck();
    await modal.getByRole('textbox', { name: '新集合名称', exact: true }).fill('HAR 工作区');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({ path: 'reports/phase1-0.1.14/har-preview-dark.png' });
    await modal.getByRole('button', { name: '导入', exact: true }).click(); await page.waitForTimeout(250);
    check('仅导入勾选请求并打开WS工作台', await page.evaluate(() => s.state.collections[1].children.length === 1 && s.activeTab().kind === 'ws' && s.activeTab().protocol === 'ws'));
    check('HAR敏感Cookie不进入定义', await page.evaluate(() => !s.state.collections[1].children[0].request.headers.some(h => /cookie/i.test(h.key))));
    await page.evaluate(() => t.importFormatDialog('openapi', null, '{}'));
    check('不支持格式在弹窗内显示错误', await modal.locator('.check-error').innerText().then(text => text.includes('OpenAPI')));
    await modal.getByRole('button', { name: '导入', exact: true }).click();
    check('无效导入不会产生空集合', await page.evaluate(() => s.state.collections.length === 2));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.evaluate(()=>t.importFormatDialog('har'));
    await modal.locator('input[type=file]').setInputFiles({name:'capture.har',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(har))});
    await modal.locator('.format-import-row').first().waitFor();
    check('可读取本地HAR文件并预览',await modal.locator('.format-import-row').count()===2);
    await page.keyboard.press('Escape');await page.waitForTimeout(200);
    check('取消文件导入不会创建集合',await page.evaluate(()=>s.state.collections.length===2));
    check('无前端异常', errors.length === 0, errors);
  } catch (error) { check('suite completed', false, error.stack); }
  finally { fs.writeFileSync('reports/phase1-0.1.14/import-native.json', JSON.stringify(results, null, 2)); console.log(`${results.filter(row => row.ok).length}/${results.length} passed`); await browser.close(); process.exitCode = results.every(row => row.ok) ? 0 : 1; }
})();
