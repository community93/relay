// 运行计划：把已经排好顺序的几个集合，按顺序依次打完，并且可以定时重复。
//
// 三件事是同一条链：左侧树里拖出来的顺序决定集合内部谁先跑，计划决定跑哪几个集合，
// 定时只是替你把「立即运行」按一次。所以这里刻意没有第二套数据 —— 步骤表每次都从
// 当前的树现算，改了树就是下一次运行的顺序，不会出现"计划里还留着老排序"。

import { el, icon, toast, duration, bytes, confirmDialog, segmented, toggle, prompt, row as fieldRow, filePicker } from './ui.js';
import { selectField, menu } from './menu.js';
import * as api from './api.js';
import { sortableRow } from './sorting.js';
import { reorderHandle } from './reorder.js';
import { changeList } from './undo.js';
import { captureRunRequest, captureRunResponse, captureRunChecks, boundRunDetails, openRunEntry } from './run-details.js';
import { requestUrl } from './preview.js';
import { evaluateChecks } from './checks.js';
import { dataFileOf, dataMapOf, buildDataFile } from './datafile.js';
import { buildWsRequest } from './ws.js';
import { activeEnv } from './state.js';
import {
  state,
  touch,
  uid,
  emit,
  newRunner,
  openRunner,
  openRequest,
  findNode,
  collectionOf,
  buildSendDraft,
  pushHistory,
} from './state.js';

// Keep execution snapshots with bounded payload retention; summaries stay intact.
const MAX_RUNS = 30;
const TICK_MS = 20000;
const DAY_MS = 86400000;

/* ---------------------------- steps ---------------------------- */

function collect(container, collectionName, out) {
  for (const child of container.children || []) {
    if (child.kind === 'folder') {
      collect(child, collectionName, out);
      continue;
    }
    const step = { node: child, collectionName };
    if (!String((child.request || {}).url || '').trim()) step.skip = '没有填 URL';
    out.push(step);
  }
}

const KIND_LABEL = { collection: '集合', folder: '文件夹', request: '请求', ws: '连接' };

export function collectionSteps(collection) {
  const out = [];
  collect(collection, collection.name, out);
  return out;
}

export function sourcesOf(runner) {
  return runner.sources || [];
}

/// 一个步骤源可以是整个集合、一个文件夹，也可以就是单个请求 —— 允许混着排，
/// 也允许同一个东西出现两次（那就是跑两遍）。
export function stepsForSource(id) {
  const hit = findNode(id);
  if (!hit) return [];
  const label = (collectionOf(id) || hit.node).name;
  const node = hit.node;
  if (node.kind === 'collection' || node.kind === 'folder') return collectionSteps(node).map((step) => ({ ...step, collectionName: label }));
  const step = { node, collectionName: label };
  if (!String((node.request || {}).url || '').trim()) step.skip = '没有填 URL';
  return [step];
}

export function stepsOf(runner) {
  const out = [];
  for (const id of sourcesOf(runner)) out.push(...stepsForSource(id));
  return out;
}

/// 源被删掉时不能假装无事发生：计划里会留一个指不到东西的 id，必须摆在脸上，
/// 否则运行数对不上却没人知道为什么。
export function danglingOf(runner) {
  return sourcesOf(runner).filter((id) => !findNode(id));
}

export function planSummary(runner) {
  const steps = stepsOf(runner);
  return {
    sources: sourcesOf(runner).length,
    total: steps.length,
    runnable: steps.filter((step) => !step.skip).length,
    skipped: steps.filter((step) => step.skip).length,
  };
}

/* ---------------------------- running ---------------------------- */

const sessions = new Map();

export function sessionOf(runnerId) {
  return sessions.get(runnerId) || null;
}

function repaint() {
  // 只有真的看得见才值得重画：后台跑的时候别把一个正在编辑的请求面板刷掉。
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  if (tab && tab.kind === 'runner') emit('rerender');
  if (state.pane === 'runner') emit('pane');
}

function wait(ms, session) {
  return new Promise((resolve) => {
    const started = Date.now();
    const step = () => {
      if (session.cancelled || Date.now() - started >= ms) return resolve();
      setTimeout(step, Math.min(150, ms));
    };
    step();
  });
}

/* ---- 长连接步骤 ----
 * SSE 建连后驻留一小段收集事件再主动断开；WS 只验证握手。两者都把结果折算成
 * HTTP 形状（status/bodyText/error），这样检查、提取、详情展示全部复用同一套。 */

const SSE_SOAK_MS = 3000;
const WS_HANDSHAKE_TIMEOUT_MS = 15000;

async function runSseStep({ step, entry, session, built, execId }) {
  const firstByteMs = state.settings.sseFirstByteMs || 15000;
  const response = { status: 0, headers: [], bodyText: '', isText: true, sizeBytes: 0, error: null, errorKind: null, timeMs: 0, eventCount: 0 };
  let open = false;
  let streamError = null;
  let done = false;
  const started = Date.now();
  api.streamSse({
    draft: built.draft,
    execId,
    firstByteTimeoutMs: firstByteMs,
    streamFormat: step.node.streamFormat || 'auto',
    onEvent: (event) => {
      if (done) return;
      if (event.kind === 'open') {
        open = true;
        response.status = event.status || 0;
        response.headers = event.headers || [];
      } else if (event.kind === 'message') {
        response.eventCount += 1;
        response.sizeBytes = event.bytes || response.sizeBytes;
        response.bodyText = `${response.bodyText}${event.data || ''}\n`;
        if (response.bodyText.length > 65536) response.bodyText = response.bodyText.slice(0, 65536);
      } else if (event.kind === 'error') {
        streamError = event.message || 'SSE 连接失败';
      }
    },
  }).catch((error) => { if (!done) streamError = String((error && error.message) || error); });

  // 等建连（首帧超时由 Rust 侧主动报错），建连后再驻留一会儿收集事件——
  // 太短可能一条事件都没等到，太长会把整份计划拖住。
  while (!open && !streamError && !session.cancelled && Date.now() - started < firstByteMs) await wait(80, session);
  const soakEnd = Date.now() + SSE_SOAK_MS;
  while (open && !streamError && !session.cancelled && Date.now() < soakEnd) await wait(80, session);
  done = true;
  await api.cancel(execId).catch(() => {});
  response.timeMs = Date.now() - started;
  if (session.cancelled) {
    response.error = '请求已取消';
    response.errorKind = 'cancelled';
  } else if (streamError) {
    response.error = streamError;
    response.errorKind = 'server';
  }
  return response;
}

