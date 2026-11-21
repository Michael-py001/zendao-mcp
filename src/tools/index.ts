/**
 * MCP 工具注册
 *
 * 设计参考禅道官方 CLI（easysoft/zentao-cli）的几点做法：
 * 1. **工具注解（annotations）**：明确标注只读 / 破坏性，让客户端能做安全提示；
 * 2. **通用数据处理参数**：`pick` 摘字段、`sort` 排序，避免把四十几个字段全丢给模型；
 * 3. **错误要给下一步**：失败信息里带上"该调到哪个工具"，而不是丢一句 404。
 *
 * ⚠️ MCP SDK 约定：registerTool 的 inputSchema / outputSchema 需要「裸字段字典」
 * （ZodRawShape），即 `{ page: z.number() }`，**不能**传 `z.object({...})` 的 ZodObject。
 * SDK 内部会自己做 z.object() 包装与 zodToJsonSchema 转换，传 ZodObject 既类型报错、
 * 运行时还会被二次包装成错误的 schema。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// 禅道客户端和缓存
import { ZenTaoClient } from '../client';
import { LRUCache } from '../utils/cache';
import { Logger } from '../utils/logger';

// 工具实现
import { batchCreateTasks } from './batchCreateTasks';
import { listBugs, getBug } from './getBugs';
import { getBugAttachments } from './getBugAttachments';
import { listMyBugs } from './getMyBugs';
// 2026-09-17 新增（P0 移植批次，见 docs/porting-candidates.md）
import { listMyWork } from './getMyWork';
// 2026-10-09 新增：地盘-日志（工时）。官方 CLI 完全没有这个模块，本项目直连 GET /my/effort
import { listMyEfforts } from './getMyEfforts';
// 2026-11-20 新增：日志**写入**（自定义日志 + 删除，走网页表单，REST 覆盖不到）
import {
  fillEffortsTool,
  deleteEffortTool,
  EffortItemShape,
  DeleteEffortShape,
} from './fillEfforts';
import { getTask } from './getTask';
import { listUsers } from './getUsers';
// 2026-09-18 新增（官方全量动作迁移 P0，见 docs/migration-plan-sdk.md）
import { listSdkModules } from './sdkModules';
import { getSdkActionHelp } from './sdkHelp';
import { callSdkAction } from './sdkCall';

/** 统一的注解构造：只读 / 破坏性 / 是否访问外部世界 */
function annotations(readOnly: boolean, destructive: boolean) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: true,
  };
}

// ---- 通用参数 ----

const PICK_DESC = '只返回指定字段（逗号分隔），如 `id,name,status`。禅道对象动辄四五十个字段，摘取能显著省 token';
const SORT_DESC = '本地排序，如 `id:desc`、`deadline:asc`（也兼容 `id_desc` 写法）';

// ---- 输入 Schema（ZodRawShape）----

/**
 * 任务详情 —— 补上「拿到 taskID 却看不了详情」这条断链。
 * `GET /tasks/{id}` 在 2026-09-17 端点探针中实测**存在**（返回任务实体，实测 78 个字段）。
 */
const TaskByIdShape = {
  taskId: z.number().int().positive().describe('任务 ID'),
  includeActions: z.boolean().optional().default(false).describe('是否附带操作历史（谁在什么时候做了什么）'),
  resolveUserNames: z
    .boolean()
    .optional()
    .default(true)
    .describe('是否把账号补上人名（默认 true；人名来自地盘接口自带的 users 字典）'),
  pick: z.string().optional().describe(PICK_DESC),
};

// 批量创建中的单个任务条目（裸形状，需要被 z.array 包裹时再用 z.object 转换）
const TaskItemShape = {
  name: z.string().min(1).max(200).describe('任务名称'),
  executionID: z.number().int().positive().optional().describe('所属执行 ID；不填则用顶层的 executionID'),
  type: z.string().optional().describe('任务类型'),
  assignedTo: z.string().optional().describe('负责人账号'),
  pri: z.number().int().min(1).max(4).optional().default(3).describe('优先级'),
  estimate: z.number().positive().optional().describe('预计工时'),
  deadline: z.string().optional().describe('截止时间 (YYYY-MM-DD)'),
  estStarted: z.string().optional().describe('预计开始时间'),
  story: z.number().int().positive().optional().describe('关联需求 ID'),
  desc: z.string().optional().describe('任务描述'),
};

const TaskItemSchema = z.object(TaskItemShape);

// ---- Bug ----

