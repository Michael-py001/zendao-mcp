#!/usr/bin/env node
/**
 * 官方 zentao-cli 能力探针（只读）
 *
 * 做三件事：
 *   1. 取官方 CLI 版本 + 目标禅道服务器版本（`zentao version`）
 *   2. 抓取指定模块的 `--help`，解析出「操作 + 最低版本门槛」，
 *      再按服务器所属系列（开源 / biz / max / ipd）自动判定每个操作当前是否可用
 *   3. 跑几条只读列表查询，验证连通性（含「不带范围」的预期报错）
 *
 * ⚠️ 全程只读：只执行 version / --help / 列表查询，绝不写禅道数据。
 *    带凭据的调用会刷新 ~/.config/zentao/zentao.json 里的 Token —— 这是官方 CLI 的正常行为。
 *
 * 用法：
 *   node probe-official-cli.mjs
 *   node probe-official-cli.mjs --modules=bug,file,my,todo
 *   node probe-official-cli.mjs --modules=ALL --out=./report.md --json=./report.json
 *   node probe-official-cli.mjs --cli="npx -y zentao-cli@0.3.0"
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// 顶层 help 里这些不是业务模块（通用命令），解析时跳过
const NON_BUSINESS = new Set([
  'help', 'login', 'logout', 'profile', 'config', 'version', 'autocomplete',
  'ls', 'list', 'get', 'create', 'update', 'delete', 'do', 'upgrade',
]);
const DEFAULT_MODULES = ['bug', 'task', 'story', 'my', 'file', 'todo'];

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = { modules: DEFAULT_MODULES, out: null, json: null, cli: null, sampleProduct: null, quiet: false };
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'modules') opts.modules = value === 'ALL' ? 'ALL' : value.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'out') opts.out = value;
    else if (key === 'json') opts.json = value;
    else if (key === 'cli') opts.cli = value;
    else if (key === 'sample-product') opts.sampleProduct = value;
    else if (key === 'quiet') opts.quiet = true;
  }
  return opts;
}

// -------------------------------------------------------------- 环境准备

/** 读项目 .env，把 ZENTAO_* 映射成官方 CLI 认识的 ZENTAO_*（返回值不打印） */
function loadEnv() {
  const env = { ...process.env };
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envFile)) return { env, source: null };

  const map = {
    ZENTAO_BASE_URL: 'ZENTAO_URL',
    ZENTAO_ACCOUNT: 'ZENTAO_ACCOUNT',
    ZENTAO_PASSWORD: 'ZENTAO_PASSWORD',
  };
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && map[m[1]]) env[map[m[1]]] = m[2].replace(/^["']|["']$/g, '');
  }

  // 环境注入了 HTTP_PROXY，会让打内网/回环的请求走代理而失败 —— 显式放行目标主机
  let host = '';
  try {
    if (env.ZENTAO_URL) host = new URL(env.ZENTAO_URL).hostname;
  } catch { /* URL 不合法就忽略 */ }
  const bypass = ['127.0.0.1', 'localhost', host].filter(Boolean).join(',');
  env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${bypass}` : bypass;

  return { env, source: envFile };
}

/** 优先用本机已安装的 zentao，否则回落到 npx */
function resolveCli(opts, env) {
  if (opts.cli) {
    const parts = opts.cli.split(/\s+/);
    return { cmd: parts[0], pre: parts.slice(1) };
  }
  const probe = spawnSync('zentao', ['--version'], { encoding: 'utf8', shell: true, env, timeout: 30000 });
  const out = (probe.stdout || '').trim();
  if (probe.status === 0 && /^\d+\.\d+/.test(out)) {
    return { cmd: 'zentao', pre: [] };
  }
  return { cmd: 'npx', pre: ['-y', 'zentao-cli@latest'] };
}

// ---------------------------------------------------------------- 版本工具

/** 'MAX8.2' -> { series:'max', version:'8.2' }；'22.5' -> { series:'opensource', version:'22.5' } */
function parseServerVersion(raw) {
  const s = String(raw).trim();
  const m = s.match(/^(biz|max|ipd)?\s*(\d+(?:\.\d+)*)$/i);
  if (!m) return null;
  return {
    series: m[1] ? m[1].toLowerCase() : 'opensource',
    version: m[2],
    raw: s,
  };
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 解析 "（最低版本：22.0 / biz13.0 / max8.0 / ipd5.0）" */
function parseMinVersions(text) {
  const m = text.match(/（最低版本：([^）]+)）/);
  if (!m) return null;
  const out = { opensource: null, biz: null, max: null, ipd: null };
  for (const part of m[1].split('/').map(s => s.trim())) {
    if (/^biz/i.test(part)) out.biz = part.replace(/^biz/i, '');
    else if (/^max/i.test(part)) out.max = part.replace(/^max/i, '');
    else if (/^ipd/i.test(part)) out.ipd = part.replace(/^ipd/i, '');
    else out.opensource = part;
  }
  return out;
}

/** 按服务器所属系列判定某个门槛是否满足 */
function checkSupport(server, min) {
  if (!server) return { ok: null, want: null, reason: '未识别服务器版本' };
  if (!min) return { ok: true, want: null, reason: '无门槛声明' };
  const want = min[server.series];
  if (!want) return { ok: true, want: null, reason: `${server.series} 系列无门槛` };
  return {
    ok: cmpVersion(server.version, want) >= 0,
    want,
    reason: `${server.series}${server.version} ${cmpVersion(server.version, want) >= 0 ? '>=' : '<'} ${server.series}${want}`,
  };
}

// ---------------------------------------------------------------- CLI 调用

function runCli(cli, args, env, timeout = 150000) {
  const r = spawnSync(cli.cmd, [...cli.pre, ...args], {
    encoding: 'utf8',
    shell: true,
    env,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    args: args.join(' '),
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// ------------------------------------------------------------ help 解析

/**
 * 从 `zentao <module> --help` 里抽出操作清单。
 * 只收集「操作:」「扩展操作:」段，遇到「上下文参数/公共选项/提示」即停止。
 */
function parseActions(helpText) {
  const lines = helpText.split(/\r?\n/);
  const actions = [];
  let collecting = false;

  for (const line of lines) {
    const t = line.trim();
    if (/^(操作|扩展操作):/.test(t)) { collecting = true; continue; }
    if (/^(上下文参数|公共选项|提示)/.test(t)) { collecting = false; continue; }
    if (!collecting || !t.startsWith('zentao ')) continue;

    // 形如 "zentao bug create [--key=value ...]    创建Bug（最低版本：...）"
    const rest = t.replace(/^zentao\s+\S+\s*/, '').trim();
    const [cmdPart = '', descPart = ''] = rest.split(/ {2,}/);

    let name;
    if (!cmdPart || cmdPart.startsWith('[选项]')) name = 'list';
    else if (cmdPart.startsWith('<id>')) name = 'get';
    else name = cmdPart.split(/\s+/)[0];

    actions.push({
      name,
      command: cmdPart.trim(),
      description: descPart.replace(/（最低版本：[^）]*）/, '').trim(),
      min: parseMinVersions(t),
    });
  }
  return actions;
}

/**
 * 从顶层 --help 抽出业务模块名。
 *
 * 顶层帮助里业务模块与通用命令混在一起，靠尾部结构区分：
 *   业务模块 → "  bug [options] [args...]           Bug模块 | 操作: ..."
 *   通用命令 → "  ls|list [options] <module> [args...]" / "  upgrade [options]"
 * 所以要求 `[options]` 后面紧跟 `[args...]`（后面允许再跟描述文字）。
 */
function parseModules(helpText) {
  const mods = [];
  for (const line of helpText.split(/\r?\n/)) {
    const m = line.match(/^\s{2}([a-z][a-z0-9]*)(?:\|[a-z0-9]+)?\s+\[options\]\s+\[args\.\.\.\]/i);
    if (m && !NON_BUSINESS.has(m[1])) mods.push(m[1]);
  }
  return mods;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { env, source } = loadEnv();
  const cli = resolveCli(opts, env);
  const cliLabel = [cli.cmd, ...cli.pre].join(' ');
  const lines = [];
  const report = { generatedAt: new Date().toISOString(), cli: cliLabel, probe: {} };

  const add = (s = '') => lines.push(s);
  const progress = (s) => { if (!opts.quiet) process.stderr.write(s + '\n'); };

  add(`# 官方 zentao-cli 能力探针报告\n`);
  add(`- 生成时间：${report.generatedAt}`);
  add(`- 调用方式：\`${cliLabel}\``);
  add(`- 凭据来源：${source ? `\`${path.relative(PROJECT_ROOT, source)}\`（映射为 ZENTAO_* 环境变量）` : '进程环境变量 / CLI 已有 profile'}\n`);

  // 1) 版本
  const ver = runCli(cli, ['version'], env);
  const serverLine = (ver.stdout || '').match(/Zentao Server:\s*(.+)/i);
  const serverRaw = serverLine ? serverLine[1].replace(/\s*\(.*\)\s*$/, '').trim() : '';
  const server = parseServerVersion(serverRaw);
  report.probe.cliOutput = ver.stdout.trim();
  report.probe.serverRaw = serverRaw;
  report.probe.server = server;

  add(`## 1. 版本\n`);
  add('```');
  add(ver.stdout.trim() || ver.stderr.trim() || '(空输出)');
  add('```\n');
  if (server) {
    add(`服务器所属系列：**${server.series}**，版本 \`${server.version}\`\n`);
  } else {
    add('⚠️ 未能从输出中识别服务器版本，后续可用性判定会全部跳过。\n');
  }

  // 2) 模块清单 + 门槛
  const help = runCli(cli, ['--help'], env);
  const allModules = parseModules(help.stdout);
  report.probe.modules = allModules;
  add(`## 2. 模块清单（共 ${allModules.length} 个业务模块）\n`);
  add(allModules.join(', ') + '\n');

  const modules = opts.modules === 'ALL' ? allModules : opts.modules;
  report.probe.analyzedModules = modules;

  add(`## 3. 版本门槛（本实例上是「能用」还是「拒绝」）\n`);
  add(`> 门槛取自各模块 \`--help\`，按服务器所属系列 \`${server ? server.series : '?'}\` 判定。\n`);

  const blocked = [];
  const allowed = [];
  report.probe.actions = {};

  for (const mod of modules) {
    const h = runCli(cli, [mod, '--help'], env);
    if (h.code !== 0 && !h.stdout) {
      add(`### \`${mod}\`\n`);
      add(`获取帮助失败：${(h.stderr || '').trim().split('\n')[0]}\n`);
      continue;
    }
    const actions = parseActions(h.stdout);
    report.probe.actions[mod] = actions;

    add(`### \`${mod}\`\n`);
    add('| 操作 | 最低版本 | 本实例 | 说明 |');
    add('| --- | --- | --- | --- |');
    for (const a of actions) {
      const s = checkSupport(server, a.min);
      const want = a.min ? a.min[server ? server.series : 'opensource'] ?? '—' : '—';
      const mark = s.ok === true ? '通过' : s.ok === false ? '**版本拒绝**' : '?';
      // ⚠️ 版本门槛通过 ≠ 真能跑通：update/delete 类操作走 PUT/DELETE，本实例会被前置服务器掐断
      const transportWarn = /^(update|delete)/i.test(a.name) ? ' ⚠️ 走 PUT/DELETE，本实例会被传输层掐断' : '';
      if (s.ok === false) blocked.push({ module: mod, action: a.name, raw: a.command, want, desc: a.description });
      else allowed.push({ module: mod, action: a.name, desc: a.description, transportBlocked: Boolean(transportWarn) });
      add(`| \`${a.name}\` | ${want === '—' ? '—' : server ? server.series + want : want} | ${mark} | ${a.description || ''}${transportWarn} |`);
    }
    add('');
  }

  // 3) 只读连通性实测
  add(`## 4. 只读连通性实测\n`);

  const list = runCli(cli, ['product', '--pick=id,name', '--limit=10'], env);
  add(`### \`zentao product --pick=id,name --limit=10\`\n`);
  add('```');
  add((list.stdout || list.stderr).trim().slice(0, 1500));
  add('```\n');

  // 取一个样本产品验证「已知范围」能查到（--sample-product 可指定影子产品做验证）
  const firstId = (list.stdout || '').match(/\|\s*(\d+)\s*\|/);
  const bid = opts.sampleProduct || (firstId ? firstId[1] : null);
  if (bid) {
    const b = runCli(cli, ['bug', '--product=' + bid, '--pick=id,title', '--limit=3'], env);
    add(`### \`zentao bug --product=${bid} --pick=id,title --limit=3\`\n`);
    add('```');
    add((b.stdout || b.stderr).trim().slice(0, 1200));
    add('```\n');
  }

  // 验证「不带范围」的行为
  const noScope = runCli(cli, ['bug', '--pick=id,title', '--limit=3'], env);
  add(`### \`zentao bug --pick=id,title --limit=3\`（不带范围）\n`);
  add('```');
  add(((noScope.stdout || '') + (noScope.stderr || '')).trim().slice(0, 800));
  add('```\n');

  // 4) 汇总
  add(`## 5. 汇总\n`);
  add(`- 在 ${server ? `${server.series}${server.version}` : '未知版本'} 上被**版本门槛拒绝**的操作：**${blocked.length}** 个`);
  for (const b of blocked.slice(0, 30)) {
    add(`  - \`${b.module} ${b.action}\` — 需要 ${server ? server.series : ''}${b.want}${b.desc ? '（' + b.desc + '）' : ''}`);
  }
  if (blocked.length > 30) add(`  - …另外 ${blocked.length - 30} 个`);

  const transportVictims = allowed.filter(a => a.transportBlocked);
  add(`\n- 版本门槛**通过**、但走 PUT/DELETE 会被本实例传输层掐断的操作：**${transportVictims.length}** 个`);
  for (const v of transportVictims) add(`  - \`${v.module} ${v.action}\``);
  add('');
  add(`> 「版本拒绝」是官方 CLI 主动报 E2010；「传输层掐断」是前置服务器直接 ECONNRESET。`);
  add(`> 两者的共同点是：**你都得绕开它**。详见 docs/vs-official-zentao-cli.md。`);
  add('');

  report.probe.blocked = blocked;
  report.probe.allowed = allowed;

  const text = lines.join('\n');
  if (opts.out) {
    const target = path.resolve(PROJECT_ROOT, opts.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    progress(`报告已写入 ${opts.out}`);
  }
  if (opts.json) {
    fs.writeFileSync(path.resolve(PROJECT_ROOT, opts.json), JSON.stringify(report, null, 2), 'utf8');
    progress(`JSON 已写入 ${opts.json}`);
  }
  if (!opts.out && !opts.json) process.stdout.write(text);
}

main();
