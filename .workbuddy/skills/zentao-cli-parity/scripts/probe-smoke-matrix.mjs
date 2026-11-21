#!/usr/bin/env node
/**
 * 探针 7 · 全量只读动作冒烟扫描 → **本实例兼容性矩阵**（P2-19）
 *
 * ## 它回答什么问题
 *
 * 「注册表里有 229 个动作，本实例到底哪些真能用？」—— 现在的答案靠**手工挑的 61 例**
 * `verify:live` 用例，覆盖率很低。本探针把**每一个只读动作**都打一遍，产出一张表：
 *
 * | 结论 | 含义 |
 * | --- | --- |
 * | ✅ 可用 | 真的调通了（有数据 / 空列表都算，空列表会写明「已扫描 N 条」） |
 * | 🚫 门槛拒绝 | `minVersion` 不过（如 `max8.5` 才有的动作）—— **不是缺陷**，换个实例就能用 |
 * | ❌ 路由不存在 | 404，两条路都没有 |
 * | ⚠️ 参数不可解 | 需要人工给 ID（本实例拿不到种子 ID），**下一轮补种子即可** |
 * | ⚠️ 需必填参数 | 动作声明了 `required` 查询参数，自动装配猜不出 |
 *
 * ## 两条设计原则（改动时别破）
 *
 * 1. **只跑 `method === 'get'`** —— 写动作一律不碰。这是本探针能安全对真实实例跑的前提。
 * 2. **不硬编码端点清单** —— 模块名、动作名、路径模板、参数全部从 SDK 注册表现读，
 *    并用「先跑无参动作收种子 ID → 再跑带参动作」的**多轮瀑布**自动补全 path 参数。
 *    这样官方注册表升级后本脚本无需跟着改。
 *
 * ## 用法
 *
 *   npm run probe:smoke
 *   node probe-smoke-matrix.mjs --out=docs/instance-compatibility-matrix.md
 *   node probe-smoke-matrix.mjs --concurrency=3 --max-rounds=4
 *   node probe-smoke-matrix.mjs --only=bug,task     # 只看某几个模块
 *   node probe-smoke-matrix.mjs --json              # 额外落一份 JSON（供 P2-17 消费）
 *
 * ⚠️ 同账号并发实测安全线是 **≤5**，默认就给 4，别再往上加。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST = path.join(PROJECT_ROOT, 'dist');

// ---------------------------------------------------------------- 参数
const opts = { out: null, json: false, concurrency: 4, maxRounds: 5, recPerPage: 5, only: null };
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
  if (!m) continue;
  if (m[1] === 'out') opts.out = m[2];
  else if (m[1] === 'json') opts.json = true;
  else if (m[1] === 'concurrency') opts.concurrency = Math.max(1, Math.min(5, Number(m[2]) || 4));
  else if (m[1] === 'max-rounds') opts.maxRounds = Number(m[2]) || 5;
  else if (m[1] === 'rec-per-page') opts.recPerPage = Number(m[2]) || 5;
  else if (m[1] === 'only') opts.only = String(m[2]).split(',').map((s) => s.trim()).filter(Boolean);
}

const OUT_MD = opts.out
  ? path.resolve(PROJECT_ROOT, opts.out)
  : path.join(PROJECT_ROOT, '.workbuddy', 'tmp', 'smoke-matrix.md');
const OUT_JSON = OUT_MD.replace(/\.md$/i, '.json');

// ---------------------------------------------------------------- 加载客户端
if (!fs.existsSync(path.join(DIST, 'client.js'))) {
  throw new Error(`找不到 ${path.relative(PROJECT_ROOT, DIST)}/client.js，请先执行 npm run build`);
}
const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  try {
    const host = new URL(process.env.ZENTAO_BASE_URL || '').hostname;
    const bypass = ['127.0.0.1', 'localhost', host].filter(Boolean).join(',');
    process.env.NO_PROXY = process.env.NO_PROXY ? `${process.env.NO_PROXY},${bypass}` : bypass;
    process.env.no_proxy = process.env.NO_PROXY;
  } catch { /* ignore */ }
}

const cfgMod = await import(pathToFileURL(path.join(DIST, 'config.js')).href);
const clientMod = await import(pathToFileURL(path.join(DIST, 'client.js')).href);
const sdkMod = await import(pathToFileURL(path.join(DIST, 'sdk', 'index.js')).href);
const pick = (mod, name) => mod[name] || mod.default?.[name];

