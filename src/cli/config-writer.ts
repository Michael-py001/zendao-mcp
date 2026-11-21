/**
 * Agent 配置文件写入器。
 *
 * 三条底线：
 * 1. 只动自己那个键，绝不整体重写 —— ~/.claude.json 里还有登录态；
 * 2. 写前备份、同目录临时文件原子替换 —— 配置文件写坏了 agent 会静默失效；
 * 3. 用 jsonc-parser 做保留注释的定点修改 —— Trae / CodeBuddy / Cline
 *    的配置允许注释和尾随逗号，JSON.stringify 整表重写会把它们全毁掉。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';
import {
  AgentDef,
  ConfigFormat,
  ManualAgent,
  Scope,
  SERVER_ENV_KEYS,
  SERVER_NAME,
  configFormat,
  manualInstruction,
  rootKey,
  serverEntry,
} from './agents';

export type WriteStatus = 'created' | 'updated' | 'unchanged' | 'failed' | 'manual';

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
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const first = errors[0];
    throw new ConfigWriteError(
      `文件内容不是合法 JSON/JSONC（${printParseErrorCode(first.error)}，偏移 ${first.offset}）`,
      filePath
    );
  }
  if (parsed === undefined && !text.trim()) return {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigWriteError('顶层不是 JSON 对象', filePath);
  }
  return parsed as Record<string, any>;
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

  if (text === null) {
    commit(filePath, `${JSON.stringify({ [rootKey]: { [SERVER_NAME]: entry } }, null, 2)}\n`, dryRun);
    return 'created';
  }

  // 定点修改：保留原有注释、尾随逗号、缩进风格和其他人的配置
  const edits = modify(text, [rootKey, SERVER_NAME], entry, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  commit(filePath, applyEdits(text, edits), dryRun);
  return 'updated';
}

/**
 * Codex 是 TOML，顶层表叫 [mcp_servers]，不是 mcpServers。
 * 只做「整段替换 / 末尾追加」，不引入 TOML 解析器 —— 我们只写一个固定条目。
 */
function tomlSectionRe(): RegExp {
  return new RegExp(`^\\[mcp_servers\\.${SERVER_NAME.replace(/-/g, '\\-')}\\]\\s*$`, 'm');
}

function writeToml(
  filePath: string,
  entry: Record<string, unknown>,
  dryRun: boolean
): WriteStatus {
  const text = readText(filePath) ?? '';
  const command = String(entry.command);
  const args = Array.isArray(entry.args) ? entry.args : [];
  const env = entry.env && typeof entry.env === 'object' ? (entry.env as Record<string, unknown>) : undefined;
  const envLine = env
    ? `env = { ${Object.entries(env)
        .map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`)
        .join(', ')} }`
    : '';
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(String(a))).join(', ')}]`,
    ...(envLine ? [envLine] : []),
    '',
  ].join('\n');

  const start = text.search(tomlSectionRe());
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
  if (format === 'toml') return tomlSectionRe().test(text);
  const data = parseJson(text, filePath);
  const root = data[rootKey(format)];
  return !!(root && typeof root === 'object' && root[SERVER_NAME]);
}

/** 条目在，但 env 三件套缺一不可 —— doctor 用 */
export function hasCompleteEnv(agent: AgentDef, scope: Scope, cwd: string): boolean {
  const filePath = agent.configPath(scope, cwd);
  const text = readText(filePath);
  if (text === null) return false;
  if (configFormat(agent) === 'toml') {
    return SERVER_ENV_KEYS.every((key) => new RegExp(`\\b${key}\\s*=`).test(text));
  }
  const data = parseJson(text, filePath);
  const entry = data[rootKey(configFormat(agent))]?.[SERVER_NAME];
  const env = entry?.env;
  return !!env && SERVER_ENV_KEYS.every((key) => !!env[key]);
}

/**
 * 自动写入类与手工指引类走同一个出口，调用方不必再分支。
 * 手工类返回 status='manual'，不算失败，但也不会碰任何文件。
 */
export function writeAgentConfig(
  agent: AgentDef | ManualAgent,
  scope: Scope,
  cwd: string,
  dryRun: boolean,
  env?: Record<string, unknown>
): WriteOutcome {
  if (!('configPath' in agent)) {
    return {
      agent: agent.name,
      path: '(手工配置)',
      status: 'manual',
      detail: manualInstruction(agent.name),
    };
  }

  const filePath = agent.configPath(scope, cwd);
  try {
    const format = configFormat(agent);
    const entry = serverEntry(format, agent.entryExtra, env);
    const status =
      format === 'toml'
        ? writeToml(filePath, entry, dryRun)
        : writeJson(filePath, rootKey(format), entry, dryRun);
    return { agent: agent.name, path: filePath, status };
  } catch (error: any) {
    return { agent: agent.name, path: filePath, status: 'failed', detail: error.message };
  }
}
