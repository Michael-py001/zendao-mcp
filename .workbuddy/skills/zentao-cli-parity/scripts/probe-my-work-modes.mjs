#!/usr/bin/env node
/**
 * `/my/work` 的 mode 全取值扫描 + 数据区分度验证
 *
 * 背景：官方 `my` 模块 14 个动作**全部被 max8.5 门槛拒绝**，看起来整块死掉。
 * 但 `/my/work` 是「一个接口 N 种资源」的设计 —— `mode` 换一个值就换一种资源。
 * 本探针回答两个问题：
 *   ① **`mode` 的哪些取值被服务端接受？**（是「不支持」还是「没数据」）
 *   ② **接受的取值之间，数据是真独立的吗？**（防止服务端没过滤、退化成同一份）
 *
 * ⭐ 为什么②必须验：`epic` / `requirement` 返回的键都叫 `stories`，`testtask` 返回 `tasks`。
 *    光看键名会以为是同一份数据。实测 ID 集合**交集为 0** 才证明是真过滤。
 *    （2026-09-18：story 100 条 ID 2002972 段 / epic 43 条 ID 1309 / requirement 28 条 ID 1508）
 *
 * ⚠️ 「条数为 0」有两种含义，别混（本项目记过的假阴性坑）：
 *      ① mode **不支持** → 伪 200（返回登录页 HTML）或报错
 *      ② mode **支持但本账号无数据** → 返回了正确的列表键，只是空
 *    判定「支持」的依据是**列表键存在**，不是**条数 > 0**。
 *
 * 用法：
 *   npm run probe:my-work
 *   node probe-my-work-modes.mjs --out=.workbuddy/tmp/my-work-modes.md
 *   node probe-my-work-modes.mjs --product=9 --project=21 --execution=43   # 用于详情复核
 *
 * 全部为**只读 GET**，不产生任何数据变更。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST = path.join(PROJECT_ROOT, 'dist');

// ---------------------------------------------------------------- 参数
const opts = { out: null, product: null, project: null, execution: null };
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
  if (!m) continue;
  if (m[1] === 'out') opts.out = m[2];
  else if (m[1] === 'product') opts.product = Number(m[2]);
  else if (m[1] === 'project') opts.project = Number(m[2]);
  else if (m[1] === 'execution') opts.execution = Number(m[2]);
}
const OUT = opts.out
  ? path.resolve(PROJECT_ROOT, opts.out)
  : path.join(PROJECT_ROOT, '.workbuddy', 'tmp', 'my-work-modes.md');

// ---------------------------------------------------------------- 加载客户端
if (!fs.existsSync(path.join(DIST, 'client.js'))) {
  throw new Error(`找不到 ${path.relative(PROJECT_ROOT, DIST)}/client.js，请先执行 npm run build`);
}
// 先自己读一遍 .env（dist/config.js 的 dotenv 按 cwd 找，未必命中），再 import 项目模块
const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  try {
    // 本机注入了 HTTP_PROXY，axios 1.x 会把内网请求也交给代理 → 必须放行禅道主机
    const host = new URL(process.env.ZENTAO_BASE_URL || '').hostname;
    const bypass = ['127.0.0.1', 'localhost', host].filter(Boolean).join(',');
    process.env.NO_PROXY = process.env.NO_PROXY ? `${process.env.NO_PROXY},${bypass}` : bypass;
    process.env.no_proxy = process.env.NO_PROXY;
  } catch { /* ignore */ }
}

const cfgMod = await import(pathToFileURL(path.join(DIST, 'config.js')).href);
const clientMod = await import(pathToFileURL(path.join(DIST, 'client.js')).href);
const loadConfig = cfgMod.loadConfig || cfgMod.default?.loadConfig;
const ZenTaoClient = clientMod.ZenTaoClient || clientMod.default?.ZenTaoClient;
if (!loadConfig || !ZenTaoClient) throw new Error('dist 里没导出 loadConfig / ZenTaoClient，构建产物可能过期');

// 本探针会故意打一批不支持的 mode，静默 logger 免得刷屏
const silent = { debug() {}, info() {}, warn() {}, error() {}, getHistory: () => [], clearHistory() {}, getLogsByLevel: () => [], setLevel() {} };
const client = new ZenTaoClient(loadConfig(), silent);

// ---------------------------------------------------------------- 工具
const sleep = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function get(ep, params) {
  try {
    return { ok: true, http: 200, body: await client.get(ep, params) };
  } catch (err) {
    const http = err?.status || err?.response?.status || 0;
    const msg = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 120);
    const html = /不是 JSON|登录页|text\/html/i.test(msg);
    return { ok: false, http, route: html ? '伪200' : http === 404 ? 'missing' : 'exists', msg };
  }
}

