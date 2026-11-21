/**
 * 「有 Bug 的产品」枚举 & 全库 Bug 合并拉取。
 *
 * 为什么需要这个模块？因为**本实例的 Bug 接口没有一个能一次拿到全库**：
 *
 * 1. **全局 `GET /bugs` 不是全库列表。** 不带 `productID` 时它会落到某个产品
 *    （本实例固定为产品 9「海上风电平台产品」），而且 `pager.recTotal` 也**谎报**
 *    成该产品的条数（766）。看着像「全库 766 条」，实际只覆盖了 9 个产品中的一个。
 *    传 `productID=0` / `browseType=all` / `scope=all` 都无法改变；`productID=all` 直接报错
 *    `Product does not exist.`
 *
 * 2. **`GET /products` 漏掉「影子产品」。** 禅道里 `shadow=1` 的产品是给项目自动
 *    生成的项目型产品，产品列表接口会硬过滤掉它们。本实例就有一个：
 *    `2000076 电网储能工程造价分析系统` —— `/products` 的 34 个里没有它，
 *    但它下面有 33 条 Bug，其中 6 条正是指派给当前账号的**待处理** Bug。
 *    只信 `/products` 会整条产品线的 Bug 全部消失，且**不报错**（最危险的那种漏）。
 *
 * 兜底数据源：`GET /bugs` 响应里的 `products` 字典 —— 它是 Bug 页面下拉框的数据，
 * **包含影子产品**（本实例 35 个 = `/products` 的 34 个 + 影子产品 2000076）。
 * 取两个来源的并集才稳妥。
 *
 * 代价：全库查询要按产品遍历（本实例 35 次请求）。所以这里配了缓存 ——
 * 产品清单变化很慢（10 分钟），Bug 状态变化相对频繁（2 分钟）。
 */

import { IBug, IProduct } from '../types';
import { ZenTaoClient } from '../client';
import { LRUCache } from './cache';
import { extractList, restoreDictOrder } from './response';

/** 缓存键 */
const PRODUCTS_KEY = 'bug-scope:products';
const ALL_BUGS_KEY = 'bug-scope:all-bugs';

/** 产品清单缓存时长：产品结构变化很慢 */
const PRODUCTS_TTL = 10 * 60 * 1000;
/** 全库 Bug 缓存时长。
 *
 * 首次遍历要 10 秒上下（本实例 35 个产品、3767 条 Bug，服务端渲染大 JSON 很慢），
 * 所以缓存要给够，否则用户连续追问就会反复等 10 秒。Bug 状态本身变化不快，
 * 5 分钟是新鲜度和体验之间的折中。
 */
const ALL_BUGS_TTL = 5 * 60 * 1000;

/** 单个产品单次拉取上限（实测单页可返回 1000+ 条） */
const PER_PRODUCT_FETCH = 1000;
/** 单个产品最多翻几页（防御性上限，避免服务端分页异常时死循环） */
const MAX_PAGES_PER_PRODUCT = 5;
/** 遍历产品时的并发度：太快容易压到前置 Web 服务器（它本来就有毛病），太慢首调体验差 */
const CONCURRENCY = 12;

/** 产品枚举结果 */
export interface BugScopeProducts {
  /** 并集后的产品清单 */
  products: IProduct[];
  /** 仅从 `/bugs` 字典补进来的产品 ID（即被 `/products` 漏掉的影子产品） */
  addedFromBrowse: number[];
}

/** 全库 Bug 结果 */
export interface AllBugsResult {
  bugs: IBug[];
  /** 遍历的产品数 */
  productCount: number;
  /** 被 `/products` 漏掉、靠 `/bugs` 字典补回的产品数 */
  shadowProductCount: number;
  /** 拉取失败的产品 ID（部分成功不报错，但要让调用方知道数据不全） */
  failedProducts: number[];
  /** 是否命中缓存 */
  fromCache: boolean;
}

/** 简单的并发上限遍历，保持返回顺序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 枚举「有 Bug 的产品」：`/products` 列表 ∪ `/bugs` 响应里的产品字典。
 *
 * 两者都要，缺一不可（见文件头说明）。任一来源失败都不会让整体失败，
 * 只要有另一个来源可用就继续 —— 但会把失败信息留给调用方判断。
 */
