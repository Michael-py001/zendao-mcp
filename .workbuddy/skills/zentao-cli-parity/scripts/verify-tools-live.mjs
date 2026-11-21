#!/usr/bin/env node
/**
 * 本项目 MCP 工具的**真机验收**探针（第 4 个脚本）
 *
 * 为什么必须有它 —— 这是本项目一条踩出来的铁律：
 *
 *   `scripts/verify-mcp.js`（= `npm run verify`）**手写 JSON-RPC、不做 ajv 校验**，
 *   而 MCP 客户端会拿 `outputSchema` 校验 `structuredContent`。
 *   于是「工具声明了 outputSchema，但返回的键对不上」这类 bug，
 *   在 `npm run verify` 那里**永远是绿的**，只有在真客户端里一调就 InvalidParams。
 *   （`get_project` / `get_execution` / `get_product` / `get_bug` 都栽在这上面过。）
 *
 * 它做三件事：
 *   1. 走完整 MCP 握手，列 `tools/list`，逐个检查**有没有 outputSchema**；
 *   2. 跑一组**只读冒烟用例**（含若干个「故意触发错误分支」的用例），
 *      把「协议级错误」（ajv 校验失败 / 参数校验失败）与「业务级错误」分开报告 ——
 *      前者是 bug，后者往往是预期行为；
 *   3. 支持 `--call=` 自由补调用，验证新加的工具。
 *
 * 用法：
 *   npm run build
 *   node verify-tools-live.mjs                                # 冒烟：默认用例
 *   node verify-tools-live.mjs --call=zendao_get_task:{"taskId":2012808}
 *   node verify-tools-live.mjs --no-smoke --call=...          # 只跑自定义用例
 *   node verify-tools-live.mjs --out=./verify-live.md         # 报告落盘
 *   node verify-tools-live.mjs --list                         # 只列工具与 schema
 *
 * ⚠️ 全部是**只读**调用（列表 / 详情 / 查询），不会写入禅道。
 * ⚠️ 默认用例里的对象 ID 取自本实例（MAX8.2）的实测数据；对象被删掉时会变成
 *    「业务级错误」，此时应视为「数据过期」而不是「脚本坏了」——
 *    报告里会把这两类明确分开。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');
const OUT_DEFAULT = null;

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = { out: OUT_DEFAULT, json: null, calls: [], smoke: true, listOnly: false, quiet: false };
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'out') opts.out = value;
    else if (key === 'json') opts.json = value;
    else if (key === 'call') opts.calls.push(value);
    else if (key === 'no-smoke') opts.smoke = false;
    else if (key === 'list') opts.listOnly = true;
    else if (key === 'quiet') opts.quiet = true;
  }
  return opts;
}

/** 读取项目 .env（走本项目自己的变量名），顺便放行代理 */
function loadEnv() {
  const env = { ...process.env };
  const envFile = path.join(PROJECT_ROOT, '.env');
  let host = '';
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      env[m[1]] = value;
      if (m[1] === 'ZENTAO_BASE_URL') {
        try {
          host = new URL(value).hostname;
        } catch {
          /* ignore */
        }
      }
    }
  }
  // ⚠️ 本机注入了 HTTP_PROXY，axios 会把内网请求也丢给代理 —— 必须放行禅道主机
  const bypass = ['127.0.0.1', 'localhost', host].filter(Boolean).join(',');
  if (bypass) {
    env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${bypass}` : bypass;
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}

/**
 * 默认冒烟用例。
 *
 * 每项：`[标签, 工具名, 参数, 是否**期望**走错误分支]`
 *
 * 「期望错误分支」的用例是在验证**防呆逻辑**是否生效（非法入参、不存在的对象、缺少必填范围），
 * 它们返回 `isError: true` 才算通过。
 * ⚠️ 注意区分两类错误：
 *   · **协议级**（`-32602 InvalidParams`）→ 只应出现在「zod 参数校验」上，其它情况都是 bug；
 *   · **业务级**（工具返回 isError）→ 正常。
 */
const SMOKE_CASES = [
  // ── 地盘四合一 ──
  ['我的任务', 'zendao_list_my_work', { mode: 'task' }, false],
  ['我的待办', 'zendao_list_my_work', { mode: 'todo' }, false],
  ['我的需求', 'zendao_list_my_work', { mode: 'story' }, false],
  ['我的 Bug', 'zendao_list_my_work', { mode: 'bug' }, false],
  ['我的 Bug（多页 + 含已关闭）', 'zendao_list_my_work', { mode: 'bug', includeClosed: true, type: 'resolvedBy' }, false],
  ['非法 mode 应被拒', 'zendao_list_my_work', { mode: 'nope' }, true],

  // ── 任务详情 ──
  ['任务详情', 'zendao_get_task', { taskId: 2012808 }, false],
  ['任务详情 + 操作历史', 'zendao_get_task', { taskId: 2012808, includeActions: true }, false],
  ['任务详情 + pick', 'zendao_get_task', { taskId: 2012808, pick: 'id,name,status' }, false],
  ['不存在的任务应报错', 'zendao_get_task', { taskId: 99999999 }, true],

  // ── 需求（改走通用层：官方 story/list 是 /{scope}/{scopeID}/stories，
  //      传 productID / projectID 时 SDK 会自动推断 scope）──
  ['需求列表（按产品）', 'zendao_call', { module: 'story', action: 'list', params: { productID: 2000076 } }, false],
  ['需求列表（按项目）', 'zendao_call', { module: 'story', action: 'list', params: { projectID: 2000546 } }, false],
  ['缺范围参数应被拒', 'zendao_call', { module: 'story', action: 'list' }, true],
  ['需求详情', 'zendao_call', { module: 'story', action: 'get', params: { id: 2003068 } }, false],
  ['不存在的需求应报错', 'zendao_call', { module: 'story', action: 'get', params: { id: 99999999 } }, true],

  // ── 版本（官方 build/list 同样挂在 scope 下）──
  ['版本列表（有数据）', 'zendao_call', { module: 'build', action: 'list', params: { scope: 'executions', scopeID: 380 } }, false],
  ['版本列表（空执行）', 'zendao_call', { module: 'build', action: 'list', params: { scope: 'executions', scopeID: 43 } }, false],

  // ── 用户字典 ──
  ['用户字典', 'zendao_list_users', { limit: 5, realNameOnly: true }, false],
  ['用户字典（按账号）', 'zendao_list_users', { account: 'your-account' }, false],

  // ── 通用层：官方全量动作（modules / help / call，2026-09-18 新增）──
  ['模块清单（按实例版本过滤）', 'zendao_modules', {}, false],
  ['模块清单（下钻 bug）', 'zendao_modules', { module: 'bug' }, false],
  ['模块清单（含被门槛拒绝的动作）', 'zendao_modules', { module: 'doc', includeUnsupported: true }, false],
  ['模块清单（关键词过滤）', 'zendao_modules', { keyword: 'bug' }, false],
  ['不存在的模块应报错', 'zendao_modules', { module: 'nope' }, true],
  ['动作参数表', 'zendao_help', { module: 'bug', action: 'list' }, false],
  ['动作参数表（列模块全部动作）', 'zendao_help', { module: 'task' }, false],
  ['动作参数表（只看请求体字段）', 'zendao_help', { module: 'bug', action: 'create', role: 'body' }, false],
  ['不存在的动作应报错', 'zendao_help', { module: 'bug', action: 'nope' }, true],
  ['通用调用：产品列表', 'zendao_call', { module: 'product', action: 'list', recPerPage: 2 }, false],
  ['通用调用：项目集列表', 'zendao_call', { module: 'program', action: 'list', recPerPage: 2 }, false],
  ['通用调用：Bug 列表', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, recPerPage: 2 }, false],
  ['通用调用：任务详情 + pick', 'zendao_call', { module: 'task', action: 'get', params: { id: 2012808 }, pick: 'id,name,status' }, false],
  ['通用调用：需求详情 + 本地过滤', 'zendao_call', { module: 'story', action: 'get', params: { id: 2003068 }, pick: 'id,title,status' }, false],
  // ⭐ 版本门槛：max8.5 才有的动作，在本实例（max8.2）必须给出**清晰的中文拒绝**
  ['通用调用：版本门槛应被拒（my/bugs 需 max8.5）', 'zendao_call', { module: 'my', action: 'bugs' }, true],
  ['通用调用：不存在的模块应报错', 'zendao_call', { module: 'nope', action: 'list' }, true],
  ['通用调用：不存在的动作应报错', 'zendao_call', { module: 'bug', action: 'nope' }, true],
  ['通用调用：缺必填参数应报错', 'zendao_call', { module: 'bug', action: 'get' }, true],

  // ── 既有工具回归（改动 outputSchema 后必跑）──
  // 项目/执行/产品/项目集的列表改走通用层（对应的手写工具已按计划收敛掉）
  ['项目列表', 'zendao_call', { module: 'project', action: 'list', recPerPage: 3 }, false],
  ['执行列表', 'zendao_call', { module: 'execution', action: 'list', recPerPage: 3 }, false],
  ['产品列表', 'zendao_call', { module: 'product', action: 'list', recPerPage: 3 }, false],
  ['项目集列表', 'zendao_call', { module: 'program', action: 'list', recPerPage: 3 }, false],
  ['Bug 列表', 'zendao_list_bugs', { productID: 2000076, limit: 3 }, false],
  ['我的 Bug 列表', 'zendao_list_my_bugs', { limit: 3 }, false],

  // ── 新增只读验收（2026-09-18，靶子：项目 2000546 / 影子产品 2000076 / 其执行 2000547）──
  // ⚠️ 全程零写操作；错误路径只用「缺必填 / 版本门槛 / 不存在的模块・动作・对象」触发。
  ['项目列表（browseType=all）', 'zendao_call', { module: 'project', action: 'list', params: { browseType: 'all' }, recPerPage: 3 }, false],
  ['执行详情（靶子项目的执行）', 'zendao_call', { module: 'execution', action: 'get', params: { id: 2000547 } }, false],
  ['不存在的执行应报错', 'zendao_call', { module: 'execution', action: 'get', params: { id: 99999999 } }, true],
  ['project/get 不存在（该模块确实没有 get 动作）', 'zendao_call', { module: 'project', action: 'get' }, true],
  ['任务列表（替代已收敛的 zendao_list_tasks）', 'zendao_call', { module: 'task', action: 'list', params: { executionID: 2000547 }, recPerPage: 2 }, false],
  ['项目范围查 Bug（靶子项目 2000546）', 'zendao_call', { module: 'bug', action: 'list', params: { projectID: 2000546 }, recPerPage: 2 }, false],
  ['官方 /users 路径（部分实例 404，必须给明确错误）', 'zendao_call', { module: 'user', action: 'list' }, true],
  ['Bug 详情 + pick', 'zendao_call', { module: 'bug', action: 'get', params: { id: 2010523 }, pick: 'id,title,status,pri' }, false],
  ['不存在的 Bug 应报错', 'zendao_call', { module: 'bug', action: 'get', params: { id: 99999999 } }, true],
  // ⭐ 参数语义（P1 修正点）：单条动作会忽略 filter，必须给出告警而不是静默丢掉
  ['单条动作传 filter 应给出「已忽略」告警', 'zendao_call', { module: 'bug', action: 'get', params: { id: 2010523 }, filter: 'status=active' }, false],
  // ⭐ 串内逗号 = AND；数组元素 = OR —— 两种写法各验一次
  ['filter：串内逗号 = AND + limit', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, filter: 'status=active,pri<=2', limit: 2 }, false],
  ['filter：数组元素 = OR', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, filter: ['status=active', 'pri<=2'], limit: 2 }, false],
  ['search：默认搜全部字段', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, search: '登录', limit: 2 }, false],
  ['search + searchFields 限定字段', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, search: '登录', searchFields: ['title'], limit: 2 }, false],
  ['search：数组元素 = OR', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, search: ['登录', '导出'], limit: 2 }, false],
  ['本地排序 sort', 'zendao_call', { module: 'bug', action: 'list', params: { productID: 2000076 }, sort: 'id_asc', limit: 2 }, false],
  ['动作参数表（project/list）', 'zendao_help', { module: 'project', action: 'list' }, false],
  ['用户字典（limit 3）', 'zendao_list_users', { limit: 3 }, false],
];

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lines = [];
  const say = (s = '') => {
    lines.push(String(s));
    if (!opts.quiet) process.stderr.write(String(s) + '\n');
  };

  if (!fs.existsSync(SERVER_ENTRY)) {
    say(`❌ 找不到 ${path.relative(PROJECT_ROOT, SERVER_ENTRY)}，请先执行 npm run build`);
    process.exit(1);
  }

  const env = loadEnv();
  const sdkDir = path.join(PROJECT_ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
  if (!fs.existsSync(sdkDir)) {
    say('❌ 找不到 @modelcontextprotocol/sdk，请先 npm install');
    process.exit(1);
  }
  const { Client } = await import(pathToFileURL(path.join(sdkDir, 'client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkDir, 'client/stdio.js')).href);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verify-tools-live', version: '1.0.0' }, { capabilities: {} });

  say('# MCP 工具真机验收');
  say('');
  say(`- 时间：${new Date().toISOString()}`);
  say(`- 服务入口：${path.relative(PROJECT_ROOT, SERVER_ENTRY)}`);
  say(`- 站点：${env.ZENTAO_BASE_URL || '(未配置)'}　账号：${env.ZENTAO_ACCOUNT || '(未配置)'}`);
  say('');

  await client.connect(transport);

  // ---- 1. tools/list ----
  const { tools } = await client.listTools();
  const missingSchema = tools.filter((t) => !t.outputSchema);
  say(`## 1. 工具清单（${tools.length} 个）`);
  say('');
  for (const t of tools) {
    const outKeys = t.outputSchema?.properties ? Object.keys(t.outputSchema.properties).join(',') : '—';
    say(`- \`${t.name}\`　outputSchema: ${outKeys}`);
  }
  say('');
  say(
    `字段覆盖检查：${missingSchema.length === 0 ? '✅ 所有工具都声明了 outputSchema' : `❌ 缺 outputSchema：${missingSchema.map((t) => t.name).join(', ')}`}`
  );
  say('');

  if (opts.listOnly) {
    await client.close();
    return emit(lines, opts, say);
  }

  // ---- 2. 用例 ----
  const cases = [];
  if (opts.smoke) cases.push(...SMOKE_CASES);
  for (const raw of opts.calls) {
    const idx = raw.indexOf(':');
    const name = idx === -1 ? raw : raw.slice(0, idx);
    const argsText = idx === -1 ? '{}' : raw.slice(idx + 1);
    let args;
    try {
      args = JSON.parse(argsText);
    } catch (e) {
      say(`❌ --call 的参数不是合法 JSON：${argsText}`);
      process.exit(1);
    }
    cases.push([`自定义调用 ${name}`, name, args, false]);
  }

  say(`## 2. 调用验收（${cases.length} 个用例）`);
  say('');

  let pass = 0;
  let unexpected = 0;
  let protocolErrors = 0;

  for (const [label, name, args, expectError] of cases) {
    say(`### ${label}`);
    say('');
    say('```');
    say(`${name} ${JSON.stringify(args)}`);
    try {
      const r = await client.callTool({ name, arguments: args });
      const sc = r.structuredContent || {};
      const text = (r.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const head = text.split('\n').slice(0, 6).join('\n');

      say(`structuredContent 顶层键: ${Object.keys(sc).join(', ') || '(无)'}`);
      say(`isError: ${r.isError === true}　期望错误分支: ${expectError}`);
      say('— 文本（前 6 行）—');
      say(head);

      const asExpected = (r.isError === true) === expectError;
      if (asExpected) {
        pass++;
        say(`✅ 符合预期`);
      } else {
        unexpected++;
        say(`❌ 与预期不符`);
      }
    } catch (e) {
      // 协议级错误：只有「故意传非法枚举」才算预期
      if (expectError) {
        pass++;
        say(`✅ 入参被拒（预期）：${String(e.message).split('\n')[0].slice(0, 160)}`);
      } else {
        protocolErrors++;
        unexpected++;
        say(`❌ 协议级错误（最可能是 outputSchema 的 ajv 校验失败）`);
        say(`   code: ${e.code}  message: ${String(e.message).slice(0, 500)}`);
        if (e.data) say(`   data: ${JSON.stringify(e.data).slice(0, 500)}`);
      }
    }
    say('```');
    say('');
  }

  // ---- 3. 汇总 ----
  say('## 3. 汇总');
  say('');
  say(`- 用例：**${cases.length}**　符合预期：**${pass}**　不符：**${unexpected}**`);
  say(`- 其中协议级错误（schema / 参数校验）：**${protocolErrors}**`);
  say('');
  if (unexpected === 0) {
    say('✅ 全部通过。`structuredContent` 与 `outputSchema` 一致，无 InvalidParams。');
  } else if (protocolErrors > 0) {
    say(
      '❌ 存在协议级错误 —— 这类**不是**业务问题，而是 schema 与返回不一致：\n' +
        '   检查对应工具的 `outputSchema` 是否漏声明了实际返回的顶层键。\n' +
        '   惯例：详情类一律用单键容器 `{ <资源>: z.any() }`，不要写字段白名单。'
    );
  } else {
    say('⚠️ 有用例与预期不符。若默认用例里的对象 ID 已被删除，属「数据过期」，换个 ID 重跑即可。');
  }

  await client.close();
  return emit(lines, opts, say);
}

/** 把报告写盘 / 打到 stdout */
function emit(lines, opts, say) {
  const text = lines.join('\n');
  if (opts.out) {
    const target = path.resolve(PROJECT_ROOT, opts.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    say(`\n✅ 报告已写入 ${opts.out}`);
  }
  if (opts.json) {
    fs.writeFileSync(path.resolve(PROJECT_ROOT, opts.json), JSON.stringify({ lines }, null, 2), 'utf8');
  }
  if (!opts.out) process.stdout.write(text);
}

main().catch((e) => {
  process.stderr.write(`探针失败：${e?.stack || e}\n`);
  process.exit(1);
});
