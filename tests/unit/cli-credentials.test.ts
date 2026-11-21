/**
 * 凭证落盘：重点验证含空格/引号/反斜杠的密码经 dotenv 解析后不失真。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseDotenv } from 'dotenv';
import { credentialsPath, loadCredentials, saveCredentials } from '../../src/cli/credentials';

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-cred-test-'));
  previous = process.env.ZENDAO_CONFIG_DIR;
  process.env.ZENDAO_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ZENDAO_CONFIG_DIR;
  else process.env.ZENDAO_CONFIG_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

it('写入后 dotenv 解析结果与明文一致（含特殊字符）', () => {
  const password = 'a b"c\\d$e\'f';
  saveCredentials(
    { baseUrl: 'http://zen.example.com/zentaomax', account: 'tester', password },
    false
  );

  const file = credentialsPath();
  expect(fs.existsSync(file)).toBe(true);
  const parsed = parseDotenv(fs.readFileSync(file));
  expect(parsed.ZENTAO_BASE_URL).toBe('http://zen.example.com/zentaomax');
  expect(parsed.ZENTAO_ACCOUNT).toBe('tester');
  expect(Buffer.from(parsed.ZENTAO_PASSWORD_B64, 'base64').toString('utf8')).toBe(password);
  expect(loadCredentials()?.password).toBe(password);
});

it('dry-run 不落盘', () => {
  saveCredentials({ baseUrl: 'http://x', account: 'a', password: 'b' }, true);
  expect(fs.existsSync(credentialsPath())).toBe(false);
});

it('服务端 config.ts 能读到 CLI 写的 base64 密码', () => {
  const password = 'p\\/"# $';
  saveCredentials({ baseUrl: 'http://zen.example.com/zentaomax', account: 'tester', password }, false);
  const keys = ['ZENDAO_ENV_FILE', 'ZENTAO_BASE_URL', 'ZENTAO_ACCOUNT', 'ZENTAO_PASSWORD', 'ZENTAO_TOKEN'];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    process.env.ZENDAO_ENV_FILE = credentialsPath();
    for (const key of keys.slice(1)) delete process.env[key];
    jest.resetModules();
    const { loadConfig } = require('../../src/config');
    const config = loadConfig();
    expect(config.password).toBe(password);
    expect(config.account).toBe('tester');
    expect(config.baseUrl).toBe('http://zen.example.com/zentaomax');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