export async function fetchBugScopeProducts(
  client: ZenTaoClient,
  cache?: LRUCache<string, any>
): Promise<BugScopeProducts> {
  const cached = cache?.get(PRODUCTS_KEY);
  if (cached) return cached as BugScopeProducts;

  const map = new Map<number, IProduct>();

  // ---- 来源 1：产品列表（不含影子产品） ----
  try {
    const res = await client.get<any>('/products', { ...client.paginationParams(1, PER_PRODUCT_FETCH) });
    const { list } = extractList<IProduct>(res, 'products', PER_PRODUCT_FETCH);
    for (const p of list) {
      const id = Number(p?.id);
      if (Number.isFinite(id) && id > 0) map.set(id, p);
    }
  } catch {
    // 交给来源 2 兜底
  }

  // ---- 来源 2：/bugs 响应的 products 字典（含 shadow=1 的影子产品） ----
  const addedFromBrowse: number[] = [];
  try {
    // 只要页面上下文，不需要 Bug 本体，所以 recPerPage 压到 1
    const res = await client.get<any>('/bugs', { ...client.paginationParams(1, 1) });
    const dict = res?.products;
    if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
      for (const [key, name] of Object.entries(dict)) {
        const id = Number(key);
        if (!Number.isFinite(id) || id <= 0 || map.has(id)) continue;
        map.set(id, { id, name: String(name) } as IProduct);
        addedFromBrowse.push(id);
      }
    }
  } catch {
    // 来源 2 失败时至少还有来源 1
  }

  const result: BugScopeProducts = { products: [...map.values()], addedFromBrowse };
  if (result.products.length) cache?.set(PRODUCTS_KEY, result, PRODUCTS_TTL);
  return result;
}

/**
 * 拉取**全库** Bug：按产品遍历后按 id 去重合并。
 *
 * 这是本项目中唯一可信的「全部 Bug」来源。任何需要跨产品找 Bug 的场景
 * （全局列表、我的 Bug、按条件筛选）都必须走这里，不能直接打 `/bugs`。
 *
 * ⚠️ 合并结果**必须显式排序**才能有确定顺序：合并用的是 Map，迭代顺序 = 插入顺序，
 * 而各产品是跑并发（`CONCURRENCY`）拉回来的，谁先回来谁先进 —— 不排的话顺序随机。
 * 单产品 `/products/{id}/bugs` 返回的是**数组**（保序、实测按 id 降序），
 * 所以按 `id_desc` 排正好与单产品视角一致。
 *
 * @param orderBy 排序表达式，缺省按 id 降序（与单产品接口的实测口径一致）
 * @param onProgress 可选的进度回调，便于日志/调试
 */
export async function fetchAllBugs(
  client: ZenTaoClient,
  cache?: LRUCache<string, any>,
  onProgress?: (done: number, total: number) => void,
  orderBy?: string
): Promise<AllBugsResult> {
  const cached = cache?.get(ALL_BUGS_KEY);
  if (cached) {
    const hit = cached as Omit<AllBugsResult, 'fromCache'>;
    // 缓存里存的是「集合」，排序在返回时才应用 —— 这样不同 orderBy 可以共用同一份缓存
    return { ...hit, bugs: restoreDictOrder(hit.bugs, orderBy), fromCache: true };
  }

  const { products, addedFromBrowse } = await fetchBugScopeProducts(client, cache);
  const merged = new Map<number, IBug>();
  const failed: number[] = [];
  let done = 0;

  await mapLimit(products, CONCURRENCY, async (p) => {
    const id = Number(p.id);
    try {
      let pageID = 1;
      const collected: IBug[] = [];
      while (pageID <= MAX_PAGES_PER_PRODUCT) {
        const res = await client.get<any>(`/products/${id}/bugs`, {
          ...client.paginationParams(pageID, PER_PRODUCT_FETCH),
          // 一律 all：本地会再筛一轮，服务端先筛会制造交集式假阴性
          browseType: 'all',
        });
        const { list, pager } = extractList<IBug>(res, 'bugs', PER_PRODUCT_FETCH);
        collected.push(...list);
        if (list.length < PER_PRODUCT_FETCH || collected.length >= pager.total) break;
        pageID++;
      }
      for (const b of collected) {
        const bugId = Number((b as any)?.id);
        if (Number.isFinite(bugId)) merged.set(bugId, { ...(b as any), product: (b as any).product ?? id });
      }
    } catch {
      failed.push(id);
    } finally {
      done++;
      onProgress?.(done, products.length);
    }
  });

  const result = {
    bugs: restoreDictOrder([...merged.values()], orderBy),
    productCount: products.length,
    shadowProductCount: addedFromBrowse.length,
    failedProducts: failed,
  };

  // 一个产品都没拉到，多半是整条链路有问题，别把空结果缓存住
  if (result.bugs.length) cache?.set(ALL_BUGS_KEY, result, ALL_BUGS_TTL);

  return { ...result, fromCache: false };
}

/** 清掉全库 Bug 缓存（写操作后调用，避免读到旧状态） */
export function invalidateAllBugsCache(cache?: LRUCache<string, any>): void {
  cache?.delete(ALL_BUGS_KEY);
}
