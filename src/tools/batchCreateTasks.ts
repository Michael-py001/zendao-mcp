/**
 * 批量创建任务
 *
 * 禅道没有原生的批量创建接口（官方 CLI 也把它列在 roadmap 的「待实现」里），
 * 所以这里按 `POST /tasks` 逐条创建，用「分批并发」把耗时压下来。
 *
 * 归属同样是 **executionID**：可以在顶层传一个默认执行，items 里再按需覆盖，
 * 这样「往同一个迭代里塞一批任务」这种常见场景不用把 ID 抄 N 遍。
 */

import { ToolResult } from '../types';
import { ZenTaoClient } from '../client';
import { IBatchCreateTaskParams, IBatchOptions, IBatchResult } from '../types';
import { LRUCache } from '../utils/cache';

export async function batchCreateTasks(
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  items: IBatchCreateTaskParams[],
  options?: IBatchOptions,
  defaultExecutionID?: number
): Promise<ToolResult> {
  void cache;

  const startTime = Date.now();
  const maxConcurrency = options?.maxConcurrency || 5;

  if (!items || items.length === 0) {
    return {
      content: [{ type: 'text', text: '错误：任务列表不能为空' }],
      isError: true,
    };
  }

  // 顶层没给默认执行、items 里也没写 executionID 的，没法创建 —— 提前拒绝，
  // 比让它们一条条去撞 404 再回来解释要清楚得多。
  const missing = items.filter(
    (item) => !item?.executionID && !defaultExecutionID
  );
  if (missing.length) {
    return {
      content: [
        {
          type: 'text',
          text:
            `有 ${missing.length} 条任务没有指定归属执行。\n\n` +
            '禅道任务必须挂在执行（迭代/阶段/看板）下：请在每个 item 里写 executionID，' +
            '或在顶层传一个 executionID 作为统一默认值。\n' +
            '执行 ID 可通过 `zendao_call { module: "execution", action: "list" }` 获取。',
        },
      ],
      isError: true,
    };
  }

  const total = items.length;
  const results: IBatchResult<IBatchCreateTaskParams> = {
    success: 0,
    failed: 0,
    total,
    results: [],
    duration: 0,
  };

  try {
    // 分批处理，每批最多 maxConcurrency 个
    for (let i = 0; i < total; i += maxConcurrency) {
      const batch = items.slice(i, i + maxConcurrency);
      const batchPromises = batch.map((item) =>
        processTask(client, item, defaultExecutionID)
      );

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach((result, index) => {
        const originalIndex = i + index;
        const item = batch[index];

        if (result.status === 'fulfilled') {
          results.success++;
          results.results.push({
            item,
            status: 'success',
            id: result.value,
            index: originalIndex,
          });
        } else {
          results.failed++;
          results.results.push({
            item,
            status: 'failed',
            error: result.reason?.message || '未知错误',
            index: originalIndex,
          });
        }
      });

      // 不继续：提前跳出（已处理的结果照常返回）
      if (!options?.continueOnError && results.failed > 0) {
        break;
      }

      // 批次间延迟
      if (options?.delayBetweenBatches && i + maxConcurrency < total) {
        await new Promise((resolve) => setTimeout(resolve, options?.delayBetweenBatches));
      }
    }

    results.duration = Date.now() - startTime;

    const detailed =
      options?.reportMode === 'detailed'
        ? `\n详细结果：\n${results.results
            .map((r) =>
              r.status === 'success'
                ? `  ✓ [${r.index}] ${r.item.name} - ID: ${r.id}`
                : `  ✗ [${r.index}] ${r.item.name} - 错误: ${r.error}`
            )
            .join('\n')}`
        : '';

    const output =
      `批量创建任务完成！\n\n` +
      `统计信息：\n  总任务数: ${total}\n  成功: ${results.success}\n  失败: ${results.failed}\n  耗时: ${results.duration}ms\n` +
      detailed;

    return {
      content: [{ type: 'text', text: output }],
      structuredContent: {
        total,
        successful: results.success,
        failed: results.failed,
        duration: results.duration,
        errors: results.results
          .filter((r) => r.status === 'failed')
          .map((r) => ({ index: r.index, error: r.error || '未知错误' })),
      },
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `批量创建任务失败: ${error.message || '未知错误'}` }],
      isError: true,
    };
  }
}

/** 创建单条任务，返回新任务 ID */
async function processTask(
  client: ZenTaoClient,
  item: IBatchCreateTaskParams,
  defaultExecutionID?: number
): Promise<number> {
  const executionID = Number(item.executionID || defaultExecutionID);

  const body: Record<string, unknown> = {
    name: item.name,
    executionID,
  };
  for (const key of ['type', 'assignedTo', 'pri', 'estimate', 'deadline', 'estStarted', 'story', 'module', 'desc'] as const) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== '') {
      body[key] = value;
    }
  }

  const res: any = await client.post('/tasks', body);
  return Number(res?.id ?? res?.data?.id ?? 0);
}
