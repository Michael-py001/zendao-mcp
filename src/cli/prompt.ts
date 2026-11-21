/**
 * 终端交互。照抄 skills CLI 的多选体验：↑↓ 移动、空格勾选、a 全选、u 全清、回车确认。
 * 非 TTY（CI / 管道）自动退化为数字序号文本输入。
 */

import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export interface Choice {
  value: string;
  label: string;
  hint?: string;
  checked?: boolean;
}

export function askText(question: string, defaultValue = ''): Promise<string> {
  const rl = createInterface({ input, output });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return rl.question(`${question}${suffix}: `).then((answer) => {
    rl.close();
    return answer.trim() || defaultValue;
  });
}

/** 密码不回显；用 ^H/Backspace 删除，Ctrl-C 退出 */
export function askSecret(question: string): Promise<string> {
  if (!input.isTTY) return askText(question);

  process.stdout.write(`${question}: `);
  return new Promise((resolve) => {
    const stdin = input as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const done = (result: string) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    const onData = (chunk: string) => {
      if (chunk === '\r' || chunk === '\n') done(value);
      else if (chunk === '\u0003') {
        done('');
        process.exit(130);
      } else if (chunk === '\u007f' || chunk === '\b') {
        value = value.slice(0, -1);
        process.stdout.write('\b \b');
      } else {
        value += chunk;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function selectInTextMode(choices: Choice[]): Promise<string[]> {
  process.stdout.write(`${choices.map((c, i) => `  ${i + 1}) ${c.label}`).join('\n')}\n`);
  const answer = await askText('选择序号（空格分隔，回车全选）');
  if (!answer.trim()) return choices.map((c) => c.value);
  const indexes = answer
    .split(/[\s,]+/)
    .map((n) => Number(n) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < choices.length);
  return indexes.map((i) => choices[i].value);
}

export function selectMany(question: string, choices: Choice[]): Promise<string[]> {
  if (!input.isTTY || choices.length === 0) return selectInTextMode(choices);

  process.stdout.write(`${question}\n`);
  const checked = new Set(choices.filter((c) => c.checked).map((c) => c.value));
  let cursor = 0;

  return new Promise((resolve) => {
    const stdin = input as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${choices.length + 1}A`);
      for (const choice of choices) {
        const mark = checked.has(choice.value) ? '●' : '○';
        const hint = choice.hint ? `  ${choice.hint}` : '';
        process.stdout.write(`\x1b[2K${cursor === choices.indexOf(choice) ? '>' : ' '} ${mark} ${choice.label}${hint}\n`);
      }
      process.stdout.write('\x1b[2K(↑↓ 移动 · 空格 勾选 · a 全选 · u 全清 · 回车确认)\n');
    };
    render(true);

    const done = (result: string[]) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(result);
    };
    const onData = (chunk: string) => {
      if (chunk === '\u0003') {
        done([]);
        process.exit(130);
      } else if (chunk === '\r' || chunk === '\n') {
        done(choices.filter((c) => checked.has(c.value)).map((c) => c.value));
      } else if (chunk === '\x1b[A') {
        cursor = (cursor - 1 + choices.length) % choices.length;
        render(false);
      } else if (chunk === '\x1b[B') {
        cursor = (cursor + 1) % choices.length;
        render(false);
      } else if (chunk === ' ') {
        const value = choices[cursor].value;
        if (checked.has(value)) checked.delete(value);
        else checked.add(value);
        render(false);
      } else if (chunk === 'a') {
        choices.forEach((c) => checked.add(c.value));
        render(false);
      } else if (chunk === 'u') {
        checked.clear();
        render(false);
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = await askText(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`);
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}
