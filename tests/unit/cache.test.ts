/**
 * 缓存单元测试示例
 */

import { LRUCache } from '../../src/utils/cache';

describe('LRU Cache', () => {
  let cache: LRUCache<string, string>;

  beforeEach(() => {
    cache = new LRUCache({ maxSize: 3, defaultTtl: 1000 });
  });

  test('基本 get/set 操作', () => {
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  test('TTL 过期测试', async () => {
    cache.set('key1', 'value1', 100); // 100ms TTL
    expect(cache.get('key1')).toBe('value1');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cache.get('key1')).toBeNull();
  });

  test('LRU 策略测试', () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.set('key3', 'value3');

    // 访问 key1，使其成为最近使用。
    // 这一步能生效，靠的是 LRUCache 用**单调访问序号**而不是 Date.now() 排序 ——
    // 用时钟的话，这段代码跑在 1ms 内，这次读会被同毫秒的插入完全盖掉。
    cache.get('key1');

    // 添加新项，会删除 key2（最久未使用）
    cache.set('key4', 'value4');

    expect(cache.get('key1')).toBe('value1'); // 应该存在
    expect(cache.get('key2')).toBeNull(); // 已被删除
    expect(cache.get('key3')).toBe('value3'); // 应该存在
    expect(cache.get('key4')).toBe('value4'); // 应该存在
  });

  test('清理过期缓存', async () => {
    cache.set('key1', 'value1', 100);
    cache.set('key2', 'value2', 200);

    // TTL 都还没到 —— 一个都不该被清掉。
    // （原用例在这里直接断言 `>= 1`，却没有让时间流逝，属于必然失败的断言）
    expect(cache.cleanup()).toBe(0);

    // 等两个 TTL 都过期，再清应当精确清掉 2 个
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(cache.cleanup()).toBe(2);
    expect(cache.get('key1')).toBeNull();
    expect(cache.get('key2')).toBeNull();
  });
});
