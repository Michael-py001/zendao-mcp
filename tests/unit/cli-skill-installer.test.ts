/**
 * init 随包安装 Skill —— 离线单测，全程临时目录，不碰真实 agent 目录。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hasSkillTarget,
  installSkill,
  resolveSkillSource,
} from '../../src/cli/skill-installer';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-skill-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('skill-installer', () => {
  it('源文件可从源码与 dist 两处解析', () => {
    const src = resolveSkillSource();
    expect(src).toBeDefined();
    expect(fs.existsSync(src!)).toBe(true);
    expect(fs.readFileSync(src!, 'utf8')).toContain('name: zendao-mcp');
  });

  it('只为已核实路径的 agent 声明支持，未知 agent 跳过', () => {
    expect(hasSkillTarget('claude-code')).toBe(true);
    expect(hasSkillTarget('cursor')).toBe(true);
    expect(hasSkillTarget('codex')).toBe(true);
    expect(hasSkillTarget('some-unknown-agent')).toBe(false);
  });

  it('安装成功后 SKILL.md 落在目标目录', () => {
    const outcome = installSkill('claude-code', 'Claude Code', 'global', dir, false, dir);
    expect(outcome.status).toBe('installed');
    const target = path.join(dir, '.claude', 'skills', 'zendao-mcp', 'SKILL.md');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('name: zendao-mcp');
  });

  it('已存在则跳过，不覆盖用户改过的内容', () => {
    installSkill('claude-code', 'Claude Code', 'global', dir, false, dir);
    const target = path.join(dir, '.claude', 'skills', 'zendao-mcp', 'SKILL.md');
    fs.writeFileSync(target, 'USER CUSTOMIZED', 'utf8');
    const second = installSkill('claude-code', 'Claude Code', 'global', dir, false, dir);
    expect(second.status).toBe('skipped');
    expect(fs.readFileSync(target, 'utf8')).toBe('USER CUSTOMIZED');
  });

  it('dry-run 不写任何文件', () => {
    const outcome = installSkill('claude-code', 'Claude Code', 'global', dir, true, dir);
    expect(outcome.status).toBe('installed');
    expect(outcome.detail).toContain('dry-run');
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false);
  });

  it('未知 agent 返回 unsupported，不抛错', () => {
    const outcome = installSkill('nope', 'Nope', 'global', dir, false, dir);
    expect(outcome.status).toBe('unsupported');
  });
});
