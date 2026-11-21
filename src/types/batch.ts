/**
 * 批量操作相关类型定义
 */

// 批量操作选项
export interface IBatchOptions {
  continueOnError?: boolean; // 出错时是否继续
  reportMode?: 'summary' | 'detailed'; // 报告模式
  maxConcurrency?: number; // 最大并发数
  delayBetweenBatches?: number; // 批次间延迟 (毫秒)
}

// 批量操作结果项
export interface IBatchResultItem<T> {
  item: T;
  status: 'success' | 'failed';
  id?: number; // 成功时返回 ID
  error?: string; // 失败时返回错误信息
  index: number; // 原始索引
}

// 批量操作结果
export interface IBatchResult<T> {
  success: number;
  failed: number;
  total: number;
  results: IBatchResultItem<T>[];
  duration: number; // 执行时间 (毫秒)
}

// 批量创建任务参数
// 注意：禅道任务挂在执行下，归属是 executionID 而不是 project
export interface IBatchCreateTaskParams {
  name: string;
  /** 所属执行 ID；若不填则取批量参数顶层的 executionID */
  executionID?: number;
  /** 任务类型，如 devel / test / design */
  type?: string;
  assignedTo?: string;
  pri?: number;
  estimate?: number;
  deadline?: string;
  estStarted?: string;
  story?: number;
  module?: number;
  desc?: string;
}

// 批量更新任务状态参数
export interface IBatchUpdateTaskStatusParams {
  taskIds: number[];
  /** 要执行的动作：start | finish | close | activate */
  action: string;
}

// 批量创建项目参数
export interface IBatchCreateProjectParams {
  name: string;
  code: string;
  begin: string;
  end?: string;
}

// 批量创建需求参数
export interface IBatchCreateStoryParams {
  title: string;
  product: number;
  pri?: number;
}
