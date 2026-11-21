/**
 * init 时随包安装 Skill 到各 agent 的 skills 目录。
 *
 * ## 为什么不写进 agent 的 MCP 配置
 * MCP 工具描述只说「单个工具怎么调」，装 Skill 是为了传递工具描述里放不下的
 * 工作流与铁律（填日志四列清单确认、dryRun 非确认、实例踩坑）。官方 zentao-cli
 * 也是 MCP + skill 并存，两者互补。
 *
 * ## 路径来源
 * 各 agent 的 skills 目录取自官方 zentao-cli 的 `add-skill.ts`（AGENT_TARGETS），
 * 那是禅道官方核对过的路径。WorkBuddy 未在其中，按其项目级约定补 `~/.workbuddy/skills/`。
 *
 * ## 安全边界（ponytail：够用就好，不要过度设计）
 * - 只装一个文件 SKILL.md，不建复杂目录树；
 * - 已存在则跳过 —— 用户可能改过，绝不覆盖；
 * - 源路径解析失败只提示、不阻断 init（skill 是可选增强，MCP 配置才是主功能）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** skill 在包内的相对路径（包根 → skills/zendao-mcp/SKILL.md） */
const SKILL_REL_PATH = path.join('skills', 'zendao-mcp', 'SKILL.md');
/** 装到 agent 后的目录名 */
export const SKILL_NAME = 'zendao-mcp';

const home = () => os.homedir();
const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(home(), '.config');

/**
 * agent id → skills 根目录。
 * 只列已核实的标准路径；未列的 agent 跳过（宁可少装，不猜路径）。
 * 路径与官方 zentao-cli 的 AGENT_TARGETS 对齐。
 */
const SKILL_DIRS: Record<string, () => string> = {
  'claude-code': () => path.join(home(), '.claude', 'skills'),
  'cursor': () => path.join(home(), '.cursor', 'skills'),
  'codex': () => path.join(home(), '.agents', 'skills'),
  'opencode': () => path.join(xdgConfig(), 'opencode', 'skills'),
  'gemini-cli': () => path.join(home(), '.gemini', 'skills'),
  'cherry-studio': () => path.join(home(), '.cherrystudio', 'skills'),
  'vscode': () => path.join(home(), '.copilot', 'skills'),
  'antigravity': () => path.join(home(), '.gemini', 'antigravity', 'skills'),
  // WorkBuddy 官方未公开 skills 路径，按其项目级约定补上（用户级则用 ~/.workbuddy/skills）
  'workbuddy': () => path.join(home(), '.workbuddy', 'skills'),
};

export interface SkillOutcome {
  agent: string;
  path: string;
  status: 'installed' | 'skipped' | 'failed' | 'unsupported';
  detail?: string;
}

/** 解析包内 skill 源文件：兼容 dist/cli（发布包）与 src/cli（源码直跑） */
export function resolveSkillSource(): string | undefined {
  const candidates = [
    path.resolve(__dirname, '..', '..', SKILL_REL_PATH), // dist/cli -> 包根
    path.resolve(__dirname, '..', '..', '..', SKILL_REL_PATH), // src/cli -> 仓库根
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/** 该 agent 是否有已知的 skills 目录 */
export function hasSkillTarget(agentId: string): boolean {
  return agentId in SKILL_DIRS;
}

/**
 * 给单个 agent 装 skill。
 * @param scope 只影响 WorkBuddy：project 时装到 cwd/.workbuddy/skills，global 时装到用户级。
 */
export function installSkill(
  agentId: string,
  agentName: string,
  scope: 'global' | 'project',
  cwd: string,
  dryRun: boolean,
  /** 仅测试注入：覆盖 homedir 根，避免碰真实用户目录 */
  homeOverride?: string
): SkillOutcome {
  const resolveDir = SKILL_DIRS[agentId];
  if (!resolveDir) {
    return { agent: agentName, path: '(未知)', status: 'unsupported' };
  }

  const root = scope === 'project' && agentId === 'workbuddy'
    ? path.join(cwd, '.workbuddy', 'skills')
    : homeOverride
      ? path.join(homeOverride, '.claude', 'skills') // 测试统一落到 claude-code 的相对结构
      : resolveDir();
  const targetDir = path.join(root, SKILL_NAME);
  const targetFile = path.join(targetDir, 'SKILL.md');

  if (fs.existsSync(targetFile)) {
    return { agent: agentName, path: targetFile, status: 'skipped', detail: '已存在，未覆盖' };
  }

  if (dryRun) {
    return { agent: agentName, path: targetFile, status: 'installed', detail: 'dry-run，未实际写入' };
  }

  const source = resolveSkillSource();
  if (!source) {
    return {
      agent: agentName,
      path: targetFile,
      status: 'failed',
      detail: '包内未找到 SKILL.md（安装不完整），MCP 配置不受影响',
    };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, targetFile);
    return { agent: agentName, path: targetFile, status: 'installed' };
  } catch (error: any) {
    return { agent: agentName, path: targetFile, status: 'failed', detail: error.message };
  }
}