/** 字典/数组统一成对象数组 */
function toList(data, keys) {
  for (const k of keys) {
    const v = data?.[k];
    if (!v) continue;
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
    if (typeof v === 'object') return Object.values(v).flat().filter((x) => x && typeof x === 'object');
  }
  return [];
}
const idOf = (x) => Number(x?.id ?? x?.value ?? 0) || null;
const titleOf = (x) => String(x?.title ?? x?.name ?? '').slice(0, 20);

/** 不参与「列表字段」判定的元数据键 */
const META_KEYS = new Set([
  'status', 'title', 'isBiz', 'isMax', 'isIPD', 'isOpenedURAndSR', 'pager', 'date',
  'user', 'users', 'memberPairs', 'orderBy', 'productID', 'projectID',
]);

const ALL_MODES = [
  'bug', 'task', 'story', 'todo',                              // 本项目已支持
  'epic', 'requirement', 'testtask', 'testcase',               // 可补：官方有、本项目未做
  'feedback', 'ticket', 'issue', 'risk', 'meeting',
  'project',                                                    // 预期不支持
];
const MODE_KEYS = {
  bug: ['bugs'], task: ['tasks'], story: ['stories'], todo: ['todos'],
  epic: ['stories'], requirement: ['stories'], testtask: ['tasks'], testcase: ['cases'],
  feedback: ['feedbacks'], ticket: ['tickets'], issue: ['issues'], risk: ['risks'], meeting: ['meetings'],
  project: ['projects'],
};
const TYPES = ['assignedTo', 'openedBy', 'resolvedBy', 'assignedBy', 'closedBy', 'feedbackBy'];

// ---------------------------------------------------------------- 主流程
const L = [];
L.push('# `/my/work` 的 mode 全取值扫描');
L.push('');
L.push(`- 生成时间：${new Date().toISOString()}`);
L.push(`- 站点：${process.env.ZENTAO_BASE_URL || '(未配置)'}`);
L.push('');

// ---------- ① mode 支持性 + 列表键
L.push('## ① mode 支持性（判据：**列表键存在**，不是条数 > 0）');
L.push('');
L.push('| mode | HTTP | status | 顶层列表键 | 结论 |');
L.push('| --- | --- | --- | --- | --- |');

const support = {};
for (const mode of ALL_MODES) {
  const r = await get('/my/work', { mode, type: 'assignedTo', pageID: 1, recPerPage: 1 });
  await sleep();
  let listKeys = '(无)';
  let verdict;
  if (r.ok && r.body?.status === 'success') {
    listKeys = Object.keys(r.body).filter((k) => !META_KEYS.has(k) && r.body[k] && typeof r.body[k] === 'object').join(', ') || '(无)';
    verdict = MODE_KEYS[mode]?.some((k) => r.body[k] !== undefined) ? '✅ 支持' : '⚠️ 无对应列表键';
  } else if (r.route === '伪200') {
    verdict = '❌ 伪 200（无此 mode）';
  } else {
    verdict = `❌ ${(r.msg || 'fail').slice(0, 50)}`;
  }
  support[mode] = verdict.includes('✅');
  L.push(`| \`${mode}\` | ${r.http} | ${r.ok ? r.body?.status : (r.route === 'exists' ? 'fail' : '-')} | ${listKeys} | ${verdict} |`);
}

// ---------- ② type × mode 出数矩阵
L.push('');
L.push('## ② type × mode 出数矩阵（`recPerPage=100`）');
L.push('');
L.push('> 找每个 mode 用哪个 `type` 能取到数据 —— 用于区分「不支持」与「无数据」。');
L.push('');
L.push(`| mode | ${TYPES.join(' | ')} |`);
L.push(`| --- | ${TYPES.map(() => '---').join(' | ')} |`);
const bestType = {};
for (const [mode, keys] of Object.entries(MODE_KEYS)) {
  if (!support[mode]) { L.push(`| \`${mode}\` | ${TYPES.map(() => '-').join(' | ')} |`); continue; }
  const cells = [];
  for (const t of TYPES) {
    const r = await get('/my/work', { mode, type: t, pageID: 1, recPerPage: 100 });
    await sleep(150);
    const n = r.ok && r.body?.status === 'success' ? toList(r.body, keys).length : 0;
    cells.push(String(n));
    if (n > 0 && (!bestType[mode] || n > bestType[mode].n)) bestType[mode] = { t, n };
  }
  L.push(`| \`${mode}\` | ${cells.join(' | ')} |`);
}

