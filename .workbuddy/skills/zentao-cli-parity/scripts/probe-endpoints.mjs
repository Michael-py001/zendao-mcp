#!/usr/bin/env node
/**
 * 本实例 REST 端点可达性探针
 *
 * 回答一个具体问题：**「禅道官方 API 里有的功能，这台实例到底给不给？」**
 *
 * 为什么需要它：官方 CLI/SDK 的 26 个模块是按「禅道标准版能力」定义的，
 * 但具体到一个实例能不能用，取决于两张网：
 *   ① 前置 Web 服务器（会不会掐断 PUT/DELETE）；
 *   ② 禅道自身的版本门槛。
 * 所以判断「某个官方功能值不值得移植进本项目」时，不能看官方文档，要看这里跑出来的矩阵。
 *
 * ⭐ 判定口径（关键，别用 `status < 400` 那套）：
 *   禅道对**不存在的对象**返回的是 HTTP 200 + `{status:'fail'}`，而不是 404；
 *   只有**路由本身不存在**才给 404。所以：
 *     HTTP 404           → 路由不存在 → 该功能在本实例不可用
 *     HTTP 200 + success → 路由存在且有数据 → 可用
 *     HTTP 200 + fail    → 路由存在（只是当前参数下没有对应对象）→ **仍然算可用**
 *     HTTP 200 + HTML    → 「伪 200」：请求被回落到前端路由、返回登录页 → **实为不存在的路由**
 *   `client.get()` 抛出的 ZenTaoError 带 `status` 字段，正好够用。
 *
 *   ⚠️ 第四种形态最容易骗人：它既不是 404 也不是 JSON，只看 HTTP 状态码会当成「有路由」。
 *   （2026-09-18 在 `/testresults`、`/testruns` 上踩到，一开始全被判成了 exists。）
 *
 * 用法：
 *   npm run probe:endpoints
 *   node probe-endpoints.mjs --out=./endpoints.md --json=./endpoints.json
 *   node probe-endpoints.mjs --product=2000076 --project=2000546 --execution=92
 *   node probe-endpoints.mjs --group=my,build,story     # 只探指定分组
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

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = { out: null, json: null, quiet: false, concurrency: 5 };
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'out') opts.out = value;
    else if (key === 'json') opts.json = value;
    else if (key === 'quiet') opts.quiet = true;
    else if (key === 'product') opts.product = Number(value);
    else if (key === 'project') opts.project = Number(value);
    else if (key === 'execution') opts.execution = Number(value);
    else if (key === 'group') opts.groups = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'concurrency') opts.concurrency = Math.max(1, Math.min(10, Number(value) || 5));
  }
  return opts;
}

// ---------------------------------------------------------------- 加载项目客户端

async function loadProjectClient() {
  if (!fs.existsSync(path.join(DIST, 'client.js'))) {
    throw new Error(`找不到 ${path.relative(PROJECT_ROOT, DIST)}/client.js，请先执行 npm run build`);
  }

  // 先把项目 .env 注入 process.env，再 import 项目模块。
  //
  // 为什么不直接依赖 dist/config.js 里的 dotenv：它按 `__dirname/../.env` 与
  // `cwd/.env` 两条路径找，cwd 由调用方决定，从这里跑时未必命中。
  // 自己读一遍最稳（dotenv 不覆盖已存在的变量，所以这里只补缺、不覆盖）。
  //
  // 顺带放行代理：本机注入了 HTTP_PROXY，axios 会把内网请求也交给代理，
  // 必须把禅道主机写进 NO_PROXY。
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }

    try {
      const host = new URL(process.env.ZENTAO_BASE_URL || '').hostname;
      const bypass = ['127.0.0.1', 'localhost', host].filter(Boolean).join(',');
      process.env.NO_PROXY = process.env.NO_PROXY ? `${process.env.NO_PROXY},${bypass}` : bypass;
      process.env.no_proxy = process.env.NO_PROXY;
    } catch { /* BASE_URL 尚未配置，交给 loadConfig 报错 */ }
  }

  const cfgMod = await import(pathToFileURL(path.join(DIST, 'config.js')).href);
  const clientMod = await import(pathToFileURL(path.join(DIST, 'client.js')).href);
  const respMod = await import(pathToFileURL(path.join(DIST, 'utils', 'response.js')).href);

  const loadConfig = cfgMod.loadConfig || cfgMod.default?.loadConfig;
  const ZenTaoClient = clientMod.ZenTaoClient || clientMod.default?.ZenTaoClient;
  const extractList = respMod.extractList || respMod.default?.extractList;

  if (!loadConfig || !ZenTaoClient) throw new Error('dist 里没导出 loadConfig / ZenTaoClient，构建产物可能过期');

  // 探针会**故意**打一批不存在的路由，client 默认的 logger 会把每个 404 连堆栈一起
  // 打到 stderr，把报告淹掉。这里换成静默 logger —— 错误信息由 probeOne 自己捕获
  // 并写进报告，不需要重复输出。
  const silentLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    getHistory: () => [],
    clearHistory() {},
    getLogsByLevel: () => [],
    setLevel() {},
  };

  const client = new ZenTaoClient(loadConfig(), silentLogger);
  return { client, extractList };
}