async function runWsStep({ step, entry, session, built, req }) {
  const connId = uid('wsrun');
  const events = [];
  const response = { status: 0, headers: [], bodyText: '', isText: true, sizeBytes: 0, error: null, errorKind: null, timeMs: 0 };
  let settled = false;
  const started = Date.now();
  try {
    await api.wsConnect({ req: { ...req, connId }, onEvent: (event) => { if (!settled) events.push(event); } });
  } catch (error) {
    response.error = String((error && error.message) || error);
    response.errorKind = 'client';
    response.timeMs = Date.now() - started;
    return response;
  }
  const deadline = Date.now() + Math.min(req.timeoutMs || WS_HANDSHAKE_TIMEOUT_MS, 60000);
  while (!events.some((event) => event.kind === 'open' || event.kind === 'error' || event.kind === 'closed')) {
    if (session.cancelled || Date.now() > deadline) break;
    await wait(80, session);
  }
  settled = true;
  const open = events.find((event) => event.kind === 'open');
  if (open) {
    response.status = 101;
    response.headers = open.headers || [];
    await api.wsClose(connId).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    await api.wsDisconnect(connId).catch(() => {});
  } else {
    await api.wsDisconnect(connId).catch(() => {});
    const bad = events.find((event) => event.kind === 'error' || event.kind === 'closed');
    if (session.cancelled) {
      response.error = '请求已取消';
      response.errorKind = 'cancelled';
    } else if (bad) {
      response.error = bad.message || (bad.kind === 'closed' ? `连接被对端关闭${bad.code ? `（代码 ${bad.code}）` : ''}` : '连接失败');
      response.errorKind = 'server';
    } else {
      response.error = '握手超时';
      response.errorKind = 'timeout';
    }
  }
  response.timeMs = Date.now() - started;
  return response;
}

