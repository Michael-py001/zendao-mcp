/**
 * Bug 附件（截图）获取 —— 离线回归测试
 *
 * 全程用本机 mock HTTP 服务 + 真实 ZenTaoClient，**不碰真实禅道**，可离线反复跑。
 *
 * 这里守的是三类很容易悄悄坏掉、且坏了不报错的点：
 *
 *   1. **附件藏在 steps 的 HTML 里**（Bug 实体的 `files` 字段恒为空数组）。
 *      正则一旦写窄（比如只认 `fileID="123"`），就会得出「这条 Bug 没图」的
 *      假阴性 —— 而这是**最像真话的错误答案**，模型会直接顺着往下答。
 *   2. **元数据的 `size` 字段装的是服务器绝对路径**，不是字节数。
 *      哪天有人"顺手修"成 `Number(size)` 当大小用，下载链路当场全断。
 *   3. **被重定向到登录页时是 200 + HTML**。若不按魔数校验，会把一个 HTML
 *      文件存成 `.png` 交给模型 —— 图打不开，但工具报告「成功」。
 *
 * 另外补一条本仓库特有的守卫：`structuredContent` 的顶层键必须**恰好等于**
 * outputSchema 声明过的键。`npm run verify` 是手写 JSON-RPC 探针、不做 ajv 校验，
 * 天生长不出这双眼睛 —— 09-15 那批「详情类工具全炸」正是这么漏过去的。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';

import { ZenTaoClient } from '../../src/client';
import { LRUCache } from '../../src/utils/cache';
import { Logger, LogLevel } from '../../src/utils/logger';
import { getBugAttachments } from '../../src/tools/getBugAttachments';
import {
  buildStaticUrl,
  collectAttachmentRefs,
  extractFileIds,
  extractFileIdsFromFiles,
  formatBytes,
  isImageExtension,
  safeFileName,
  sniffBinary,
  toSiteRelativePath,
} from '../../src/utils/attachments';

// ---------------------------------------------------------------------------
// 纯函数部分
// ---------------------------------------------------------------------------

/** 真实数据：Bug 2010511 的 steps 原文（截自实际响应） */
const REAL_STEPS =
  '<p><span>[步骤]</span></p><p><span>1、一级标题下无明细内容，对应一级标题未在平台展示</span></p>' +
  '<p><img onload="setImageSize(this,0)" src="/zentaomax/index.php?m=file&f=read&t=png&fileID=2016187" ' +
  'alt="index.php?m=file&amp;f=read&amp;t=png&amp;fileID=2016187" /></p>' +
  '<p><span>2、二级标题下无明细内容，对应二级标题未在平台展示，见图：</span></p>' +
  '<p><span><img onload="setImageSize(this,0)" src="/zentaomax/index.php?m=file&f=read&t=png&fileID=2016188" /></span></p>';

/** 真实数据：文件元数据里的 size 字段（是路径，不是字节数） */
const REAL_SERVER_PATH = '/opt/zbox/app/zentaomax/www/data/upload/1/202609/09171606076498e3';
const REAL_RELATIVE_PATH = 'data/upload/1/202609/09171606076498e3';

