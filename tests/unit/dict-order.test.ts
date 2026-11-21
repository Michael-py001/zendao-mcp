/**
 * ID 字典顺序还原 —— 离线回归测试
 *
 * 守的是 09-15 主人发现的那个 bug：「我的待处理 Bug」列表与禅道网页**整个颠倒**。
 *
 * 根因不在排序逻辑，而在解析层：`/my/work`（以及不带 productID 的 `/bugs`）
 * 返回的列表是 **ID 字典** `{"2010523": {...}}`，而 **ECMA-262 规定对象的
 * 「数组索引键」在属性枚举中排最前且按数值升序** —— 于是 `JSON.parse` 之后，
 * 字典键的插入顺序（= 服务端的排序结果）被永久规范化成升序。服务端明明给的是
 * `orderBy: "id_desc"`，我们拿到手却成了升序，而且**不报错**。
 *
 * 这几条用例的价值就在于：**它复现的是真实响应文本**（`RAW_DICT`），
 * 所以一旦有人把 `restoreDictOrder` 从 `extractList` 里拿掉，测试立刻红。
 * 另外它还挡住一类反向事故：把数组也给"排"了 —— 数组本来就保序，
 * 服务端已经排好，本地再按 orderBy 排一次会破坏它。
 */

import { extractList, restoreDictOrder } from '../../src/utils/response';

/**
 * 真实的响应文本（形状抄自实测抓包）。
 * 注意：这里刻意用**字符串**而不是对象字面量 —— 因为对象字面量在 JS 里
 * 构造的瞬间就会被规范化成升序，反而测不出问题。用文本走一遍 `JSON.parse`，
 * 才是真实的受害链路。
 */
const RAW_DICT =
  '{"status":"success","orderBy":"id_desc","bugs":{' +
  '"2010523":{"id":"2010523","title":"预制舱匹配未完全展示"},' +
  '"2010521":{"id":"2010521","title":"中文前带英文未展示"},' +
  '"2010520":{"id":"2010520","title":"价格库编辑无响应"},' +
  '"2010519":{"id":"2010519","title":"中文名称是英文时未展示"},' +
  '"2010515":{"id":"2010515","title":"规则条数展示不正确"},' +
  '"2010511":{"id":"2010511","title":"一级二级标题未展示"}' +
  '},"pager":{"recTotal":6,"pageID":1,"recPerPage":100,"pageTotal":1}}';

/** 期望的服务端语义顺序（id 降序 = 网页看到的顺序） */
const EXPECTED_DESC = ['2010523', '2010521', '2010520', '2010519', '2010515', '2010511'];
/** JS 对象被规范化后的顺序（id 升序 = 修复前的错误输出） */
const EXPECTED_ASC = ['2010511', '2010515', '2010519', '2010520', '2010521', '2010523'];

const ids = (list: any[]) => list.map((item) => String(item.id));