// ---------------------------------------------------------------- 探测核心

/** 取前 n 个键做摘要，避免把整条实体塞进报告 */
function preview(data, n = 6) {
  if (data === null || typeof data !== 'object') return String(data).slice(0, 80);
  const keys = Object.keys(data).slice(0, n);
  return keys.join(', ') + (Object.keys(data).length > n ? ` …(共 ${Object.keys(data).length} 键)` : '');
}

/**
 * 探测单个端点。
 *
 * 只看「路由是否存在」，不关心业务是否命中 —— 见文件头部的判定口径说明。
 */
async function probeOne(client, item, attempt = 0) {
  const { label, path: ep, params } = item;
  const started = Date.now();
  try {
    const data = await client.get(ep, params);
    return {
      ...item,
      route: 'exists',
      http: 200,
      biz: data?.status ?? '(无 status 字段)',
      ms: Date.now() - started,
      note: preview(data),
    };
  } catch (err) {
    const http = err?.status || err?.response?.status || 0;
    const msg = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 140);

    if (http === 404) {
      return { ...item, route: 'missing', http: 404, biz: '-', ms: Date.now() - started, note: '路由不存在' };
    }

    // 「伪 200」：路由不存在时，前置服务器会把请求回落到禅道前端路由，
    // 于是返回 200 + 登录页 HTML，而不是 404。
    // 必须单独识别，否则会被误判成「路由存在」—— 2026-09-18 就在
    // /testresults、/testruns 上踩到，一开始全被算成了「有路由」。
    if (/不是 JSON|登录页|text\/html/i.test(msg)) {
      return {
        ...item,
        route: 'missing',
        http,
        biz: '-',
        ms: Date.now() - started,
        note: '伪 200（返回登录页 HTML）→ 实为无此路由',
      };
    }

    // ⚠️ 403 在本实例**不可靠**：并发 / token 重登窗口会把「路由不存在」包成 403
    // （实测 /users、/users/1、/projects/{id}/members、/testtasks/{id}/builds 单跑都是 404，
    //   并发全量跑就变成 403；/testcases/{id}/run 也偶发过一次）。
    // 所以拿到 403 不急着定论，先等一下串行重试一次：
    //   重试得到 404 → 路由确实不存在；重试仍是 403 → 才算「存在但被拒」。
    if (http === 403 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 500));
      return probeOne(client, item, 1);
    }

    // 其他一律算「路由在，只是这次没取到数据」
    return { ...item, route: 'exists', http, biz: 'fail', ms: Date.now() - started, note: msg };
  }
}

/** 简易并发池（避免把服务端打崩，也避免串行太慢） */
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- 探测清单

/**
 * 构造探测清单。
 *
 * `group` 用来分组，`expect` 是编写时就已知的预期 —— 报告里会把
 * 「预期」与「实测」并排放，**不一致的地方就是最有价值的发现**。
 */