const loadConfig = pick(cfgMod, 'loadConfig');
const ZenTaoClient = pick(clientMod, 'ZenTaoClient');
const getSdkRuntime = pick(sdkMod, 'getSdkRuntime');
const isActionAvailable = pick(sdkMod, 'isActionAvailable');
if (!loadConfig || !ZenTaoClient || !getSdkRuntime) {
  throw new Error('dist 里没导出 loadConfig / ZenTaoClient / getSdkRuntime，构建产物可能过期');
}

const silent = {
  debug() {}, info() {}, warn() {}, error() {},
  getHistory: () => [], clearHistory() {}, getLogsByLevel: () => [], setLevel() {},
};
const rt = await getSdkRuntime(new ZenTaoClient(loadConfig(), silent));
const sdk = rt.sdk;

// ---------------------------------------------------------------- 注册表展开
/** 归一化 getModuleNames 的各种返回形态（数组 / 对象） */
function moduleNames() {
  const raw = sdk.getModuleNames ? sdk.getModuleNames() : [];
  const list = Array.isArray(raw) ? raw : Object.keys(raw || {});
  return list.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
}

const ALL = [];
for (const moduleName of moduleNames()) {
  const mod = sdk.getModule(moduleName);
  for (const action of mod?.actions || []) {
    if (!action?.name) continue;
    ALL.push({
      module: moduleName,
      action: action.name,
      method: String(action.method || '').toLowerCase(),
      path: action.path,
      display: action.display || '',
      minVersion: action.minVersion,
      pathParams: Object.keys(action.pathParams || {}),
      requiredParams: (action.params || []).filter((p) => p?.required).map((p) => p.name),
    });
  }
}

const READ_ONLY = ALL.filter((a) => a.method === 'get');
const WRITE_TOUCHED = ALL.length - READ_ONLY.length;
const scoped = opts.only ? READ_ONLY.filter((a) => opts.only.includes(a.module)) : READ_ONLY;

// ---------------------------------------------------------------- 种子 ID 瀑布
/**
 * 种子池：资源名（小写单数）→ **候选 ID 列表**。
 *
 * ⭐ 为什么要「列表」而不是「一个」：本实例产品 `13` 下面的 productplan / testcase /
 * feedback / ticket 全是**空**的，只取第一个父 ID 会让这些模块的详情动作被误判成
 * 「参数不可解」。多候选 + 「空结果就换下一个候选重试」能把它们救回来。
 */
const seeds = new Map();
const SEED_LIMIT = 5;

/** 小写化 + 去尾 s，得到资源单数名（bugs→bug，products→product，executions→execution） */
const singular = (s) => {
  const t = String(s || '').toLowerCase();
  return t.endsWith('ies') ? `${t.slice(0, -3)}y` : t.endsWith('s') ? t.slice(0, -1) : t;
};

/** 收集响应里**所有**记录 id（上限 SEED_LIMIT）：数组形态 + 以 id 为键的字典形态都认 */
function findListIds(value, out = [], depth = 0) {
  if (out.length >= SEED_LIMIT || !value || typeof value !== 'object' || depth > 4) return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= SEED_LIMIT) break;
      if (item && typeof item === 'object') {
        const id = item.id ?? item.ID;
        if (id != null) out.push(id);
        else findListIds(item, out, depth + 1);
      }
    }
    return out;
  }
  if (value.id != null) { out.push(value.id); return out; }
  if (value.ID != null) { out.push(value.ID); return out; }
  // 以 id 为键的字典：`{ "2000279": {…} }`（testtasks / testcases / epic 等是这个形态）
  const numericKeys = Object.keys(value).filter((k) => /^\d+$/.test(k));
  if (numericKeys.length && typeof value[numericKeys[0]] === 'object') {
    for (const k of numericKeys) {
      if (out.length >= SEED_LIMIT) break;
      out.push(k);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'pager' || k === 'status' || k === 'message') continue;
    findListIds(v, out, depth + 1);
    if (out.length >= SEED_LIMIT) break;
  }
  return out;
}

/** 把挖到的 id 们追加到候选资源名下（去重，先到先得） */
function harvest(value, candidates) {
  const ids = findListIds(value);
  if (!ids.length) return;
  for (const keyName of candidates) {
    if (!keyName) continue;
    const list = seeds.get(keyName) || [];
    for (const id of ids) if (!list.includes(id) && list.length < SEED_LIMIT) list.push(id);
    if (list.length) seeds.set(keyName, list);
  }
}

