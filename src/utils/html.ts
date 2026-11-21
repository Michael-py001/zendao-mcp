/**
 * 禅道富文本 → Markdown 转换
 *
 * 借鉴自官方 CLI（easysoft/zentao-cli）的处理方式：
 * 禅道里 `desc`（任务描述）、`spec`（需求描述）、`comment`（备注）这类字段存的是
 * HTML 富文本，直接丢给 LLM 既浪费 token 又难读，转成 Markdown 后可读性高得多。
 *
 * 这里是零依赖的轻量实现：覆盖禅道编辑器实际会产出的标签，不做完整 HTML 解析器。
 */

/** 把 HTML 里的字符实体还原成普通字符 */
function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&ldquo;': '“',
    '&rdquo;': '”',
    '&lsquo;': '‘',
    '&rsquo;': '’',
    '&hellip;': '…',
    '&mdash;': '—',
    '&ndash;': '–',
    '&times;': '×',
    '&middot;': '·',
  };

  return input
    .replace(/&[a-zA-Z]+;/g, (m) => named[m] ?? m)
    // 数字实体：&#123; / &#x1F600;
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/** 判断这段文本看起来是否是 HTML（禅道有些字段是纯文本，别去动它） */
export function looksLikeHtml(input: unknown): boolean {
  return typeof input === 'string' && /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(input);
}

/**
 * 将一段 HTML 转成 Markdown 文本。
 * 非 HTML 输入原样返回，因此可以放心地对任意字段使用。
 */
export function htmlToMarkdown(input: unknown): string {
  if (typeof input !== 'string' || !input) return typeof input === 'string' ? input : '';
  if (!looksLikeHtml(input)) return input;

  let text = input;

  // 1) 干掉整段无语义内容（脚本、样式、注释）
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // 2) 块级结构：在标签处插入换行，后面再统一收拢空行
  text = text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|section|article|tr|h[1-6]|blockquote|pre|li)\s*>/gi, '\n')
    .replace(/<\s*(p|div|section|article|tr|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<\s*hr\s*\/?\s*>/gi, '\n---\n');

  // 3) 标题
  for (let level = 6; level >= 1; level--) {
    const hashes = '#'.repeat(level);
    const re = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    text = text.replace(re, (_m, inner) => `\n${hashes} ${String(inner).trim()}\n`);
  }

  // 4) 行内样式
  text = text
    .replace(/<\s*(strong|b)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, _t, inner) => {
      const s = String(inner).trim();
      return s ? `**${s}**` : '';
    })
    .replace(/<\s*(em|i)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, _t, inner) => {
      const s = String(inner).trim();
      return s ? `*${s}*` : '';
    })
    .replace(/<\s*(del|s|strike)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, _t, inner) =>
      String(inner).trim() ? `~~${String(inner).trim()}~~` : ''
    )
    .replace(/<\s*code\b[^>]*>([\s\S]*?)<\s*\/\s*code\s*>/gi, (_m, inner) => {
      const s = String(inner).trim();
      return s ? `\`${s}\`` : '';
    });

  // 5) 代码块
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const body = String(inner).replace(/<[^>]+>/g, '').trim();
    return `\n\`\`\`\n${body}\n\`\`\`\n`;
  });

  // 6) 列表：先把 li 变成 Markdown 列表项
  text = text.replace(/<\s*li\b[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_m, inner) => {
    const body = String(inner).replace(/\n+/g, ' ').trim();
    return `\n- ${body}`;
  });
  // 有序列表的 <ol> 单独处理：逐条换成 1. 2. 3.
  text = text.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    let index = 0;
    const body = String(inner).replace(/^\s*- /gm, () => `${++index}. `);
    return `\n${body}\n`;
  });

  // 7) 链接与图片（必须在通用去标签之前）
  text = text
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const label = String(inner).replace(/<[^>]+>/g, '').trim() || href;
      return `[${label}](${href})`;
    })
    .replace(/<img\b[^>]*src\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, src) => `![](${src})`);

  // 8) 表格：禅道偶尔会用表格排版，转成 Markdown 表格
  text = text.replace(/<\/?(table|thead|tbody|tfoot)\b[^>]*>/gi, '\n');
  text = text.replace(/<\s*th\b[^>]*>([\s\S]*?)<\s*\/\s*th\s*>/gi, (_m, inner) => {
    return `| ${String(inner).replace(/<[^>]+>/g, '').trim()} `;
  });
  text = text.replace(/<\s*td\b[^>]*>([\s\S]*?)<\s*\/\s*td\s*>/gi, (_m, inner) => {
    return `| ${String(inner).replace(/<[^>]+>/g, '').trim()} `;
  });

  // 9) 剩余标签一律剥掉
  text = text.replace(/<[^>]+>/g, '');

  // 10) 实体还原 + 收拢空白
  text = decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n') // 行尾空格
    .replace(/\n{3,}/g, '\n\n') // 连续空行压成一段间隔
    .replace(/[ \t]{2,}/g, ' ');

  return text.trim();
}

/**
 * 递归遍历对象，把其中「长得像 HTML」的字符串字段转成 Markdown。
 * 返回新对象，不改动入参。
 *
 * @param value 任意 JSON 值
 * @param maxDepth 防御性深度上限，避免异常数据把栈打穿
 */
export function convertHtmlFields<T>(value: T, maxDepth = 6): T {
  if (maxDepth <= 0 || value == null) return value;

  if (typeof value === 'string') {
    return (looksLikeHtml(value) ? htmlToMarkdown(value) : value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => convertHtmlFields(item, maxDepth - 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = convertHtmlFields(val, maxDepth - 1);
    }
    return out as unknown as T;
  }

  return value;
}