function buildTargets(ids, extractList) {
  const P = ids.product;
  const PJ = ids.project;
  const E = ids.execution;
  const page1 = { pageID: 1, recPerPage: 1 };

  /** @type {Array<{group:string,label:string,path:string,params?:any,expect?:string,why?:string}>} */
  const list = [
    // ---------- 基线：本项目已在用的通路，确认探针本身工作正常 ----------
    { group: '基线', label: '项目列表', path: '/projects', params: page1, expect: 'exists', why: '本项目已用' },
    { group: '基线', label: '产品列表', path: '/products', params: page1, expect: 'exists', why: '本项目已用' },
    { group: '基线', label: '项目集列表', path: '/programs', params: page1, expect: 'exists', why: '本项目已用' },
    { group: '基线', label: '执行列表', path: '/executions', params: page1, expect: 'exists', why: '本项目已用' },
    { group: '基线', label: '我的 Bug（地盘 work）', path: '/my/work', params: { mode: 'bug', type: 'assignedTo', ...page1 }, expect: 'exists', why: '本项目已用，替代 /my/bugs' },
    { group: '基线', label: '官方路径 /my/bugs', path: '/my/bugs', params: page1, expect: 'missing', why: '官方定义有、本实例 404，本项目才改用 /my/work' },
    { group: '基线', label: '任务列表（按执行）', path: `/executions/${E}/tasks`, params: page1, expect: 'exists', why: '本项目已用' },

    // ---------- 地盘家族：官方全要 max8.5，但 /my/work 把四种资源都开了 ----------
    { group: '地盘', label: '我的任务（work 通路）', path: '/my/work', params: { mode: 'task', type: 'assignedTo', ...page1 }, expect: 'exists', why: '⭐ 返回 tasks 字段；官方 /my/tasks 要 max8.5' },
    { group: '地盘', label: '我的需求（work 通路）', path: '/my/work', params: { mode: 'story', type: 'assignedTo', ...page1 }, expect: 'exists', why: '⭐ 返回 stories 字段（带 gradeGroup）' },
    { group: '地盘', label: '我的待办（work 通路）', path: '/my/work', params: { mode: 'todo', type: 'assignedTo', ...page1 }, expect: 'exists', why: '⭐ 返回 todos 字段 + waitCount/doingCount，结构与 bug 不同' },
    { group: '地盘', label: '官方路径 /my/tasks', path: '/my/tasks', params: page1, expect: 'missing', why: '官方定义但本实例 404（需 max8.5）' },
    { group: '地盘', label: '官方路径 /my/stories', path: '/my/stories', params: page1, expect: 'missing', why: '同上' },
    { group: '地盘', label: '官方路径 /my/testcases', path: '/my/testcases', params: page1, expect: 'missing', why: '同上' },
    { group: '地盘', label: '官方路径 /my/projects', path: '/my/projects', params: page1, expect: 'missing', why: '同上' },

    // ---------- 版本：⭐ 关键修正，版本挂在「执行」下，不是产品下 ----------
    { group: '版本', label: '执行下版本列表', path: `/executions/${E}/builds`, params: page1, expect: 'exists', why: '⭐ Bug 的 openedBuild/resolvedBuild 就靠它，别再硬填 trunk' },
    { group: '版本', label: '产品下版本列表', path: `/products/${P}/builds`, params: page1, expect: 'missing', why: '⚠️ 反直觉：产品维度没有版本接口' },
    { group: '版本', label: '项目下版本列表', path: `/projects/${PJ}/builds`, params: page1, expect: 'missing', why: '同上，只有执行维度有' },
    { group: '版本', label: '产品下发布列表', path: `/products/${P}/releases`, params: page1, expect: 'exists', why: '发布记录' },
    { group: '版本', label: '产品下计划列表', path: `/products/${P}/productplans`, params: page1, expect: 'exists', why: '需求/Bug 归属计划（注意是 productplans，不是 plans）' },

    // ---------- 需求线：Bug.story / task.story 存着需求 ID，但一直查不到内容 ----------
    { group: '需求', label: '产品下需求列表', path: `/products/${P}/stories`, params: page1, expect: 'exists', why: '⭐ 修 Bug 时看需求背景' },
    { group: '需求', label: '项目下需求列表', path: `/projects/${PJ}/stories`, params: page1, expect: 'exists', why: '按项目维度取需求' },
    { group: '需求', label: '需求详情', path: '/stories/1', params: undefined, expect: 'exists', why: '返回业务 fail 但路由在（用真实故事 ID 可查）' },
    { group: '需求', label: '需求列表（全局）', path: '/stories', params: page1, expect: 'missing', why: '无全局入口，必须带 scope' },
    { group: '需求', label: '需求模块树', path: `/products/${P}/story/modules`, params: page1, expect: 'missing', why: '⚠️ 与 bug/modules 一样没有' },
    { group: '需求', label: '业务需求 epic', path: '/epics', params: page1, expect: 'missing', why: '官方 CLI 说 max8.2 无门槛，但 REST 端点实际 404' },
    { group: '需求', label: '用户需求 requirement', path: '/requirements', params: page1, expect: 'missing', why: '同上' },

    // ---------- 测试线（2026-09-18 深探；结论：能建不能跑） ----------
    { group: '测试', label: '产品下测试用例', path: `/products/${P}/testcases`, params: page1, expect: 'exists', why: '✅ 可用，键 testcases' },
    { group: '测试', label: '用例全局列表', path: '/testcases', params: page1, expect: 'exists', why: '⭐ 用例**有**全局入口（180 条）；键 cases（字典），另带 products(35)/modules(50) 字典' },
    { group: '测试', label: '项目下用例', path: `/projects/${PJ}/testcases`, params: page1, expect: 'exists', why: '可用' },
    { group: '测试', label: '执行下用例', path: `/executions/${E}/testcases`, params: page1, expect: 'exists', why: '可用' },
    { group: '测试', label: '用例详情（纯数字 ID）', path: '/testcases/2004636', params: undefined, expect: 'exists', why: '⭐ 60 字段，含 steps 嵌套步骤树（group/item + expect）与 files' },
    { group: '测试', label: '用例详情（列表给的复合 ID）', path: '/testcases/case_2004636', params: undefined, expect: 'missing', why: '⚠️ 反直觉坑：列表里 id 是 `case_2004636`，原样当路径参数直接 **404**，详情必须剥前缀用纯数字' },
    { group: '测试', label: '用例模块树', path: '/testcases/modules', params: { productID: P }, expect: 'missing', why: '⚠️ 404 —— 与官方 `testcase modules`「需 max8.5」双向印证' },
    { group: '测试', label: '测试单（全局）', path: '/testtasks', params: page1, expect: 'exists', why: '188 条；键 tasks（字典，非数组）+ users 字典 206 条' },
    { group: '测试', label: '产品下测试单', path: `/products/${P}/testtasks`, params: page1, expect: 'exists', why: '测试单（提 Bug 的批次）' },
    { group: '测试', label: '项目下测试单', path: `/projects/${PJ}/testtasks`, params: page1, expect: 'exists', why: '可用' },
    { group: '测试', label: '测试单详情', path: '/testtasks/2000279', params: undefined, expect: 'exists', why: 'testtask 实体 31 字段（含 files）+ actions 操作历史' },
    { group: '测试', label: '⭐ 用例执行结果', path: '/testtasks/2000279/results', params: page1, expect: 'exists', why: '⭐ 全实例**唯一**能看到「用例跑没跑、结果如何」的入口：keys 含 results/runID/case/builds；⚠️ 但**忽略路径 id**，实为全库 2912 条（pass 2557 / fail 330 / blocked 25）' },
    { group: '测试', label: '执行结果?type=fail', path: '/testtasks/2000279/results', params: { type: 'fail', ...page1 }, expect: 'exists', why: 'type 筛选**真生效**（330 条 = 分布里的 fail 数），type∈{all,fail,pass,blocked}' },
    { group: '测试', label: '测试单下用例 /cases', path: '/testtasks/2000279/cases', params: page1, expect: 'exists', why: '⚠️ 路由在但恒报 "Task does not exist." —— 它要的是 **taskID**（「任务下的用例」），不是测试单 ID，实际取不到数据' },
    { group: '测试', label: '执行用例 /run', path: '/testcases/2004636/run', params: undefined, expect: 'missing', why: '❌ 本实例**没有「执行用例」的 REST 路由**（官方 CLI 也没有这个动作）。⚠️ 曾偶发返回 403「Not allowed（权限不足）」—— 连测 16 次（8 串行 + 8 并发）全 404，判定为一次性伪影，别当成权限问题去追' },
    { group: '测试', label: '用例结果 /results', path: '/testcases/2004636/results', params: page1, expect: 'missing', why: '❌ 没有；执行结果只能从测试单那条 /testtasks/{id}/results 看' },
    { group: '测试', label: '执行结果 /testresults', path: '/testresults', params: page1, expect: 'missing', why: '⚠️ **伪 200**：返回登录页 HTML 而非 404（别被 status 骗了）' },
    { group: '测试', label: '执行结果 /testruns', path: '/testruns', params: page1, expect: 'missing', why: '⚠️ 同样是伪 200' },
    { group: '测试', label: '测试单下版本', path: '/testtasks/2000279/builds', params: page1, expect: 'missing', why: '404' },

    // ---------- 组织：/users 全 404，但 /my/work 响应里自带用户字典 ----------
    { group: '组织', label: '用户列表', path: '/users', params: page1, expect: 'missing', why: '⚠️ 没有；改用 /my/work 响应里的 users 字典（账号→姓名）' },
    { group: '组织', label: '用户详情', path: '/users/1', params: undefined, expect: 'missing', why: '同上' },
    { group: '组织', label: '项目成员', path: `/projects/${PJ}/members`, params: page1, expect: 'missing', why: '没有' },
    { group: '组织', label: '执行成员', path: `/executions/${E}/members`, params: page1, expect: 'missing', why: '没有' },

    // ---------- 项目 / 执行维度：查 Bug 多了两条入口，任务反而没有 ----------
    { group: '维度', label: '项目下 Bug', path: `/projects/${PJ}/bugs`, params: page1, expect: 'exists', why: '⭐ 「这个项目有哪些 Bug」，现在只能按产品查' },
    { group: '维度', label: '执行下 Bug', path: `/executions/${E}/bugs`, params: page1, expect: 'exists', why: '⭐ 「这个迭代有哪些 Bug」' },
    { group: '维度', label: '产品下 Bug', path: `/products/${P}/bugs`, params: page1, expect: 'exists', why: '标准路径，本项目通过 /bugs?productID 走' },
    { group: '维度', label: '项目下任务', path: `/projects/${PJ}/tasks`, params: page1, expect: 'missing', why: '⚠️ 没有；任务只能逐执行查' },
    { group: '维度', label: '任务详情', path: '/tasks/1', params: undefined, expect: 'exists', why: '⭐ 返回业务 fail 但路由在 —— 可作为 zendao_get_task 的基础' },

    // ---------- 其他资源 ----------
    { group: '其他', label: '待办 todo', path: '/todos', params: page1, expect: 'missing', why: '没有独立端点（但 /my/work?mode=todo 可用）' },
    { group: '其他', label: '反馈 feedback', path: '/feedbacks', params: page1, expect: 'exists', why: '客服/反馈' },
    { group: '其他', label: '工单 ticket', path: '/tickets', params: page1, expect: 'exists', why: '工单' },
    { group: '其他', label: '问题 issue', path: '/issues', params: page1, expect: 'exists', why: '项目问题' },
    { group: '其他', label: '风险 risk', path: '/risks', params: page1, expect: 'exists', why: '项目风险' },
    { group: '其他', label: '会议 meeting', path: '/meetings', params: page1, expect: 'exists', why: '会议' },
    { group: '其他', label: '文档空间（我自己）', path: '/doc/my/spaces', params: page1, expect: 'missing', why: '整个 doc 模块 42 项里 41 项要 max8.5，剩下这项也没路' },
    { group: '其他', label: '文件元数据', path: '/files/2016187', params: undefined, expect: 'exists', why: '附件下载已在用' },
  ];

  void extractList;
  return list;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const say = (s = '') => { if (!opts.quiet) process.stderr.write(s + '\n'); };

  const { client, extractList } = await loadProjectClient();
  say(`站点：${client.siteBaseUrl}（API ${client.apiPrefix}）`);

  // 解析 ID：优先命令行传入，否则动态取列表第一项
  const ids = { product: opts.product, project: opts.project, execution: opts.execution };
  const note = [];
  if (!ids.product) {
    try {
      const { list } = extractList(await client.get('/products', client.paginationParams(1, 1)), 'products', 1);
      ids.product = list[0]?.id ?? 2000076;
      note.push(`product=${ids.product}(动态)`);
    } catch { ids.product = 2000076; note.push('product=2000076(兜底)'); }
  }
  if (!ids.project) {
    try {
      const { list } = extractList(await client.get('/projects', { browseType: 'all', ...client.paginationParams(1, 1) }), 'projects', 1);
      ids.project = list[0]?.id ?? 2000546;
      note.push(`project=${ids.project}(动态)`);
    } catch { ids.project = 2000546; note.push('project=2000546(兜底)'); }
  }
  if (!ids.execution) {
    try {
      const { list } = extractList(await client.get('/executions', client.paginationParams(1, 1)), 'executions', 1);
      ids.execution = list[0]?.id ?? 92;
      note.push(`execution=${ids.execution}(动态)`);
    } catch { ids.execution = 92; note.push('execution=92(兜底)'); }
  }
  say(`取样 ID：${note.join(' / ')}`);

  let targets = buildTargets(ids, extractList);
  if (opts.groups) {
    const want = new Set(opts.groups);
    targets = targets.filter((t) => want.has(t.group));
    say(`已按 --group 过滤，共 ${targets.length} 个端点`);
  }

  say(`开始探测 ${targets.length} 个端点（并发 ${opts.concurrency}）…`);
  const results = await runPool(
    targets,
    async (t) => {
      const r = await probeOne(client, t);
      say(`  ${r.route === 'exists' ? '✅' : '❌'} ${r.group}/${r.label}  ${r.http}`);
      return r;
    },
    opts.concurrency
  );

  // ---- 汇总 ----
  const groups = new Map();
  for (const r of results) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  const existsCount = results.filter((r) => r.route === 'exists').length;
  const missingCount = results.length - existsCount;

  const lines = [];
  lines.push('# 本实例 REST 端点可达性矩阵\n');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 站点：${client.siteBaseUrl}（API ${client.apiPrefix}）`);
  lines.push(`- 取样 ID：${note.join(' / ')}`);
  lines.push(`- 结论：**${existsCount} 个路由存在 / ${missingCount} 个不存在**（共 ${results.length} 个探测点）\n`);
  lines.push('> 判定口径：禅道对「对象不存在」返回 HTTP 200 + `status:fail`，只有「路由不存在」才给 404。');
  lines.push('> 所以 404 才代表该功能在本实例没路，200 + fail 仍然算可用。');
  lines.push('> ⚠️ 第三种「不存在」是**伪 200**：返回 200 + 登录页 HTML（请求被回落到前端路由），同样记作无路由。\n');

  const unexpected = [];
  for (const [g, list] of groups) {
    lines.push(`## ${g}\n`);
    lines.push('| 端点 | 用途 | 结果 | HTTP | 返回 | 备注 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of list) {
      const mark = r.route === 'exists' ? '✅ 可用' : '❌ 无此路由';
      const shown = r.params ? `${r.path}?${new URLSearchParams({ ...r.params }).toString()}` : r.path;
      lines.push(`| \`${shown}\` | ${r.label} | ${mark} | ${r.http} | ${r.biz} | ${r.note || r.why || ''} |`);
      if (r.expect && r.expect !== '?' && r.expect !== r.route) {
        unexpected.push({ ...r, group: g });
      }
    }
    lines.push('');
  }

  lines.push(`## 预期与实测不一致的点\n`);
  if (!unexpected.length) {
    lines.push('无 —— 所有带明确预期的探测点都与实测一致。\n');
  } else {
    for (const u of unexpected) {
      lines.push(`- **${u.group} / ${u.label}**：预期 \`${u.expect}\`，实测 \`${u.route}\`（HTTP ${u.http}）`);
      if (u.why) lines.push(`  - 背景：${u.why}`);
    }
    lines.push('');
  }

  lines.push('## 直接可用的移植候选\n');
  const candidates = results.filter((r) => r.route === 'exists' && r.why && r.why.includes('⭐'));
  if (!candidates.length) {
    lines.push('（本次探测未命中标记为高价值的候选，可能是被 --group 过滤掉了）\n');
  } else {
    for (const c of candidates) {
      lines.push(`- **${c.label}** — \`${c.path}\``);
      lines.push(`  - ${c.why}`);
      lines.push(`  - 实测：HTTP ${c.http} / ${c.biz}`);
    }
    lines.push('');
  }

  const text = lines.join('\n');
  if (opts.out) {
    const outPath = path.isAbsolute(opts.out) ? opts.out : path.resolve(PROJECT_ROOT, opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');
    say(`\n✅ 报告已写入 ${outPath}`);
  }
  if (opts.json) {
    const jsonPath = path.isAbsolute(opts.json) ? opts.json : path.resolve(PROJECT_ROOT, opts.json);
    fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), ids, results }, null, 2), 'utf8');
    say(`✅ JSON 已写入 ${jsonPath}`);
  }
  if (!opts.out && !opts.json) process.stdout.write(text);

  const bad = unexpected.length;
  say(`\n完成：${existsCount} 存在 / ${missingCount} 无路由${bad ? `，${bad} 处与预期不符` : ''}`);
}

main().catch((err) => {
  process.stderr.write(`\n❌ 探针失败：${err?.stack || err}\n`);
  process.exit(1);
});
