/**
 * 扩展 agent 名单后的单测：临时目录，不碰真实配置。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENTS,
  MANUAL_AGENTS,
  PACKAGE_NAME,
  SERVER_NAME,
  AgentDef,
  configFormat,
  detectInstalled,
  rootKey,
} from '../../src/cli/agents';
import { hasEntry, writeAgentConfig } from '../../src/cli/config-writer';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-agents-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const local = (agent: AgentDef, fileName: string): AgentDef => ({
  ...agent,
  configPath: () => path.join(dir, fileName),
  detect: () => [],
});

describe('注册表完整性', () => {
  it('自动配置 agent 与手工 agent 的 ID 都不重复、不交叉', () => {
    const autoIds = AGENTS.map((a) => a.id);
    const manualIds = MANUAL_AGENTS.map((a) => a.id);
    expect(new Set(autoIds).size).toBe(autoIds.length);
    expect(new Set(manualIds).size).toBe(manualIds.length);
    expect(autoIds.filter((id) => manualIds.includes(id))).toEqual([]);
    expect(AGENTS.length).toBeGreaterThanOrEqual(25);
    expect(MANUAL_AGENTS.length).toBeGreaterThanOrEqual(50);
    expect(SERVER_NAME).toBe('zentao-cli');
  });

  it('每种格式都能算出根键，所有配置路径可计算', () => {
    for (const agent of AGENTS) {
      const format = configFormat(agent);
      expect(rootKey(format)).toBeTruthy();
      for (const scope of agent.scopes) {
        expect(() => agent.configPath(scope, dir)).not.toThrow();
        expect(path.isAbsolute(agent.configPath(scope, dir))).toBe(true);
      }
      expect(() => agent.detect(dir)).not.toThrow();
    }
    expect(() => detectInstalled(dir, 'global')).not.toThrow();
  });
});

describe('新格式与扩展字段', () => {
  it('Zed 写入 context_servers 而不是 mcpServers', () => {
    const zed = AGENTS.find((a) => a.id === 'zed')!;
    const agent = local(zed, 'settings.json');
    const outcome = writeAgentConfig(agent, 'global', dir, false);
    expect(outcome.status).toBe('created');

    const data = JSON.parse(fs.readFileSync(outcome.path, 'utf8'));
    expect(data.mcpServers).toBeUndefined();
    expect(data.context_servers[SERVER_NAME].args).toEqual(['-y', PACKAGE_NAME, 'mcp']);
    expect(hasEntry(agent, 'global', dir)).toBe(true);
  });

  it('Cline 的 disabled / alwaysAllow 随条目一起写入且幂等', () => {
    const cline = AGENTS.find((a) => a.id === 'cline')!;
    const agent = local(cline, 'cline_mcp_settings.json');
    expect(writeAgentConfig(agent, 'global', dir, false).status).toBe('created');
    const data = JSON.parse(fs.readFileSync(agent.configPath('global', dir), 'utf8'));
    expect(data.mcpServers[SERVER_NAME].disabled).toBe(false);
    expect(data.mcpServers[SERVER_NAME].alwaysAllow).toEqual([]);
    expect(writeAgentConfig(agent, 'global', dir, false).status).toBe('unchanged');
  });

  it('CodeBuddy 只加 disabled: false', () => {
    const codebuddy = AGENTS.find((a) => a.id === 'codebuddy')!;
    const agent = local(codebuddy, '.mcp.json');
    writeAgentConfig(agent, 'global', dir, false);
    const data = JSON.parse(fs.readFileSync(agent.configPath('global', dir), 'utf8'));
    expect(data.mcpServers[SERVER_NAME].disabled).toBe(false);
    expect(data.mcpServers[SERVER_NAME].alwaysAllow).toBeUndefined();
  });

  it('TOML 格式不掺入扩展字段', () => {
    const codex = AGENTS.find((a) => a.id === 'codex')!;
    const agent = local(codex, 'config.toml');
    writeAgentConfig(agent, 'global', dir, false);
    const text = fs.readFileSync(agent.configPath('global', dir), 'utf8');
    expect(text).not.toContain('disabled');
  });
});

describe('手工配置 agent', () => {
  it('返回 manual 状态，给出启动命令，不创建任何文件', () => {
    const target = MANUAL_AGENTS.find((a) => a.id === 'goose')!;
    const outcome = writeAgentConfig(target, 'global', dir, false);
    expect(outcome.status).toBe('manual');
    expect(outcome.detail).toContain(`npx -y ${PACKAGE_NAME} mcp`);
    expect(outcome.detail).toContain('ZENTAO_PASSWORD');
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
