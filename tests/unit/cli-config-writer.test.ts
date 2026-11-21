/**
 * CLI 配置写入器单测：全部在临时目录进行，不碰任何真实 agent 配置。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { AgentDef, PACKAGE_NAME, SERVER_NAME } from '../../src/cli/agents';
import { hasEntry, writeAgentConfig } from '../../src/cli/config-writer';

let dir: string;

const jsonAgent = (fileName: string, id = 'cursor'): AgentDef => ({
  id,
  name: id,
  scopes: ['global'],
  configPath: () => path.join(dir, fileName),
  detect: () => [],
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-cli-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeAgentConfig / JSON', () => {
  it('只新增 mcpServers.zendao，不破坏已有键', () => {
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'uvx' } }, theme: 'dark' }));

    const outcome = writeAgentConfig(jsonAgent('mcp.json'), 'global', dir, false);

    expect(outcome.status).toBe('updated');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.theme).toBe('dark');
    expect(data.mcpServers.other.command).toBe('uvx');
    expect(data.mcpServers.zendao.command).toBe('npx');
    expect(data.mcpServers.zendao.args).toEqual(['-y', PACKAGE_NAME, 'serve']);
    expect(data.mcpServers.zendao.env).toBeUndefined();
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('mcp.json.bak.'))).toHaveLength(1);
  });

  it('文件不存在时创建，且重复执行幂等', () => {
    const agent = jsonAgent('fresh.json');
    expect(writeAgentConfig(agent, 'global', dir, false).status).toBe('created');
    expect(writeAgentConfig(agent, 'global', dir, false).status).toBe('unchanged');
    expect(hasEntry(agent, 'global', dir)).toBe(true);
    // 新建无需备份；只有覆盖已有文件才备份
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('fresh.json.bak'))).toHaveLength(0);
  });

  it('dry-run 不改文件、不建备份', () => {
    const agent = jsonAgent('dry.json');
    writeAgentConfig(agent, 'global', dir, true);
    expect(fs.existsSync(agent.configPath('global', dir))).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('JSONC 注释原样保留，定点插入条目', () => {
    const file = path.join(dir, 'commented.json');
    fs.writeFileSync(file, '{\n  // 这是注释\n  "mcpServers": {\n    "other": { "command": "uvx" }\n  }\n}\n');
    const outcome = writeAgentConfig(jsonAgent('commented.json'), 'global', dir, false);
    expect(outcome.status).toBe('updated');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('// 这是注释');
    const data = parseJsonc(text);
    expect(data.mcpServers.other.command).toBe('uvx');
    expect(data.mcpServers.zendao.command).toBe('npx');
  });

  it('尾随逗号保留，且不破坏其他人的配置', () => {
    const file = path.join(dir, 'trailing.json');
    fs.writeFileSync(
      file,
      '{\n  "mcpServers": {\n    "old": { "url": "https://example.com" },\n  },\n}\n'
    );
    expect(writeAgentConfig(jsonAgent('trailing.json'), 'global', dir, false).status).toBe('updated');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/},\n\s*"zendao":/); // 原有条目后的尾随逗号仍在
    const data = parseJsonc(text, [], { allowTrailingComma: true });
    expect(data.mcpServers.old.url).toBe('https://example.com');
    expect(data.mcpServers.zendao.args).toEqual(['-y', PACKAGE_NAME, 'serve']);
  });

  it('真正损坏的 JSON 仍报错退出', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ "mcpServers": { oops\n');
    const outcome = writeAgentConfig(jsonAgent('broken.json'), 'global', dir, false);
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('合法 JSON/JSONC');
  });

  it('VS Code 用 servers + type stdio；OpenCode 用 mcp + 数组命令', () => {
    const vscode = writeAgentConfig(jsonAgent('vscode.json', 'vscode'), 'global', dir, false);
    const opencode = writeAgentConfig(jsonAgent('opencode.json', 'opencode'), 'global', dir, false);
    const vs = JSON.parse(fs.readFileSync(vscode.path, 'utf8'));
    const oc = JSON.parse(fs.readFileSync(opencode.path, 'utf8'));
    expect(vs.servers[SERVER_NAME].type).toBe('stdio');
    expect(oc.mcp[SERVER_NAME].type).toBe('local');
    expect(Array.isArray(oc.mcp[SERVER_NAME].command)).toBe(true);
  });
});

describe('writeAgentConfig / Codex TOML', () => {
  const codex = (): AgentDef => ({
    id: 'codex',
    name: 'Codex CLI',
    scopes: ['global'],
    configPath: () => path.join(dir, 'config.toml'),
    detect: () => [],
  });

  it('追加段落后保留已有 TOML 内容，重复执行不重复追加', () => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.context7]\nurl = "https://example.com/mcp"\n');

    expect(writeAgentConfig(codex(), 'global', dir, false).status).toBe('updated');
    expect(writeAgentConfig(codex(), 'global', dir, false).status).toBe('unchanged');

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[mcp_servers.context7]');
    expect(text.match(/\[mcp_servers\.zendao\]/g)).toHaveLength(1);
    expect(text).toContain(`args = ["-y", "${PACKAGE_NAME}", "serve"]`);
    expect(hasEntry(codex(), 'global', dir)).toBe(true);
  });

  it('更新已有段落时不会留下旧字段', () => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(
      file,
      `[mcp_servers.${SERVER_NAME}]\ncommand = "old"\nurl = "http://stale"\n\n[other]\nx = 1\n`
    );
    writeAgentConfig(codex(), 'global', dir, false);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('http://stale');
    expect(text).toContain('[other]');
    expect(text).toContain('x = 1');
  });
});
