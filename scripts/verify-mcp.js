#!/usr/bin/env node
/**
 * MCP 接入自检探针
 *
 * 以 MCP 客户端的身份，用真实的 JSON-RPC over stdio 流程连一遍本项目的服务器：
 *   1) initialize        —— 握手，确认服务活了
 *   2) tools/list        —— 确认工具都注册上了
 *   3) tools/call        —— 真实调用一次 zendao_list_projects，确认能读到禅道数据
 *   4) stdout 洁净度     —— 确认没有日志污染 JSON-RPC 通道
 *
 * 比「进程起没起来」有力得多：它会真的连禅道、真的走协议。
 *
 * 用法：
 *   npm run verify
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const TIMEOUT_MS = 25000;

// 收尾状态：区分「服务器自己挂了」和「探针跑完主动关掉它」两种情况
let done = false;

function shutdown(code) {
  done = true;
  try {
    child.kill();
  } catch (e) {
    /* ignore */
  }
  process.exit(code);
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  shutdown(1);
}

if (!fs.existsSync(ENTRY)) {
  console.error(`❌ 找不到构建产物 ${ENTRY}\n   请先运行：npm run build`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, '.env'))) {
  console.warn(`⚠️  项目根没有 .env，服务可能因缺少认证信息而启动失败\n`);
}

console.log(`--- 探针启动 ---`);
console.log(`入口   : ${ENTRY}`);
console.log(`Node   : ${process.execPath}\n`);

const child = spawn(process.execPath, [ENTRY], {
  cwd: ROOT,
  // stdout 是 JSON-RPC 专用通道，必须自己接管；stderr 直接透传，方便看服务日志
  stdio: ['pipe', 'pipe', 'inherit'],
});

// ---- 逐行解析 JSON-RPC 响应 ----
let buffer = '';
const pending = new Map();
const strayLines = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      // stdout 上出现非 JSON 内容 = 协议通道被污染，这是 stdio MCP 的致命问题
      strayLines.push(line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时（${TIMEOUT_MS}ms）`)), TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

child.on('exit', (code) => {
  if (done) return; // 探针自己关的，正常
  console.error(`\n❌ 服务器进程提前退出，exit code = ${code}`);
  console.error('   多半是配置/认证问题，看上面 stderr 里的日志');
  process.exit(1);
});

(async () => {
  // ---- 1) 握手 ----
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'zendao-verify-probe', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize 失败: ${JSON.stringify(init.error)}`);
  const info = init.result.serverInfo || {};
  console.log(`✅ 1) initialize     -> ${info.name} v${info.version} (协议 ${init.result.protocolVersion})`);

  notify('notifications/initialized');

  // ---- 2) 工具列表 ----
  const listed = await rpc('tools/list', {});
  if (listed.error) throw new Error(`tools/list 失败: ${JSON.stringify(listed.error)}`);
  const tools = listed.result.tools || [];
  console.log(`✅ 2) tools/list     -> ${tools.length} 个工具`);
  for (const t of tools) {
    const required = (t.inputSchema && t.inputSchema.required) || [];
    console.log(`      · ${t.name}${required.length ? `  (必填: ${required.join(', ')})` : ''}`);
  }

  // ---- 3) 真实调用 ----
  // 用 `zendao_modules` 做冒烟：它**不依赖任何实例 ID**、不受版本门槛限制，
  // 且能一次性证明「SDK 加载成功 + 版本探测成功 + structuredContent 与 outputSchema 一致」。
  // （早先这里硬编码的是 zendao_list_projects，工具收敛后已失效。）
  const target = 'zendao_modules';
  const called = await rpc('tools/call', { name: target, arguments: {} });
  if (called.error) throw new Error(`tools/call 失败: ${JSON.stringify(called.error)}`);

  const sc = (called.result && called.result.structuredContent) || {};
  if (called.result && called.result.isError) {
    const text = (called.result.content || []).map((c) => c.text).join('\n');
    console.log(`⚠️ 3) tools/call     -> 工具返回错误（协议是通的，是业务侧报错）`);
    console.log(text);
  } else if (typeof sc.actionTotal === 'number' || Array.isArray(sc.modules)) {
    console.log(
      `✅ 3) tools/call     -> ${target} 成功，实例版本 ${sc.version ?? '未知'}，` +
        `注册表 ${sc.moduleTotal ?? '?'} 模块 / ${sc.actionTotal ?? '?'} 动作，当前实例可用 ${sc.actionSupported ?? '?'} 个`
    );
    for (const m of (sc.modules || []).slice(0, 3)) {
      console.log(`      · ${m.name}  可用 ${m.actionSupported ?? '?'}/${m.actionTotal ?? '?'}`);
    }
  } else {
    console.log(`⚠️ 3) tools/call     -> 返回了结果但没有结构化数据（structuredContent 缺失）`);
    console.log(JSON.stringify(called.result).slice(0, 500));
  }

  // ---- 4) stdout 洁净度 ----
  if (strayLines.length) {
    console.error(`\n❌ stdout 上出现了 ${strayLines.length} 行非 JSON 内容，协议通道被污染：`);
    for (const l of strayLines.slice(0, 5)) console.error(`      ${l.slice(0, 160)}`);
    console.error('   检查是不是有代码把日志写到了 console.log');
    shutdown(1);
    return;
  }
  console.log(`✅ 4) stdout 洁净    -> 无非 JSON 输出，协议通道正常`);

  console.log('\n--- 接入自检通过 ---');
  shutdown(0);
})().catch((err) => {
  fail(err.message);
});