const BugListShape = {
  productID: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('产品 ID。Bug 归属产品；不知道产品 ID 就先调 zendao_call { module: "product", action: "list" }'),
  scope: z
    .enum(['products', 'projects', 'executions'])
    .optional()
    .describe('显式指定范围类型（需与 scopeID 成对使用）；不传则用 productID 或查全局'),
  scopeID: z.number().int().positive().optional().describe('范围 ID（配合 scope 使用）'),
  browseType: z
    .enum(['all', 'unresolved', 'assignedtome'])
    .optional()
    .default('all')
    .describe(
      '浏览口径。**只保留语义确定的值** —— **部分禅道实例**的 Bug 接口传 closed/resolved 会返回 0' +
        '（而库里确有大量已关闭 Bug），属误导性结果，故不暴露；要按状态筛请用 status 参数。' +
        '注：`assignedtome` 在部分实例服务端不认（会返回空集），本工具已改为本地按当前账号兜底过滤 —— ' +
        '若只想要「我的 Bug」，建议直接用 zendao_list_my_bugs'
    ),
  status: z
    .enum(['active', 'resolved', 'closed'])
    .optional()
    .describe('按状态精确筛选（本地过滤，结果可信）：active 激活 / resolved 已解决 / closed 已关闭'),
  severity: z.number().int().min(1).max(4).optional().describe('严重程度 1-4，1 最严重（本地过滤）'),
  pri: z.number().int().min(1).max(4).optional().describe('优先级 1-4，1 最高（本地过滤）'),
  type: z
    .string()
    .optional()
    .describe('Bug 类型：codeerror 代码错误 / config 配置相关 / performance 性能问题 等（本地过滤）'),
  assignedTo: z.string().optional().describe('指派给（账号，本地过滤）'),
  keyword: z.string().optional().describe('关键词，在标题 / 重现步骤中模糊匹配（本地过滤）'),
  filter: z
    .string()
    .optional()
    .describe(
      '过滤表达式（借鉴官方 CLI）：`status:active,pri<=2,title~登录`。运算符 `:` 等于 / `!=` / `>` `<` `>=` `<=` / `~` 包含 / `!~` 不包含'
    ),
  filterMode: z.enum(['and', 'or']).optional().default('and').describe('filter 表达式多个条件之间的连接方式'),
  orderBy: z.string().optional().describe('服务端排序字段，如 id_desc、pri_asc'),
  page: z.number().int().min(1).optional().default(1).describe('页码'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('每页数量'),
  pick: z.string().optional().describe(PICK_DESC),
  sort: z.string().optional().describe(SORT_DESC),
};

const MyBugListShape = {
  role: z
    .enum(['assigned', 'opened', 'resolved', 'edited', 'any'])
    .optional()
    .default('assigned')
    .describe(
      '「我」的身份口径。assigned 指派给我（默认）/ opened 由我创建 / resolved 由我解决 / ' +
        'edited 由我最后修改 / any 与我相关（任一身份）。' +
        'assigned / opened / resolved 走服务端「地盘」接口（快，约 1 秒）；' +
        'edited 和 any 走「逐产品合并」（慢，约 10 秒，有 5 分钟缓存）。' +
        '⚠️ 禅道里这几个字段的数据差异可能极大，只查 assigned 容易得出「什么都没有」的结论，' +
        '若结果为 0 建议换 resolved / any 再试 —— 返回里会提示各身份的命中数'
    ),
  includeClosed: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否包含已关闭的 Bug。默认 false（只看待处理的：active + resolved）'),
  status: z
    .enum(['active', 'resolved', 'closed'])
    .optional()
    .describe('进一步按状态精确筛选（本地）：active 激活 / resolved 已解决 / closed 已关闭'),
  productID: z.number().int().positive().optional().describe('只查某个产品下的 Bug（不传则查全库）'),
  keyword: z.string().optional().describe('关键词，在标题 / 重现步骤中模糊匹配（本地过滤）'),
  orderBy: z.string().optional().describe('服务端排序字段，如 id_desc、pri_asc'),
  page: z.number().int().min(1).optional().default(1).describe('页码'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('每页数量'),
  pick: z.string().optional().describe(PICK_DESC),
  sort: z.string().optional().describe(SORT_DESC),
};

/**
 * 「我的地盘」四合一：Bug / 任务 / 需求 / 待办。
 *
 * 服务端是**同一个接口** `GET /my/work`，靠 `mode` 选资源、`type` 选身份 ——
 * 所以做成一个带 `mode` 的工具，而不是四个工具。
 */
const MyWorkListShape = {
  mode: z
    .enum(['bug', 'task', 'story', 'todo'])
    .describe(
      '**必填**，查哪种资源：bug 我的 Bug / task 我的任务 / story 我的需求 / todo 我的待办。' +
        '⚡ 除 bug 外的三种都是官方 CLI **给不了**的能力 —— 官方走 /my/tasks、/my/stories、' +
        '/my/todos，这些路由在 max8.5 以下实例是 404；本工具走统一的 /my/work 接口，不受该门槛影响。'
    ),
  type: z
    .enum(['assignedTo', 'openedBy', 'resolvedBy', 'assignedBy', 'closedBy', 'feedbackBy'])
    .optional()
    .default('assignedTo')
    .describe(
      '身份口径：assignedTo 指派给我（默认）/ openedBy 由我创建 / resolvedBy 由我解决 / ' +
        'assignedBy 由我指派给别人 / closedBy 由我关闭 / feedbackBy 由我反馈。' +
        '⚠️ 该参数**自带状态条件**（assignedTo 只返回未关闭的），且 `todo` mode 没有身份维度、会被忽略。'
    ),
  includeClosed: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否包含已关闭的（本地过滤）。默认 false 只看待处理'),
  status: z.string().optional().describe('按状态精确筛选（本地），如 wait / doing / done / closed'),
  keyword: z.string().optional().describe('关键词，在标题 / 描述里模糊匹配（本地）'),
  resolveUserNames: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      '是否把 assignedTo / openedBy 这类账号补上人名（默认 true）。' +
        '人名来自地盘接口自带的 users 字典 —— **部分实例**的 /users 端点是 404，这是唯一的映射来源'
    ),
  page: z.number().int().min(1).optional().default(1).describe('页码（本地分页）'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('每页数量（本地分页）'),
  sort: z.string().optional().describe(SORT_DESC),
  pick: z.string().optional().describe(PICK_DESC),
};

/**
 * 地盘 → 日志（工时）。
 *
 * ⚡ 官方 CLI **完全没有**这个能力（`zentao ls effort` → E2001，官方 SDK `zentao-api`
 * 里连 `effort` 这个字符串都没有），所以这是本项目相对官方的独占能力。
 *
 * ⚠️ 两个必须知道的坑，都写进参数说明了：
 * ① 日期过滤是本地的 —— 网页上那个 `date=20261015` 经 api.php/v2 之后**完全失效**
 *   （`begin`/`end`/`start`/`dateFrom`… 一并被静默忽略，实测 16 种参数名全无效）；
 * ② 服务端对不支持的 `type` 取值**不报错、只回 0 条**，所以「0 条」有歧义。
 */
const MyEffortListShape = {
  type: z
    .enum(['all', 'today', 'yesterday', 'thisweek', 'lastweek', 'thismonth', 'lastmonth'])
    .optional()
    .default('all')
    .describe(
      '服务端时间口径（**相对「今天」解释**）：all 全部（默认）/ today 今天 / yesterday 昨天 / ' +
        'thisweek 本周 / lastweek 上周 / thismonth 本月 / lastmonth 上月。' +
        '⚠️ 服务端**只认这几个预设**；传别的值（如 thisyear / lastyear）不报错但只回 0 条，' +
        '所以「0 条」既可能是真没有、也可能是取值不支持 —— 想确认就换 all 看总数。'
    ),
  date: z
    .string()
    .optional()
    .describe(
      '**单个日期**，`20261015` 或 `2026-10-15` 都行（等价于 begin=end=该日）。' +
        '⚠️ 本地过滤 —— 网页上那个 `date=20261015` 参数经 api.php/v2 **不生效**，由本工具自行裁剪。' +
        '与 begin / end 互斥。'
    ),
  begin: z.string().optional().describe('起始日期（含，本地过滤），同上两种写法。'),
  end: z.string().optional().describe('截止日期（含，本地过滤），同上两种写法。'),
  keyword: z.string().optional().describe('关键词，在「工作内容」（work）里模糊匹配（本地过滤）'),
  orderBy: z.string().optional().default('date_desc').describe('服务端排序，如 date_desc（默认）/ date_asc / id_desc / id_asc'),
  summary: z.boolean().optional().default(true).describe('是否附带按日 / 按月的工时汇总（默认 true）'),
  page: z.number().int().min(1).optional().default(1).describe('页码（本地分页）'),
  limit: z.number().int().min(1).max(200).optional().default(20).describe('每页数量（本地分页）'),
  sort: z.string().optional().describe(SORT_DESC),
  pick: z.string().optional().describe(PICK_DESC),
};

const BugByIdShape = {
  bugID: z.number().int().positive().describe('Bug ID'),
  includeActions: z.boolean().optional().default(false).describe('是否附带操作历史（谁在什么时候做了什么）'),
  pick: z.string().optional().describe(PICK_DESC),
};

const BugAttachmentsShape = {
  bugID: z.number().int().positive().describe('Bug ID'),
  download: z
    .boolean()
    .optional()
    .default(true)
    .describe('是否把附件下载到本地并返回绝对路径（默认 true）。只想拿 URL 就传 false'),
  outputDir: z
    .string()
    .optional()
    .describe('本地保存目录。默认 `{系统临时目录}/zendao-attachments/{bugID}`，也可用环境变量 ZENTAO_ATTACHMENT_DIR 覆盖'),
  force: z.boolean().optional().default(false).describe('已存在时是否重新下载，默认 false（复用上次的）'),
};

const BatchCreateTasksShape = {
  executionID: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('统一的目标执行 ID；items 里没单独写 executionID 时用这个'),
  items: z.array(TaskItemSchema).min(1).max(50).describe('任务列表（最多 50 个）'),
  options: z
    .object({
      continueOnError: z.boolean().optional().default(true).describe('出错时是否继续'),
      reportMode: z.enum(['summary', 'detailed']).optional().default('summary').describe('报告模式'),
      maxConcurrency: z.number().int().min(1).max(20).optional().default(5).describe('最大并发数'),
      delayBetweenBatches: z.number().int().min(0).optional().describe('批次间延迟（毫秒）'),
    })
    .optional()
    .default({}),
};

// ---- 用户字典 ----
// ⚠️ /users 与 /users/{id} 在本实例都是 404，账号↔人名只能从地盘接口的 users 字典取。

const UserListShape = {
  keyword: z.string().optional().describe('关键词，在账号或姓名里模糊匹配（本地）'),
  account: z.string().optional().describe('精确查某个账号（本地），如 `your-account`'),
  realNameOnly: z.boolean().optional().default(false).describe('只看有真实姓名的（排除没填姓名、账号即姓名的账号）'),
  page: z.number().int().min(1).optional().default(1).describe('页码'),
  limit: z.number().int().min(1).max(100).optional().default(50).describe('每页数量'),
  sort: z.string().optional().describe(SORT_DESC),
  pick: z.string().optional().describe(PICK_DESC),
};

// ---- 输出 Schema ----
// 说明：这些会被塞进 outputSchema（裸形状），SDK 会用它校验结构化返回。
// 禅道返回的字段类型不稳定（数值可能是字符串、可选字段可能缺失），
// 所以这里刻意写得**宽松**：容器类字段一律 z.array(z.any())，
// 只约束最关键的分页元信息，避免真实调用时因校验失败抛 InvalidParams。

/**
 * 详情类输出形状：**一律写成「单键容器」`{ <资源>: z.any() }`，不要写成字段白名单**。
 *
 * 原因：MCP SDK 会把 outputSchema 转成 JSON Schema，客户端再用 ajv 校验 structuredContent，
 * 而 zod object 默认带 `additionalProperties: false`。禅道实体有 40~75 个字段、且随版本漂移，
 * 白名单永远写不全 —— 结果就是「工具一调就炸」：
 *   Structured content does not match the tool's output schema: data must NOT have additional properties
 * （get_bug 以及已收敛掉的其它详情类工具都踩过，2026-09-15 修复）
 *
 * 换成容器后：structuredContent 顶层只有容器键这一个属性，实体字段层面不再受限；
 * `pick` 也才有用武之地（它裁的就是容器里那个对象，而不是把顶层字段裁得越界）。
 * 列表类工具（`{ bugs: z.array(z.any()) }`）天然是这个形状，所以从来没出过问题。
 *
 * ----
 *
 * 任务详情：比列表多一个**可选的操作历史** —— 单独开一个形状，
 * 而不是给实体容器加可选字段，免得别的工具声明里也凭空出现 `actions`，
 * 让人误以为它们会返回操作历史（实际不会）。
 */
const TaskDetailOutputShape = {
  task: z.any(),
  actions: z.array(z.any()).optional(),
};

const BatchResultOutputShape = {
  total: z.number(),
  successful: z.number(),
  failed: z.number(),
  duration: z.number().optional(),
  errors: z
    .array(
      z.object({
        index: z.number(),
        error: z.string(),
      })
    )
    .optional(),
};

const BugOutputShape = {
  /**
   * Bug 实体，完整字段透传（实测 75 个字段）。
   * 常用：id/title/status/pri/severity/type/product/module/project/execution/assignedTo/
   * openedBy/openedDate/steps/resolution/resolvedBy/files …
   */
  bug: z.any(),
};

/**
 * Bug 附件（截图）清单。
 *
 * 附件对象形如 `{ fileID, source, title, extension, isImage, url, localPath, bytes, kind, error }`，
 * 字段随禅道版本与下载结果而变，所以用 z.any() 放开 —— 理由同 BugOutputShape。
 */
const BugAttachmentsOutputShape = {
  bugID: z.coerce.number(),
  bugTitle: z.string().optional(),
  count: z.number(),
  downloaded: z.number(),
  attachments: z.array(z.any()),
};

const BugListOutputShape = {
  scope: z.string().optional(),
  browseType: z.string().optional(),
  bugs: z.array(z.any()),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  pageTotal: z.number().optional(),
  /** 全局范围是逐产品合并得到的：遍历的产品数 */
  productScanned: z.number().optional(),
  /** 其中靠 /bugs 产品字典补回的影子产品（shadow=1）数量 */
  shadowProductScanned: z.number().optional(),
};

const MyBugListOutputShape = {
  account: z.string().optional(),
  role: z.string().optional(),
  scope: z.string().optional(),
  source: z.string().optional(),
  includeClosed: z.boolean().optional(),
  bugs: z.array(z.any()),
  total: z.number(),
  scanned: z.number().optional(),
  page: z.number(),
  limit: z.number(),
  pageTotal: z.number().optional(),
  serverTodoCount: z.number().optional(),
  productScanned: z.number().optional(),
  shadowProductScanned: z.number().optional(),
};

/** 「我的地盘」四合一的结构化返回（四种 mode 共用，`items` 里是各自资源） */
const MyWorkListOutputShape = {
  account: z.string().optional(),
  mode: z.string(),
  type: z.string().optional(),
  includeClosed: z.boolean().optional(),
  scope: z.string().optional(),
  source: z.string().optional(),
  items: z.array(z.any()),
  total: z.number(),
  /** 服务端实际返回的条数（本地过滤前），用于解释「为什么是这个数」 */
  scanned: z.number().optional(),
  page: z.number(),
  limit: z.number(),
  pageTotal: z.number().optional(),
  /** 服务端自报的计数对象（todoCount，各资源各占一个键） */
  serverCounts: z.any().optional(),
  /** 服务端生成的中文汇总句（只有 task mode 有） */
  serverSummary: z.string().optional(),
  /** todo mode 的额外标量（date / waitCount / doingCount） */
  extras: z.any().optional(),
};

/**
 * 地盘-日志（工时）的结构化返回。
 *
 * `byDate` / `byMonth` 是「日期 → 小时」的映射，键随数据而变，用 z.any() 放开。
 * 注意 `structuredContent` 里**不含**响应自带的 `user` 对象（那个里面带 password 哈希）。
 */
const MyEffortListOutputShape = {
  account: z.string().optional(),
  type: z.string(),
  typeLabel: z.string().optional(),
  date: z.string().optional(),
  begin: z.string().optional(),
  end: z.string().optional(),
  /** server-type = 只用服务端 type 口径；local = 还叠加了本地日期 / 关键词过滤 */
  rangeMode: z.string().optional(),
  keyword: z.string().optional(),
  orderBy: z.string().optional(),
  source: z.string().optional(),
  items: z.array(z.any()),
  total: z.number(),
  /** 服务端返回的条数（本地过滤前） */
  scanned: z.number().optional(),
  page: z.number(),
  limit: z.number(),
  pageTotal: z.number().optional(),
  /** 本次结果内 consumed 合计（小时） */
  hoursTotal: z.number().optional(),
  /** 本次结果内 left 合计（小时） */
  leftTotal: z.number().optional(),
  /** 本次结果覆盖的天数 */
  days: z.number().optional(),
  /** 服务端自报的总条数（不含本地过滤） */
  serverRecTotal: z.number().optional(),
  byDate: z.any().optional(),
  byMonth: z.any().optional(),
};

/** 版本实体（实测 24 个字段：id/name/date/product/execution/builder/stories/bugs …） */
/** 用户字典条目：`{ account, realName, hasRealName }` */
const UserListOutputShape = {
  source: z.string().optional(),
  users: z.array(z.any()),
  total: z.number(),
  /** 其中查到了真实姓名的人数 */
  withRealName: z.number().optional(),
  page: z.number(),
  limit: z.number(),
  pageTotal: z.number().optional(),
};

// ---------- 通用层（官方全量动作）----------
//
// ⚠️ 这三个形状刻意写成「全字段 z.any().optional()」：
// `zendao_modules` 与 `zendao_help` 都有**两种返回形态**（不给 module 时给摘要、
// 给了 module 时给详情），共用同一个 outputSchema 时，任何 `required` 字段
// 都会在其中一种形态下被 ajv 判为缺失。用 optional + any 覆盖并集最稳。

const SdkModulesShape = {
  module: z
    .string()
    .optional()
    .describe('下钻到单个模块（如 `bug`、`task`、`product`）；不传则只给模块级摘要'),
  keyword: z.string().optional().describe('按模块名 / 动作名做本地关键词过滤'),
  includeUnsupported: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否把「被版本门槛拒绝的动作」也列出来（默认 false，只列可用动作）'),
};

const SdkHelpShape = {
  module: z.string().describe('模块名（必填，大小写不敏感），如 `bug`、`task`、`product`'),
  action: z
    .string()
    .optional()
    .describe('动作名，如 `list` / `get` / `create` / `close`；省略则列出该模块全部动作的参数摘要'),
  role: z.enum(['path', 'query', 'body']).optional().describe('只看某一类参数（路径 / 查询 / 请求体）'),
};

const SdkCallShape = {
  module: z.string().describe('模块名（必填，大小写不敏感），如 `bug`、`task`、`product`'),
  action: z
    .string()
    .describe('动作名（必填，大小写不敏感；`ls` 是 `list` 的别名），如 `list` / `get` / `create` / `close`'),
  params: z
    .record(z.any())
    .optional()
    .describe(
      '动作参数对象。path / query / body 字段**平铺**在这里（不用区分角色），' +
        '例如 `{ productID: 7, pageID: 1 }`。参数名与必填项用 `zendao_help` 查'
    ),
  page: z.number().int().min(1).optional().describe('页码（服务端分页，映射为 v2 的 pageID）'),
  recPerPage: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('每页条数（服务端分页）。不传时用 20 —— 不设的话服务端会把整页全量返回'),
  pick: z.string().optional().describe(PICK_DESC),
  sort: z.string().optional().describe(SORT_DESC),
  limit: z.number().int().min(1).optional().describe('本地限数（服务端结果返回后再截断）'),
  search: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      '本地搜索。**字符串内逗号 = AND，数组元素之间 = OR**：' +
        '`"登录"` → 任一字段含「登录」即保留；`"登录,导出"` → 两个词都要命中；' +
        '`["登录","导出"]` → 命中任一即可'
    ),
  searchFields: z
    .array(z.string())
    .optional()
    .describe('搜索范围字段，如 `["title","steps"]`；省略则搜全部字段'),
  filter: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      '本地过滤表达式，如 `status=active`、`pri<=2`、`title~登录`。' +
        '支持 `=` `!=` `~`（包含） `!~` `>` `<` `>=` `<=`（`:` 等价于 `=`）。' +
        '**语义：字符串内逗号 = AND，数组元素之间 = OR** —— ' +
        '`"status=active,pri<=2"` 是「且」，`["status=active","status=resolved"]` 是「或」'
    ),
  autoFill: z
    .boolean()
    .optional()
    .describe('`update` 动作是否先取现值再提交（默认 true，避免未提交字段被覆盖为空）'),
  convertHtml: z
    .boolean()
    .optional()
    .default(true)
    .describe('是否把富文本字段（HTML）转成 Markdown（默认 true）'),
  raw: z
    .boolean()
    .optional()
    .default(false)
    .describe('返回服务端原始响应（不做结果提取与本地处理），排查问题时用'),
};

