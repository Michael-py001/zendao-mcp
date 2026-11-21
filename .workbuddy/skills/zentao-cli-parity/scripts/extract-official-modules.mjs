#!/usr/bin/env node
/**
 * 官方「业务模块索引」提取器 —— **两种数据源**（P2-17 升级）
 *
 * 回答：「**官方到底有哪些模块、哪些动作、各自要求什么版本？**」
 * 这是对比文档 `docs/official-module-parity.md` 的「线 A + 线 B」数据来源。
 *
 * ## 两种模式
 *
 * | 模式 | 命令 | 数据源 | 要 clone 官方仓库？ |
 * | --- | --- | --- | --- |
 * | `sdk`（新，**推荐**） | `--sdk [--out=<json>]` | **`zentao-api` 的注册表**（`exportRegistry()`） | ❌ 不需要 |
 * | `md`（原有，保留做交叉验证） | `<command-reference.md> [out.json]` | 官方仓库的 `docs/command-reference.md` | ✅ 需要 |
 *
 * ### 为什么 sdk 模式是升级（P2-17）
 *
 * 1. **不需要 clone 官方仓库** —— 定义直接来自 npm 依赖 `zentao-api`，开箱即用。
 * 2. **与运行时同一份注册表** —— 含 SDK 内置的 `override.js` 补丁（12 处），
 *    所以它反映的正是「工具层看得到的」定义，不会因为官方文档改写而漂移。
 * 3. **信息更全** —— 额外带上 `method` / `path` / `type`，
 *    这三样 **markdown 里根本没有**（md 只有动作名 + 版本门槛）。
 *
 * md 模式**保留**下来做**交叉验证**：两条独立路径都报 `26 / 229` 与 `106 / 123`，
 * 这个结论才敢信（2026-09-18 首次吻合，2026-09-20 SDK 内省再次吻合）。
 *
 * ⚠️ 官方仓库**不需要 `npm install`** —— CLI 自身已不维护本地模块注册表，
 *    模块定义来自外部 `zentao-api` SDK。
 *
 * ## 用法
 *
 *   node extract-official-modules.mjs --sdk                      # SDK 内省 → stdout
 *   node extract-official-modules.mjs --sdk --out=.workbuddy/tmp/official-modules-sdk.json
 *   node extract-official-modules.mjs --sdk --compare=.workbuddy/tmp/official-modules.json
 *   node extract-official-modules.mjs D:/…/command-reference.md .workbuddy/tmp/official-modules.json
 *
 * ## 输出结构（两种模式统一，schemaVersion 2）
 *
 *   { schemaVersion, mode, source, extractedAt, moduleCount, actionCount,
 *     gate: { max80, max85, unknown, noMaxLine },
 *     summary: [{ name, display, count }],
 *     modules: [{ name, display, actions: [
 *        { action, title, versions: { open?, biz?, max?, ipd? }, minVersion: [...],
 *          method?, path?, type?,          // 仅 sdk 模式
 *          line? }                         // 仅 md 模式
 *     ]}]}
 *
 * 版本门槛口径：以 **`max` 产品线**为准（本项目目标实例是 MAX8.2）。
 *   `max8.0` → 本实例可过；`max8.5` → 被拒。合计 106 / 123 与
 *   `probe-official-cli.mjs` 的「123 个被拒」精确吻合。
 *   ⚠️ `22.0`（无字母前缀）是**开源版**那条线，本提取器记作 `open`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ---------------------------------------------------------------- 参数
const opts = { mode: null, out: '', compare: '', mdPath: '', json: false };
const positionals = [];

for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
  if (m) {
    if (m[1] === 'sdk') opts.mode = 'sdk';
    else if (m[1] === 'md') opts.mode = 'md';
    else if (m[1] === 'from') opts.mode = String(m[2]).trim() === 'md' ? 'md' : 'sdk';
    else if (m[1] === 'out') opts.out = m[2] || '';
    else if (m[1] === 'compare') opts.compare = m[2] || '';
    else if (m[1] === 'json') opts.json = true;
    continue;
  }
  positionals.push(arg);
}
opts.mdPath = positionals[0] || '';
if (!opts.out && positionals[1]) opts.out = positionals[1];

// 模式推断：显式 --sdk/--from=sdk 优先；给了 md 路径 → md；否则默认 sdk
if (!opts.mode) opts.mode = opts.mdPath ? 'md' : 'sdk';

// -------------------------------------------------------------- 版本解析
/**
 * 解析一条 `minVersion` 项：`max8.0` → `{edition:'max',version:'8.0'}`；
 * `22.0`（无字母前缀）→ `{edition:'open',version:'22.0'}`。
 */