describe('ID 字典的顺序还原', () => {
  describe('真实链路：服务端文本 → JSON.parse → extractList', () => {
    test('JSON.parse 本身就会把字典键规范化成升序（这是根因，先确认它）', () => {
      const parsed = JSON.parse(RAW_DICT);
      expect(Object.keys(parsed.bugs)).toEqual(EXPECTED_ASC);
    });

    test('extractList 必须把顺序还原成服务端的 id_desc', () => {
      const { list } = extractList<any>(JSON.parse(RAW_DICT), 'bugs', 100);
      expect(ids(list)).toEqual(EXPECTED_DESC);
    });

    test('还原顺序不能影响分页信息的解析', () => {
      const { list, pager } = extractList<any>(JSON.parse(RAW_DICT), 'bugs', 100);
      expect(list).toHaveLength(6);
      expect(pager).toMatchObject({ total: 6, page: 1, limit: 100, pageTotal: 1 });
    });
  });

  describe('orderBy 的取值', () => {
    const dictOf = (...order: string[]) =>
      JSON.parse(
        '{"status":"success","bugs":{' +
          order.map((id) => `"${id}":{"id":"${id}"}`).join(',') +
          '}}'
      );

    test('orderBy=id_desc → 降序', () => {
      const res = { ...dictOf('2010523', '2010511'), orderBy: 'id_desc' };
      expect(ids(extractList<any>(res, 'bugs').list)).toEqual(['2010523', '2010511']);
    });

    test('orderBy=id_asc → 升序（服务端要什么就给什么）', () => {
      const res = { ...dictOf('2010523', '2010511'), orderBy: 'id_asc' };
      expect(ids(extractList<any>(res, 'bugs').list)).toEqual(['2010511', '2010523']);
    });

    test('orderBy=id:desc（冒号写法）同样认', () => {
      const res = { ...dictOf('2010523', '2010511'), orderBy: 'id:desc' };
      expect(ids(extractList<any>(res, 'bugs').list)).toEqual(['2010523', '2010511']);
    });

    test('orderBy 缺失时按缺省 id_desc（实测两个字典接口都报 id_desc）', () => {
      const res = dictOf('2010523', '2010511');
      expect(ids(extractList<any>(res, 'bugs').list)).toEqual(['2010523', '2010511']);
    });

    test('按非 id 字段排也支持（字典的值就是实体，能读到该字段）', () => {
      const res = {
        orderBy: 'pri_desc',
        bugs: {
          1: { id: '1', pri: 3 },
          2: { id: '2', pri: 1 },
          3: { id: '3', pri: 2 },
        },
      };
      // 注：对象字面量里键本来就是 1,2,3，排的是 pri
      expect(extractList<any>(res, 'bugs').list.map((b: any) => b.pri)).toEqual([3, 2, 1]);
    });

    test('⚠️ orderBy 指向的字段在元素上不存在 → 不排序（宁可不还原，也不按错字段乱排）', () => {
      const res = { ...dictOf('2010523', '2010511'), orderBy: 'nosuchfield_desc' };
      expect(ids(extractList<any>(res, 'bugs').list)).toEqual(['2010511', '2010523']);
    });
  });

  describe('数组不受影响（数组本身保序，服务端已排好）', () => {
    test('数组 + orderBy 也不会被本地重排', () => {
      const res = {
        status: 'success',
        orderBy: 'id_desc',
        bugs: [{ id: '2010511' }, { id: '2010523' }],
      };
      expect(ids(extractList<any>(res, 'bugs').list)).toEqual(['2010511', '2010523']);
    });

    test('单产品 /products/{id}/bugs 的数组形状（实测首条就是最新的）', () => {
      const res = {
        status: 'success',
        bugs: [{ id: '2010523' }, { id: '2010521' }, { id: '2010511' }],
        pager: { recTotal: 3, pageID: 1, recPerPage: 20, pageTotal: 1 },
      };
      const { list } = extractList<any>(res, 'bugs', 20);
      expect(ids(list)).toEqual(['2010523', '2010521', '2010511']);
    });
  });

  describe('边界与防呆', () => {
    test('空字典 `{}` → 空列表，不是报错', () => {
      const res = { status: 'success', orderBy: 'id_desc', bugs: {} };
      expect(extractList<any>(res, 'bugs').list).toEqual([]);
    });

    test('id→名称 的映射字典不会被误当成资源列表', () => {
      // /bugs 响应里的 products 字典就长这样，误当成列表会得到一堆字符串
      const res = { status: 'success', products: { 9: '海上风电平台产品', 2000076: '电网储能' } };
      expect(extractList<any>(res, 'bugs').list).toEqual([]);
    });

    test('数字型 id（非字符串）同样能排', () => {
      const values = [{ id: 2010511 }, { id: 2010523 }, { id: 2010515 }];
      expect(restoreDictOrder(values, 'id_desc').map((v) => v.id)).toEqual([
        2010523, 2010515, 2010511,
      ]);
    });
  });

  describe('合并路径：fetchAllBugs 的排序动作', () => {
    test('并发合并出来的乱序数组会被排成 id 降序（与单产品视角一致）', () => {
      // 各产品是并发拉回来的，Map 插入顺序不可控 —— 所以合并后必须显式排序
      const merged = [{ id: '2010417' }, { id: '2010553' }, { id: '2010439' }, { id: '2010500' }];
      expect(restoreDictOrder(merged, 'id_desc').map((v) => v.id)).toEqual([
        '2010553', '2010500', '2010439', '2010417',
      ]);
    });

    test('合并后传 orderBy 给服务端的口径时，排序跟着走', () => {
      const merged = [{ id: '3' }, { id: '1' }, { id: '2' }];
      expect(restoreDictOrder(merged, 'id_asc').map((v) => v.id)).toEqual(['1', '2', '3']);
    });

    test('缺省（不传 orderBy）仍然是 id 降序', () => {
      const merged = [{ id: '1' }, { id: '3' }, { id: '2' }];
      expect(restoreDictOrder(merged).map((v) => v.id)).toEqual(['3', '2', '1']);
    });
  });
});
