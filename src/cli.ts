#!/usr/bin/env node
/** npm bin 入口：无参数等价于启动 MCP 服务 */
import { run } from './cli/index';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: any) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
