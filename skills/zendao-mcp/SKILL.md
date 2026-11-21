---
name: zendao-mcp
display_name: 禅道 MCP
description: 通过 zendao-mcp 的 MCP 工具查询和维护禅道（ZenTao）的产品、需求、任务、Bug、工时、页面链接与附件。当用户要求操作禅道数据、查我的待办/任务/Bug、填报工时、生成禅道页面链接或读取附件时使用；安装/接入问题参见 MCP-SETUP.md。
description_zh: 让 AI 客户端通过 MCP 读写禅道的项目、任务、Bug 和工时。擅长「我的地盘」类查询、跨产品 Bug 汇总、通用动作兜底，以及本实例特有的附件与工时通路。
description_en: MCP tools to query and maintain ZenTao products, stories, tasks, bugs, efforts, page links and attachments. Use for ZenTao data operations, "my work" queries, effort logging and attachment reads.
license: MIT
version: 1.3.0
metadata:
  repository: https://github.com/Michael-py001/zendao-mcp
  keywords: [zentao, 禅道, mcp, project-management]
---

# 禅道 MCP

接的是 `zendao-mcp`（stdio MCP，工具名统一前缀 `zendao_`）。共 **16 个工具**：3 个通用层走官方 `zentao-api@0.9.3` 注册表（43 模块 / 365 动作，按实例版本过滤），13 个手写工具补官方给不了的实例能力。

## 先发现，再动手

不确定某个动作怎么调时，走这三步，不要凭记忆猜参数：

1. `zendao_modules` — 看当前实例**实际可用**的模块/动作（版本门槛在运行时判，不是所有 365 个都能用）
2. `zendao_help { module, action }` — 查参数表、必填项、枚举、调用示例
3. `zendao_call { module, action, params }` — 执行任意官方动作（写类动作会真落库）

## 工具选择地图

| 场景 | 首选工具 |
| --- | --- |
| 我的 Bug（指派/我建/我解决/我改） | `zendao_list_my_bugs { role }` — **role 只查一种会漏**，大宗用 `any` |
| 我的任务/需求/待办/Bug | `zendao_list_my_work { mode }` — mode: task/story/todo/bug 等 |
| 全库 / 按产品查 Bug | `zendao_list_bugs`（自带跨产品合并，因为没有全库 Bug 接口） |
| Bug / 任务详情 | `zendao_get_bug` / `zendao_get_task` |
| Bug 截图 | `zendao_get_bug_attachments { bugID }` — 下载到本地返回绝对路径 |
| 任意对象的附件 | `zendao_read_attachment { fileID | url | html }` |
| 工时日志查询 | `zendao_list_my_efforts` |
| 工时日志写入 / 删除 | `zendao_fill_efforts` / `zendao_delete_effort` — ⚠️ 见下方铁律 |
| 账号→人名 | `zendao_list_users` |
| 页面链接生成/解析 | `zendao_link { action: create|parse }` |
| 批量建任务 | `zendao_batch_create_tasks { items, executionID }` |

## ⛔ 写操作铁律（违反会出事）

- **填工时日志前必须先出清单等用户确认**：列「标题 / 对象 / 执行 / 工时」四列表格，用户点头后才真写。`dryRun: true` 只是验参数，**不是确认环节**，确认完也不许自行改 `dryRun: false`。
- **日志对象不能默认留空**：先 `zendao_list_my_work { mode: "task" }` 拉我名下任务做语义匹配；匹配不上才用 `custom`。
- **挂任务的日志 `left` 必填**：`objectType=task_xxx` 又不给 `left`，服务端返回 246 字节空壳页，不报错也不落库，**整批全灭**。工具会自动读任务剩余工时并按批内顺序递减；注意 `left` 只写进日志自身，不回写任务的剩余工时。
- **写类动作会真写库**：`zendao_call` 的 create/update/delete/close、`batch_create_tasks`、`fill_efforts`、`delete_effort` 都是真写。只被要求查询/分析时不要写。
- 写完后按 ID 再查一次详情核实，别把「调用没报错」当成「写成功」。

## 实例踩坑（血泪结论，别重新试错）

- **「我的 X」只认 `zendao_list_my_work`**：官方 `my` 模块的 `/my/tasks` 等在本实例真 404；`zendao_call { module: "my", ... }` 打不到。
- **没有全局任务 / 需求列表**：任务必须带 `executionID`（任务挂执行下），需求必须带 `productID` 或 `projectID`（需求无全局列表）；Bug 挂产品下。
- **Bug 截图藏在 `steps` 里**：Bug 的 `files` 字段常为空，图片是 `steps` HTML 里的 `<img fileID=...>`。用 `zendao_get_bug_attachments`，别只看 `files`。
- **`filters` / `browseType` 基本无效**：除 `/projects` 的 `browseType` 外都被静默忽略。大范围拉取 + 本地过滤 + 本地分页，别指望服务端筛选。
- **结果为 0 要说清扫描范围**：写「已扫描 N 条」而不是「没有」，避免把「没找到」误报成「不存在」。
- **拿不到 currentAccount 就报错**，不要用空账号去猜「指派给我」。
- **富文本默认转 Markdown**；`zendao_call` 的 HTML→Markdown 转换对列表和详情都生效，需要原始 HTML 传 `convertHtml: false`。

## 输出约定

- 每个工具同时返回可读文本和 `structuredContent`；程序化处理取后者。
- 列表类结果可能来自 ID 字典，本项目已按 `orderBy` 重排（JS 会吃掉整数键的插入顺序）。
- 单条动作走 `zendao_call` 时 `filter`/`search`/`sort`/`limit` 会被 SDK 忽略，工具会在文本里提示——别以为生效了。