/** 路径里的资源段（跳过 `{xxx}` 占位），已单数化：`/productplans/{planID}` → ['productplan'] */
function pathResources(pathTemplate) {
  return String(pathTemplate || '')
    .split('/')
    .filter((s) => s && !s.startsWith('{'))
    .map(singular);
}

/**
 * 归一化候选 ID。
 *
 * ⚠️ **复合 ID 不能直接当路径参数**（本项目记过的坑，2026-09-20 再次实测确认）：
 * `testcase/list` 给的是 `case_74`，原样传给 `/testcases/{caseID}` → **404**；
 * 剥成 `74` 就正常。SDK 不做这层归一化，得我们自己剥。
 */
function normalizeId(value) {
  if (typeof value === 'string') {
    const m = /^[A-Za-z]+_(\d+)$/.exec(value.trim());
    if (m) return m[1];
  }
  return value;
}

/** 解析一个 path 参数名 → 值（解析不出返回 undefined）。
 *
 * `attempt` 是第几次尝试：同资源有多个候选 ID 时，用 `attempt` 依次往下取；
 * 取到末尾就固定用最后一个（于是「候选没变」＝「没有更多可试的」）。
 *
 * ⚠️ 三层兜底缺一不可，参数名和模块名**经常对不上**：
 * `/productplans/{planID}` 的参数叫 `planID`（种子叫 `productplan`）、
 * `/testcases/{caseID}` 的参数叫 `caseID`（种子叫 `testcase`）。
 * 只按参数名前缀查，这两个就会被误判成「参数不可解」。
 */