export async function runRunner(runner, { trigger = 'manual', allowedHosts = [] } = {}) {
  if (sessions.has(runner.id)) {
    toast('这个计划正在运行中', 'err', 2600);
    return null;
  }
  const steps = stepsOf(runner);
  if (!steps.some((step) => !step.skip)) {
    toast('这个计划里没有可执行的请求', 'err', 3200);
    return null;
  }
  // 数据文件循环：CSV 每行跑一遍整个计划，按文件顺序从上到下。行列出的变量在
  // 这一轮里优先于环境（见 varScope），提取器当轮拿到的值又优先于它。
  const data = dataFileOf(runner);
  const iterations = data ? data.rows.length : 1;
  const run = {
    id: uid('rec'),
    runnerId: runner.id,
    runnerName: runner.name,
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    entries: [],
    totals: { ran: 0, passed: 0, failed: 0, skipped: 0 },
  };
  if (data) { run.dataFile = data.fileName; run.iterations = iterations; }
  const session = { runId: run.id, run, index: 0, total: steps.length * iterations, cancelled: false, execId: null, current: null, iterations };
  const context = { environment: activeEnv() ? structuredClone(activeEnv()) : null, runtime: new Map(), dataRow: data ? dataMapOf(data, 0) : null };
  run.environmentId = context.environment?.id;
  run.environmentName = context.environment?.name || '无环境';
  sessions.set(runner.id, session);
  repaint();

  iterationLoop: for (let iter = 0; iter < iterations; iter += 1) {
    if (data) context.dataRow = dataMapOf(data, iter);
    for (let i = 0; i < steps.length; i += 1) {
      if (session.cancelled) {
        run.cancelled = true;
        break iterationLoop;
      }
      const step = steps[i];
      const draft0 = step.node.request || {};
      const isWs = step.node.kind === 'ws';
      const isSse = step.node.protocol === 'sse';
      const entry = {
        at: Date.now(),
        collectionName: step.collectionName,
        name: step.node.name || draft0.name || '未命名请求',
        nodeId: step.node.id,
        method: isWs ? 'WS' : draft0.method || 'GET',
        url: draft0.url || '',
        status: 0,
        ok: false,
        timeMs: 0,
        sizeBytes: 0,
      };
      if (data) entry.iteration = iter + 1;
      run.entries.push(entry);
      session.index = iter * steps.length + i;
      session.current = entry;

    if (step.skip) {
      entry.skipped = true;
      entry.reason = step.skip;
      run.totals.skipped += 1;
      session.current = null;
      repaint();
      continue;
    }

    // 与手点「发送」完全同源：同一个 buildSendDraft，refId 指向树里的节点，所以
    // 集合变量、继承鉴权、环境前缀在计划里与在编辑器里算出同一个结果。
    const submitted = {
      draft: JSON.parse(JSON.stringify(draft0)),
      refId: step.node.id,
      auth: JSON.parse(JSON.stringify(step.node.auth || { kind: 'inherit' })),
    };
    const wsBuild = isWs ? buildWsRequest({ ...submitted, protocol: 'ws' }, context) : null;
    const built = isWs ? wsBuild.preview : buildSendDraft(submitted, context);
    const rules = built.preparedChecks;
    entry.details = captureRunRequest(submitted, built);
    boundRunDetails(run, state.runs);
    if (!built.draft.url || built.missing.length) {
      entry.error = built.missing.length?`缺少变量：${built.missing.join('、')}`:'变量解析后 URL 是空的';
      entry.missingVars=built.missing;
      entry.errorKind='validation';
      entry.outcome='validation-error';
      // Even a step blocked before sending must invalidate its promised outputs.
      const blockedResult = evaluateChecks(rules, { status: 0, error: entry.error }, context.runtime);
      if (entry.details) captureRunChecks(entry.details, blockedResult);
      run.totals.failed += 1;
      run.totals.ran += 1;
      session.current = null;
      repaint();
      if(runner.stopOnError){run.stoppedAfter=run.totals.ran;break iterationLoop;}
      continue;
    }
    // 记录解析后的地址：一次运行该说清它真正打了哪里，`{{baseUrl}}` 那种写法在
    // 请求定义里看得到，在结果里看不到就等于没说。
    entry.url = requestUrl(built.draft);

    session.execId = uid('run');
    entry.pending = true;
    repaint();
    const started = Date.now();
    try {
      const response = isWs
        ? await runWsStep({ step, entry, session, built, req: wsBuild.req })
        : isSse
          ? await runSseStep({ step, entry, session, built, execId: session.execId })
          : await api.execute(built.draft, session.execId, allowedHosts);
      if (entry.details) captureRunResponse(entry.details, response);
      entry.status = response.status || 0;
      entry.timeMs = response.timeMs || Date.now() - started;
      entry.sizeBytes = response.sizeBytes || 0;
      entry.error = response.error || null;
      entry.errorKind = response.errorKind || null;
      if (isWs && entry.status === 101) entry.note = '握手成功';
      if (isSse && !entry.error) entry.note = `收到 ${response.eventCount || 0} 条事件`;
      const result = evaluateChecks(rules, response, context.runtime);
      entry.ok = result.ok;
      entry.outcome = result.outcome;
      entry.checkSummary = { passed: result.passed, total: result.checks.length, extracted: result.extractions.filter(row => row.ok).length, extractionTotal: result.extractions.length };
      if (entry.details) captureRunChecks(entry.details, result);
    } catch (error) {
      entry.error = String((error && error.message) || error);
      entry.errorKind = 'client';
      entry.outcome = session.cancelled ? 'cancelled' : 'network-error';
      const result = evaluateChecks(rules, { status: 0, error: entry.error, errorKind: session.cancelled ? 'cancelled' : 'client' }, context.runtime);
      if (entry.details) captureRunChecks(entry.details, result);
      entry.timeMs = Date.now() - started;
      if (entry.details) captureRunResponse(entry.details, { error: entry.error, errorKind: entry.errorKind, status: 0, bodyText: '', headers: [], isText: true });
    } finally {
      entry.pending = false;
      session.execId = null;
      session.current = null;
    }
    if (built.missing.length) entry.missingVars = built.missing;
    boundRunDetails(run, state.runs);
    emit('run-entry', entry);
    run.totals.ran += 1;
    if (entry.outcome === 'cancelled') { run.cancelled = true; run.totals.cancelled = (run.totals.cancelled || 0) + 1; }
    else if (entry.ok) run.totals.passed += 1;
    else run.totals.failed += 1;

    pushHistory({
      kind: isWs ? 'ws' : 'http',
      name: `${runner.name}${data ? ` · 第${iter + 1}行` : ''} · ${entry.name}`.slice(0, 90),
      method: entry.method,
      url: built.draft.url,
      status: entry.status,
      timeMs: entry.timeMs,
      sizeBytes: entry.sizeBytes,
      errorKind: entry.errorKind,
      snapshot: JSON.parse(JSON.stringify(draft0)),
      auth: JSON.parse(JSON.stringify(step.node.auth || { kind: 'inherit' })),
      protocol: isWs ? 'ws' : isSse ? 'sse' : 'http',
    });
    repaint();

    if (!entry.ok && runner.stopOnError) {
      run.stoppedAfter = run.totals.ran;
      break iterationLoop;
    }
    if (runner.delayMs > 0 && (i < steps.length - 1 || iter < iterations - 1)) await wait(runner.delayMs, session);
    }
  }

  run.finishedAt = Date.now();
  sessions.delete(runner.id);
  state.runs.unshift(run);
  if (state.runs.length > MAX_RUNS) state.runs.length = MAX_RUNS;
  openRunId = run.id;
  touch('runs');
  repaint();

  const head = run.cancelled ? '已中断' : run.stoppedAfter ? '遇错停下' : run.totals.failed ? `${run.totals.failed} 个失败` : '全部通过';
  toast(
    `${runner.name}：${data ? `${iterations} 轮数据跑` : '跑'}了 ${run.totals.ran} 个，${head}` + (run.totals.skipped ? `，跳过 ${run.totals.skipped} 个` : ''),
    run.totals.failed || run.cancelled ? 'err' : 'ok',
    5200
  );
  return run;
}

export function stopRunner(runnerId) {
  const session = sessions.get(runnerId);
  if (!session) return false;
  session.cancelled = true;
  if (session.execId) api.cancel(session.execId).catch(() => {});
  repaint();
  return true;
}

/// 树菜单里的「运行这一项」不造临时概念：找到（或建一个）只含这一项的计划，打开它、
/// 跑它。集合、文件夹、单个请求都走这条路 —— 想跑一条请求不必把整个集合拖进来。
export function runNodeFromTree(node) {
  const title = node.kind === 'collection' ? `集合：${node.name}` : `运行：${node.name}`;
  let runner = state.runners.find((item) => sourcesOf(item).length === 1 && sourcesOf(item)[0] === node.id);
  if (!runner) {
    runner = newRunner(title);
    runner.sources = [node.id];
    state.runners.push(runner);
    touch('runners');
  }
  state.pane = 'runner';
  emit('pane');
  openRunner(runner);
  runRunner(runner);
  return runner;
}

