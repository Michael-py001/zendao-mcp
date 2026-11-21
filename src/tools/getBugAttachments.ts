/**
 * Bug 附件（截图）获取
 *
 * 为什么要有这个工具：主人那边的 Bug 几乎条条都是「见图」型 —— 复现步骤里贴的截图
 * 才是信息主体，`steps` 的文字只有一句话。而 `zendao_get_bug` 返回的 `steps`
 * 被转成 Markdown 后只剩一个 `![](/zentaomax/index.php?m=file&f=read&t=png&fileID=2016187)`
 * —— 模型看得见「有图」，但取不到图。
 *
 * 本工具把这条链路打通：从 `steps` 里捞 `fileID` → 查元数据拿到服务器存储路径 →
 * 拼静态 URL 下载 → 落到本地临时目录，把**本地绝对路径**交给调用方（宿主可直接 Read）。
 *
 * ⚠️ 两个必须记住的实测事实（细节见 utils/attachments.ts）：
 * - Bug 实体的 `files` 字段**恒为空数组**，附件只在 `steps` 的 HTML 里；
 * - 文件元数据的 **`size` 字段装的是服务器绝对路径**，不是字节数。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { extractOne } from '../utils/response';
import {
  AttachmentRef,
  buildStaticUrl,
  collectAttachmentRefs,
  formatBytes,
  isImageExtension,
  safeFileName,
  sniffBinary,
} from '../utils/attachments';

export interface GetBugAttachmentsArgs {
  /** Bug ID */
  bugID: number;
  /** 是否把文件下载到本地（默认 true）。false 时只返回元数据与可直取 URL */
  download?: boolean;
  /** 本地保存目录，默认 `{系统临时目录}/zendao-attachments/{bugID}` */
  outputDir?: string;
  /** 已存在时是否重新下载，默认 false（复用上次下载的结果） */
  force?: boolean;
}

/** 下载并发数。附件通常只有几张，这个值只是避免一条 Bug 挂十几张图时排队等太久 */
const DOWNLOAD_CONCURRENCY = 4;

const SOURCE_LABELS: Record<AttachmentRef['source'], string> = {
  files: '附件字段',
  steps: '重现步骤',
  comment: '操作历史备注',
};

/** 本地保存根目录：宿主拉起 MCP 时 cwd 不受我们控制，所以绝不依赖 cwd */
function defaultOutputDir(): string {
  return process.env.ZENTAO_ATTACHMENT_DIR || path.join(os.tmpdir(), 'zendao-attachments');
}

/** 有并发上限的 map：避免一条 Bug 挂十几张图时把禅道打出一串超时 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return out;
}

/** 解析出来的单个附件 */
interface ResolvedAttachment {
  fileID: number;
  source: string;
  title?: string;
  extension?: string;
  isImage: boolean;
  /** 可直取的静态 URL（拿不到时为 null） */
  url?: string | null;
  /** 本地绝对路径（未下载则没有） */
  localPath?: string;
  bytes?: number;
  /** 魔数嗅探结果，用来证明「这确实是张图」而不是登录页 HTML */
  kind?: string;
  error?: string;
}

/**
 * 获取 Bug 的附件（截图）清单，并默认下载到本地。
 */