describe('附件解析（纯函数）', () => {
  describe('extractFileIds —— 从 HTML 里捞附件 ID', () => {
    test('真实 steps 里应捞出 2 个 ID，且保持出现顺序', () => {
      expect(extractFileIds(REAL_STEPS)).toEqual([2016187, 2016188]);
    });

    test('兼容 fileID=123 / fileID:"123" / fileID: 123 三种写法', () => {
      expect(extractFileIds('<a href="x?fileID=11">')).toEqual([11]);
      expect(extractFileIds('<img src="x?fileID=\'22\'">')).toEqual([22]);
      expect(extractFileIds('fileID: 33')).toEqual([33]);
    });

    test('同一个 ID 出现多次只保留一个，位置取首次出现', () => {
      expect(extractFileIds('fileID=7 ... fileID=9 ... fileID=7')).toEqual([7, 9]);
    });

    test('非字符串 / 空值 / 无命中都不炸', () => {
      expect(extractFileIds(undefined)).toEqual([]);
      expect(extractFileIds(null)).toEqual([]);
      expect(extractFileIds(12345)).toEqual([]);
      expect(extractFileIds('这里没有附件')).toEqual([]);
    });

    test('ID 为 0 的脏数据要被丢掉（不是合法 fileID）', () => {
      expect(extractFileIds('fileID=0')).toEqual([]);
    });
  });

  describe('extractFileIdsFromFiles —— files 字段归一化', () => {
    test('空数组（本实例的真实形态）返回空', () => {
      expect(extractFileIdsFromFiles([])).toEqual([]);
    });

    test('数字 / 字符串 / {id} 对象三种元素都认', () => {
      expect(extractFileIdsFromFiles([1, '2', { id: 3 }])).toEqual([1, 2, 3]);
    });

    test('⭐ files 是对象字典（max8.2 独立附件）时也要全部捞出', () => {
      // 2026-11-18 实测：2011366 的 files 是 {"2018691":{id,...}}，
      // 旧实现只认数组，把测试人员上传的 xlsx 整个漏掉。
      const dict = {
        '2018691': { id: 2018691, title: '工程量报价单格式.xlsx', extension: 'xlsx' },
        '2018692': { id: 2018692, title: '另一份.xlsx' },
      };
      expect(extractFileIdsFromFiles(dict)).toEqual([2018691, 2018692]);
    });

    test('单值（数字 / {id}）也认', () => {
      expect(extractFileIdsFromFiles(2018691)).toEqual([2018691]);
      expect(extractFileIdsFromFiles({ id: 7 })).toEqual([7]);
    });

    test('空值 / 空字典 / 脏数据返回空', () => {
      expect(extractFileIdsFromFiles(undefined)).toEqual([]);
      expect(extractFileIdsFromFiles(null)).toEqual([]);
      expect(extractFileIdsFromFiles({})).toEqual([]);
      expect(extractFileIdsFromFiles({ abc: { id: 0 } })).toEqual([]);
    });
  });

  describe('collectAttachmentRefs —— 三处来源合并', () => {
    const bug = {
      files: [{ id: 100 }],
      steps: '<img src="?fileID=200" />',
    };
    const actions = [{ comment: '<img src="?fileID=300" />' }, { comment: 'fileID=200' }];

    test('files / steps / comment 三处都扫，并标注来源', () => {
      const refs = collectAttachmentRefs(bug, actions);
      expect(refs.map((r) => r.fileID)).toEqual([100, 200, 300]);
      expect(refs.map((r) => r.source)).toEqual(['files', 'steps', 'comment']);
    });

    test('重复 ID 只保留第一次出现（来源以先扫到的为准）', () => {
      const refs = collectAttachmentRefs(bug, actions);
      expect(refs.filter((r) => r.fileID === 200)).toHaveLength(1);
      expect(refs.find((r) => r.fileID === 200)!.source).toBe('steps');
    });

    test('actions 缺失 / 非数组都不炸', () => {
      expect(collectAttachmentRefs({ steps: 'fileID=5' }).map((r) => r.fileID)).toEqual([5]);
      expect(collectAttachmentRefs({ steps: 'fileID=5' }, undefined as any).map((r) => r.fileID)).toEqual([5]);
    });
  });

  describe('toSiteRelativePath —— 服务器绝对路径 → 站点相对路径', () => {
    test('真实路径应剥掉 /www/ 前缀', () => {
      expect(toSiteRelativePath(REAL_SERVER_PATH)).toBe(REAL_RELATIVE_PATH);
    });

    test('路径里出现多个 /www/ 时取最后一个（前面的可能是站点名）', () => {
      expect(toSiteRelativePath('/opt/www/zentaomax/www/data/upload/1/x')).toBe('data/upload/1/x');
    });

    test('没有 /www/ 但含 /data/upload/ 也能切出来', () => {
      expect(toSiteRelativePath('/srv/app/data/upload/1/x')).toBe('data/upload/1/x');
    });

    test('⚠️ 纯数字（真的是字节数的实例）必须返回 null，不能拼出假 URL', () => {
      expect(toSiteRelativePath('176376')).toBeNull();
      expect(toSiteRelativePath(176376)).toBeNull();
    });

    test('完整 URL / 空值 / 无关路径都返回 null', () => {
      expect(toSiteRelativePath('https://x.com/data/upload/1/a')).toBeNull();
      expect(toSiteRelativePath('')).toBeNull();
      expect(toSiteRelativePath(undefined)).toBeNull();
      expect(toSiteRelativePath('/opt/zbox/app/zentaomax/www/index.php')).toBe('index.php');
    });
  });

  describe('buildStaticUrl', () => {
    test('拼出可直取的地址，并吃掉 baseUrl 结尾多余的斜杠', () => {
      expect(buildStaticUrl('http://zen.example.com/zentaomax', REAL_SERVER_PATH)).toBe(
        `http://zen.example.com/zentaomax/${REAL_RELATIVE_PATH}`
      );
      expect(buildStaticUrl('http://zen.example.com/zentaomax/', REAL_SERVER_PATH)).toBe(
        `http://zen.example.com/zentaomax/${REAL_RELATIVE_PATH}`
      );
    });

    test('路径不可解析时返回 null', () => {
      expect(buildStaticUrl('http://h/zentaomax', '176376')).toBeNull();
    });
  });

  describe('safeFileName —— 文件名必须安全且不互相覆盖', () => {
    test('正常标题补上 fileID 前缀（同 Bug 下同名截图很常见）', () => {
      expect(safeFileName('企业微信截图_17889447957737.png', 2016187, 'png')).toBe(
        '2016187-企业微信截图_17889447957737.png'
      );
    });

    test('标题没带扩展名时自动补上', () => {
      expect(safeFileName('image', 5, 'png')).toBe('5-image.png');
    });

    test('标题把扩展名写错了也要纠正', () => {
      expect(safeFileName('shot.bmp', 5, 'png')).toBe('5-shot.bmp.png');
    });

    test('⚠️ 路径穿越必须被清掉，不能写出目录', () => {
      // 不断言字面结果（清洗顺序改一下就变），只断言「安全」这个本质
      for (const evil of ['../../evil.png', '..\\..\\evil.png', '../', '.hidden.png']) {
        const name = safeFileName(evil, 9, 'png');
        expect(name).not.toContain('/');
        expect(name).not.toContain('\\');
        expect(name.startsWith('.')).toBe(false);
        expect(name.startsWith('9-')).toBe(true);
      }
      expect(safeFileName('../../evil.png', 9, 'png').endsWith('.png')).toBe(true);
    });

    test('Windows 非法字符与控制字符要替换掉', () => {
      const name = safeFileName('a:b*c?d"e<f>g|h\u0000i.png', 1, 'png');
      expect(name).toBe('1-a_b_c_d_e_f_g_h_i.png');
    });

    test('标题为空 / 纯空白 / 纯点 → 退回 fileID 命名', () => {
      expect(safeFileName('', 7, 'png')).toBe('7.png');
      expect(safeFileName('   ', 7, 'png')).toBe('7.png');
      expect(safeFileName('..', 7, 'png')).toBe('7.png');
      expect(safeFileName(undefined, 7)).toBe('7');
    });

    test('超长标题被截断但保留扩展名', () => {
      const name = safeFileName('x'.repeat(500) + '.png', 1, 'png');
      expect(name.length).toBeLessThanOrEqual(120 + String(1).length + 1);
      expect(name.endsWith('.png')).toBe(true);
    });
  });

  describe('sniffBinary —— 只能看魔数（本实例的静态响应连 content-type 都不给）', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);
    const bmp = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(32)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);

    test('各种图片格式都能认出来', () => {
      expect(sniffBinary(png)).toBe('png');
      expect(sniffBinary(jpeg)).toBe('jpeg');
      expect(sniffBinary(gif)).toBe('gif');
      expect(sniffBinary(bmp)).toBe('bmp');
      expect(sniffBinary(webp)).toBe('webp');
    });

    test('⚠️ 登录页 HTML 必须被识别出来（否则会被存成 .png 交给模型）', () => {
      expect(sniffBinary(Buffer.from('<!DOCTYPE html><html>...'))).toBe('html');
      expect(sniffBinary(Buffer.from('<html lang="zh">'))).toBe('html');
      expect(sniffBinary(Buffer.from('  \n<!-- comment -->'))).toBe('html');
    });

    test('认不出的一律 unknown，绝不瞎猜成图片', () => {
      expect(sniffBinary(Buffer.from('PK\u0003\u0004zip'))).toBe('unknown');
      expect(sniffBinary(Buffer.alloc(0))).toBe('unknown');
    });
  });

  describe('杂项', () => {
    test('isImageExtension 认常见图片后缀（大小写、带点都行）', () => {
      expect(isImageExtension('png')).toBe(true);
      expect(isImageExtension('.JPG')).toBe(true);
      expect(isImageExtension('docx')).toBe(false);
      expect(isImageExtension(undefined)).toBe(false);
    });

    test('formatBytes 输出人能读的大小', () => {
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(176376)).toBe('172.2 KB');
      expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
      expect(formatBytes('oops')).toBe('-');
    });
  });
});

