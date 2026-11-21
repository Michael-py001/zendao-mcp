/**
 * `zendao-mcp init` —— 检测已装 agent、收集凭证、写入各自 MCP 配置。
 * 交互模型参考 skills CLI：自动检测 → 多选 → 汇总确认 → 可选 -a/-y 全非交互。
 */

import { AGENTS, AgentDef, PACKAGE_NAME, Scope, detectInstalled, SERVER_NAME } from './agents';
import { hasEntry, writeAgentConfig, WriteOutcome } from './config-writer';
import { Credentials, credentialsPath, loadCredentials, saveCredentials } from './credentials';
import { askSecret, askText, confirm, selectMany } from './prompt';

export interface InitOptions {
  cwd: string;
  dryRun: boolean;
  yes: boolean;
  scope: Scope;
  agentIds?: string[];
}

const HELP = `用法: npx -y ${PACKAGE_NAME} init [选项]

选项:
  -a, --agent <id>   指定 agent，可重复（claude-code, cursor, codex, opencode,
                     gemini-cli, vscode, windsurf, workbuddy, claude-desktop）
  -g, --global       用户级配置（默认）
  -p, --project      项目级配置
  -y, --yes          跳过确认
      --dry-run      只打印计划，不改任何文件
  -h, --help         显示帮助
`;

export function parseInitArgs(args: string[], cwd = process.cwd()): InitOptions {
  const options: InitOptions = { cwd, dryRun: false, yes: false, scope: 'global' };
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-a' || arg === '--agent') {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) ids.push(args[++i]);
    } else if (arg === '-g' || arg === '--global') options.scope = 'global';
    else if (arg === '-p' || arg === '--project') options.scope = 'project';
    else if (arg === '-y' || arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}\n${HELP}`);
    }
  }
  if (ids.length) options.agentIds = ids;
  return options;
}

async function collectCredentials(dryRun: boolean): Promise<Credentials> {
  const existing = loadCredentials();
  if (dryRun) {
    return {
      baseUrl: existing?.baseUrl || 'http://localhost',
      account: existing?.account || '<your-account>',
      password: existing?.password || '<your-password>',
    };
  }

  const baseUrl = await askText('禅道站点地址（站点根，不要带 /index.php）', existing?.baseUrl);
  const account = await askText('禅道账号', existing?.account);
  if (!account) throw new Error('账号不能为空');
  const password = await askSecret('禅道密码');
  if (!password) throw new Error('密码不能为空');
  return { baseUrl, account, password };
}

export async function runInit(options: InitOptions): Promise<number> {
  process.stdout.write(`\nzendao-mcp init${options.dryRun ? '（dry-run，不会写文件）' : ''}\n\n`);

  const installed = detectInstalled(options.cwd, options.scope);
  process.stdout.write(`检测到的 agent: ${installed.length ? installed.map((a) => a.name).join('、') : '无'}\n\n`);

  const available = AGENTS.filter((a) => a.scopes.includes(options.scope));
  let selected: AgentDef[];
  if (options.agentIds) {
    const picked = options.agentIds.map((id) => available.find((a) => a.id === id));
    const missing = options.agentIds.filter((_, i) => !picked[i]);
    if (missing.length) throw new Error(`未知的 agent: ${missing.join(', ')}`);
    selected = picked as AgentDef[];
  } else if (options.dryRun || options.yes) {
    selected = installed;
  } else {
    const choices = [
      ...installed.map((a) => ({ value: a.id, label: a.name, hint: '已检测到', checked: true })),
      ...available
        .filter((a) => !installed.includes(a))
        .map((a) => ({ value: a.id, label: a.name, hint: '未检测到', checked: false })),
    ];
    const ids = await selectMany('选择要安装到的 agent', choices);
    selected = available.filter((a) => ids.includes(a.id));
  }

  if (selected.length === 0) throw new Error('没有选中任何 agent');

  const credentials = await collectCredentials(options.dryRun);
  const credFile = credentialsPath();

  process.stdout.write('\n安装计划:\n');
  process.stdout.write(`  凭证: ${credFile}（权限 600，不写进 agent 配置）\n`);
  for (const agent of selected) {
    const file = agent.configPath(options.scope, options.cwd);
    const exists = hasEntry(agent, options.scope, options.cwd);
    process.stdout.write(`  ${agent.name}: ${file}${exists ? '（已存在，将更新）' : ''}\n`);
  }

  if (!options.yes && !options.dryRun && !(await confirm('\n确认写入?'))) {
    process.stdout.write('已取消，未修改任何文件。\n');
    return 0;
  }

  if (!options.dryRun) {
    const saved = saveCredentials(credentials, false);
    process.stdout.write(`\n凭证已写入 ${saved}\n`);
  }

  const outcomes: WriteOutcome[] = selected.map((agent) =>
    writeAgentConfig(agent, options.scope, options.cwd, options.dryRun)
  );

  process.stdout.write('\n结果:\n');
  for (const outcome of outcomes) {
    const label = outcome.status === 'failed' ? `失败: ${outcome.detail}` : outcome.status;
    process.stdout.write(`  ${outcome.agent}: ${label}\n`);
  }

  const notes = [...new Set(selected.map((a) => a.note).filter((n): n is string => !!n))];
  if (notes.length) process.stdout.write(`\n注意:\n${notes.map((n) => `  - ${n}`).join('\n')}\n`);
  process.stdout.write(`\n重启对应 agent 后，工具列表里应出现 ${SERVER_NAME} 的工具。\n`);
  process.stdout.write('可用 doctor 检查配置是否写入成功；首次发布前 npx 会拉不到包，先用本地构建验证。\n');

  return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}