export async function getBugAttachments(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  args: GetBugAttachmentsArgs
): Promise<ToolResult> {
  void cache;

  const bugID = Number(args?.bugID);
  if (!Number.isFinite(bugID) || bugID <= 0) {
    return {
      content: [{ type: 'text', text: 'bugID 必须是正整数。可先用 zendao_list_my_bugs / zendao_list_bugs 拿到 ID。' }],
      isError: true,
    };
  }

  const shouldDownload = args.download !== false;

  try {
    // ---- 1) 取 Bug 详情（steps + actions 都要，附件可能藏在两处） ----
    // 单独包一层 try：禅道对不存在的 ID 不返回 404，而是返回 `{status:"fail"}`，
    // 客户端会把它抛成异常。这种「未找到」是调用方最容易犯的错（ID 抄错/复制漏位），
    // 必须翻译成能直接照做的提示，而不是甩一句 API 失败。
    let res: any;
    try {
      res = await client.get<any>(`/bugs/${bugID}`);
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (/not\s*exist|does\s*not\s*exist|不存在/i.test(msg)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `未找到 Bug ${bugID}。\n` +
                `禅道对不存在的 ID 不返回 404，而是返回 {status:"fail"}（本次返回：${msg}）。\n` +
                '请先用 zendao_list_my_bugs 或 zendao_list_bugs 确认 ID 是否正确。',
            },
          ],
          isError: true,
        };
      }
      throw error;
    }

    const bug = extractOne<any>(res, 'bug');

    if (!bug || !bug.id) {
      return {
        content: [
          {
            type: 'text',
            text:
              `未找到 Bug ${bugID}。\n` +
              '禅道对不存在的 ID 不返回 404，而是返回 `{status:"fail"}`，' +
              '所以请先用 zendao_list_my_bugs 或 zendao_list_bugs 确认 ID 是否正确。',
          },
        ],
        isError: true,
      };
    }

    const refs = collectAttachmentRefs(bug, res?.actions);

    if (!refs.length) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Bug ${bugID}「${bug.title || ''}」没有附件引用。\n` +
              '已扫描三处：files 字段、重现步骤（steps）、操作历史（actions.comment）。\n' +
              '注：files 字段在部分实例/老数据是空数组，用户贴的截图会内嵌在 steps 的 HTML 里；' +
              '另一些实例（如 max8.2）files 是以 fileID 为键的对象字典，装的是测试人员上传的独立附件（xlsx 等）。' +
              '三处都扫且兼容三种 files 形态；三处都没有，说明这条 Bug 确实没传附件。',
          },
        ],
        structuredContent: {
          bugID,
          bugTitle: String(bug.title || ''),
          count: 0,
          downloaded: 0,
          attachments: [],
        },
      };
    }

    // ---- 2) 逐个查元数据（拿到服务器存储路径，才拼得出静态 URL） ----
    const dir = args.outputDir || path.join(defaultOutputDir(), String(bugID));

    const resolved = await mapLimit(refs, DOWNLOAD_CONCURRENCY, async (ref) => {
      const item: ResolvedAttachment = {
        fileID: ref.fileID,
        source: SOURCE_LABELS[ref.source],
        isImage: false,
      };

      try {
        const metaRes = await client.get<any>(`/files/${ref.fileID}`);
        const file = extractOne<any>(metaRes, 'file') || {};

        item.title = file.title ? String(file.title) : undefined;
        item.extension = file.extension ? String(file.extension).toLowerCase() : undefined;
        item.isImage = isImageExtension(item.extension);

        // ⚠️ file.size 装的是服务器绝对路径，不是字节数（见模块头注释）
        item.url = buildStaticUrl(client.siteBaseUrl, file.size);

        if (!item.url) {
          item.error =
            '拿不到可直取的静态路径：文件元数据的 size 字段里没有可识别的 data/upload 路径，' +
            '**部分禅道部署**不支持这种取法。';
          return item;
        }

        if (!shouldDownload) return item;

        // ---- 3) 下载 ----
        const fileName = safeFileName(item.title, ref.fileID, item.extension);
        const localPath = path.join(dir, fileName);

        if (!args.force && fs.existsSync(localPath)) {
          const stat = fs.statSync(localPath);
          if (stat.size > 0) {
            item.localPath = localPath;
            item.bytes = stat.size;
            item.kind = 'cached';
            return item;
          }
        }

        const bin = await client.fetchBinary(item.url);

        if (bin.status < 200 || bin.status >= 300) {
          item.error = `下载失败：HTTP ${bin.status}${bin.location ? `（重定向到 ${bin.location}）` : ''}`;
          return item;
        }

        const kind = sniffBinary(bin.data);

        // 被重定向到登录页时会是 200 + HTML —— 这种情况必须报错，
        // 否则会把一个 HTML 文件存成 .png 交给模型，比直接失败更糟。
        if (kind === 'html') {
          item.error =
            '下载到的不是图片而是 HTML（多半被导到了登录页）。该实例的 data/upload 静态目录可能需要认证，' +
            '或文件已从服务器上删除。';
          return item;
        }

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, bin.data);

        item.localPath = localPath;
        item.bytes = bin.data.length;
        item.kind = kind;
        return item;
      } catch (error: any) {
        item.error = error?.message || '未知错误';
        return item;
      }
    });

    // ---- 4) 组装输出 ----
    const ok = resolved.filter((a) => !a.error);
    const failed = resolved.filter((a) => a.error);
    const images = ok.filter((a) => a.isImage);

    const header =
      `Bug ${bugID}「${bug.title || ''}」的附件：共 ${resolved.length} 个` +
      (ok.length ? `，成功 ${ok.length} 个` : '') +
      (failed.length ? `，失败 ${failed.length} 个` : '') +
      (shouldDownload ? '' : '（本次只查元数据，未下载）');

    const lines = resolved.map((a, i) => {
      const meta = [
        a.extension ? a.extension.toUpperCase() : '未知类型',
        a.bytes != null ? formatBytes(a.bytes) : null,
        `来源: ${a.source}`,
      ]
        .filter(Boolean)
        .join(' | ');

      const rows = [`  [${i + 1}] ${a.title || `文件 ${a.fileID}`}  (${meta})`];
      if (a.localPath) rows.push(`      本地路径: ${a.localPath}`);
      if (a.url) rows.push(`      直取 URL : ${a.url}`);
      if (a.error) rows.push(`      ⚠️ ${a.error}`);
      return rows.join('\n');
    });

    const tail: string[] = [];
    if (images.length && shouldDownload) {
      tail.push(
        `提示：其中 ${images.length} 个是图片，可直接用文件读取能力打开上面的本地路径查看内容` +
          '（禅道里很多 Bug 是「见图」型，看一眼截图比读 steps 文字有效得多）。'
      );
    }
    if (failed.length) {
      tail.push(
        `⚠️ 有 ${failed.length} 个附件没取到，别据此断定「这个 Bug 没图」——` +
          '失败原因见上方各行。'
      );
    }

    return {
      content: [{ type: 'text', text: [header, ...lines, ...tail].join('\n') }],
      structuredContent: {
        bugID,
        bugTitle: String(bug.title || ''),
        count: resolved.length,
        downloaded: shouldDownload ? ok.filter((a) => a.localPath).length : 0,
        attachments: resolved,
      },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `获取 Bug 附件失败: ${error?.message || '未知错误'}` }],
      isError: true,
    };
  }
}