function parseMinVersionEntry(raw) {
  const m = String(raw).trim().match(/^([a-zA-Z]*)(\d+(?:\.\d+)*)$/);
  if (!m) return null;
  return { edition: m[1] ? m[1].toLowerCase() : 'open', version: m[2] };
}

/** `['22.0','biz13.0','max8.0','ipd5.0']` → `{open:'22.0',biz:'13.0',max:'8.0',ipd:'5.0'}` */
function toVersionsDict(list) {
  const out = {};
  for (const raw of list || []) {
    const p = parseMinVersionEntry(raw);
    if (p) out[p.edition] = p.version;
  }
  return out;
}

/**
 * 统计版本门槛。口径以 `max` 产品线为准：
 * `max8.0` = 本实例（MAX8.2）可过；`max8.5` = 被拒。
 */
function computeGate(modules) {
  const gate = { max80: 0, max85: 0, unknown: 0, noMaxLine: 0 };
  for (const mod of modules) {
    for (const act of mod.actions) {
      const max = act.versions ? act.versions.max : undefined;
      if (!max) gate.noMaxLine++;
      else if (max === '8.0') gate.max80++;
      else if (max === '8.5') gate.max85++;
      else gate.unknown++;
    }
  }
  return gate;
}

/** 统一封装结果骨架 */
function buildResult(mode, source, modules) {
  return {
    schemaVersion: 2,
    mode,
    source,
    extractedAt: new Date().toISOString(),
    moduleCount: modules.length,
    actionCount: modules.reduce((n, m) => n + m.actions.length, 0),
    gate: computeGate(modules),
    summary: modules.map((m) => ({ name: m.name, display: m.display, count: m.actions.length })),
    modules,
  };
}

