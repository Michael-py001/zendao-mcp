/**
 * Agent 配置文件写入器。
 *
 * 三条底线：
 * 1. 只动自己那个键，绝不整体重写 —— ~/.claude.json 里还有登录态；
 * 2. 写前备份、同目录临时文件原子替换 —— 配置文件写坏了 agent 会静默失效；
 * 3. JSON 解析失败就报错退出，不做正则瞎改 —— JSONC 注释没法安全保留。
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentDef, ConfigFormat, Scope, SERVER_NAME, configFormat, serverEntry } from './agents';

export type WriteStatus = 'created' | 'updated' | 'unchanged' | 'failed';

export interface WriteOutcome {
  agent: string;
  path: string;
  status: WriteStatus;
  detail?: string;
}

export class ConfigWriteError extends Error {
  constructor(message: string, readonly filePath: string) {
    super(`${filePath}: ${message}`);
    this.name = 'ConfigWriteError';
  }
}

function readText(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function parseJson(text: string, filePath: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层不是 JSON 对象');
    }
    return parsed as Record<string, any>;
  } catch (error: any) {
    const hint = /\/\/|\/\*/.test(text)
      ? '这个文件带注释（JSONC），标准 JSON 解析器无法安全保留注释；请先在编辑器里去掉注释后重试，或用 agent 自带界面添加'
      : '文件内容不是合法 JSON';
    throw new ConfigWriteError(`${hint}（${error.message}）`, filePath);
  }
}

function commit(filePath: string, text: string, dryRun: boolean): void {
  if (dryRun) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const backup = `${filePath}.bak.${Date.now()}`;
    fs.copyFileSync(filePath, backup);
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (error: any) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw new ConfigWriteError(`原子替换失败：${error.message}`, filePath);
  }
}

function writeJson(
  filePath: string,
  rootKey: string,
  entry: Record<string, unknown>,
  dryRun: boolean
): WriteStatus {
  const text = readText(filePath);
  const data = text === null ? {} : parseJson(text, filePath);
  const servers = data[rootKey];
  const before = servers && typeof servers === 'object' ? servers[SERVER_NAME] : undefined;

  if (JSON.stringify(before) === JSON.stringify(entry)) return 'unchanged';

  const next = { ...(servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {}) };
  next[SERVER_NAME] = entry;
  data[rootKey] = next;

  commit(filePath, `${JSON.stringify(data, null, 2)}\n`, dryRun);
  return text === null ? 'created' : 'updated';
}

/**
 * Codex 是 TOML，顶层表叫 [mcp_servers]，不是 mcpServers。
 * 只做「整段替换 / 末尾追加」，不引入 TOML 解析器 —— 我们只写一个固定条目。
 */
function writeToml(
  filePath: string,
  entry: Record<string, unknown>,
  dryRun: boolean
): WriteStatus {
  const text = readText(filePath) ?? '';
  const command = String(entry.command);
  const args = Array.isArray(entry.args) ? entry.args : [];
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(String(a))).join(', ')}]`,
    '',
  ].join('\n');

  const start = text.search(/^\[mcp_servers\.zendao\]\s*$/m);
  let next: string;
  if (start >= 0) {
    const after = text.slice(start).split('\n').slice(1);
    const endOffset = after.findIndex((line) => /^\[/.test(line));
    const body = endOffset < 0 ? '' : after.slice(endOffset).join('\n');
    next = `${text.slice(0, start)}${block}${body}`;
  } else {
    next = `${text.trimEnd()}\n\n${block}`;
  }
  if (next === text) return 'unchanged';

  commit(filePath, next, dryRun);
  return text.trim() === '' ? 'created' : 'updated';
}

/** 探测当前配置里是否已经装好这个 server（doctor 用） */
export function hasEntry(agent: AgentDef, scope: Scope, cwd: string): boolean {
  const filePath = agent.configPath(scope, cwd);
  const text = readText(filePath);
  if (text === null) return false;
  const format: ConfigFormat = configFormat(agent);
  if (format === 'toml') return /^\[mcp_servers\.zendao\]\s*$/m.test(text);
  const data = parseJson(text, filePath);
  const root = data[format === 'servers' ? 'servers' : format === 'mcp' ? 'mcp' : 'mcpServers'];
  return !!(root && typeof root === 'object' && root[SERVER_NAME]);
}

export function writeAgentConfig(
  agent: AgentDef,
  scope: Scope,
  cwd: string,
  dryRun: boolean
): WriteOutcome {
  const filePath = agent.configPath(scope, cwd);
  try {
    const format = configFormat(agent);
    const entry = serverEntry(format);
    const status =
      format === 'toml'
        ? writeToml(filePath, entry, dryRun)
        : writeJson(filePath, format, entry, dryRun);
    return { agent: agent.name, path: filePath, status };
  } catch (error: any) {
    return { agent: agent.name, path: filePath, status: 'failed', detail: error.message };
  }
}
