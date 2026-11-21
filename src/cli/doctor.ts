/**
 * `zendao-mcp doctor` —— 只做本地静态检查，不发网络请求、不改文件。
 */

import { AGENTS, Scope } from './agents';
import { hasEntry } from './config-writer';
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

  for (const agent of AGENTS) {
    if (!agent.scopes.includes(options.scope)) continue;
    const file = agent.configPath(options.scope, options.cwd);
    let installed: boolean;
    try {
      installed = hasEntry(agent, options.scope, options.cwd);
    } catch (error: any) {
      process.stdout.write(`${agent.name}: 配置解析失败 — ${error.message}\n`);
      continue;
    }
    process.stdout.write(`${agent.name}: ${installed ? `已配置 (${file})` : `未配置 (${file})`}\n`);
  }
  return 0;
}