// ------------------------------------------------------------- 源 1：MD
function extractFromMarkdown(src) {
  if (!fs.existsSync(src)) {
    console.error(`找不到文件: ${src}`);
    console.error('提示：先 clone 官方仓库（https://github.com/easysoft/zentao-cli）取 docs/command-reference.md，');
    console.error('      或直接用 `--sdk` 模式（不需要官方仓库）。');
    process.exit(1);
  }

  const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*业务模块索引/.test(l));
  if (start === -1) {
    if (/\.json$/i.test(src)) {
      throw new Error(
        `${src} 是 JSON，不是官方 markdown —— 想比对两份结果请用 --compare=<file.json>；` +
          '想从 SDK 注册表取数请用 --sdk。'
      );
    }
    throw new Error('未找到「业务模块索引」章节 —— 官方文档结构可能变了');
  }

  const modules = [];
  let cur = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];

    // 章节结束：下一个二级标题（业务模块索引是最后一个大章节，一般走不到这里）
    if (/^##\s+/.test(line)) break;

    // 模块标题：### user · 用户
    const mMod = line.match(/^###\s+([a-zA-Z0-9_]+)\s*·\s*(.+?)\s*$/);
    if (mMod) {
      cur = { name: mMod[1], display: mMod[2], actions: [] };
      modules.push(cur);
      continue;
    }

    // 动作标题：#### `zentao user list` · 获取用户列表
    const mAct = line.match(/^####\s+`zentao\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)`\s*·\s*(.+?)\s*$/);
    if (mAct && cur) {
      const rawVersions = [];
      // 紧随其后找「最低禅道版本：`22.0` / `biz13.0` / `max8.0` / `ipd5.0`。」
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const vline = lines[j].match(/最低禅道版本[：:]\s*(.+?)。?\s*$/);
        if (vline) {
          for (const part of vline[1].split('/')) {
            const mm = part.match(/`([a-zA-Z]*[\d.]+)`/);
            if (mm) rawVersions.push(mm[1]);
          }
          break;
        }
        if (/^#{2,4}\s/.test(lines[j])) break;
      }
      cur.actions.push({
        action: mAct[2],
        title: mAct[3],
        versions: toVersionsDict(rawVersions),
        minVersion: rawVersions,
        line: i + 1,
      });
    }
  }

  return buildResult('md', src, modules);
}

// ------------------------------------------------------------ 源 2：SDK
async function extractFromSdk() {
  const sdk = await import('zentao-api');
  if (typeof sdk.exportRegistry !== 'function') {
    throw new Error('zentao-api 未导出 exportRegistry —— SDK 版本可能变了');
  }

  // exportRegistry() 默认已把 requestBody 拍平为 bodyParams 且移除函数属性；
  // 这里只取我们要的字段，避免把 183KB 定义整份写进报告。
  const registry = sdk.exportRegistry();

  const modules = Object.keys(registry).map((key) => {
    const def = registry[key] || {};
    const actions = (def.actions || []).map((act) => {
      const minVersion = [...(act.minVersion || [])];
      return {
        action: String(act.name),
        title: act.display || act.description || '',
        versions: toVersionsDict(minVersion),
        minVersion,
        method: String(act.method || '').toUpperCase(),
        path: act.path || '',
        type: String(act.type || ''),
      };
    });
    return { name: def.name || key, display: def.display || def.name || key, actions };
  });

  const sdkVersion = sdk.VERSION ? String(sdk.VERSION) : 'unknown';
  return buildResult('sdk', `zentao-api@${sdkVersion} (exportRegistry)`, modules);
}

// ------------------------------------------------------ --compare 交叉验证
function loadResult(file) {
  if (!fs.existsSync(file)) {
    console.error(`--compare 找不到文件: ${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 对比两份提取结果。**只比两模式都有的字段**：
 * 模块名 / 动作名 / 版本门槛（`md` 没有 method/path/type，故不参与比较）。
 */
function compareResults(a, b) {
  const lines = [];
  const same =
    a.moduleCount === b.moduleCount && a.actionCount === b.actionCount ? '✅' : '❌';
  lines.push(
    `模块数 ${a.moduleCount} vs ${b.moduleCount} · 动作数 ${a.actionCount} vs ${b.actionCount}  ${same}`
  );

  const aMods = new Map(a.modules.map((m) => [m.name, m]));
  const bMods = new Map(b.modules.map((m) => [m.name, m]));
  const onlyA = [...aMods.keys()].filter((k) => !bMods.has(k));
  const onlyB = [...bMods.keys()].filter((k) => !aMods.has(k));
  if (onlyA.length) lines.push(`仅前者有模块: ${onlyA.join(', ')}`);
  if (onlyB.length) lines.push(`仅后者有模块: ${onlyB.join(', ')}`);

  const diffs = [];
  for (const [name, am] of aMods) {
    const bm = bMods.get(name);
    if (!bm) continue;
    const amActs = new Map(am.actions.map((x) => [x.action, x]));
    const bmActs = new Map(bm.actions.map((x) => [x.action, x]));
    for (const [actName, ax] of amActs) {
      const bx = bmActs.get(actName);
      if (!bx) {
        diffs.push(`${name}/${actName}: 仅前者有`);
        continue;
      }
      const av = JSON.stringify(ax.versions);
      const bv = JSON.stringify(bx.versions);
      if (av !== bv) diffs.push(`${name}/${actName}: 版本门槛 ${av} vs ${bv}`);
    }
    for (const actName of bmActs.keys()) {
      if (!amActs.has(actName)) diffs.push(`${name}/${actName}: 仅后者有`);
    }
  }

  lines.push(diffs.length === 0 ? '✅ 逐动作版本门槛完全一致' : `❌ ${diffs.length} 处差异：`);
  for (const d of diffs.slice(0, 40)) lines.push(`  - ${d}`);
  if (diffs.length > 40) lines.push(`  … 另有 ${diffs.length - 40} 处`);

  const aGate = computeGate(a.modules);
  const bGate = computeGate(b.modules);
  lines.push(
    `门槛统计（重算）：前者 max8.0=${aGate.max80} max8.5=${aGate.max85} 其他=${aGate.unknown} 无max线=${aGate.noMaxLine}` +
      ` ／ 后者 max8.0=${bGate.max80} max8.5=${bGate.max85} 其他=${bGate.unknown} 无max线=${bGate.noMaxLine}`
  );

  return { lines, identical: onlyA.length + onlyB.length + diffs.length === 0, diffCount: diffs.length };
}

// ------------------------------------------------------------------ main
const result = opts.mode === 'sdk' ? await extractFromSdk() : extractFromMarkdown(opts.mdPath);

if (opts.out) {
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), 'utf8');
  console.log('written:', opts.out);
} else {
  console.log(JSON.stringify(result, null, 2));
}

console.log(`mode=${result.mode} source=${result.source}`);
console.log(`modules=${result.moduleCount} actions=${result.actionCount}`);
console.log(
  `max8.0(本实例可过)=${result.gate.max80} max8.5(被拒)=${result.gate.max85} 其他=${result.gate.unknown}（其中无 max 线=${result.gate.noMaxLine}）`
);

if (opts.compare) {
  const other = loadResult(opts.compare);
  console.log(`\n=== 交叉验证：本结果(${result.mode}) vs ${opts.compare}(${other.mode || '?'}) ===`);
  const { lines, identical } = compareResults(result, other);
  for (const l of lines) console.log(l);
  if (!identical) process.exitCode = 2;
}
