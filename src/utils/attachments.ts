/**
 * 禅道附件解析（纯函数，不做任何 IO）
 *
 * 为什么需要它 —— 三条实测结论，少一条就取不到图：
 *
 * 1. **Bug 实体的 `files` 字段形态随实例/版本而变**，绝不能假设只有数组：
 *      - 有的实例/老数据是 `[]`（实测 2010511 / 2010520）；
 *      - 有的实例（max8.2，2026-11-18 实测）是**以 fileID 为键的对象字典**：
 *        `{"2018691": {id, title, extension, size, webPath, ...}}`，
 *        里面装的是测试人员上传的独立附件（xlsx 等），不在 steps 里。
 *    只处理数组会把这类独立附件**整个漏掉**。截图则贴在「重现步骤」富文本里：
 *      `<img src="/zentaomax/index.php?m=file&f=read&t=png&fileID=2016187">`
 *    所以三处都要扫，且 files 字段必须兼容数组 / 字典 / 单值三种形态。
 *
 * 2. `GET /api.php/v2/files/{id}` 是有效端点，返回
 *      `{ file: { id, title, extension, size, addedBy, objectType, objectID }, status: 'success' }`
 *    ⚠️ 但 **`size` 字段装的其实是服务器绝对路径，不是字节数**：
 *      `/opt/zbox/app/zentaomax/www/data/upload/1/202609/09171606076498e3`
 *    存储文件名**没有扩展名**，真名（含扩展名）在 `title` 里，如
 *    `企业微信截图_17889447957737.png`。
 *
 * 3. 把该路径去掉 `.../www/` 前缀，拼成 `{站点根}/data/upload/...` → **200 + 真图片**，
 *    且**不需要任何认证**。也就是说 `data/upload/**` 是个匿名可读的静态目录
 *    （只要猜到那串随机存储名）。本工具仍会带 Token 去取 —— 万一该实例哪天收紧了权限，
 *    带着认证照样能拿到，但不依赖它。
 */

/** 一个附件引用：从哪来的、ID 是多少 */
export interface AttachmentRef {
  fileID: number;
  /** 引用来源：files 字段 / 重现步骤 / 操作历史备注 */
  source: 'files' | 'steps' | 'comment';
}

/**
 * 从一段 HTML 里捞出所有附件 ID（保序去重）。
 * 兼容 `fileID=123` / `fileID:123` / `fileID="123"` 三种写法。
 */
export function extractFileIds(html: unknown): number[] {
  if (typeof html !== 'string' || !html) return [];

  const out: number[] = [];
  const seen = new Set<number>();
  const re = /fileID\s*[=:]\s*['"]?(\d+)/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = Number(m[1]);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 归一化 `files` 字段里的附件 ID。
 *
 * 三种形态都要认（2026-11-18 实测补齐字典形态）：
 *  1. 数组：`[123, "456", {id: 789}]`；
 *  2. **对象字典**：`{"2018691": {id: 2018691, ...}, "2018692": {...}}`
 *     —— max8.2 的独立附件（xlsx 等）走这种，键和值里的 id 都能用；
 *  3. 单个值：`123` / `{id: 123}`。
 *
 * 之前的版本只认数组，导致字典形态的独立附件（测试人员上传的 Excel）全被漏掉。
 */
export function extractFileIdsFromFiles(files: unknown): number[] {
  if (files === null || files === undefined) return [];

  const out: number[] = [];
  const push = (v: unknown) => {
    const id = v && typeof v === 'object' && 'id' in (v as any)
      ? Number((v as any).id)
      : Number(v);
    if (Number.isFinite(id) && id > 0 && !out.includes(id)) out.push(id);
  };

  if (Array.isArray(files)) {
    files.forEach(push);
  } else if (typeof files === 'object') {
    // 单个 {id: 123} 对象：直接取 id（别当字典遍历，否则键 "id" 会被当 fileID 丢掉）
    if ('id' in (files as any)) {
      push(files);
    } else {
      // 字典：键是 fileID，值是附件对象。优先取对象里的 id，回退到键。
      for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
        const obj = value && typeof value === 'object' && 'id' in (value as any)
          ? Number((value as any).id)
          : Number(key);
        if (Number.isFinite(obj) && obj > 0 && !out.includes(obj)) out.push(obj);
      }
    }
  } else {
    push(files);
  }
  return out;
}

/**
 * 汇总一个 Bug 上所有附件引用。
 *
 * 三处都扫：`files` 字段 → `steps` 富文本 → 操作历史的 `comment`。
 * 实测复现步骤里贴的图**只出现在 steps**，但用户回复时补的图会在 comment 里，
 * 漏扫一条就会得出「这个 Bug 没附件」的错误结论。
 */
export function collectAttachmentRefs(bug: any, actions?: any[]): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<number>();

  const push = (id: number, source: AttachmentRef['source']) => {
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ fileID: id, source });
  };

  for (const id of extractFileIdsFromFiles(bug?.files)) push(id, 'files');
  for (const id of extractFileIds(bug?.steps)) push(id, 'steps');
  for (const action of Array.isArray(actions) ? actions : []) {
    for (const id of extractFileIds(action?.comment)) push(id, 'comment');
  }

  return refs;
}

