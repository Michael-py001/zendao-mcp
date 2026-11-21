/**
 * 通用附件读取（从 URL / HTML / fileID 取禅道附件内容）
 *
 * 从官方 zentao-cli 0.5.0 移植的思路：新 SDK 导出了
 * `extractFileIdFromUrl` / `extractFileIdsFromHtml`，能从任意富文本/图片链接里
 * 定位禅道文件 ID —— 不再局限于 Bug 的 steps 字段。
 *
 * ⚠️ 关键设计决策（为什么不直接用 SDK 的 file/read 动作）：
 * `file/read` 的最低版本是 max9.0 / 23.0，本实例 max8.2 跑不了（官方 0.5.0
 * 的 CLI 会先判版本再调）。所以本工具沿用项目里**已实测可用**的通路：
 * `GET /files/{id}` 取元数据（size 字段藏服务器存储路径）→ 拼 `data/upload/**`
 * 静态 URL → `fetchBinary` 下载。那条路在 max8.2 上验证过匿名可读。
 *
 * 与 `zendao_get_bug_attachments` 的分工：
 * - 后者：给 Bug ID，扫 files/steps/actions 三处，输出该 Bug 的全部截图；
 * - 本工具：给 fileID、附件 URL 或一段 HTML，提取并读取内容 —— 覆盖需求、任务、
 *   评论等任意对象的附件，是对后者的补充而非替代。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { extractOne } from '../utils/response';
import { getSdk } from '../sdk/loader';
import {
  buildStaticUrl,
  formatBytes,
  isImageExtension,
  safeFileName,
  sniffBinary,
} from '../utils/attachments';

export interface ReadAttachmentArgs {
  /** 单个文件 ID（正整数） */
  fileID?: number;
  /** 附件/图片链接，从中提取 fileID（支持路径路由和 GET 路由，相对或绝对地址） */
  url?: string;
  /** 一段富文本 HTML，按顺序提取里面所有禅道图片引用 */
  html?: string;
  /** 是否下载到本地（默认 true）。false 时只返回元数据与直取 URL */
  download?: boolean;
  /** 本地保存目录；默认 `{临时目录}/zendao-attachments/files` */
  outputDir?: string;
  /** 已存在时是否重新下载，默认 false（复用上次的） */
  force?: boolean;
}

interface ResolvedFile {
  fileID: number;
  source: string;
  title?: string;
  extension?: string;
  isImage: boolean;
  url?: string | null;
  localPath?: string;
  bytes?: number;
  kind?: string;
  error?: string;
}

export function defaultFileOutputDir(): string {
  return process.env.ZENTAO_ATTACHMENT_DIR || path.join(os.tmpdir(), 'zendao-attachments');
}

/**
 * 从三种输入里解析出待取的文件 ID（保序去重）。
 *
 * URL / HTML 的提取交给 SDK 0.9.3 的新函数 —— 这是本次移植的核心增量：
 * 它能正确处理 PATH_INFO 路由（`/file-read-123.html`）、`&amp;` 分隔的查询串
 * 以及带域名的绝对地址，比项目里原来的正则更全。
 */
async function collectFileIds(
  client: ZenTaoClient,
  args: ReadAttachmentArgs
): Promise<{ ids: number[]; sources: Map<number, string>; warning?: string }> {
  const ids: number[] = [];
  const sources = new Map<number, string>();
  const push = (id: number | undefined, source: string) => {
    if (!Number.isSafeInteger(id) || (id as number) <= 0) return;
    if (!ids.includes(id as number)) {
      ids.push(id as number);
      sources.set(id as number, source);
    }
  };

  if (args.fileID !== undefined && args.fileID !== null) {
    push(Number(args.fileID), '直接指定');
  }

  let sdkWarning: string | undefined;
  try {
    const sdk = await getSdk();
    if (args.url?.trim()) {
      push(sdk.extractFileIdFromUrl(args.url.trim(), client.siteBaseUrl), '附件链接');
    }
    if (args.html?.trim()) {
      for (const [, fileID] of sdk.extractFileIdsFromHtml(args.html, client.siteBaseUrl)) {
        push(fileID, '富文本图片');
      }
    }
  } catch (error: any) {
    // SDK 的 HTML 解析依赖 parse5；取不到提取能力时至少让显式 fileID 仍可用
    sdkWarning = `链接/HTML 提取不可用（${error?.message || '未知错误'}）；直接指定的 fileID 不受影响`;
  }

  return { ids, sources, warning: sdkWarning };
}

