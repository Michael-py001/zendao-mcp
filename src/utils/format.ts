/**
 * 展示层格式化小工具
 *
 * 这里只放「为了给人看」的转换，不做数据加工 —— 数据加工归 `fields.ts` / `response.ts`。
 */

/**
 * 工时字段格式化。
 *
 * ⚠️ 禅道**不同接口对同一个字段的格式不一致**，这是实测踩到的（2026-09-17）：
 *
 * | 接口 | `estimate` 的实际值 |
 * | --- | --- |
 * | `GET /tasks/{id}`（详情） | `"40"` —— 纯数字，单位要调用方补 |
 * | `GET /my/work?mode=task`（地盘列表） | `"40h"` —— **已经带了单位** |
 *
 * 直接拼模板字符串 `` `${value}h` `` 就会输出 `40hh`。
 * 这个函数把两种形态统一成「数值 + h」，且不会重复加单位。
 */
export function formatHours(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // 已带单位（h / H / 天用 d 之类）就原样返回
  return /[a-zA-Z]$/.test(text) ? text : `${text}h`;
}
