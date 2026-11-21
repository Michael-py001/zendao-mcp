#!/usr/bin/env node
/**
 * 本项目 MCP 工具盘点探针
 *
 * 用宿主同款 SDK（@modelcontextprotocol/sdk 的 Client + StdioClientTransport）
 * 起一个真客户端连上 dist/index.js，走一次完整 MCP 握手后列出 tools/list。
 *
 * 注意：`scripts/verify-mcp.js` 是手写 JSON-RPC 探针，不做 ajv 校验；
 *      本脚本走真 SDK，能看到客户端实际能拿到的工具与 schema。
 *
 * 用法：
 *   npm run build
 *   node probe-mcp-tools.mjs
 *   node probe-mcp-tools.mjs --out=./tools.md
 *   node probe-mcp-tools.mjs --json=./tools.json
 *   node probe-mcp-tools.mjs --call=zendao_list_projects   # 附带调一次只读工具验证连通
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> zentao-cli-parity/ -> skills/ -> .workbuddy/ -> 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = { out: null, json: null, call: null, quiet: false };
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'out') opts.out = value;
    else if (key === 'json') opts.json = value;
    else if (key === 'call') opts.call = value;
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
        try { host = new URL(value).hostname; } catch { /* ignore */ }
      }
    }
  }
  const bypass = ['127.0.0.1', 'localhost', host].filter(Boolean).join(',');
  env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${bypass}` : bypass;
  return env;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const say = (s = '') => { if (!opts.quiet) process.stderr.write(s + '\n'); };

  if (!fs.existsSync(SERVER_ENTRY)) {
    process.stderr.write(`❌ 找不到 ${path.relative(PROJECT_ROOT, SERVER_ENTRY)}，请先执行 npm run build\n`);
    process.exit(1);
  }

  const env = loadEnv();

  // 动态解析 SDK 路径，避免脚本位置影响裸模块解析
  const require = createRequire(path.join(PROJECT_ROOT, 'package.json'));
  const clientEntry = require.resolve('@modelcontextprotocol/sdk/client/index.js');
  const stdioEntry = require.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  const { Client } = await import(pathToFileURL(clientEntry).href);
  const { StdioClientTransport } = await import(pathToFileURL(stdioEntry).href);

  say(`连接 ${path.relative(PROJECT_ROOT, SERVER_ENTRY)} ...`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: PROJECT_ROOT,
    env,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'zendao-parity-probe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const serverInfo = client.getServerVersion?.();
  const { tools } = await client.listTools();

  const lines = [];
  lines.push(`# zendao-mcp 工具清单\n`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 服务端：${serverInfo ? `${serverInfo.name} v${serverInfo.version}` : '(未知)'}`);
  lines.push(`- 工具总数：**${tools.length}**\n`);

  // 按前缀分组，方便和官方 CLI 的能力矩阵对照
  const groups = new Map();
  for (const tool of tools) {
    const key = tool.name.replace(/^zendao_/, '').split('_')[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tool);
  }

  lines.push(`## 分组概览\n`);
  lines.push('| 分组 | 数量 | 工具 |');
  lines.push('| --- | --- | --- |');
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of sorted) {
    lines.push(`| ${key} | ${list.length} | ${list.map(t => '`' + t.name + '`').join(' ')} |`);
  }
  lines.push('');

  lines.push(`## 明细\n`);
  for (const tool of tools) {
    const ann = tool.annotations || {};
    const tags = [];
    if (ann.readOnlyHint) tags.push('只读');
    if (ann.destructiveHint) tags.push('破坏性');
    if (tool.outputSchema) tags.push('有 outputSchema');
    const desc = String(tool.description || '').split('\n')[0].slice(0, 120);
    lines.push(`### \`${tool.name}\``);
    lines.push(`- ${desc}`);
    lines.push(`- 参数：${tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties).join(', ') || '(无)' : '(无)'}`);
    if (tags.length) lines.push(`- 标记：${tags.join(' / ')}`);
    lines.push('');
  }

  // 可选：调一个只读工具验证连通
  if (opts.call) {
    say(`调用 ${opts.call} ...`);
    lines.push(`## 连通性验证：\`${opts.call}\`\n`);
    try {
      const res = await client.callTool({ name: opts.call, arguments: {} });
      const preview = JSON.stringify(res.structuredContent ?? res.content, null, 2).slice(0, 2000);
      lines.push('```json');
      lines.push(preview);
      lines.push('```');
    } catch (err) {
      lines.push('调用失败：');
      lines.push('```');
      lines.push(String(err?.message || err));
      lines.push('```');
    }
    lines.push('');
  }

  await client.close();

  const text = lines.join('\n');
  if (opts.out) {
    fs.writeFileSync(path.resolve(PROJECT_ROOT, opts.out), text, 'utf8');
    say(`✅ 清单已写入 ${opts.out}（共 ${tools.length} 个工具）`);
  }
  if (opts.json) {
    fs.writeFileSync(path.resolve(PROJECT_ROOT, opts.json), JSON.stringify({ tools }, null, 2), 'utf8');
    say(`✅ JSON 已写入 ${opts.json}`);
  }
  if (!opts.out && !opts.json) process.stdout.write(text);
}

main().catch(err => {
  process.stderr.write(`\n❌ 探针失败：${err?.stack || err}\n`);
  process.exit(1);
});