// ---------------------------------------------------------------------------
// 端到端（本机 mock，离线）
// ---------------------------------------------------------------------------

const ME = 'your-account';
const MOCK_TOKEN = 'mock-token-abc';

/** 真实数据：Bug 2010511，两张截图 */
const BUG_ID = 2010511;
const FILE_A = 2016187;
const FILE_B = 2016188;
/** 一个「静态路径返回登录页 HTML」的陷阱附件，用来验证魔数校验 */
const FILE_TRAP = 9999001;

const PATH_A = '/opt/zbox/app/zentaomax/www/data/upload/1/202609/09171606076498e3';
const PATH_B = '/opt/zbox/app/zentaomax/www/data/upload/1/202609/0917161404555401';
const PATH_TRAP = '/opt/zbox/app/zentaomax/www/data/upload/1/202609/trapfile';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1024, 0x41),
]);

/** 拉起一个「行为对齐真实实例」的禅道 mock */
async function startMockZenTao(opts: { bugExists?: boolean; withAttachments?: boolean } = {}) {
  const requests: Array<{ method: string; pathname: string }> = [];

  const steps = opts.withAttachments === false
    ? '<p>没有附件的 Bug</p>'
    : '<p>见图：</p>' +
      `<p><img src="/zentaomax/index.php?m=file&f=read&t=png&fileID=${FILE_A}" /></p>` +
      `<p><img src="/zentaomax/index.php?m=file&f=read&t=png&fileID=${FILE_B}" /></p>`;

  const files: Record<number, any> = {
    [FILE_A]: {
      id: FILE_A,
      title: '企业微信截图_17889447957737.png',
      extension: 'png',
      // ⚠️ 真实实例这里装的是服务器绝对路径，不是字节数
      size: PATH_A,
      addedBy: 'zhulili',
      objectType: 'bug',
      objectID: BUG_ID,
    },
    [FILE_B]: {
      id: FILE_B,
      title: '企业微信截图_17889450332289.png',
      extension: 'png',
      size: PATH_B,
      addedBy: 'zhulili',
      objectType: 'bug',
      objectID: BUG_ID,
    },
    [FILE_TRAP]: {
      id: FILE_TRAP,
      title: '被弹到登录页的图.png',
      extension: 'png',
      size: PATH_TRAP,
      addedBy: 'zhulili',
      objectType: 'bug',
      objectID: BUG_ID,
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      requests.push({ method: req.method || '', pathname });

      const json = (payload: any, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // 换 Token
      if (req.method === 'POST' && pathname === '/api.php/v2/users/login') {
        return json({ status: 'success', token: MOCK_TOKEN, user: { account: ME } });
      }

      // Bug 详情：files 恒为空数组，附件只在 steps 里（真实形态）
      if (req.method === 'GET' && pathname === `/api.php/v2/bugs/${BUG_ID}`) {
        if (opts.bugExists === false) return json({ status: 'fail', message: 'Bug does not exist' });
        return json({
          status: 'success',
          bug: { id: BUG_ID, title: '一级标题或二级标题下无明细内容，对应标题未在平台展示', steps, files: [] },
          actions: [{ id: 1, actor: 'zhulili', action: 'opened', comment: '' }],
        });
      }

      // 不存在的 Bug：禅道不返回 404，而是 status=fail
      if (req.method === 'GET' && /^\/api\.php\/v2\/bugs\/\d+$/.test(pathname)) {
        return json({ status: 'fail', message: 'Bug does not exist' });
      }

      // 文件元数据
      const fileMatch = /^\/api\.php\/v2\/files\/(\d+)$/.exec(pathname);
      if (req.method === 'GET' && fileMatch) {
        const file = files[Number(fileMatch[1])];
        if (!file) return json({ status: 'fail', message: 'File does not exist' });
        return json({ status: 'success', file });
      }

      // 静态直取：故意**不给 content-type**（与真实实例一致）
      if (req.method === 'GET' && pathname.startsWith('/data/upload/')) {
        if (pathname.endsWith('trapfile')) {
          res.writeHead(200);
          return res.end('<!DOCTYPE html><html><body>登录</body></html>');
        }
        res.writeHead(200);
        return res.end(PNG_BYTES);
      }

      json({ status: 'fail', message: `no route for ${pathname}` }, 404);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    server,
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** NO_PROXY 存取，防止本机 HTTP_PROXY 把回环请求改写 */
function mockNoProxy() {
  let savedUpper: string | undefined;
  let savedLower: string | undefined;
  return {
    install() {
      savedUpper = process.env.NO_PROXY;
      savedLower = process.env.no_proxy;
      process.env.NO_PROXY = '127.0.0.1,localhost';
      process.env.no_proxy = '127.0.0.1,localhost';
    },
    restore() {
      if (savedUpper === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = savedUpper;
      if (savedLower === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = savedLower;
    },
  };
}

/** outputSchema 声明过的顶层键 —— 多一个少一个都会让宿主的 ajv 校验拦下这次调用 */
const DECLARED_KEYS = ['bugID', 'bugTitle', 'count', 'downloaded', 'attachments'];

describe('Bug 附件端到端（本机 mock，离线）', () => {
  let mock: Awaited<ReturnType<typeof startMockZenTao>>;
  let client: ZenTaoClient;
  let cache: LRUCache<string, any>;
  let outDir: string;
  const noProxy = mockNoProxy();

  beforeAll(async () => {
    noProxy.install();
    mock = await startMockZenTao();
  });

  beforeEach(async () => {
    mock.requests.length = 0;
    cache = new LRUCache<string, any>();
    client = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      new Logger(LogLevel.ERROR)
    );
    // 每个用例一个干净目录，避免上一个用例下载的文件造成「命中缓存」假象
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendao-attach-test-'));
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await mock.close();
    noProxy.restore();
  });

  test('⭐ 从 steps 里捞出两张截图并真的下载到本地', async () => {
    const result = await getBugAttachments(client, cache, { bugID: BUG_ID, outputDir: outDir });

    expect(result.isError).toBeFalsy();
    const sc: any = result.structuredContent;
    expect(sc.count).toBe(2);
    expect(sc.downloaded).toBe(2);

    for (const fileID of [FILE_A, FILE_B]) {
      const item = sc.attachments.find((a: any) => a.fileID === fileID);
      expect(item).toBeDefined();
      expect(item.isImage).toBe(true);
      expect(item.source).toBe('重现步骤');
      // 魔数证明拿到的是真图片，而不是 200 的登录页
      expect(item.kind).toBe('png');
      expect(item.bytes).toBe(PNG_BYTES.length);

      // 本地文件必须真实存在且内容一致
      expect(item.localPath).toBeTruthy();
      expect(fs.existsSync(item.localPath)).toBe(true);
      expect(fs.readFileSync(item.localPath).equals(PNG_BYTES)).toBe(true);

      // 静态 URL 必须是按「剥掉 /www/ 前缀」的规则拼出来的
      expect(item.url).toBe(`${mock.baseUrl}/data/upload/1/202609/${fileID === FILE_A ? '09171606076498e3' : '0917161404555401'}`);
    }

    // 本地路径必须是绝对路径（宿主才能直接打开）
    for (const a of sc.attachments) {
      expect(path.isAbsolute(a.localPath)).toBe(true);
      expect(a.localPath.startsWith(outDir)).toBe(true);
    }

    // 文案里要给到本地路径，模型才知道去哪看图
    const text = String((result.content as any)[0].text);
    expect(text).toContain('本地路径');
    expect(text).toContain(sc.attachments[0].localPath);
  });

  test('⚠️ 结构化返回的顶层键必须与 outputSchema 声明完全一致', async () => {
    const result = await getBugAttachments(client, cache, { bugID: BUG_ID, outputDir: outDir });
    const sc: any = result.structuredContent;

    expect(Object.keys(sc).sort()).toEqual([...DECLARED_KEYS].sort());
    // 附件对象本身走 z.any()，可以自由携带字段；但它必须是数组
    expect(Array.isArray(sc.attachments)).toBe(true);
  });

  test('重复调用命中已下载的文件，不重复发请求', async () => {
    await getBugAttachments(client, cache, { bugID: BUG_ID, outputDir: outDir });
    const firstRound = mock.requests.filter((r) => r.pathname.startsWith('/data/upload/')).length;
    expect(firstRound).toBe(2);

    mock.requests.length = 0;
    const second = await getBugAttachments(client, cache, { bugID: BUG_ID, outputDir: outDir });
    const secondRound = mock.requests.filter((r) => r.pathname.startsWith('/data/upload/')).length;

    expect(secondRound).toBe(0); // 复用了本地文件
    expect((second.structuredContent as any).downloaded).toBe(2);
    expect((second.structuredContent as any).attachments.every((a: any) => a.kind === 'cached')).toBe(true);
  });

  test('force=true 时强制重新下载', async () => {
    await getBugAttachments(client, cache, { bugID: BUG_ID, outputDir: outDir });
    mock.requests.length = 0;
    await getBugAttachments(client, cache, { bugID: BUG_ID, outputDir: outDir, force: true });

    expect(mock.requests.filter((r) => r.pathname.startsWith('/data/upload/')).length).toBe(2);
  });

  test('download=false 时只给元数据与 URL，不落盘', async () => {
    const result = await getBugAttachments(client, cache, { bugID: BUG_ID, download: false, outputDir: outDir });
    const sc: any = result.structuredContent;

    expect(sc.downloaded).toBe(0);
    expect(sc.attachments).toHaveLength(2);
    for (const a of sc.attachments) {
      expect(a.url).toBeTruthy();
      expect(a.localPath).toBeUndefined();
    }
    expect(mock.requests.filter((r) => r.pathname.startsWith('/data/upload/'))).toHaveLength(0);

    // 连目录都不该被创建
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0).toBe(0);
  });

  test('⚠️ 静态地址返回登录页 HTML 时必须报错，绝不能存成 .png', async () => {
    // 造一条 steps 里指向「陷阱附件」的 Bug：复用 2010511 的 mock，
    // 这里直接把 trap 的 fileID 塞进 files 字段走一遍完整链路。
    const trapSteps = `<img src="/zentaomax/index.php?m=file&f=read&t=png&fileID=${FILE_TRAP}" />`;
    const trapClient = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      new Logger(LogLevel.ERROR)
    );
    // 用打桩替换 get：只为了把 trapSteps 喂进去，其余仍走真实 mock
    const originalGet = trapClient.get.bind(trapClient);
    (trapClient as any).get = async (endpoint: string, params?: any) => {
      if (endpoint === `/bugs/${BUG_ID}`) {
        return { status: 'success', bug: { id: BUG_ID, title: '陷阱', steps: trapSteps, files: [] } };
      }
      return originalGet(endpoint, params);
    };

    const result = await getBugAttachments(trapClient, cache, { bugID: BUG_ID, outputDir: outDir });
    const item = (result.structuredContent as any).attachments[0];

    expect(item.error).toContain('HTML');
    expect(item.localPath).toBeUndefined();
    expect((result.structuredContent as any).downloaded).toBe(0);
    // 目录里不能出现被污染的文件
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0).toBe(0);
    // 文案要警告「别据此断定没图」
    expect(String((result.content as any)[0].text)).toContain('别据此断定');
  });

  test('⭐ files 字段是对象字典时，独立 xlsx 附件也要下载到本地（2026-11-18 回归）', async () => {
    const XLSX_ID = 2018691;
    const XLSX_PATH = '/opt/zbox/app/zentaomax/www/data/upload/1/202611/1117072905201711';
    const XLSX_BYTES = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(512, 0x42)]);

    const dictClient = new ZenTaoClient(
      { baseUrl: mock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      new Logger(LogLevel.ERROR)
    );
    const originalGet = dictClient.get.bind(dictClient);
    (dictClient as any).get = async (endpoint: string, params?: any) => {
      if (endpoint === `/bugs/${BUG_ID}`) {
        return {
          status: 'success',
          bug: {
            id: BUG_ID, title: '带独立附件的 Bug', steps: '',
            files: { [String(XLSX_ID)]: { id: XLSX_ID, title: '工程量报价单格式.xlsx' } },
          },
          actions: [],
        };
      }
      if (endpoint === `/files/${XLSX_ID}`) {
        return {
          status: 'success',
          file: { id: XLSX_ID, title: '工程量报价单格式.xlsx', extension: 'xlsx', size: XLSX_PATH },
        };
      }
      return originalGet(endpoint, params);
    };
    const origFetch = dictClient.fetchBinary.bind(dictClient);
    (dictClient as any).fetchBinary = async (url: string) => {
      if (url.endsWith('1117072905201711')) return { status: 200, data: XLSX_BYTES };
      return origFetch(url);
    };

    const result = await getBugAttachments(dictClient, cache, { bugID: BUG_ID, outputDir: outDir });
    const sc: any = result.structuredContent;

    expect(sc.count).toBe(1);
    expect(sc.downloaded).toBe(1);
    const item = sc.attachments[0];
    expect(item.fileID).toBe(XLSX_ID);
    expect(item.source).toBe('附件字段');
    expect(item.isImage).toBe(false);
    expect(fs.existsSync(item.localPath)).toBe(true);
    expect(fs.readFileSync(item.localPath).equals(XLSX_BYTES)).toBe(true);
  });

  test('没有附件的 Bug：count=0，但不是错误', async () => {
    const quietMock = await startMockZenTao({ withAttachments: false });
    const quietClient = new ZenTaoClient(
      { baseUrl: quietMock.baseUrl, account: ME, password: 'p@ss', timeout: 5000, retry: 0 },
      new Logger(LogLevel.ERROR)
    );

    try {
      const result = await getBugAttachments(quietClient, cache, { bugID: BUG_ID, outputDir: outDir });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as any).count).toBe(0);
      expect((result.structuredContent as any).attachments).toEqual([]);
      expect(String((result.content as any)[0].text)).toContain('没有附件引用');
    } finally {
      await quietMock.close();
    }
  });

  test('Bug 不存在时给出可操作的错误，而不是空结果', async () => {
    const result = await getBugAttachments(client, cache, { bugID: 999999999, outputDir: outDir });
    expect(result.isError).toBe(true);
    expect(String((result.content as any)[0].text)).toContain('未找到 Bug');
    // 关键：不能是「没有附件」这种会误导人的成功结果
    expect(result.structuredContent).toBeUndefined();
  });

  test('bugID 非法时直接拒绝', async () => {
    const result = await getBugAttachments(client, cache, { bugID: 0 } as any);
    expect(result.isError).toBe(true);
    expect(String((result.content as any)[0].text)).toContain('正整数');
  });
});
