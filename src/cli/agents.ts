/**
 * Agent 配置注册表。
 *
 * 每个 agent 的 MCP 配置文件位置、顶层键、作用域支持都不同。这里集中声明，
 * init 命令只依赖这张表，不散落 if/else。
 *
 * 分两类：
 * - AGENTS：MCP 配置路径与格式已经核实，可以自动写入；
 * - MANUAL_AGENTS：来自 skills CLI（vercel-labs/skills）的 agent 名册，
 *   但只公开了 skills 目录、没有可靠的 MCP 配置格式 —— 显式选中时给出
 *   启动命令让用户手工添加，绝不猜路径写文件。
 *
 * 路径参考各厂商文档与公开的多客户端配置整理，并在 2026-11-21 于本机核对。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 发布到 npm 的包名，也是写进各 agent 配置的入口 */
export const PACKAGE_NAME = '@michael_py001/zendao-mcp';
/** 在各 agent 配置里注册的名字 */
export const SERVER_NAME = 'zentao-cli';
/** MCP 子命令（serve 仍保留为兼容别名） */
export const MCP_COMMAND = 'mcp';
/** 手工配置时给用户复制的启动命令 */
export const START_COMMAND = `npx -y ${PACKAGE_NAME} ${MCP_COMMAND}`;

/** env 里必须齐备的三个凭证字段 */
export const SERVER_ENV_KEYS = ['ZENTAO_URL', 'ZENTAO_ACCOUNT', 'ZENTAO_PASSWORD'] as const;

/** 写进 agent 配置 env 的凭证（与官方 zentao-cli 的字段名保持一致） */
export interface ServerEnv {
  ZENTAO_URL: string;
  ZENTAO_ACCOUNT: string;
  ZENTAO_PASSWORD: string;
}

export type Scope = 'global' | 'project';
/** 三种 JSON 根键（mcpServers / servers / context_servers）＋ Codex 的 TOML */
export type ConfigFormat = 'mcpServers' | 'servers' | 'mcp' | 'toml' | 'contextServers';

export interface AgentDef {
  id: string;
  name: string;
  /** 该 agent 支持哪些作用域 */
  scopes: Scope[];
  /** 按作用域算出配置文件绝对路径 */
  configPath: (scope: Scope, cwd: string) => string;
  /** 判断「装了这个 agent」要看哪些路径 */
  detect: (cwd: string) => string[];
  /** 不填则由 id 推断；显式声明优先 */
  format?: ConfigFormat;
  /** 某些宿主要求条目里附带额外字段，如 Cline 的 disabled / alwaysAllow */
  entryExtra?: Record<string, unknown>;
  /** 写完之后给用户的额外提示 */
  note?: string;
}

/** skills CLI 名单里的 agent：只提供手工配置指引 */
export interface ManualAgent {
  id: string;
  name: string;
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

/** VS Code 系扩展（Cline / Roo / Kilo）把 MCP 设置放在 globalStorage 里 */
function vsCodeGlobalStorage(extensionId: string, file: string): string {
  switch (process.platform) {
    case 'win32':
      return path.join(appData(), 'Code', 'User', 'globalStorage', extensionId, 'settings', file);
    case 'darwin':
      return path.join(
        home(),
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        extensionId,
        'settings',
        file
      );
    default:
      return path.join(xdgConfig(), 'Code', 'User', 'globalStorage', extensionId, 'settings', file);
  }
}

function zedSettingsPath(): string {
  return process.platform === 'win32'
    ? path.join(appData(), 'Zed', 'settings.json')
    : path.join(xdgConfig(), 'zed', 'settings.json');
}

function traeSettingsPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(appData(), 'Trae', 'User', 'mcp.json');
    case 'darwin':
      return path.join(home(), 'Library', 'Application Support', 'Trae', 'User', 'mcp.json');
    default:
      return path.join(xdgConfig(), 'Trae', 'User', 'mcp.json');
  }
}