/// 「加入运行计划」：只有一个计划时直接加进去，多于一个才让你挑。加完把你带到
/// 那个计划跟前 —— 只 toast 一句"已加入"，看不见就等于没加。
export function joinPlanMenu(anchor, node) {
  const items = state.runners.map((runner) => ({
    label: runner.name,
    hint: `${sourcesOf(runner).length} 个步骤`,
    onSelect: () => {
      addSource(runner, node.id);
      state.pane = 'runner';
      emit('pane');
      openRunner(runner);
      toast(`已把「${node.name}」加进「${runner.name}」`, 'ok', 3000);
    },
  }));
  menu(
    anchor,
    items.concat(items.length ? [{ separator: true }] : []).concat([
      { label: '新建运行计划', icon: 'plus', hint: '只放这一项', onSelect: () => {
        const runner = newRunner(node.kind === 'collection' ? `集合：${node.name}` : `运行：${node.name}`);
        runner.sources = [node.id];
        state.runners.push(runner);
        touch('runners');
        state.pane = 'runner';
        emit('pane');
        openRunner(runner);
      } },
    ])
  );
}

/* ---------------------------- schedule ---------------------------- */

function clockOf(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Math.min(23, Number(match[1])), minute: Math.min(59, Number(match[2])) };
}

function periodMs(spec) {
  const minutes = Math.min(1440, Math.max(1, Number(spec.everyMinutes) || 30));
  return minutes * 60000;
}

/// 纯函数，且刻意按"墙钟 + 锚点"算下一个时点，而不是在上一次触发后挂一条
/// setTimeout 链：窗口被遮挡时 WebView2 会节流定时器，链式写法会把之后的每一次都
/// 往后推；按锚点重算最多只迟一个 tick，不会漂移，也不会漏跑。
export function nextFire(spec, afterMs = Date.now()) {
  if (spec.kind === 'daily') {
    const { hour, minute } = clockOf(spec.at);
    const stamp = new Date(afterMs);
    stamp.setHours(hour, minute, 0, 0);
    if (stamp.getTime() <= afterMs) stamp.setTime(stamp.getTime() + DAY_MS);
    return stamp.getTime();
  }
  const period = periodMs(spec);
  const anchor = Number(spec.anchorAt) || Number(spec.lastFiredAt) || 0;
  if (!anchor) return afterMs + period;
  const steps = Math.max(1, Math.floor((afterMs - anchor) / period) + 1);
  return anchor + steps * period;
}

function graceMs(spec) {
  // 机器睡了整个周末，睁眼瞬间不该补跑一百次。
  return spec.kind === 'daily' ? 3600000 : Math.min(periodMs(spec), 300000);
}

export function dueAt(spec, now = Date.now()) {
  return nextFire(spec, Math.max(Number(spec.lastFiredAt) || 0, Number(spec.anchorAt) || now));
}

function stamp(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/// 「今天 14:30 · 12 分钟后」这种写法，比一个裸的时间戳更容易判断到底赶不赶。
export function nextLabel(spec, now = Date.now()) {
  const ms = dueAt(spec, now);
  const lead = ms - now;
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const tomorrow = new Date(ms).toDateString() === new Date(now + DAY_MS).toDateString();
  const day = sameDay ? '今天' : tomorrow ? '明天' : `${new Date(ms).getMonth() + 1} 月 ${new Date(ms).getDate()} 日`;
  const away =
    lead < 60000 ? '不到 1 分钟' : lead < 3600000 ? `${Math.round(lead / 60000)} 分钟` : lead < DAY_MS ? `${Math.round(lead / 3600000)} 小时` : `${Math.round(lead / DAY_MS)} 天`;
  return `${day} ${stamp(ms)} · ${away}后`;
}

let heartbeat = null;

export async function catchUp() {
  const now = Date.now();
  for (const runner of state.runners) {
    const spec = runner.schedule;
    if (!spec || !spec.enabled || sessions.has(runner.id)) continue;
    const due = nextFire(spec, Math.max(Number(spec.lastFiredAt) || 0, Number(spec.anchorAt) || 0));
    if (due > now) continue;
    if (now - due > graceMs(spec)) {
      spec.lastFiredAt = due;
      touch('runners');
      repaint();
      continue;
    }
    spec.lastFiredAt = now;
    touch('runners');
    toast(`定时触发：${runner.name}`, 'ok', 2600);
    runRunner(runner, { trigger: 'timer' });
  }
  updateTrayHint(now);
}

/* 应用收进托盘后这块界面看不见了，托盘菜单里的"下次触发"就是仅剩的可见状态，
 * 所以每个心跳都刷一遍；invoke 失败（比如纯浏览器预览）就安静放过。 */
function updateTrayHint(now = Date.now()) {
  const enabled = state.runners
    .filter((runner) => runner.schedule?.enabled)
    .map((runner) => ({ name: runner.name, due: dueAt(runner.schedule, now) }))
    .filter((item) => Number.isFinite(item.due))
    .sort((a, b) => a.due - b.due);
  const text = enabled.length ? `下次 ${stamp(enabled[0].due)} · ${enabled[0].name}` : '无';
  window.__TAURI__?.core?.invoke?.('tray_set_next', { text }).catch?.(() => {});
}

export function startScheduler() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    catchUp().catch(() => {});
  }, TICK_MS);
  // 从后台切回来先补一次检查，不然最长要等满一个 tick 才发现已经过点。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) catchUp().catch(() => {});
  });
  catchUp().catch(() => {});
}

/* ---------------------------- sidebar ---------------------------- */

function isActiveRunner(runnerId) {
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  return !!(tab && tab.kind === 'runner' && tab.refId === runnerId);
}