// ---------- ③ 数据区分度（同键 mode 的 ID 交集）
L.push('');
L.push('## ③ 数据区分度：同键 mode 的 ID 集合比对');
L.push('');
L.push('> ⭐ 这是**最关键的一步** —— 证明服务端真按 mode 过滤，而不是退化成同一份数据。');
L.push('');
const captured = {};
L.push('| mode | type | 条数 | 首个 ID | 前 3 标题 |');
L.push('| --- | --- | --- | --- | --- |');
for (const [mode, keys] of Object.entries(MODE_KEYS)) {
  const bt = bestType[mode];
  if (!bt) { captured[mode] = { ids: [] }; continue; }
  const r = await get('/my/work', { mode, type: bt.t, pageID: 1, recPerPage: 100 });
  await sleep(150);
  const items = r.ok ? toList(r.body, keys) : [];
  const ids = [...new Set(items.map(idOf).filter(Boolean))];
  captured[mode] = { ids };
  L.push(`| \`${mode}\` | ${bt.t} | ${items.length} | ${ids[0] ?? '-'} | ${items.slice(0, 3).map(titleOf).join(' / ') || '-'} |`);
}

L.push('');
for (const [key, modes] of Object.entries({ stories: ['story', 'epic', 'requirement'], tasks: ['task', 'testtask'] })) {
  L.push(`**${key}**：`);
  const base = captured[modes[0]]?.ids ?? [];
  for (const m of modes) {
    const ids = captured[m]?.ids ?? [];
    const inter = ids.filter((x) => base.includes(x));
    if (m === modes[0]) {
      L.push(`- \`${m}\`：${ids.length} 条（基准）`);
    } else {
      const degenerate = inter.length > 0 && inter.length === Math.min(base.length, ids.length) && base.length === ids.length;
      L.push(`- \`${m}\`：${ids.length} 条，与基准交集 ${inter.length} 条 → ${degenerate ? '⚠️ **疑似未过滤（退化）**' : '✅ **不同实体，真过滤**'}`);
    }
  }
}

// ---------- ④ 结果端点复核
L.push('');
L.push('## ④ 详情路由复核（可选，需传 --product/--project/--execution）');
L.push('');
const checks = [];
if (opts.execution) {
  const r = await get(`/executions/${opts.execution}/builds`, { pageID: 1, recPerPage: 5 });
  const items = r.ok ? toList(r.body, ['builds']) : [];
  if (items.length) checks.push(['build get', `/builds/${idOf(items[0])}`]);
}
if (opts.product) {
  const r = await get(`/products/${opts.product}/testcases`, { pageID: 1, recPerPage: 5 });
  const items = r.ok ? toList(r.body, ['testcases']) : [];
  if (items.length) {
    // ⚠️ 用例列表给的 ID 形如 case_2004636，详情必须剥掉前缀
    const raw = String(items[0].id ?? '');
    const pure = raw.replace(/^[a-z]+_/i, '');
    checks.push(['testcase get（列表 ID）', `/testcases/${raw}`]);
    checks.push(['testcase get（剥离前缀）', `/testcases/${pure}`]);
  }
  const sr = await get(`/products/${opts.product}/stories`, { pageID: 1, recPerPage: 5 });
  const sits = sr.ok ? toList(sr.body, ['stories']) : [];
  if (sits.length) checks.push(['story get', `/stories/${idOf(sits[0])}`]);
}
if (!checks.length) {
  L.push('（未传取样参数，跳过）');
} else {
  L.push('| 端点 | HTTP | 判定 |');
  L.push('| --- | --- | --- |');
  for (const [label, ep] of checks) {
    const r = await get(ep, undefined);
    await sleep();
    const verdict = r.ok ? (r.body?.status === 'success' ? '✅ 可用' : `⚠️ 200+${r.body?.status}`)
      : r.route === 'missing' ? '❌ 无此路由'
        : r.route === '伪200' ? '❌ 伪 200' : '✅ 路由在（200+fail）';
    L.push(`| ${label} \`${ep}\` | ${r.http} | ${verdict} |`);
  }
}

const supported = ALL_MODES.filter((m) => support[m]);
L.push('');
L.push(`## 结论：**${supported.length} / ${ALL_MODES.length} 个 mode 受支持**`);
L.push('');
L.push(`- 支持：${supported.map((m) => `\`${m}\``).join('、')}`);
L.push(`- 不支持：${ALL_MODES.filter((m) => !support[m]).map((m) => `\`${m}\``).join('、') || '（无）'}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('written:', OUT);
console.log(`supported=${supported.length}/${ALL_MODES.length}`);