/** 只检测「用户级配置所在目录」，不探测具体的 MCP 文件是否存在 */
const dir = (p: string) => path.dirname(p);

export const AGENTS: AgentDef[] = [
  // ── 原有 9 个 ────────────────────────────────────────────────────────────
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
    note: 'Codex 配置是 TOML：[mcp_servers.zentao-cli]；项目级配置只对已信任目录生效，故只装用户级',
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
    format: 'mcp',
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
    format: 'servers',
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

  // ── 新增：VS Code 系扩展 ─────────────────────────────────────────────────
  {
    id: 'cline',
    name: 'Cline',
    scopes: ['global'],
    configPath: () => vsCodeGlobalStorage('saoudrizwan.claude-dev', 'cline_mcp_settings.json'),
    detect: () => [dir(vsCodeGlobalStorage('saoudrizwan.claude-dev', 'cline_mcp_settings.json'))],
    entryExtra: { disabled: false, alwaysAllow: [] },
    note: 'Cline 的配置在 VS Code globalStorage 下；首次连接时需在 MCP 面板批准工具',
  },
  {
    id: 'roo',
    name: 'Roo Code',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      scope === 'global'
        ? vsCodeGlobalStorage('rooveterinaryinc.roo-cline', 'mcp_settings.json')
        : path.join(cwd, '.roo', 'mcp.json'),
    detect: (cwd) => [
      dir(vsCodeGlobalStorage('rooveterinaryinc.roo-cline', 'mcp_settings.json')),
      path.join(cwd, '.roo'),
    ],
    entryExtra: { disabled: false, alwaysAllow: [] },
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      scope === 'global'
        ? vsCodeGlobalStorage('kilocode.kilo-code', 'mcp_settings.json')
        : path.join(cwd, '.kilocode', 'mcp.json'),
    detect: (cwd) => [
      dir(vsCodeGlobalStorage('kilocode.kilo-code', 'mcp_settings.json')),
      path.join(cwd, '.kilocode'),
      path.join(xdgConfig(), 'kilo'),
    ],
    entryExtra: { disabled: false, alwaysAllow: [] },
    note: '新版 Kilo 也读 ~/.config/kilo/kilo.json（mcp 键）；若配置未生效，请在扩展面板里确认读取的是哪份',
  },

  // ── 新增：编辑器 / CLI ───────────────────────────────────────────────────
  {
    id: 'zed',
    name: 'Zed',
    scopes: ['global'],
    configPath: () => zedSettingsPath(),
    detect: () => [zedSettingsPath(), path.join(xdgConfig(), 'zed')],
    format: 'contextServers',
    note: 'Zed 用 context_servers 根键，不是 mcpServers',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot CLI',
    scopes: ['global'],
    configPath: () => path.join(home(), '.copilot', 'mcp-config.json'),
    detect: () => [path.join(home(), '.copilot')],
    note: 'Copilot 插件在 JetBrains / Xcode 里用的是另一份 mcp.json（servers 根键），本项只配 CLI',
  },
  {
    id: 'kiro-cli',
    name: 'Kiro CLI',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) => path.join(scope === 'global' ? home() : cwd, '.kiro', 'settings', 'mcp.json'),
    detect: (cwd) => [path.join(home(), '.kiro'), path.join(cwd, '.kiro')],
  },
  {
    id: 'continue',
    name: 'Continue',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) => path.join(scope === 'global' ? home() : cwd, '.continue', 'config.json'),
    detect: (cwd) => [path.join(home(), '.continue'), path.join(cwd, '.continue')],
    note: 'Continue 也接受 mcpServers 数组形式；安装器写入的是对象形式',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) => path.join(scope === 'global' ? home() : cwd, '.qwen', 'settings.json'),
    detect: (cwd) => [path.join(home(), '.qwen'), path.join(cwd, '.qwen')],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    scopes: ['global'],
    configPath: () => path.join(home(), '.gemini', 'antigravity', 'mcp_config.json'),
    detect: () => [path.join(home(), '.gemini', 'antigravity')],
  },
  {
    id: 'trae',
    name: 'Trae',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) => (scope === 'global' ? traeSettingsPath() : path.join(cwd, '.trae', 'mcp.json')),
    detect: (cwd) => [traeSettingsPath(), path.join(home(), '.trae'), path.join(cwd, '.trae')],
    note: '项目级 MCP 需要先在 Trae 设置里打开「项目级 MCP」开关',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      path.join(scope === 'global' ? path.join(home(), '.codebuddy') : cwd, '.mcp.json'),
    detect: (cwd) => [path.join(home(), '.codebuddy'), path.join(cwd, '.mcp.json')],
    entryExtra: { disabled: false },
    note: 'CodeBuddy 的配置通常是 JSONC；安装器会保留原有注释和尾随逗号',
  },
  {
    id: 'droid',
    name: 'Droid (Factory)',
    scopes: ['global'],
    configPath: () => path.join(home(), '.factory', 'mcp.json'),
    detect: () => [path.join(home(), '.factory')],
  },
  {
    id: 'augment',
    name: 'Augment Code',
    scopes: ['global'],
    configPath: () => path.join(home(), '.augment', 'settings.json'),
    detect: () => [path.join(home(), '.augment')],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    scopes: ['global', 'project'],
    configPath: (scope, cwd) =>
      path.join(scope === 'global' ? home() : cwd, '.qoder', 'settings.json'),
    detect: (cwd) => [path.join(home(), '.qoder'), path.join(cwd, '.qoder')],
    note: 'Qoder CN 请使用 -a qoder-cn（只提供手工指引）',
  },
  {
    id: 'devin',
    name: 'Devin CLI',
    scopes: ['global'],
    configPath: () => path.join(xdgConfig(), 'devin', 'mcp_config.json'),
    detect: () => [path.join(xdgConfig(), 'devin')],
  },
  {
    id: 'amp',
    name: 'Amp',
    scopes: ['global'],
    configPath: () => path.join(xdgConfig(), 'amp', 'settings.json'),
    detect: () => [path.join(xdgConfig(), 'amp')],
  },
];