export async function readAttachments(
  client: ZenTaoClient,
  _cache: LRUCache<string, any>,
  args: ReadAttachmentArgs
): Promise<ToolResult> {
  void _cache;
  const shouldDownload = args.download !== false;

  try {
    const { ids, sources, warning } = await collectFileIds(client, args);
    if (!ids.length) {
      return {
        content: [
          {
            type: 'text',
            text:
              '没有解析出任何文件 ID。请至少提供一项：\n' +
              '· fileID：明确的数字 ID\n' +
              '· url：禅道附件/图片链接（如 /index.php?m=file&f=read&fileID=123）\n' +
              '· html：含 <img src="...fileID=123..."> 的富文本片段\n' +
              (warning ? `⚠️ ${warning}` : ''),
          },
        ],
        isError: true,
      };
    }

    const dir = args.outputDir || path.join(defaultFileOutputDir(), 'files');
    const resolved: ResolvedFile[] = [];

    // 文件数通常个位数，串行足够；避免同账号并发触发 401（项目实测结论）
    for (const fileID of ids) {
      const item: ResolvedFile = { fileID, source: sources.get(fileID) || '未知', isImage: false };
      resolved.push(item);

      try {
        const metaRes = await client.get<any>(`/files/${fileID}`);
        const file = extractOne<any>(metaRes, 'file') || {};

        item.title = file.title ? String(file.title) : undefined;
        item.extension = file.extension ? String(file.extension).toLowerCase() : undefined;
        item.isImage = isImageExtension(item.extension);

        // size 字段装的是服务器绝对路径（见 utils/attachments.ts 实测说明）
        item.url = buildStaticUrl(client.siteBaseUrl, file.size);
        if (!item.url) {
          item.error =
            '拿不到可直取的静态路径：文件元数据的 size 字段里没有可识别的 data/upload 路径。' +
            '该实例可能不支持静态直取（file/read 需 max9.0，当前实例更低）。';
          continue;
        }
        if (!shouldDownload) continue;

        const fileName = safeFileName(item.title, fileID, item.extension);
        const localPath = path.join(dir, fileName);
        if (!args.force && fs.existsSync(localPath)) {
          const stat = fs.statSync(localPath);
          if (stat.size > 0) {
            item.localPath = localPath;
            item.bytes = stat.size;
            item.kind = 'cached';
            continue;
          }
        }

        const bin = await client.fetchBinary(item.url);
        if (bin.status < 200 || bin.status >= 300) {
          item.error = `下载失败：HTTP ${bin.status}${bin.location ? `（重定向到 ${bin.location}）` : ''}`;
          continue;
        }

        const kind = sniffBinary(bin.data);
        if (kind === 'html') {
          item.error = '下载到的是 HTML 而非文件内容（多半被导到登录页）。静态目录可能需要认证，或文件已删除。';
          continue;
        }

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, bin.data);
        item.localPath = localPath;
        item.bytes = bin.data.length;
        item.kind = kind;
      } catch (error: any) {
        item.error = error?.message || '未知错误';
      }
    }

    const ok = resolved.filter((a) => !a.error);
    const failed = resolved.filter((a) => a.error);
    const lines = resolved.map((a, i) => {
      const meta = [
        a.extension ? a.extension.toUpperCase() : '未知类型',
        a.bytes != null ? formatBytes(a.bytes) : null,
        `来源: ${a.source}`,
      ]
        .filter(Boolean)
        .join(' | ');
      const rows = [`  [${i + 1}] fileID=${a.fileID} ${a.title || ''} (${meta})`];
      if (a.localPath) rows.push(`      本地路径: ${a.localPath}`);
      if (a.url) rows.push(`      直取 URL : ${a.url}`);
      if (a.error) rows.push(`      ⚠️ ${a.error}`);
      return rows.join('\n');
    });

    const header =
      `解析出 ${resolved.length} 个附件` +
      (ok.length ? `，成功 ${ok.length} 个` : '') +
      (failed.length ? `，失败 ${failed.length} 个` : '') +
      (shouldDownload ? '' : '（本次只查元数据，未下载）');

    return {
      content: [
        {
          type: 'text',
          text: [header, warning ? `⚠️ ${warning}` : '', ...lines].filter(Boolean).join('\n'),
        },
      ],
      structuredContent: {
        count: resolved.length,
        downloaded: shouldDownload ? ok.filter((a) => a.localPath).length : 0,
        files: resolved,
      },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `读取附件失败: ${error?.message || '未知错误'}` }],
      isError: true,
    };
  }
}