const SdkModulesOutputShape = {
  version: z.any().optional(),
  edition: z.any().optional(),
  versionSource: z.any().optional(),
  module: z.any().optional(),
  display: z.any().optional(),
  moduleTotal: z.any().optional(),
  actionTotal: z.any().optional(),
  actionSupported: z.any().optional(),
  actions: z.any().optional(),
  modules: z.any().optional(),
};

const SdkHelpOutputShape = {
  module: z.any().optional(),
  action: z.any().optional(),
  display: z.any().optional(),
  description: z.any().optional(),
  method: z.any().optional(),
  path: z.any().optional(),
  type: z.any().optional(),
  resultType: z.any().optional(),
  minVersion: z.any().optional(),
  supported: z.any().optional(),
  mediaType: z.any().optional(),
  params: z.any().optional(),
  example: z.any().optional(),
  version: z.any().optional(),
  actionTotal: z.any().optional(),
  actions: z.any().optional(),
};

const SdkCallOutputShape = {
  module: z.any(),
  action: z.any(),
  status: z.any(),
  pager: z.any(),
  data: z.any(),
  response: z.any(),
  kind: z.any(),
};

// ---- 日志写入（自定义日志 / 删除）----
//
// ⚠️ 这一组工具走的是**网页表单**（index.php），不是 REST ——
// 禅道 REST 完全没有自定义日志的写入与日志删除通路。详见 src/web/effort.ts 的实测记录。

