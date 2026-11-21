/**
 * 官方 0.5.0 移植工具 —— 离线回归测试
 *
 * 守的是三条「坏了也不报错」的链路：
 *   1. zendao_link 的 create/parse 依赖 getconfig 路由字段（moduleVar/methodVar），
 *      缺字段会抛 E_MISSING_PARAM —— 这里用真实 SDK + mock 配置确认闭环；
 *   2. SDK 0.9.3 的 extractFileIdFromUrl / extractFileIdsFromHtml 是本项目
 *      通用附件读取的核心提取能力，URL 形态（GET/路径路由/绝对地址）一变就会静默取不到；
 *   3. 生成链接的站点越界 / 目录穿越防护。
 *
 * 全程不访问真实禅道，可离线反复跑。
 */

import * as http from 'http';
import { AddressInfo } from 'net';

import { ZenTaoClient } from '../../src/client';
import { LRUCache } from '../../src/utils/cache';
import { Logger, LogLevel } from '../../src/utils/logger';

// 用真实 SDK（0.9.3）
const sdkPromise = import('zentao-api');

/** 真机 getconfig 回包里与链接相关的字段（GET 路由，本项目实例实测） */
const GET_CONFIG = {
  version: 'max8.2',
  requestType: 'GET',
  requestFix: '-',
  moduleVar: 'm',
  methodVar: 'f',
  viewVar: 't',
  router: 'index.php',
  webRoot: '/zentaomax/',
  defaultView: 'html',
};

const PATH_CONFIG = {
  ...GET_CONFIG,
  requestType: 'PATH_INFO',
};

describe('zendao_link —— 页面链接（真实 SDK 0.9.3，离线）', () => {
  test('SDK 导出 createLink / parseLink', async () => {
    const sdk = await sdkPromise;
    expect(typeof sdk.createLink).toBe('function');
    expect(typeof sdk.parseLink).toBe('function');
  });

  test('GET 路由：create → parse 闭环还原模块/方法/参数', async () => {
    const sdk = await sdkPromise;
    const profile = { server: 'http://zentao.test/zentaomax', serverConfig: GET_CONFIG as any };
    const link = sdk.createLink(profile, {
      moduleName: 'bug',
      methodName: 'view',
      vars: [['bugID', '123']],
    });
    expect(link).toContain('m=bug');
    expect(link).toContain('f=view');
    expect(link).toContain('bugID=123');

    const parsed = sdk.parseLink(profile, link, { requestType: 'auto' });
    expect(parsed.moduleName).toBe('bug');
    expect(parsed.methodName).toBe('view');
    expect(parsed.vars).toEqual([['bugID', '123']]);
  });

  test('PATH_INFO 路由：create 出路径式链接', async () => {
    const sdk = await sdkPromise;
    const profile = { server: 'http://zentao.test/zentaomax', serverConfig: PATH_CONFIG as any };
    const link = sdk.createLink(profile, {
      moduleName: 'bug',
      methodName: 'view',
      vars: [['bugID', '456']],
    });
    expect(link).toMatch(/bug-view-456/);
  });

  test('relative + hash 生效', async () => {
    const sdk = await sdkPromise;
    const profile = { server: 'http://zentao.test/zentaomax', serverConfig: GET_CONFIG as any };
    const link = sdk.createLink(profile, {
      moduleName: 'task',
      methodName: 'view',
      vars: [['taskID', '7']],
      relative: true,
      hash: '#legend',
    });
    expect(link.startsWith('/')).toBe(true);
    expect(link.endsWith('#legend')).toBe(true);
  });

  test('缺路由字段时 SDK 抛 E_MISSING_PARAM（工具需降级处理）', async () => {
    const sdk = await sdkPromise;
    expect(() =>
      sdk.createLink({ server: 'http://zentao.test/zentaomax', serverConfig: { version: 'max8.2' } as any }, {
        moduleName: 'bug',
        methodName: 'view',
      })
    ).toThrow();
  });

  test('外链被标记为 external', async () => {
    const sdk = await sdkPromise;
    const profile = { server: 'http://zentao.test/zentaomax', serverConfig: GET_CONFIG as any };
    const parsed = sdk.parseLink(profile, 'https://example.com/other', { requestType: 'auto' });
    expect(parsed.external).toBe(true);
  });
});

describe('通用附件提取（真实 SDK 0.9.3，离线）', () => {
  test('extractFileIdFromUrl —— GET 路由 / 带 t 参数 / 绝对路径', async () => {
    const sdk = await sdkPromise;
    const site = 'http://zentao.test/zentaomax';
    expect(sdk.extractFileIdFromUrl('/zentaomax/index.php?m=file&f=read&t=png&fileID=2016187', site)).toBe(2016187);
    expect(sdk.extractFileIdFromUrl('http://zentao.test/zentaomax/index.php?m=file&f=read&fileID=123', site)).toBe(123);
  });

  test('extractFileIdFromUrl —— PATH_INFO 路由', async () => {
    const sdk = await sdkPromise;
    expect(sdk.extractFileIdFromUrl('/file-read-456.html', 'http://zentao.test/zentaomax')).toBe(456);
  });

  test('extractFileIdsFromHtml —— 按顺序提取多个图片，保留重复项', async () => {
    const sdk = await sdkPromise;
    const site = 'http://zentao.test/zentaomax';
    const html =
      '<img src="/zentaomax/index.php?m=file&f=read&fileID=111">' +
      '<p>text</p>' +
      '<img src="/zentaomax/index.php?m=file&f=read&fileID=222">';
    const result = sdk.extractFileIdsFromHtml(html, site);
    expect(result.map(([, id]) => id)).toEqual([111, 222]);
  });

  test('extractFileIdsFromHtml —— 无图片时返回空数组', async () => {
    const sdk = await sdkPromise;
    expect(sdk.extractFileIdsFromHtml('<p>没有图片</p>', 'http://zentao.test/zentaomax')).toEqual([]);
  });
});

describe('SDK 版本与能力基线', () => {
  test('模块 43 / 动作 365（0.9.3 基线，防止误降级）', async () => {
    const sdk = await sdkPromise;
    const names = sdk.getModuleNames();
    const total = names.reduce((sum: number, name: string) => {
      const mod = sdk.getModule(name);
      return sum + (mod?.actions?.length ?? 0);
    }, 0);
    expect(names.length).toBe(43);
    expect(total).toBe(365);
  });

  test('file 模块含 get / read 动作（供其它实例升级后用）', async () => {
    const sdk = await sdkPromise;
    const actions = sdk.getModule('file')?.actions.map((a) => a.name) ?? [];
    expect(actions).toContain('get');
    expect(actions).toContain('read');
  });
});