function runnerRow(runner) {
  const session = sessionOf(runner.id);
  const summary = planSummary(runner);
  const dangling = danglingOf(runner).length;
  return el(
    'div',
    {
      class: `node ${isActiveRunner(runner.id) ? 'selected' : ''}`,
      dataset: { runner: runner.id },
      ...sortableRow('runners', runner),
      onclick: () => openRunner(runner),
      oncontextmenu: (event) => {
        event.preventDefault();
        runnerMenu(event.currentTarget, runner);
      },
    },
    [
      el('span', { class: 'twist' }, [icon('play')]),
      el('span', { class: 'name', text: runner.name }),
      session
        ? el('span', { class: 'count running', text: `${session.index + 1}/${session.total}` })
        : el('span', { class: 'count', text: String(summary.runnable) }),
      specEnabled(runner) ? el('span', { class: 'faint small nowrap', title: '定时已开启' }, [icon('clock')]) : null,
      dangling ? el('span', { class: 'faint small nowrap warn-text', title: `${dangling} 个集合已被删除` }, '!') : null,
    ]
  );
}

function specEnabled(runner) {
  return !!(runner.schedule && runner.schedule.enabled);
}

function runnerMenu(anchor, runner) {
  menu(
    anchor,
    [
      { label: '立即运行', icon: 'play', onSelect: () => runRunner(runner) },
      { label: '重命名', icon: 'pencil', onSelect: () => renameRunner(runner) },
      { label: '创建副本', icon: 'copy', onSelect: () => duplicateRunner(runner) },
      { separator: true },
      {
        label: '删除计划',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          if (!(await confirmDialog(`确定删除运行计划「${runner.name}」吗？集合和请求本身不受影响。`))) return;
          const at = state.runners.indexOf(runner);
          if (at >= 0) state.runners.splice(at, 1);
          for (const tab of [...state.tabs]) if (tab.kind === 'runner' && tab.refId === runner.id) tab.refId = null;
          touch('runners');
          emit('pane');
          emit('tabs');
          toast('已删除运行计划', 'ok', 2200);
        },
      },
    ],
    { align: 'end' }
  );
}

function renameRunner(runner) {
  prompt({ title: '重命名运行计划', label: '计划名称', value: runner.name, okText: '改名' }).then((value) => {
    const name = String(value || '').trim();
    if (!name || name === runner.name) return;
    runner.name = name;
    const tab = state.tabs.find((item) => item.kind === 'runner' && item.refId === runner.id);
    if (tab) tab.title = name;
    touch('runners');
    emit('tabs');
    emit('pane');
  });
}

function duplicateRunner(runner) {
  const copy = JSON.parse(JSON.stringify(runner));
  copy.id = uid('run');
  copy.name = `${runner.name} 副本`;
  copy.schedule = { ...copy.schedule, enabled: false };
  state.runners.push(copy);
  touch('runners');
  emit('pane');
  openRunner(copy);
}

/// 新建就带上当前选中的那一项，省掉"建完再去右边加"这一趟。
export function createRunner(name) {
  const runner = newRunner(name || '新建运行计划');
  const picked = state.selectedNodeIds[state.selectedNodeIds.length - 1];
  if (picked) runner.sources = [picked];
  state.runners.push(runner);
  touch('runners');
  openRunner(runner);
  emit('pane');
  return runner;
}

export function renderRunnersPane(host) {
  host.replaceChildren(
    el('div', { class: 'sidebar-head' }, [
      el('span', { class: 'sidebar-title', text: '运行计划' }),
      el(
        'button',
        { class: 'btn sm primary', title: state.collections.length ? '新建一个串行计划' : '先建一个集合', onclick: () => createRunner() },
        [icon('plus'), el('span', { text: '新建' })]
      ),
    ]),
    el(
      'div',
      { class: 'sidebar-body' },
      state.runners.length
        ? state.runners.map(runnerRow)
        : [
            el('div', { class: 'empty', style: { height: 'auto', padding: '40px 16px' } }, [
              el('h3', { text: '还没有运行计划' }),
              el('button', { class: 'btn primary sm', text: '新建计划', onclick: () => createRunner() }),
            ]),
          ]
    )
  );
}

/* ---------------------------- workspace ---------------------------- */

let openRunId = null;

/// 选择器列出树里所有可加入的节点（集合 / 文件夹 / 请求），带路径。刻意**不按
/// "已经加过了"过滤，也永不禁用**：一个灰掉、点开是空的控件，只会让人以为
/// "这功能没法用" —— 而重复加同一个请求本来就是有意义的（跑两遍）。
function sourceOptions() {
  const out = [];
  const walk = (node, trail) => {
    const name = node.name || '未命名';
    const path = trail.concat(name);
    const above = trail.join(' / ');
    out.push({ value: node.id, label: name, hint: above ? `${KIND_LABEL[node.kind] || '条目'} · ${above}` : KIND_LABEL[node.kind] || '条目' });
    for (const child of node.children || []) walk(child, path);
  };
  for (const collection of state.collections) walk(collection, []);
  return out;
}

function sourcePicker(runner) {
  return selectField({
    value: '',
    placeholder: '添加步骤…',
    title: '把集合、文件夹或单个请求接到队列末尾',
    className: 'runner-add',
    options: sourceOptions(),
    onChange: (value) => {
      if (!value) return;
      addSource(runner, value);
    },
  });
}

export function addSource(runner, nodeId) {
  changeList({ ...planOrder(runner), label: '添加计划步骤' }, rows => rows.push(nodeId));
  const hit = findNode(nodeId);
  return hit ? hit.node : null;
}

function swap(list, from, to) {
  if (to < 0 || to >= list.length) return false;
  [list[from], list[to]] = [list[to], list[from]];
  return true;
}