/**
 * skills CLI（vercel-labs/skills v1.9.0）名单里的其余 agent。
 * 它们有公开的 skills 目录，但 MCP 配置格式没有可靠依据 —— 不自动写文件。
 */
export const MANUAL_AGENTS: ManualAgent[] = [
  { id: 'aider-desk', name: 'AiderDesk' },
  { id: 'antigravity-cli', name: 'Antigravity CLI' },
  { id: 'astrbot', name: 'AstrBot' },
  { id: 'autohand-code', name: 'Autohand Code CLI' },
  { id: 'bob', name: 'IBM Bob' },
  { id: 'openclaw', name: 'OpenClaw' },
  { id: 'dexto', name: 'Dexto' },
  { id: 'fx', name: 'fx' },
  { id: 'kimi-code-cli', name: 'Kimi Code CLI' },
  { id: 'loaf', name: 'Loaf' },
  { id: 'pi', name: 'Pi' },
  { id: 'sarvam-code', name: 'Sarvam Code' },
  { id: 'warp', name: 'Warp' },
  { id: 'codearts-agent', name: 'CodeArts Agent' },
  { id: 'codemaker', name: 'Codemaker' },
  { id: 'codestudio', name: 'Code Studio' },
  { id: 'command-code', name: 'Command Code' },
  { id: 'cortex', name: 'Cortex Code' },
  { id: 'crush', name: 'Crush' },
  { id: 'deepagents', name: 'Deep Agents' },
  { id: 'eve', name: 'Eve' },
  { id: 'firebender', name: 'Firebender' },
  { id: 'forgecode', name: 'ForgeCode' },
  { id: 'goose', name: 'Goose' },
  { id: 'grok', name: 'Grok Build' },
  { id: 'hermes-agent', name: 'Hermes Agent' },
  { id: 'inference-sh', name: 'inference.sh' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'junie', name: 'Junie' },
  { id: 'iflow-cli', name: 'iFlow CLI' },
  { id: 'kimchi', name: 'Kimchi' },
  { id: 'kode', name: 'Kode' },
  { id: 'lingma', name: 'Lingma / 通义灵码' },
  { id: 'mcpjam', name: 'MCPJam' },
  { id: 'minimax-code', name: 'MiniMax Code' },
  { id: 'mistral-vibe', name: 'Mistral Vibe' },
  { id: 'moxby', name: 'Moxby' },
  { id: 'mux', name: 'Mux' },
  { id: 'openhands', name: 'OpenHands' },
  { id: 'ona', name: 'Ona' },
  { id: 'posit-assistant', name: 'Posit Assistant' },
  { id: 'qoder-cn', name: 'Qoder CN' },
  { id: 'reasonix', name: 'Reasonix' },
  { id: 'rovodev', name: 'Rovo Dev' },
  { id: 'tabnine-cli', name: 'Tabnine CLI' },
  { id: 'terramind', name: 'Terramind' },
  { id: 'tinycloud', name: 'Tinycloud' },
  { id: 'trae-cn', name: 'Trae CN' },
  { id: 'zcode', name: 'ZCode' },
  { id: 'zencoder', name: 'Zencoder' },
  { id: 'zenflow', name: 'Zenflow' },
  { id: 'neovate', name: 'Neovate' },
  { id: 'pochi', name: 'Pochi' },
  { id: 'promptscript', name: 'PromptScript' },
  { id: 'adal', name: 'AdaL' },
  { id: 'replit', name: 'Replit' },
  { id: 'universal', name: 'Universal' },
];

