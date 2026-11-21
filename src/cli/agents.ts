/**
 * Agent 配置注册表。
 *
 * 每个 agent 的 MCP 配置文件位置、顶层键、作用域支持都不同。这里集中声明，
 * init 命令只依赖这张表，不散落 if/else。路径参考各厂商文档，并在 2026-11-21
 * 于本机逐个核对过存在性。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 发布到 npm 的包名，也是写进各 agent 配置的入口 */
export const PACKAGE_NAME = '@michael-py001/zendao-mcp';
/** 在各 agent 配置里注册的名字 */
export const SERVER_NAME = 'zendao';

export type Scope = 'global' | 'project';
/** mcpServers / servers / mcp 是三种 JSON 根键；toml 是 Codex 专用 */
export type ConfigFormat = 'mcpServers' | 'servers' | 'mcp' | 'toml';

export interface AgentDef {
  id: string;
  name: string;
  /** 该 agent 支持哪些作用域 */
  scopes: Scope[];
  /** 按作用域算出配置文件绝对路径 */
  configPath: (scope: Scope, cwd: string) => string;
  /** 判断「装了这个 agent」要看哪些路径 */
  detect: (cwd: string) => string[];
  /** 写完之后给用户的额外提示 */
  note?: string;
}

const home = () => os.homedir();
const appData = () => process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(home(), '.config');

function claudeDesktopPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(appData(), 'Claude', 'claude_desktop_config.json');
    case 'darwin':
      return path.join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(xdgConfig(), 'Claude', 'claude_desktop_config.json');
  }
}

function vsCodeUserPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(appData(), 'Code', 'User', 'mcp.json');
    case 'darwin':
      return path.join(home(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    default:
      return path.join(xdgConfig(), 'Code', 'User', 'mcp.json');
  }
}

export const AGENTS: AgentDef[] = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    scopes: ['global'],
    configPath: () => path.join(home(), '.workbuddy', 'mcp.json'),
    detect: () => [path.join(home(), '.workbuddy', 'mcp.json'), path.join(home(), '.workbuddy')],
    note: '自定义 MCP 有信任门槛：写完后需在连接器中心右上角点「信任」才会生效',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      scope === 'global' ? path.join(home(), '.claude.json') : path.join(cwd, '.mcp.json'),
    // ~/.claude.json 还含登录态，只能改 mcpServers 一个键，不能整体重写
    detect: (cwd) => [path.join(home(), '.claude.json'), path.join(cwd, '.mcp.json')],
    note: '~/.claude.json 同时存放登录态，安装器只会改 mcpServers 键；项目级 .mcp.json 首次使用会弹确认',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    scopes: ['global'],
    configPath: () => claudeDesktopPath(),
    detect: () => [claudeDesktopPath()],
    note: 'Windows 上若 npx 启动失败，把 command 改成 cmd、args 前面加 /c',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      path.join(scope === 'global' ? home() : cwd, '.cursor', 'mcp.json'),
    detect: (cwd) => [path.join(home(), '.cursor', 'mcp.json'), path.join(cwd, '.cursor', 'mcp.json')],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    scopes: ['global'],
    configPath: () => path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'config.toml'),
    detect: () => [path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'config.toml')],
    note: 'Codex 配置是 TOML：[mcp_servers.zendao]；项目级配置只对已信任目录生效，故只装用户级',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      scope === 'global'
        ? path.join(xdgConfig(), 'opencode', 'opencode.json')
        : path.join(cwd, 'opencode.json'),
    detect: (cwd) => [
      path.join(xdgConfig(), 'opencode', 'opencode.json'),
      path.join(cwd, 'opencode.json'),
      path.join(cwd, '.opencode', 'opencode.json'),
    ],
    note: 'OpenCode 的顶层键是 mcp，命令是数组形式',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      path.join(
        scope === 'global' ? process.env.GEMINI_CLI_HOME || home() : cwd,
        '.gemini',
        'settings.json'
      ),
    detect: (cwd) => [
      path.join(home(), '.gemini', 'settings.json'),
      path.join(cwd, '.gemini', 'settings.json'),
    ],
  },
  {
    id: 'vscode',
    name: 'VS Code / Copilot',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      scope === 'global' ? vsCodeUserPath() : path.join(cwd, '.vscode', 'mcp.json'),
    detect: (cwd) => [vsCodeUserPath(), path.join(cwd, '.vscode', 'mcp.json')],
    note: 'VS Code 自己的格式用 servers 根键，且 stdio 条目必须带 type: "stdio"',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      scope === 'global'
        ? path.join(home(), '.codeium', 'windsurf', 'mcp_config.json')
        : path.join(cwd, '.windsurf', 'mcp.json'),
    detect: (cwd) => [
      path.join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
      path.join(home(), '.config', 'devin', 'mcp_config.json'),
      path.join(cwd, '.windsurf', 'mcp.json'),
    ],
  },
];

/** agent 的 MCP 配置根键 */
export function configFormat(agent: AgentDef): ConfigFormat {
  if (agent.id === 'codex') return 'toml';
  if (agent.id === 'vscode') return 'servers';
  if (agent.id === 'opencode') return 'mcp';
  return 'mcpServers';
}

/** 写进 agent 配置的服务器条目，不含任何凭证 */
export function serverEntry(format: ConfigFormat): Record<string, unknown> {
  const command = 'npx';
  const args = ['-y', PACKAGE_NAME, 'serve'];
  switch (format) {
    case 'servers':
      return { type: 'stdio', command, args };
    case 'mcp':
      return { type: 'local', command: [command, ...args], enabled: true };
    default:
      return { command, args };
  }
}

/** 按「配置文件/目录是否存在」判断本机装了哪些 agent */
export function detectInstalled(cwd: string, scope: Scope): AgentDef[] {
  return AGENTS.filter(
    (agent) =>
      agent.scopes.includes(scope) &&
      agent.detect(cwd).some((p) => fs.existsSync(p))
  );
}