function orderRow(runner, index) {
  const list = sourcesOf(runner);
  const id = list[index];
  const hit = findNode(id);
  const steps = stepsForSource(id);
  // Containers show their runnable request count; an individual request already
  // identifies one item and does not need a second, unexplained "1".
  const count = steps.filter((step) => !step.skip).length;
  const isContainer = hit && ['collection', 'folder'].includes(hit.node.kind);
  const move = (delta) => {
    if (index + delta >= 0 && index + delta < list.length) changeList(planOrder(runner), rows => rows.splice(index + delta, 0, rows.splice(index, 1)[0]));
  };
  return el('div', { class: 'plan-step', dataset: { orderIndex: index } }, [
    reorderHandle(index, planOrder(runner)),
    el('span', { class: 'plan-no', text: String(index + 1) }),
    hit
      ? el('span', { class: isContainer ? 'plan-kind' : `badge method-${(hit.node.protocol === 'ws' ? 'other' : hit.node.request?.method || 'get').toLowerCase()}`, text: isContainer ? KIND_LABEL[hit.node.kind] : hit.node.protocol === 'ws' ? 'WS' : hit.node.protocol === 'sse' ? 'SSE' : hit.node.request?.method || 'GET' })
      : null,
    el('div', { class: 'plan-copy' }, [
      hit
        ? el('span', { class: 'name', text: hit.node.name || '未命名', title: hit.node.name || '' })
        : el('span', { class: 'name warn-text', text: '已删除', title: '运行时会自动跳过，建议移除' }),
      hit ? el('span', { class: 'plan-path', text: isContainer ? '按集合顺序执行' : hit.node.request?.url || '未设置地址', title: isContainer ? '集合内部按左侧树的顺序跑' : hit.node.request?.url || '' }) : null,
    ]),
    isContainer ? el('span', { class: 'count nowrap', text: `${count} 个请求`, title: '可执行请求数' }) : null,
    el('span', { class: 'plan-move' }, [
      el('button', { class: 'btn icon sm', title: '上移', disabled: index === 0, onclick: () => move(-1) }, [icon('chevU')]),
      el('button', {
        class: 'btn icon sm',
        title: '下移',
        disabled: index === list.length - 1,
        onclick: () => move(1),
      }, [icon('chevD')]),
      el('button', {
        class: 'btn icon sm',
        title: '从队列里移除这一个',
        onclick: () => {
          changeList({ ...planOrder(runner), label: '移除计划步骤' }, rows => rows.splice(index, 1));
        },
      }, [icon('close')]),
    ]),
  ]);
}

function planOrder(runner) {
  return { selector: '.plan-step', get: () => sourcesOf(runner), set: list => { runner.sources = list; }, domain: 'runners', label: '计划排序', name: '拖拽执行步骤', valid: () => state.runners.includes(runner) };
}

/// 数据文件卡：一个 CSV 就是"这个计划跑 N 遍"。解析结果随计划持久化，定时运行
/// 不依赖原文件还在；行变量按文件顺序覆盖环境变量。
function dataCard(runner) {
  const data = dataFileOf(runner);
  const setData = (value) => {
    if (value) runner.data = value;
    else delete runner.data;
    touch('runners');
    emit('rerender');
  };
  const picker = filePicker({
    accept: '.csv,text/csv',
    buttonText: data ? '换一个 CSV' : '选择 CSV',
    hint: data ? '' : '第一行是列名，之后每行跑一遍计划',
    onPick: async (handle) => {
      const parsed = buildDataFile(handle.name, await handle.arrayBuffer());
      setData(parsed);
      toast(`已按 ${parsed.rows.length} 行数据循环：第 1 行 → 第 ${parsed.rows.length} 行`, 'ok', 4600);
    },
  });
  if (!data) {
    return el('div', { class: 'group' }, [
      el('div', { class: 'group-head' }, [el('span', { class: 'group-title', text: '数据文件（可选）' })]),
      el('div', { class: 'group-body' }, [picker]),
    ]);
  }
  const shown = data.rows.slice(0, 3);
  return el('div', { class: 'group' }, [
    el('div', { class: 'group-head' }, [
      el('span', { class: 'group-title', text: '数据文件' }),
      el('button', { class: 'btn sm ghost', text: '移除', title: '回到单遍运行', onclick: () => setData(null) }),
    ]),
    el('div', { class: 'group-body' }, [
      el('p', { class: 'hint' }, [
        el('span', { text: `${data.fileName} · ${data.rows.length} 行 × ${data.header.length} 列${data.encoding === 'gbk' ? ' · 按 GBK 读取' : ''}` }),
        el('span', { class: 'faint small', text: `　按文件顺序：第 1 行 → 第 ${data.rows.length} 行；列名写成 {{${data.header[0]}}} 即被当轮的值替换` }),
      ]),
      el('div', { class: 'data-preview' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, data.header.map((name) => el('th', { text: name })))]),
          el('tbody', {}, shown.map((row) => el('tr', {}, data.header.map((_, i) => el('td', { text: row[i] ?? '' }))))),
        ]),
      ]),
      data.rows.length > shown.length ? el('p', { class: 'hint faint small', text: `预览前 ${shown.length} 行，共 ${data.rows.length} 行` }) : null,
    ].filter(Boolean)),
  ]);
}

function delayPicker(runner) {
  return selectField({
    value: String(runner.delayMs || 0),
    className: 'runner-delay',
    options: [
      { value: '0', label: '不停' },
      { value: '500', label: '0.5 秒' },
      { value: '1000', label: '1 秒' },
      { value: '3000', label: '3 秒' },
      { value: '10000', label: '10 秒' },
    ],
    onChange: (value) => {
      runner.delayMs = Number(value);
      touch('runners');
    },
  });
}