function resolvePathParam(name, pathTemplate, attempt = 0) {
  if (name === 'scope') return 'products';
  const pickNth = (list) => (list && list.length ? normalizeId(list[Math.min(attempt, list.length - 1)]) : undefined);

  if (name === 'scopeID') {
    for (const k of ['product', 'project', 'execution']) {
      const v = pickNth(seeds.get(k));
      if (v !== undefined) return v;
    }
    return undefined;
  }

  const m = /^(.*?)ID$/.exec(name);
  if (m) {
    const base = m[1].toLowerCase();
    // ① 按参数名前缀
    for (const k of [base, `${base}s`, `${base}es`]) {
      const v = pickNth(seeds.get(k));
      if (v !== undefined) return v;
    }
    // ② 按路径里的资源段
    for (const res of pathResources(pathTemplate)) {
      const v = pickNth(seeds.get(res));
      if (v !== undefined) return v;
    }
    // ③ 按路径里的范围段（/products/{productID}/bugs）
    for (const scoped of ['product', 'project', 'execution']) {
      if (pathResources(pathTemplate).includes(scoped)) {
        const v = pickNth(seeds.get(scoped));
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 单次调用 + 分类
/**
 * 调一个动作并分类。
 * 返回 { status, note, items, ms }；status ∈ ok | empty | gate | notfound | error | skip
 */
async function run(action, attempt = 0) {
  const started = Date.now();

  // ① 门槛判定（调用前）—— 「不支持」和「报错」是两件事，必须分开统计
  if (isActionAvailable && !isActionAvailable(sdk, action.module, action.action, rt.version.version)) {
    return { status: 'gate', note: `需要 ${(action.minVersion || []).join(' / ') || '更高版本'}` };
  }

  // ② 参数装配
  const params = {};
  for (const name of action.pathParams) {
    const v = resolvePathParam(name, action.path, attempt);
    if (v === undefined) {
      return {
        status: 'skip',
        note: `缺 path 参数 ${name}（本实例取不到种子 ID —— 通常是父资源列表为空）`,
      };
    }
    params[name] = v;
  }
  if (action.requiredParams.length) {
    return { status: 'skip', note: `动作声明必填参数：${action.requiredParams.join(', ')}` };
  }

  // ③ 真打
  try {
    const data = await rt.call(
      `${action.module}/${action.action}`,
      params,
      { recPerPage: opts.recPerPage, throwOnFail: true }
    );
    const count = countOf(data);
    const paramNote = Object.keys(params).length ? `（${JSON.stringify(params).slice(1, -1)}）` : '';
    return {
      status: count === 0 ? 'empty' : 'ok',
      note: count === 0 ? `已扫描：本页 0 条${paramNote}` : `本页 ${count} 条${paramNote}`,
      items: count,
      params,
      raw: data,
      ms: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b404\b|does not exist|不存在/i.test(message) && !/Not allowed/i.test(message)) {
      return { status: 'notfound', note: message.slice(0, 120), ms: Date.now() - started };
    }
    const code = error?.code ? `${error.code}: ` : '';
    return { status: 'error', note: `${code}${message}`.slice(0, 160), ms: Date.now() - started };
  }
}

/**
 * 数一数响应里有多少条。
 *
 * ⚠️ 两个必须守住的点（都踩过）：
 * 1. **空集合就是 0**。`{status, message, data: [], pager: {…}}` 绝不能掉进
 *    「没有数组 → 当单条对象 → 返回 1」的兜底，否则空列表会被报成「✅ 可用（1 条）」
 *    —— 典型的假绿，比报错更危险。
 * 2. **以 id 为键的字典也算条目**（`testtasks` / `testcases` 返回的是这种）。
 */
function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;

  let sawCollection = false;
  let max = 0;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'pager') continue; // 分页元信息不是数据
    if (Array.isArray(v)) {
      sawCollection = true;
      max = Math.max(max, v.length);
    } else if (v && typeof v === 'object') {
      const numeric = Object.keys(v).filter((x) => /^\d+$/.test(x)).length;
      if (numeric) {
        sawCollection = true;
        max = Math.max(max, numeric);
      }
    }
  }
  if (sawCollection) return max;
  // 完全没有集合容器：若是「单条对象」也算拿到了数据
  return Object.keys(value).length ? 1 : 0;
}

// ---------------------------------------------------------------- 多轮瀑布
const results = new Map(); // `${module}/${action}` -> result
const attempts = new Map(); // `${module}/${action}` -> 已试到第几个候选种子
const key = (a) => `${a.module}/${a.action}`;
let todo = scoped.map((action) => ({ action, attempt: 0 }));

async function pool(items, worker, limit) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

let round = 0;
while (todo.length && round < opts.maxRounds) {
  round += 1;
  const batch = todo;
  todo = [];

  await pool(
    batch,
    async ({ action, attempt }) => {
      const res = await run(action, attempt);
      results.set(key(action), res);
      attempts.set(key(action), attempt);
      // 采集种子：模块名 + 路径里的资源名都作为候选
      if (res.status === 'ok' || res.status === 'empty') {
        const pathRes = String(action.path || '').match(/\/([a-zA-Z]+)(?:\/|$)/g) || [];
        const candidates = new Set([action.module, singular(action.module)]);
        for (const seg of pathRes) candidates.add(singular(seg.replace(/\//g, '')));
        harvest(res.raw, [...candidates].filter(Boolean));
      }
    },
    opts.concurrency
  );

  // ⚠️ 必须**重扫全部动作**，而不是只看本轮这一批：
  // 种子 ID 是「A 动作的成功」换来的，A 可能在第 2 轮才成功，
  // 而那批里并没有（第 1 轮就跳过的）B —— 只看本轮会永远漏掉 B。
  for (const action of scoped) {
    const k = key(action);
    const res = results.get(k);
    if (!res) continue;
    const tried = attempts.get(k) ?? 0;

    // 情况一：之前因为拿不到 path 参数被跳过，现在有种子了 → 从头试
    if (res.status === 'skip' && /缺 path 参数/.test(res.note)) {
      if (action.pathParams.every((n) => resolvePathParam(n, action.path, 0) !== undefined)) {
        todo.push({ action, attempt: 0 });
      }
      continue;
    }

    // 情况二：调通了但**这一页是空的** → 换个候选父 ID 再试（产品 13 下子资源全空就是这么救的）
    if (res.status === 'empty' && action.pathParams.length) {
      const hasMore = action.pathParams.some(
        (n) => resolvePathParam(n, action.path, tried) !== resolvePathParam(n, action.path, tried + 1)
      );
      if (hasMore) todo.push({ action, attempt: tried + 1 });
    }
  }
}

// ---------------------------------------------------------------- 汇总 / 输出
const ORDER = ['ok', 'empty', 'gate', 'notfound', 'error', 'skip'];
const LABEL = {
  ok: '✅ 可用',
  empty: '✅ 可用（空）',
  gate: '🚫 门槛拒绝',
  notfound: '❌ 路由不存在',
  error: '❌ 其他错误',
  skip: '⚠️ 参数不可解',
};
const byStatus = Object.fromEntries(ORDER.map((s) => [s, 0]));
const rows = [];
for (const action of scoped) {
  const res = results.get(key(action)) || { status: 'skip', note: '未执行' };
  byStatus[res.status] = (byStatus[res.status] || 0) + 1;
  rows.push({ ...action, ...res });
}

const version = rt.version?.version || '(未知)';
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

const lines = [];
lines.push('# 本实例兼容性矩阵（全量只读动作冒烟扫描）');
lines.push('');
lines.push(`> 自动生成，**不要手改**。生成时间：${stamp}`);
lines.push(`> 生成命令：\`npm run probe:smoke\`（探针 7 / P2-19，脚本 \`.workbuddy/skills/zentao-cli-parity/scripts/probe-smoke-matrix.mjs\`）`);
lines.push('');
lines.push('## 一、总览');
lines.push('');
lines.push('| 项 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 实例版本 | \`${version}\`${rt.version?.edition ? `（${rt.version.edition}）` : ''} |`);
lines.push(`| 注册表动作总数 | ${ALL.length} |`);
lines.push(`| 其中只读（\`method=get\`） | **${READ_ONLY.length}** |`);
lines.push(`| 非只读（本探针**不碰**） | ${WRITE_TOUCHED} |`);
lines.push(`| 扫描范围 | ${opts.only ? `\`--only=${opts.only.join(',')}\` → ${scoped.length} 个` : `全部 ${scoped.length} 个只读动作`} |`);
lines.push(`| 并发 / 轮次 | ${opts.concurrency} / 用了 ${round} 轮 |`);
lines.push('');
lines.push(`> ⚠️ 明细里的**条数是「本页取到的条数」**（脚本按 \`recPerPage=${opts.recPerPage}\` 取，只为验证「接口通不通」，`);
lines.push('> 不代表总量）。结论看「接口是否有响应」，不看条数多少。');
lines.push('>');
lines.push('> ⚠️ 本探针**只跑 `method=get`** 的动作，写动作（POST/PUT/DELETE）一个都不碰 —— 这是它能安全对真实实例跑的前提。');
lines.push('');
lines.push('| 结论 | 数量 |');
lines.push('| --- | --- |');
for (const s of ORDER) lines.push(`| ${LABEL[s]} | ${byStatus[s] || 0} |`);
lines.push('');
lines.push('## 二、怎么读这张表');
lines.push('');
lines.push('- **✅ 可用 / ✅ 可用（空）** —— 接口**通**。空只说明这一页没数据，不代表接口坏（别当缺陷）。');
lines.push('- **🚫 门槛拒绝** —— 动作在注册表里，但 `minVersion` 比本实例高。**这不是缺陷**：换到满足版本的实例就能用。');
lines.push('- **❌ 路由不存在** —— 服务端根本没这条路由（404），两条路都没有。');
lines.push('- **⚠️ 参数不可解** —— 本探针自动装配不出 ID，通常是因为**父资源列表为空**（拿不到种子 ID）。给个 ID 再验即可，不一定是接口问题。');
lines.push('');
lines.push('## 三、逐动作明细');
lines.push('');
lines.push('| 模块 | 动作 | 结论 | 说明 |');
lines.push('| --- | --- | --- | --- |');
for (const r of rows) {
  const note = String(r.note || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 110);
  lines.push(`| \`${r.module}\` | \`${r.action}\` | ${LABEL[r.status]} | ${note} |`);
}
lines.push('');

const md = lines.join('\n');
fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, md, 'utf8');
if (opts.json) {
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify({ generatedAt: new Date().toISOString(), version, totals: byStatus, rows }, null, 1),
    'utf8'
  );
}

// 控制台摘要（ASCII 为主，避免 Windows 控制台乱码）
console.log('');
console.log('=== smoke matrix ===');
console.log(`instance version : ${version}`);
console.log(`registry actions : ${ALL.length} (readonly ${READ_ONLY.length} / write-skipped ${WRITE_TOUCHED})`);
console.log(`scanned          : ${scoped.length}  (rounds used: ${round})`);
for (const s of ORDER) console.log(`${LABEL[s].padEnd(18)}: ${byStatus[s] || 0}`);
console.log(`seeds harvested  : ${[...seeds.entries()].map(([k, v]) => `${k}=[${v.join(',')}]`).join(' ')}`);
console.log(`report           : ${path.relative(PROJECT_ROOT, OUT_MD)}`);
