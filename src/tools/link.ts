/**
 * 禅道页面链接生成 / 解析
 *
 * 从官方 zentao-cli 0.5.0 移植（原 `zentao link create/parse` + MCP `zentao_link`）。
 * 底层用 `zentao-api` 0.9.3 新导出的 `createLink` / `parseLink` —— **纯同步纯函数**：
 * 不访问网络、不需要 Token，只依赖站点地址与服务器路由配置（GET / PATH_INFO / PATH_INFO2）。
 *
 * 典型用途：Bug/任务列表只给数字 ID，调用方要给用户一个能点开的网页地址；
 * 反过来拿到一条禅道链接，解析出它指向哪个模块/方法/对象。
 *
 * 安全边界（照搬官方实现，不能省）：
 * - 站点地址必须是干净 HTTP(S) URL（不含凭据 / 查询串 / 片段）；
 * - 生成的链接必须仍在当前 origin；
 * - 路径变量不能解析成 `.` / `..` 目录。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { getSdk } from '../sdk/loader';
import { getSdkRuntime } from '../sdk';

export interface LinkArgs {
  action: 'create' | 'parse';
  /** create：页面模块名，如 `bug` / `task` */
  module?: string;
  /** create：页面方法名，如 `view` */
  method?: string;
  /** create：`名称=值` 形式的参数，可重复；路径模式下按顺序使用值 */
  vars?: string[];
  /** create：返回以 `/` 开头的站内路径（默认 false = 完整网址） */
  relative?: boolean;
  /** create：锚点 */
  hash?: string;
  /** parse：要解析的链接（完整网址或站内相对路径） */
  url?: string;
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 校验站点根地址 —— 与官方 siteURL() 同口径 */
function siteUrl(server: string): URL {
  let site: URL;
  try {
    site = new URL(server);
  } catch {
    throw new Error('站点地址无效，请检查 ZENTAO_BASE_URL 配置（需要完整的 HTTP(S) 地址）');
  }
  if (!/^https?:\/\//i.test(server) || site.username || site.password || /[?#]/.test(server)) {
    throw new Error('站点地址必须是纯 HTTP(S) 地址，不能含登录凭据、查询参数或片段');
  }
  return site;
}

/**
 * 路径片段编码。
 *
 * 不变量（先证后写）：PATH_INFO / PATH_INFO2 模式下，禅道用 `requestFix`（通常是 `-`）
 * 分隔路径参数。若变量值里含分隔符或 `.` 却没有转义，编码后的链接会被服务端
 * 拆成更多段、或解析成 `..` 穿越路径 —— 所以这两类字符必须条件编码。
 * GET 模式没有这个问题，直接 encodeURIComponent 即可。
 */
function encodePart(value: string, separator?: string): string {
  try {
    if (!separator) return encodeURIComponent(value);
    return Array.from(value, (char) => {
      const encoded = encodeURIComponent(char);
      return char === encoded && (char === '.' || separator.includes(char))
        ? '%' + char.charCodeAt(0).toString(16).toUpperCase()
        : encoded;
    }).join('');
  } catch {
    throw new Error('页面参数包含无效的 Unicode 字符');
  }
}

export async function zendaoLink(client: ZenTaoClient, args: LinkArgs): Promise<ToolResult> {
  const action = String(args?.action ?? '').trim();
  if (action !== 'create' && action !== 'parse') {
    return fail('action 必须是 create（生成链接）或 parse（解析链接）。');
  }

  try {
    const site = siteUrl(client.siteBaseUrl);
    const sdk = await getSdk();

    // 路由配置（GET/PATH_INFO + moduleVar/methodVar）来自 getconfig，24h 缓存。
    // parse 的 requestType:'auto' 虽不强制要 config，但带上它才能正确识别本站的入口路径；
    // 拿不到就降级为 {server}，SDK 会用默认路由参数名解析。
    const serverConfig = await (async () => {
      try {
        const rt = await getSdkRuntime(client);
        return await rt.adapter.getZentaoConfig();
      } catch {
        return undefined;
      }
    })();
    const profile = { server: site.href, serverConfig: serverConfig as any };

    // ---- parse：本地解析，不访问网络 ----
    if (action === 'parse') {
      if (!args.url?.trim()) return fail('请提供要解析的链接（url）。');
      const parsed = sdk.parseLink(profile, args.url, { requestType: 'auto' });
      const parts = [
        `✅ 解析完成：${parsed.url ?? args.url}`,
        parsed.external ? '⚠️ 这是外链（不在当前站点内）' : '',
        `模块: ${parsed.moduleName ?? 'index'} · 方法: ${parsed.methodName ?? 'index'}`,
        parsed.requestType ? `路由模式: ${parsed.requestType}` : '',
        parsed.vars?.length ? `参数: ${parsed.vars.map(([k, v]) => (k ? `${k}=${v}` : v)).join(', ')}` : '',
      ].filter(Boolean);
      return {
        content: [{ type: 'text', text: parts.join('\n') }],
        structuredContent: { action: 'parse', link: parsed },
      };
    }

    // ---- create：需要路由配置；拿不到就降级为不传（SDK 会按默认 GET 处理） ----
    const moduleName = String(args.module ?? '').trim();
    const methodName = String(args.method ?? '').trim();
    if (!moduleName || !methodName) return fail('create 需要同时提供 module（页面模块）和 method（页面方法）。');

    const separator =
      serverConfig && (serverConfig as any).requestType !== 'GET' && typeof (serverConfig as any).requestFix === 'string'
        ? (serverConfig as any).requestFix as string
        : undefined;

    const vars = args.vars?.map((item) => {
      const at = item.indexOf('=');
      if (at < 1 || !item.slice(0, at).trim()) {
        throw new Error(`参数 "${item}" 格式错误，请用 名称=值（如 bugID=123）`);
      }
      return [encodePart(item.slice(0, at), separator), encodePart(item.slice(at + 1), separator)] as const;
    });

    const link = sdk.createLink(profile, {
      moduleName: encodePart(moduleName, separator),
      methodName: encodePart(methodName, separator),
      vars,
      relative: args.relative ?? false,
      hash: args.hash,
    });

    // 安全兜底：链接不能跳出当前站点，也不能指向目录穿越路径
    if (new URL(link, site).origin !== site.origin) {
      return fail('生成的页面链接超出当前站点，已拒绝返回。');
    }
    if (/\/(?:\.|%2e){1,2}(?:\/|$)/i.test(link)) {
      return fail('路径变量解析为 . 或 .. 目录，已拒绝返回（请检查 vars）。');
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `✅ 页面链接: ${link}\n` +
            `模块: ${moduleName} · 方法: ${methodName}` +
            (vars?.length ? ` · 参数: ${vars.map(([k, v]) => `${k}=${v}`).join(', ')}` : '') +
            (serverConfig ? `\n路由模式: ${(serverConfig as any).requestType ?? '默认'}` : '\n（未取到路由配置，按默认模式生成）'),
        },
      ],
      structuredContent: { action: 'create', url: link },
    };
  } catch (error: any) {
    return fail(`生成/解析页面链接失败: ${error?.message || '未知错误'}`);
  }
}