/** agent 的 MCP 配置根键 */
export function configFormat(agent: AgentDef): ConfigFormat {
  if (agent.format) return agent.format;
  if (agent.id === 'codex') return 'toml';
  if (agent.id === 'vscode') return 'servers';
  if (agent.id === 'opencode') return 'mcp';
  if (agent.id === 'zed') return 'contextServers';
  return 'mcpServers';
}

/** JSON 文件里真正的根键名 */
export function rootKey(format: ConfigFormat): string {
  switch (format) {
    case 'contextServers':
      return 'context_servers';
    case 'servers':
      return 'servers';
    case 'mcp':
      return 'mcp';
    default:
      return 'mcpServers';
  }
}

/** 写进 agent 配置的服务器条目，不含任何凭证 */
export function serverEntry(
  format: ConfigFormat,
  extra?: Record<string, unknown>,
  env?: Record<string, unknown>
): Record<string, unknown> {
  const command = 'npx';
  const args = ['-y', PACKAGE_NAME, MCP_COMMAND];
  const base: Record<string, unknown> =
    format === 'servers'
      ? { type: 'stdio', command, args }
      : format === 'mcp'
        ? { type: 'local', command: [command, ...args], enabled: true }
        : { command, args };
  // Zed 原本要求 env:{}，有凭证时直接填进去；其他宿主没有 env 键就不写空对象
  if (env || format === 'contextServers') base.env = env || {};
  return extra ? { ...base, ...extra } : base;
}

/** 按「配置文件/目录是否存在」判断本机装了哪些可自动配置的 agent */
export function detectInstalled(cwd: string, scope: Scope): AgentDef[] {
  return AGENTS.filter(
    (agent) =>
      agent.scopes.includes(scope) &&
      agent.detect(cwd).some((p) => fs.existsSync(p))
  );
}

/** 手工类 agent 的启动指引 */
export function manualInstruction(name: string): string {
  return `${name} 未公开可靠的 MCP 配置格式，请在该 agent 的 MCP 设置里手工添加 stdio 服务器：${START_COMMAND}，并在 env 里填 ZENTAO_URL / ZENTAO_ACCOUNT / ZENTAO_PASSWORD`;
}
