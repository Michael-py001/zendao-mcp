/**
 * 用户级凭证落盘。
 *
 * 凭证只写 ~/.zendao-mcp/.env，绝不写进 agent 配置 —— 那些文件常被提交到 git，
 * 也会被别的工具读取。服务端 config.ts 会从这里读取。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Credentials {
  baseUrl: string;
  account?: string;
  password?: string;
  token?: string;
}

export function credentialsDir(): string {
  return process.env.ZENDAO_CONFIG_DIR || path.join(os.homedir(), '.zendao-mcp');
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), '.env');
}

/** 读取已落盘的凭证，供 init 回显默认值；读不到就返回 null */
export function loadCredentials(): Partial<Credentials> | null {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return null;
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(ZENTAO_[A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    out[match[1]] = value;
  }
  return {
    baseUrl: out.ZENTAO_BASE_URL,
    account: out.ZENTAO_ACCOUNT,
    // 密码用 base64 存：dotenv 对双引号里的 \" 和 \\ 不做反转义，明文密码会被改写
    password: out.ZENTAO_PASSWORD_B64
      ? Buffer.from(out.ZENTAO_PASSWORD_B64, 'base64').toString('utf8')
      : out.ZENTAO_PASSWORD,
    token: out.ZENTAO_TOKEN,
  };
}

export function saveCredentials(credentials: Credentials, dryRun: boolean): string {
  const dir = credentialsDir();
  const file = credentialsPath();
  const lines = [`ZENTAO_BASE_URL=${JSON.stringify(credentials.baseUrl)}`];
  if (credentials.token) {
    lines.push(`ZENTAO_TOKEN=${JSON.stringify(credentials.token)}`);
  } else {
    if (!credentials.account || !credentials.password) {
      throw new Error('账号和密码必须成对提供');
    }
    lines.push(`ZENTAO_ACCOUNT=${JSON.stringify(credentials.account)}`);
    lines.push(`ZENTAO_PASSWORD_B64=${Buffer.from(credentials.password, 'utf8').toString('base64')}`);
  }
  const content = `${lines.join('\n')}\n`;

  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
    // 已存在的文件 mode 不会被 writeFile 覆盖，显式收紧一次
    fs.chmodSync(file, 0o600);
  }
  return file;
}