/**
 * 服务器绝对路径 → 站点相对路径。
 *
 * 例：`/opt/zbox/app/zentaomax/www/data/upload/1/202609/abc` → `data/upload/1/202609/abc`
 * 拿不到就返回 null —— 别的禅道版本这里可能真的存字节数（如 `"176376"`），
 * 那种情况说明该实例不走这条路，宁可报错也不要拼出一个必然 404 的 URL。
 */
export function toSiteRelativePath(serverPath: unknown): string | null {
  if (typeof serverPath !== 'string') return null;

  const raw = serverPath.trim();
  if (!raw) return null;
  // 纯数字 = 真的是字节数，不是路径
  if (/^\d+$/.test(raw)) return null;
  // 本来就是完整 URL 的，不猜
  if (/^https?:\/\//i.test(raw)) return null;

  // 优先从最后一个 `/www/` 后面切（路径里可能还有别的 www 段）
  const marker = raw.lastIndexOf('/www/');
  if (marker >= 0) return raw.slice(marker + '/www/'.length).replace(/^\/+/, '');

  const upload = raw.indexOf('/data/upload/');
  if (upload >= 0) return raw.slice(upload + 1).replace(/^\/+/, '');

  // 已经是相对路径的形态
  if (/^data\/upload\//i.test(raw)) return raw;

  return null;
}

/** 拼出可直取的静态资源 URL。baseUrl 形如 `http://host/zentaomax` */
export function buildStaticUrl(baseUrl: string, serverPath: unknown): string | null {
  const rel = toSiteRelativePath(serverPath);
  if (!rel) return null;
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${rel}`;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']);

/** 扩展名是否属于图片（决定要不要提示模型「可以看图」） */
export function isImageExtension(ext: unknown): boolean {
  return IMAGE_EXTENSIONS.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

/**
 * 生成安全且可读的本地文件名。
 *
 * 前缀 fileID 是故意的：同一个 Bug 下多张图很可能同名
 * （企业微信截图_xxx.png 这种），不加前缀会互相覆盖。
 * 同时把路径分隔符、控制字符、开头的点都清掉 —— `title` 是服务端来的字符串，
 * 不能假设它安全，`../` 之类的东西不能让它写出目录。
 */
export function safeFileName(title: unknown, fileID: number, extension?: unknown): string {
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');

  let name = typeof title === 'string' ? title.trim() : '';
  name = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();

  // 标题不可用时直接用 fileID 当文件名 —— 注意这里必须**提前返回**，
  // 否则下面还会再补一次 fileID 前缀，得到 `7-7.png` 这种重复命名的垃圾。
  if (!name) return ext ? `${fileID}.${ext}` : String(fileID);

  // title 通常已带扩展名；没带（或带错了）就补一个，方便宿主按后缀识别
  if (ext && !name.toLowerCase().endsWith(`.${ext}`)) name = `${name}.${ext}`;

  // 防御长标题：保留扩展名，砍中间
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const suffix = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 120 - suffix.length) + suffix;
  }

  return `${fileID}-${name}`;
}

export type BinaryKind = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'html' | 'unknown';

/**
 * 按魔数嗅探响应体。
 *
 * 主要用途：区分「真图片」和「被重定向到登录页的 HTML」。
 * 禅道的 `m=file&f=read` 在前台一律 302 到登录页，而静态直取是 200；
 * 这两种情况都可能返回「一个 200 的响应」，只有看内容才知道拿到的是不是图。
 * ⚠️ 本实例的静态响应**连 content-type 都不给**，所以只能看魔数，不能信头部。
 */
export function sniffBinary(buf: Buffer): BinaryKind {
  if (!buf || buf.length < 4) return 'unknown';

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  const head = buf.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<!--')) {
    return 'html';
  }

  return 'unknown';
}

/** 字节数 → 人能读的大小 */
export function formatBytes(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '-';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}
