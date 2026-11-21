/**
 * CLI 命令分发。无参数 / serve 走 MCP 服务，其余是安装与诊断命令。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Scope } from './agents';
import { InitOptions, parseInitArgs, runInit } from './init';
import { runDoctor } from './doctor';

const HELP = (version: string) => `zendao-mcp ${version}

用法:
  npx -y @michael-py001/zendao-mcp init    交互式安装到本机 AI agent
  npx -y @michael-py001/zendao-mcp doctor  检查安装状态
  npx -y @michael-py001/zendao-mcp serve   启动 MCP 服务（agent 配置里用的就是这条）

init --help 查看安装选项。
`;

function version(): string {
  try {
    const file = path.resolve(__dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseScope(args: string[]): Scope {
  return args.includes('-p') || args.includes('--project') ? 'project' : 'global';
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'serve' || command === 'start') {
    await import('../index.js');
    return 0;
  }

  switch (command) {
    case 'init': {
      const options: InitOptions = parseInitArgs(rest);
      return runInit(options);
    }
    case 'doctor':
      return runDoctor({ cwd: process.cwd(), scope: parseScope(rest) });
    case '--version':
    case '-v':
      process.stdout.write(`${version()}\n`);
      return 0;
    case '--help':
    case '-h':
      process.stdout.write(HELP(version()));
      return 0;
    default:
      process.stderr.write(`未知命令: ${command}\n${HELP(version())}`);
      return 1;
  }
}