const FillEffortsInputShape = {
  items: z
    .array(z.object(EffortItemShape))
    .min(1)
    .max(50)
    .describe('要填的日志条目（最多 50 条）'),
  dryRun: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      '默认 true = 只预览不写。禅道日志写错没有"编辑回滚"（只能删），所以真写必须显式传 false'
    ),
  autoExecution: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      '是否自动推断执行（迭代）：任务/Bug 用它自己所属的执行；否则用 projectID 下「进行中且开始时间最晚」的迭代'
    ),
};

const FillEffortsOutputShape = {
  dryRun: z.any(),
  total: z.any(),
  submitted: z.any(),
  failed: z.any(),
  days: z.any(),
  duplicates: z.any(),
  items: z.any(),
};

const DeleteEffortOutputShape = {
  effortID: z.any(),
  deleted: z.any(),
  verifiedGone: z.any(),
  message: z.any(),
};

/**
 * 注册所有工具到 MCP 服务器
 */
export function registerAllTools(
  server: McpServer,
  client: ZenTaoClient,
  cache: LRUCache<string, any>,
  logger: Logger
): void {
  // ---------- 任务管理 ----------

  server.registerTool(
    'zendao_get_task',
    {
      title: '获取任务详情',
      description:
        '根据任务 ID 获取详细信息，可选附带操作历史（actions）。' +
        '⚡ 补的是这条断链：`zendao_call { module: "task", action: "list" }` 能列、' +
        '`task/create` 能建、`task/update` 能改状态，但**拿到 taskID 之后看不了详情**，' +
        '原来只能回网页 —— 本工具补上这条路（`GET /tasks/{id}`）。' +
        '默认会把 assignedTo / openedBy 这类账号补上人名（resolveUserNames: true）。',
      inputSchema: TaskByIdShape,
      outputSchema: TaskDetailOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取任务详情', args);
      try {
        const result = await getTask(client, cache, args.taskId, {
          includeActions: args.includeActions,
          pick: args.pick,
          resolveUserNames: args.resolveUserNames,
        });
        logger.info('获取任务详情成功');
        return result;
      } catch (error: any) {
        logger.error('获取任务详情失败', error);
        throw error;
      }
    }
  );

  // ---------- 批量操作 ----------

  server.registerTool(
    'zendao_batch_create_tasks',
    {
      title: '批量创建任务',
      description:
        '一次性创建多个任务（最多 50 个），支持并发处理与错误恢复。' +
        '禅道没有原生批量接口，这里是逐条调用 + 分批并发。' +
        '可在顶层传 executionID 作为统一归属，items 里也能逐条覆盖。',
      inputSchema: BatchCreateTasksShape,
      outputSchema: BatchResultOutputShape,
      annotations: annotations(false, false),
    },
    async (args) => {
      logger.info('批量创建任务', { itemCount: args.items.length });
      try {
        const result = await batchCreateTasks(
          client,
          cache,
          args.items as any,
          args.options as any,
          args.executionID
        );
        const sc: any = result.structuredContent || {};
        logger.info('批量创建任务完成', {
          total: sc.total,
          successful: sc.successful,
          failed: sc.failed,
        });
        return result;
      } catch (error: any) {
        logger.error('批量创建任务失败', error);
        throw error;
      }
    }
  );

  // ---------- Bug ----------
  //
  // 已收敛到 `zendao_call { module, action }` 的模块（这里只留「不看就会踩」的部分，
  // 完整对照见 docs/official-module-parity.md）：
  //   · project / execution / task / product / program —— list/get 走 zendao_call 即可
  //   · story   ⚠️ **没有全局列表**（/stories、/epics、/requirements 全 404），
  //                必须显式给 productID 或 projectID 之一
  //   · build   ⭐ 版本挂在**执行**下（`/executions/{id}/builds`），
  //                不在产品/项目下（/products|projects/{id}/builds、/builds 全 404）
  //   · user    ⚠️ /users 在多数实例是 404，人员名册请走 zendao_list_users

  server.registerTool(
    'zendao_list_bugs',
    {
      title: '获取 Bug 列表',
      description:
        '获取禅道 Bug 列表。**Bug 归属产品**，通常传 productID（不知道就先调 `zendao_call { module: "product", action: "list" }`）；' +
        '也可用 scope + scopeID 指定 products / projects / executions 范围；都不传则查全局 Bug。' +
        '支持按状态 / 严重程度 / 优先级 / 类型 / 指派给 / 关键词过滤，以及官方风格的 filter 表达式（如 `status:active,pri<=2`）。' +
        '⚠️ 两点**部分实例**的坑：① 服务端 filters 参数被忽略，过滤一律本地做（会放大拉取并在结果里提示已扫描条数）；' +
        '② **全局 /bugs 不是全库** —— 不带 productID 时它只返回某一个产品，所以本工具在全局模式下改为' +
        '「逐产品遍历合并」（含 /products 列表漏掉的 shadow=1 影子产品），首次较慢（约 10 秒）、有 5 分钟缓存。' +
        '要跨产品找 Bug 就不要绕开这个工具。',
      inputSchema: BugListShape,
      outputSchema: BugListOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取 Bug 列表', args);
      try {
        const result = await listBugs(client, cache, args);
        logger.info('获取 Bug 列表成功');
        return result;
      } catch (error: any) {
        logger.error('获取 Bug 列表失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_list_my_bugs',
    {
      title: '获取我的 Bug 列表',
      description:
        '按身份列出与**当前登录账号**相关的 Bug，默认口径是「指派给我 + 未关闭」，即「我待处理的 Bug」。' +
        '⚡ 想知道「我有哪些 Bug 要处理」就用这个工具，比 zendao_list_bugs 手拼参数更可靠。' +
        '禅道里「我」有四种身份，分散在不同字段上（assignedTo / openedBy / resolvedBy / lastEditedBy），' +
        '用 role 参数切换（assigned/opened/resolved/edited/any）——这四种的数据可能差异极大，' +
        '**有的实例里某一账号 assignedTo 只有个位数、resolvedBy 却有数百条**，只查一种身份会得出片面结论。' +
        'includeClosed 默认 false（只看待处理的 active + resolved）。' +
        '数据源有两条，工具会自动选并在结果里写明：' +
        '① 首选**服务端「地盘」接口**（GET /my/work?mode=bug&type=assignedTo，与网页「我的地盘 → Bug」同一通路），' +
        '一次请求返回、约 1 秒，结果与网页一致；' +
        '② 当身份是 edited、或要 includeClosed、或指定了 productID 时，回落到「逐产品遍历合并全库 Bug + 本地过滤」' +
        '（逐个产品遍历，含被 /products 列表漏掉的 shadow=1 影子产品；产品多的实例首次约 10 秒，之后 5 分钟内走缓存）。' +
        '绝不能用全局 /bugs —— 它不带产品时只返回单个产品，会静默漏掉其他产品线的全部 Bug。' +
        '结果为空时工具会列出各身份各命中多少条，并注明数据来源，便于判断「是真没有还是查错了」。',
      inputSchema: MyBugListShape,
      outputSchema: MyBugListOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取我的 Bug 列表', args);
      try {
        const result = await listMyBugs(client, cache, args);
        logger.info('获取我的 Bug 列表成功');
        return result;
      } catch (error: any) {
        logger.error('获取我的 Bug 列表失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_list_my_work',
    {
      title: '获取我的地盘（任务 / 需求 / 待办 / Bug）',
      description:
        '按身份列出与**当前登录账号**相关的资源，用 `mode` 切换：task 我的任务 / story 我的需求 / ' +
        'todo 我的待办 / bug 我的 Bug。默认口径是「指派给我」（assignedTo）。' +
        '⚡ **这是本项目相对官方 CLI 的独占能力**：官方 CLI 走 /my/tasks、/my/stories、/my/todos，' +
        '这些路由在 max8.5 以下实例全是 404（整个 my 模块被版本门槛挡住）；' +
        '本工具走统一的 /my/work 接口，不受该门槛限制。' +
        '「我接下来要干什么」这种问题，用 mode: "task" / "todo" 一问就有答案。' +
        '数据源是服务端地盘接口 GET /my/work（与网页「我的地盘」同一通路，约 1 秒）。' +
        '⚠️ 三个实测坑，工具已处理：① `type` 自带状态条件（assignedTo 只给未关闭的），' +
        '想连已关闭一起看要传 includeClosed: true；' +
        '② `todo` mode 服务端忽略分页参数，本工具改走「全量拉取 + 本地分页」；' +
        '③ 结果里的账号默认补上人名（来自同一响应自带的 users 字典 —— **部分实例**的 /users 是 404，这是唯一来源）。' +
        '注意与 zendao_list_my_bugs 的分工：后者专精 Bug，支持 opened/resolved/edited/any 四种身份、' +
        '可含已关闭、可按产品筛，并且在没有 /my/work 的老实例上会回落到逐产品扫描。',
      inputSchema: MyWorkListShape,
      outputSchema: MyWorkListOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取我的地盘', { mode: args.mode, type: args.type });
      try {
        const result = await listMyWork(client, cache, args as any);
        logger.info('获取我的地盘成功', { mode: args.mode });
        return result;
      } catch (error: any) {
        logger.error('获取我的地盘失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_list_my_efforts',
    {
      title: '获取我的日志（工时）',
      description:
        '列出**当前登录账号**在禅道「地盘 → 日志」里登记的工时记录（工作内容 / 日期 / 工时）。' +
        '⚡ 官方 CLI **完全没有**这个能力（模块清单里没有 effort，官方 SDK 里连这个词都没有），' +
        '所以这是本项目相对官方的独占能力；数据源是与网页同一通路的 `GET /my/effort`。' +
        '典型用法：「我这个月填了多少工时」「9 月 17 号那天填了什么」「上个月都干了啥」。' +
        '时间口径有两套，可以叠加：' +
        '① `type` —— **服务端**预设（all / today / yesterday / thisweek / lastweek / thismonth / lastmonth），' +
        '相对「今天」解释；' +
        '② `date`（单日）或 `begin`/`end`（区间）—— **本地**过滤，任意日期都能筛。' +
        '⚠️ 三个实测坑，工具已处理，但你需要知道：' +
        '（a）**日期过滤是本地的**：网页上那个 `date=20261015` 参数经 api.php/v2 之后彻底失效，' +
        '实测 `date`/`begin`/`end`/`start`/`dateFrom`… 共 16 种参数名一律被静默忽略，所以区间由本工具自行裁剪；' +
        '（b）服务端对不支持的 `type` 取值**不报错、只回 0 条**，于是「0 条」有歧义（真没有 vs 取值不支持），' +
        '结果里会提示你换 `type: "all"` 复核；' +
        '（c）分页参数是 `pageID`，不是 `page`（传 page 会被静默忽略、永远返回第一页），本工具已修正。' +
        '结果默认附带按日 / 按月的工时汇总（`summary: false` 可关掉）。' +
        '⚠️ 本工具**只读**。要**写**日志用 `zendao_fill_efforts`（支持不挂任务的自定义日志），删日志用 `zendao_delete_effort`。',
      inputSchema: MyEffortListShape,
      outputSchema: MyEffortListOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取我的日志（工时）', {
        type: args.type,
        date: args.date,
        begin: args.begin,
        end: args.end,
      });
      try {
        const result = await listMyEfforts(client, cache, args as any);
        logger.info('获取我的日志（工时）成功');
        return result;
      } catch (error: any) {
        logger.error('获取我的日志（工时）失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_fill_efforts',
    {
      title: '填写日志（工时）',
      description:
        '批量写入禅道「地盘 → 日志」的工时记录，**支持自定义日志（不挂任务）**。' +
        '⚡ 这条能力 REST 做不到：禅道 REST 只能给**任务**记工时（`POST /api.php/v1/tasks/{id}/estimate`），' +
        '而 `objectType=custom` 的自定义日志**没有任何 REST 写入通路**（`/efforts` 系列全 404）。' +
        '本工具改走网页批量录入表单（`m=effort&f=batchCreate`），所以自定义日志也能纯接口写入。' +
        '🛡️ **默认 `dryRun: true` 只预览** —— 因为禅道没有日志的编辑回滚能力，写错只能删，' +
        '而错误的工时会计入考勤统计。确认预览无误后传 `dryRun: false` 才真正落库。' +
        '📌 迭代（执行）自动推断：任务/Bug 沿用自己所属的执行；给了 `projectID` 就取该项目' +
        '「进行中 + 开始时间最晚」的迭代。也可以直接用 `executionID` 指定。' +
        '⚠️ 表单一次提交只能填**同一天**（日期是整表一个值），跨天会自动分组提交；单批最多 50 条。' +
        '⚠️ 需要 `ZENTAO_ACCOUNT` + `ZENTAO_PASSWORD`（网页登录必须有明文密码，' +
        'Token 和官方 CLI 的 profile 都用不了）。' +
        '写完后工具会**自动回查**，把落库的日志 ID 带回来 —— 要撤销就用 `zendao_delete_effort`。',
      inputSchema: FillEffortsInputShape,
      outputSchema: FillEffortsOutputShape,
      annotations: annotations(false, true),
    },
    async (args) => {
      logger.info('填写日志（工时）', { count: args.items?.length, dryRun: args.dryRun });
      try {
        const result = await fillEffortsTool(client, cache, args as any);
        const sc: any = result.structuredContent || {};
        logger.info('填写日志完成', { dryRun: sc.dryRun, total: sc.total, submitted: sc.submitted });
        return result;
      } catch (error: any) {
        logger.error('填写日志失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_delete_effort',
    {
      title: '删除日志（工时）',
      description:
        '删除一条已登记的禅道日志（工时记录）。**不可撤销**（禅道没有回收站），是 `zendao_fill_efforts` 写错后的唯一收尾手段。' +
        '⚡ REST 做不到：DELETE 在本实例被 HTTP 层直接掐断（`ECONNRESET`）。本工具走网页删除入口' +
        '（`m=effort&f=delete&confirm=yes`）。' +
        '📌 删掉**挂任务**的日志时，禅道会自动回滚该任务的已消耗工时（任务状态不会退回未开始）。' +
        '日志 ID 从 `zendao_list_my_efforts` 或 `zendao_fill_efforts` 的返回里拿；' +
        '顺带传 `date` 可以做删除后校验。',
      inputSchema: DeleteEffortShape,
      outputSchema: DeleteEffortOutputShape,
      annotations: annotations(false, true),
    },
    async (args) => {
      logger.info('删除日志（工时）', { effortID: args.effortID });
      try {
        const result = await deleteEffortTool(client, cache, args as any);
        logger.info('删除日志完成', { effortID: args.effortID });
        return result;
      } catch (error: any) {
        logger.error('删除日志失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_get_bug',
    {
      title: '获取 Bug 详情',
      description:
        '根据 Bug ID 获取详细信息，可选附带操作历史（actions）。' +
        '注意：禅道对不存在的 ID 不返回 404 而是返回 status=fail，本工具会识别并给出明确提示。',
      inputSchema: BugByIdShape,
      outputSchema: BugOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取 Bug 详情', args);
      try {
        const result = await getBug(client, cache, args.bugID, {
          includeActions: args.includeActions,
          pick: args.pick,
        });
        logger.info('获取 Bug 详情成功');
        return result;
      } catch (error: any) {
        logger.error('获取 Bug 详情失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_get_bug_attachments',
    {
      title: '获取 Bug 附件（截图）',
      description:
        '把 Bug 复现步骤里的截图**下载到本地**，返回可直接打开的本地绝对路径。' +
        '⚡ 禅道里很多 Bug 是「见图」型 —— steps 文字只有一句话，信息全在截图里，' +
        '看到 `zendao_get_bug` 返回的 steps 里有 `![](/zentaomax/index.php?m=file&f=read&t=png&fileID=…)` ' +
        '就该调这个工具把图拿下来看。' +
        '两处坑（工具已处理）：① Bug 实体的 `files` 字段**常为空数组**，附件只在 steps 的 HTML 里，' +
        '所以会同时扫 files 字段、steps、操作历史三处；' +
        '② 文件元数据（GET /files/{id}）的 **size 字段装的是服务器绝对路径**而非字节数，' +
        '工具据此拼出 `data/upload/**` 静态地址直取（该目录匿名可读，仍会带认证）。' +
        '默认下载到 `{临时目录}/zendao-attachments/{bugID}/`，重名会带 fileID 前缀避免互相覆盖；' +
        '下载后会按魔数校验确实是图片（防止把登录页 HTML 存成 .png）。' +
        '结果里逐个附件给出本地路径、直取 URL、大小与来源；拿不到的会写明原因 —— ' +
        '有失败项时不要据此断定「这条 Bug 没图」。',
      inputSchema: BugAttachmentsShape,
      outputSchema: BugAttachmentsOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取 Bug 附件', { bugID: args.bugID, download: args.download });
      try {
        const result = await getBugAttachments(client, cache, args);
        logger.info('获取 Bug 附件成功');
        return result;
      } catch (error: any) {
        logger.error('获取 Bug 附件失败', error);
        throw error;
      }
    }
  );

  // ---------- Bug 模块树（分类目录）----------

  // ---------- 用户字典（账号 ↔ 人名）----------

  server.registerTool(
    'zendao_list_users',
    {
      title: '获取用户字典（账号 → 人名）',
      description:
        '把禅道里的**账号**（如 `your-account`）换算成**人名**（如 `xxx`）。' +
        '⚡ 禅道所有返回里的 assignedTo / openedBy / resolvedBy 存的都是账号字符串，' +
        '「这条 Bug 是谁提的、该找谁」是最高频的问题之一。' +
        '⚠️ 官方那几个路径在**部分实例**不可用：GET /users、/users/{id}、' +
        '/{projects|executions}/{id}/members 可能全是 404。' +
        '本工具绕道服务端地盘接口 —— `/my/work` 的响应每个 mode 都自带 `users` 与 `memberPairs` ' +
        '两套 `{账号: 姓名}` 字典（合计上百条），取一次缓存 30 分钟。' +
        '多数场景不必手动调它：zendao_list_my_work / zendao_get_task / zendao_list_bugs ' +
        '默认就会把账号补上 `xxxName` 字段。',
      inputSchema: UserListShape,
      outputSchema: UserListOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('获取用户字典', args);
      try {
        const result = await listUsers(client, cache, args as any);
        logger.info('获取用户字典成功');
        return result;
      } catch (error: any) {
        logger.error('获取用户字典失败', error);
        throw error;
      }
    }
  );

  // ---------- 通用层：官方全量动作（26 模块 / 229 个动作）----------
  //
  // 这三个工具是「官方注册表驱动」的统一入口，覆盖官方 CLI 的全部业务动作 ——
  // 而具体有哪些动作可用，由**实例自报的禅道版本**在运行时决定
  // （例如 max8.2 实例放行 106 个，max8.5 实例放行 229 个）。
  //
  // 与上面手写工具的关系：手写工具带实例兜底逻辑（全库合并、附件提取、/my/work 地盘），
  // 通用层负责「广度」。已知被通用层完全覆盖的手写工具，后续会按计划收敛。

  server.registerTool(
    'zendao_modules',
    {
      title: '列出可用模块与动作（随实例版本自适应）',
      description:
        '列出**当前禅道实例实际可用**的模块与动作（官方注册表全量 26 模块 / 229 个动作，' +
        '按实例版本过滤后给出真正能调的那些）。' +
        '⚡ 通用层三步走的第一步：`zendao_modules`（有哪些动作）→ `zendao_help`（参数怎么传）→ `zendao_call`（执行）。' +
        '默认给**模块级摘要**（每行一个模块 + 可用动作名），传 `module` 可下钻看单模块的动作清单（含 HTTP 方法与路径）。' +
        '⚠️ 禅道各版本能力差异极大（开源版 / 企业版 / 旗舰版 / IPD 版），' +
        '所以「有哪些能力」必须以本工具的**实时结果**为准，不要凭印象猜。' +
        '想看被版本门槛拒绝的动作（如升级后会有什么）传 `includeUnsupported: true`。',
      inputSchema: SdkModulesShape,
      outputSchema: SdkModulesOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('列出模块与动作', args);
      try {
        const result = await listSdkModules(client, cache, args as any);
        logger.info('列出模块与动作完成');
        return result;
      } catch (error: any) {
        logger.error('列出模块与动作失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_help',
    {
      title: '查动作的完整参数表',
      description:
        '查询某个**动作**的完整参数定义：路径参数 / 查询参数 / 请求体字段，' +
        '每项都带**类型、是否必填、默认值、可选值枚举与中文说明**，并附一条可直接粘贴的 `zendao_call` 调用示例。' +
        '⚡ 通用层三步走的第二步 —— 调 `zendao_call` 之前先用它确认参数名与必填项，' +
        '避免参数名猜错（禅道的参数名有不少反直觉处，如 `productID`、`openedBuild`、`recPerPage`）。' +
        '省略 `action` 时会列出该模块**全部动作**及其必填参数，适合「还没想好用哪个动作」时。',
      inputSchema: SdkHelpShape,
      outputSchema: SdkHelpOutputShape,
      annotations: annotations(true, false),
    },
    async (args) => {
      logger.info('查询动作参数表', args);
      try {
        const result = await getSdkActionHelp(client, cache, args as any);
        logger.info('查询动作参数表完成');
        return result;
      } catch (error: any) {
        logger.error('查询动作参数表失败', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'zendao_call',
    {
      title: '执行任意官方动作（通用执行器）',
      description:
        '按 `模块/动作` 调用禅道官方 API —— **一个工具覆盖官方注册表的全部 229 个动作**，' +
        '包括产品 / 项目 / 执行 / 需求 / 任务 / Bug / 版本 / 发布 / 测试 / 反馈 / 工单 / 计划 等。' +
        '⚡ 用法：先用 `zendao_modules` 确认动作可用，再用 `zendao_help` 确认参数名，然后调用本工具。' +
        '例：`{ module: "bug", action: "list", params: { productID: 7 } }`。' +
        '路径 / 查询 / 请求体参数**平铺**在 `params` 里，不用区分角色。' +
        '⚠️ 写操作会**真的落库**（create / update / delete / close 等）。' +
        '⚠️ **部分禅道实例**的前端会在 HTTP 层拦截 PUT/DELETE（表现为连接重置或 501），' +
        '这种环境下相关动作会给出明确失败说明，**不会静默改数据**，也不会降级成 POST 去试探。' +
        '⚠️ 若某动作报「版本不支持」，说明当前禅道版本没有这个能力（不是配置问题），可用 `zendao_modules` 查看替代动作。',
      inputSchema: SdkCallShape,
      outputSchema: SdkCallOutputShape,
      annotations: annotations(false, true),
    },
    async (args) => {
      logger.info('执行官方动作', args);
      try {
        const result = await callSdkAction(client, cache, args as any);
        logger.info('执行官方动作完成');
        return result;
      } catch (error: any) {
        logger.error('执行官方动作失败', error);
        throw error;
      }
    }
  );

  logger.info('所有工具注册完成');
}