function runOptionsCard(runner) {
  const spec = runner.schedule;
  const set = (patch) => {
    Object.assign(spec, patch);
    // 开启、换口径、改时点都以现在为锚点重算，否则"每 30 分钟"会沿用一个早已
    // 过期的老锚点，看起来像开关没生效
    spec.anchorAt = Date.now();
    touch('runners');
    emit('rerender');
  };
  const { hour, minute } = clockOf(spec.at);
  const every = selectField({
    value: String(spec.everyMinutes || 30),
    className: 'runner-every',
    options: [1, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440].map((minutes) => ({
      value: String(minutes),
      label: minutes < 60 ? `每 ${minutes} 分钟` : minutes < 1440 ? `每 ${minutes / 60} 小时` : '每 24 小时',
    })),
    onChange: (value) => set({ everyMinutes: Number(value) }),
  });
  // 定点就用自绘列表框挑整点/刻钟，而不是原生 <input type=time>：一个带系统
  // 样式的分钟滚轮摆在满屏令牌化的界面里，正是这版设计要消掉的东西。
  const hours = selectField({
    value: String(hour),
    className: 'runner-clock',
    options: Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `${String(i).padStart(2, '0')} 时` })),
    onChange: (value) => set({ at: `${String(value).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }),
  });
  const minutes = selectField({
    value: String(minute),
    className: 'runner-clock',
    options: [0, 15, 30, 45].map((m) => ({ value: String(m), label: `${String(m).padStart(2, '0')} 分` })),
    onChange: (value) => set({ at: `${String(hour).padStart(2, '0')}:${String(value).padStart(2, '0')}` }),
  });
  // 运行设置和定时合成一张卡：它们回答的是同一个问题（这次怎么跑）。分成两张
  // 并排，短的会被拉伸成一片空，不拉伸又会底边不齐 —— 两个都不如不拆。
  return el('div', { class: 'group' }, [
    el('div', { class: 'group-head' }, [el('span', { class: 'group-title', text: '运行方式' })]),
    el('div', { class: 'group-body' }, [
      fieldRow('遇到失败就停下', toggle(runner.stopOnError, (on) => {
        runner.stopOnError = on;
        touch('runners');
        emit('rerender');
      }, '遇到失败就停下')),
      fieldRow('请求间隔', delayPicker(runner)),
      fieldRow('定时运行', toggle(spec.enabled, (on) => set({ enabled: on }), '定时自动运行')),
      spec.enabled ? fieldRow('方式', segmented([['interval', '固定间隔'], ['daily', '每天定点']], spec.kind || 'interval', (value) => set({ kind: value }))) : null,
      spec.enabled && spec.kind !== 'daily' ? fieldRow('间隔', every) : null,
      spec.enabled && spec.kind === 'daily' ? fieldRow('时间', el('div', { class: 'btn-row' }, [hours, minutes])) : null,
      spec.enabled
        ? el('p', { class: 'hint runner-next' }, [
            icon('clock'),
            el('span', { text: `下次 ${nextLabel(spec)}` }),
            el('span', { class: 'faint small', text: '　仅应用运行时触发，不补跑' }),
          ])
        : null,
    ].filter(Boolean)),
  ]);
}

function entryRow(entry, run) {
  const tone = entry.pending ? 'pending' : entry.skipped ? 'skip' : entry.ok ? 'pass' : 'fail';
  return el(
    'div',
    {
      class: `run-entry ${tone}`,
      dataset: { run: run.id, entryIndex: run.entries.indexOf(entry) },
      role:'button',tabindex:'0',
      'aria-haspopup':'dialog','aria-label':`查看${entry.name}的执行详情`,
      onkeydown:event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}},
      title: `${entry.collectionName} · ${entry.url}\n${new Date(entry.at).toLocaleString('zh-CN')}`,
      onclick: () => {
        openRunEntry(run, run.entries.indexOf(entry), selected => {
          const hit = findNode(selected.nodeId);
          if (!hit) { toast('这个请求已经不在集合里了', 'err', 2600); return; }
          openRequest(hit.node, { replaceExisting: false });
        });
      },
    },
    [
      el('span', { class: 'run-dot', 'aria-hidden': 'true' }),
      el('span', { class: `badge method-${(entry.method || 'get').toLowerCase()}`, text: (entry.method || '').slice(0, 6) }),
      el('span', { class: 'name' }, [
        el('span', { text: entry.name || entry.url }),
        // 数据循环里同一步骤每行出现一次，轮次跟在名字后面才能对上"这一轮是谁"。
        entry.iteration ? el('span', { class: 'run-reason', text: `第 ${entry.iteration} 行` }) : null,
        // 跳过原因跟在名字后面：它属于"这一行是什么"。塞进耗时那一列会把下面
        // 所有数字都顶歪，三个数字列就对不齐了。
        entry.skipped ? el('span', { class: 'run-reason', text: entry.reason }) : null,
        entry.error && !entry.skipped ? el('span', { class: 'run-reason', text: entry.error }) : null,
        entry.note && !entry.error && !entry.skipped ? el('span', { class: 'run-reason', text: entry.note }) : null,
        entry.checkSummary?.total || entry.checkSummary?.extractionTotal ? el('span', { class: 'run-reason', text: `检查 ${entry.checkSummary.passed}/${entry.checkSummary.total} · 提取 ${entry.checkSummary.extracted}/${entry.checkSummary.extractionTotal}` }) : null,
      ]),
      el('span', { class: 'run-col', text: entry.pending?'执行中':entry.skipped ? '跳过' : entry.outcome === 'cancelled' ? '已取消' : entry.status ? String(entry.status) : entry.errorKind || '失败' }),
      el('span', { class: 'run-col faint small nowrap', text: entry.skipped ? '—' : duration(entry.timeMs) }),
      el('span', { class: 'run-col faint small nowrap', text: entry.skipped ? '—' : bytes(entry.sizeBytes) }),
      el('span', { class: 'run-entry-detail-arrow', 'aria-hidden': 'true' }, [icon('chevR')]),
    ]
  );
}

function runBlock(run) {
  const expanded = openRunId === run.id;
  const tone = run.totals.failed ? 'fail' : run.cancelled || run.stoppedAfter ? 'stop' : 'pass';
  return el('div', { class: 'run-block' }, [
    el(
      'div',
      {
        class: 'run-head',
        role:'button',tabindex:'0','aria-expanded':String(expanded),
        onkeydown:event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}},
        onclick: () => {
          openRunId = expanded ? null : run.id;
          emit('rerender');
        },
      },
      [
        el('span', { class: `run-mark ${tone}`, 'aria-hidden': 'true' }),
        el('span', { class: 'name', text: new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false }) }),
        run.trigger === 'timer' ? el('span', { class: 'count', title: '由定时触发' }, [icon('clock')]) : null,
        run.iterations ? el('span', { class: 'count', title: `数据文件：${run.dataFile}` , text: `${run.iterations} 行数据` }) : null,
        el('span', {
          class: 'run-col small',
          text: `${run.totals.passed} 过 / ${run.totals.failed} 败` + (run.totals.skipped ? ` / ${run.totals.skipped} 跳` : '') + (run.totals.cancelled ? ` / ${run.totals.cancelled} 取消` : ''),
        }),
        el('span', { class: 'run-col faint small nowrap', text: duration(run.finishedAt - run.startedAt) }),
        el('span', { class: `twist openable ${expanded ? 'open' : ''}` }, [icon('chevD')]),
      ]
    ),
    expanded ? el('div', { class: 'run-entries' }, run.entries.map(entry => entryRow(entry, run))) : null,
  ]);
}

export function renderRunnerTab(tab) {
  const runner = state.runners.find((item) => item.id === tab.refId);
  if (!runner) {
    return el('div', { class: 'pane-scroll' }, [
      el('div', { class: 'empty' }, [el('h3', { text: '运行计划已删除' })]),
    ]);
  }
  const session = sessionOf(runner.id);
  const summary = planSummary(runner);
  const runs = state.runs.filter((run) => run.runnerId === runner.id);

  const title = el('input', {
    class: 'req-title',
    value: runner.name,
    'aria-label': '计划名称',
    onchange: (event) => {
      const name = event.target.value.trim();
      if (!name || name === runner.name) return;
      runner.name = name;
      tab.title = name;
      touch('runners');
      emit('tabs');
      emit('pane');
    },
  });

  const data = dataFileOf(runner);
  const head = el('div', { class: 'runner-head' }, [
    el('div', { class: 'runner-title' }, [
      title,
      el('p', { class: 'hint' }, [
        el('span', { text: `${summary.sources} 个步骤 · ${summary.runnable} 个请求${data ? ` · ${data.rows.length} 轮数据` : ''}` }),
        summary.skipped ? el('span', { class: 'faint small', text: `（另有 ${summary.skipped} 个不进队列）` }) : null,
      ]),
    ]),
    el('div', { class: 'btn-row' }, [
      session
        ? el('button', { class: 'btn danger', onclick: () => stopRunner(runner.id) }, [icon('stop'), el('span', { text: '停止' })])
        : el('button', { class: 'btn primary', onclick: () => runRunner(runner) }, [icon('play'), el('span', { text: '立即运行' })]),
    ]),
  ]);

  const progress = session
    ? el('div', { class: 'run-progress live-run-progress' }, [
        el('div',{class:'live-run-top'},[el('span',{class:'live-run-label'},[el('span',{class:'status-dot live'}),'运行中']),el('span',{class:'live-run-totals',text:`通过 ${session.run.totals.passed} · 失败 ${session.run.totals.failed} · 跳过 ${session.run.totals.skipped}`})]),
        el('div', { class: 'run-bar',role:'progressbar','aria-label':'计划执行进度','aria-valuemin':'0','aria-valuemax':String(session.total),'aria-valuenow':String(session.run.totals.ran+session.run.totals.skipped), style: { '--i': String(session.run.totals.ran+session.run.totals.skipped), '--n': String(session.total) } }),
        el('span', { class: 'faint small', text: `${Math.min(session.index + 1,session.total)} / ${session.total}　${session.current ? session.current.name : '等待下一步'}` }),
        session.run.entries.length?el('div',{class:'live-run-entries'},session.run.entries.slice(-6).map(entry => entryRow(entry, session.run))):null,
      ])
    : null;

  const list = sourcesOf(runner);
  const plan = el('div', { class: 'group' }, [
    el('div', { class: 'group-head' }, [el('span', { class: 'group-title', text: '执行顺序' }), sourcePicker(runner)]),
    el(
      'div',
      { class: 'group-body plan-list' },
      list.length
        ? list.map((_, index) => orderRow(runner, index))
        : [
            el('p', { class: 'hint' }, [
              el('span', { text: '还没有步骤。' }),
            ]),
          ]
    ),
  ]);

  const history = el('div', { class: 'group' }, [
    el('div', { class: 'group-head' }, [
      el('span', { class: 'group-title', text: '运行记录' }),
      runs.length
        ? el('button', {
            class: 'btn sm ghost',
            text: '清空',
            onclick: async () => {
              if (!(await confirmDialog(`清空「${runner.name}」的 ${runs.length} 条运行记录吗？`))) return;
              state.runs = state.runs.filter((run) => run.runnerId !== runner.id);
              touch('runs');
              emit('rerender');
            },
          })
        : null,
    ]),
    el(
      'div',
      { class: 'group-body' },
      runs.length ? runs.map(runBlock) : [el('p', { class: 'hint', text: '暂无运行记录' })]
    ),
  ]);

  return el('div', { class: 'pane-scroll runner-pane', 'aria-busy':String(!!session) }, [head, progress, plan, dataCard(runner), runOptionsCard(runner), history]);
}
