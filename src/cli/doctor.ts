/**
 * `zendao-mcp doctor` —— 只做本地静态检查，不发网络请求、不改文件。
 */

import { AGENTS, Scope, detectInstalled } from './agents';
import { hasCompleteEnv, hasEntry } from './config-writer';
import { credentialsPath, loadCredentials } from './credentials';

export interface DoctorOptions {
  cwd: string;
  scope: Scope;
}

export function runDoctor(options: DoctorOptions): number {
  const credentials = loadCredentials();
  process.stdout.write(`凭证文件: ${credentialsPath()} ${credentials ? '存在' : '不存在'}\n`);
  if (!credentials?.baseUrl || (!credentials.account && !credentials.token)) {
    process.stdout.write('  提示: 先运行 init，或在 ~/.zendao-mcp/.env 里填好禅道地址与凭证\n');
  }

  const candidates = AGENTS.filter((a) => a.scopes.includes(options.scope));
  const detected = detectInstalled(options.cwd, options.scope);
  let configured = 0;

  for (const agent of candidates) {
    const file = agent.configPath(options.scope, options.cwd);
    let installed: boolean;
    try {
      installed = hasEntry(agent, options.scope, options.cwd);
    } catch (error: any) {
      process.stdout.write(`${agent.name}: 配置解析失败 — ${error.message}\n`);
      continue;
    }
    if (installed) configured++;
    // 只显示已配置的，或本机确实装了的 agent —— 25 个全列出来噪音太大
    if (!installed && !detected.includes(agent)) continue;
    const state = !installed
      ? '未配置'
      : hasCompleteEnv(agent, options.scope, options.cwd)
        ? '已配置，凭证齐全'
        : '已配置，但 env 缺少 ZENTAO_*';
    process.stdout.write(`${agent.name}: ${state} (${file})\n`);
  }
  process.stdout.write(`检查了 ${candidates.length} 个 agent，已配置 ${configured} 个。\n`);
  return 0;
}
