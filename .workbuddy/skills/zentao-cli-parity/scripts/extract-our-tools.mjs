#!/usr/bin/env node
/**
 * 从本项目 `src/tools/index.ts` 提取已注册的 MCP 工具清单。
 *
 * 用途：产出**本项目侧**的对照数据，与 `extract-official-modules.mjs`（官方侧）配对，
 * 用于生成 [docs/official-module-parity.md] 第三节「本项目工具 → 官方动作映射」。
 *
 * 与 `probe-mcp-tools.mjs` 的区别：
 *   - `probe-mcp-tools.mjs` 起**真客户端**看 `tools/list`，重点在 schema 覆盖与协议正确性；
 *   - 本脚本**纯静态解析源码**，不需要 build、不需要连禅道，输出的是
 *     `name / title / description / inputSchema / outputSchema / readOnly` 的速览表。
 *     适合做「工具数量对账」和写文档。
 *
 * ⚠️ 解析依赖 `src/tools/index.ts` 里 `server.registerTool('name', {...}, async ...)` 的书写格式。
 *    如果哪天注册风格变了（比如换成循环注册），本脚本会静默少抓 —— **务必核对总数**
 *    （当前应为 11；对不上就用 `npm run probe:tools` 交叉验证）。
 *
 * 用法：
 *   node extract-our-tools.mjs [src/tools/index.ts] [out.json]
 *   node extract-our-tools.mjs   # 默认取项目根的 src/tools/index.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const src = process.argv[2] || path.join(PROJECT_ROOT, 'src', 'tools', 'index.ts');
const out = process.argv[3] || '';

if (!fs.existsSync(src)) {
  console.error(`找不到 ${src} —— 请在项目根执行，或显式传第一个参数`);
  process.exit(1);
}

const text = fs.readFileSync(src, 'utf8');
const tools = [];

const re = /server\.registerTool\(\s*\n\s*'([a-z0-9_]+)'\s*,\s*\n\s*\{([\s\S]*?)\n\s*\}\s*,\s*\n\s*async/g;

for (const m of text.matchAll(re)) {
  const name = m[1];
  const body = m[2];
  const title = body.match(/title:\s*'((?:[^'\\]|\\.)*)'/)?.[1] ?? '';

  // description 通常是多段字符串用 + 拼接，把所有字面量接起来
  let desc = '';
  const descStart = body.indexOf('description:');
  if (descStart !== -1) {
    const chunk = body.slice(descStart, descStart + 2000);
    desc = [...chunk.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .map((x) => x[1])
      .join('')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tools.push({
    name,
    title,
    desc,
    inputSchema: body.match(/inputSchema:\s*(\w+)/)?.[1] ?? '(无)',
    outputSchema: body.match(/outputSchema:\s*(\w+)/)?.[1] ?? '(无)',
    readOnly: /annotations\(true,\s*false\)/.test(body),
  });
}

const result = { source: src, extractedAt: new Date().toISOString(), count: tools.length, tools };

if (out) {
  fs.mkdirSync(path.dirname(path.resolve(PROJECT_ROOT, out)), { recursive: true });
  fs.writeFileSync(path.resolve(PROJECT_ROOT, out), JSON.stringify(result, null, 2), 'utf8');
  console.log('written:', out);
} else {
  for (const t of tools) console.log(`${t.readOnly ? 'R' : 'W'}  ${t.name}  |  ${t.title}`);
}

const readOnly = tools.filter((t) => t.readOnly).length;
console.log(`tools=${tools.length} (readOnly=${readOnly} write=${tools.length - readOnly})`);
const EXPECTED_TOOL_COUNT = 11; // P1 工具收敛后：通用层 3 + 手写兜底 8
if (tools.length !== EXPECTED_TOOL_COUNT) {
  console.log(`⚠️ 期望 ${EXPECTED_TOOL_COUNT} 个工具，实际 ${tools.length} —— 若刚增删过工具请更新本脚本的期望值；否则可能是注册格式变了导致漏抓`);
}
