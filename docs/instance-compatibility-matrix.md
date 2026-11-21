# 本实例兼容性矩阵（全量只读动作冒烟扫描）

> 自动生成，**不要手改**。生成时间：2026-09-20 06:25:51
> 生成命令：`npm run probe:smoke`（探针 7 / P2-19，脚本 `.workbuddy/skills/zentao-cli-parity/scripts/probe-smoke-matrix.mjs`）

## 一、总览

| 项 | 值 |
| --- | --- |
| 实例版本 | `max8.2`（max） |
| 注册表动作总数 | 229 |
| 其中只读（`method=get`） | **90** |
| 非只读（本探针**不碰**） | 139 |
| 扫描范围 | 全部 90 个只读动作 |
| 并发 / 轮次 | 4 / 用了 5 轮 |

> ⚠️ 明细里的**条数是「本页取到的条数」**（脚本按 `recPerPage=5` 取，只为验证「接口通不通」，
> 不代表总量）。结论看「接口是否有响应」，不看条数多少。
>
> ⚠️ 本探针**只跑 `method=get`** 的动作，写动作（POST/PUT/DELETE）一个都不碰 —— 这是它能安全对真实实例跑的前提。

| 结论 | 数量 |
| --- | --- |
| ✅ 可用 | 19 |
| ✅ 可用（空） | 6 |
| 🚫 门槛拒绝 | 59 |
| ❌ 路由不存在 | 3 |
| ❌ 其他错误 | 0 |
| ⚠️ 参数不可解 | 3 |

## 二、怎么读这张表

- **✅ 可用 / ✅ 可用（空）** —— 接口**通**。空只说明这一页没数据，不代表接口坏（别当缺陷）。
- **🚫 门槛拒绝** —— 动作在注册表里，但 `minVersion` 比本实例高。**这不是缺陷**：换到满足版本的实例就能用。
- **❌ 路由不存在** —— 服务端根本没这条路由（404），两条路都没有。
- **⚠️ 参数不可解** —— 本探针自动装配不出 ID，通常是因为**父资源列表为空**（拿不到种子 ID）。给个 ID 再验即可，不一定是接口问题。

## 三、逐动作明细

| 模块 | 动作 | 结论 | 说明 |
| --- | --- | --- | --- |
| `user` | `list` | ❌ 路由不存在 | HTTP request failed: 404 接口不存在（404）：确认 ZENTAO_BASE_URL 指向站点根目录，且当前 API 版本（v2）与禅道实际版本匹配 |
| `user` | `get` | ⚠️ 参数不可解 | 缺 path 参数 userID（本实例取不到种子 ID —— 通常是父资源列表为空） |
| `program` | `list` | ✅ 可用 | 本页 19 条 |
| `program` | `get` | ❌ 路由不存在 | HTTP request failed: 404 接口不存在（404）：确认 ZENTAO_BASE_URL 指向站点根目录，且当前 API 版本（v2）与禅道实际版本匹配 |
| `product` | `list` | ✅ 可用 | 本页 5 条 |
| `product` | `programProducts` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `product` | `get` | ✅ 可用 | 本页 1 条（"productID":13） |
| `project` | `list` | ✅ 可用 | 本页 5 条 |
| `project` | `programProjects` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `project` | `team` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `project` | `projectMembers` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `execution` | `list` | ✅ 可用 | 本页 5 条 |
| `execution` | `projectExecutions` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `execution` | `team` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `execution` | `executionMembers` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `execution` | `get` | ✅ 可用 | 本页 1 条（"executionID":43） |
| `productplan` | `list` | ✅ 可用 | 本页 1 条（"productID":7） |
| `productplan` | `get` | ✅ 可用 | 本页 1 条（"planID":17） |
| `story` | `list` | ✅ 可用 | 本页 1 条（"scope":"products","scopeID":13） |
| `story` | `modules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `story` | `get` | ✅ 可用 | 本页 1 条（"storyID":52） |
| `story` | `getGrades` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `epic` | `list` | ✅ 可用（空） | 已扫描：本页 0 条（"productID":8） |
| `epic` | `get` | ✅ 可用 | 本页 1 条（"storyID":52） |
| `requirement` | `list` | ✅ 可用（空） | 已扫描：本页 0 条（"productID":8） |
| `requirement` | `get` | ✅ 可用 | 本页 1 条（"storyID":52） |
| `bug` | `list` | ✅ 可用 | 本页 1 条（"scope":"products","scopeID":13） |
| `bug` | `modules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `bug` | `get` | ✅ 可用 | 本页 1 条（"bugID":1902） |
| `testcase` | `list` | ✅ 可用 | 本页 5 条（"scope":"products","scopeID":7） |
| `testcase` | `modules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `testcase` | `get` | ✅ 可用 | 本页 1 条（"caseID":"74"） |
| `task` | `list` | ✅ 可用 | 本页 5 条（"executionID":43） |
| `task` | `modules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `task` | `get` | ✅ 可用 | 本页 1 条（"taskID":173） |
| `issue` | `list` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `issue` | `projectIssues` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `issue` | `executionIssues` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `issue` | `get` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `risk` | `list` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `risk` | `projectRisks` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `risk` | `executionRisks` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `risk` | `get` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `meeting` | `list` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `meeting` | `projectMeetings` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `meeting` | `executionMeetings` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `meeting` | `get` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `feedback` | `list` | ✅ 可用（空） | 已扫描：本页 0 条（"productID":8） |
| `feedback` | `get` | ⚠️ 参数不可解 | 缺 path 参数 feedbackID（本实例取不到种子 ID —— 通常是父资源列表为空） |
| `ticket` | `list` | ✅ 可用（空） | 已扫描：本页 0 条（"productID":8） |
| `ticket` | `get` | ⚠️ 参数不可解 | 缺 path 参数 ticketID（本实例取不到种子 ID —— 通常是父资源列表为空） |
| `system` | `list` | ✅ 可用 | 本页 1 条（"productID":13） |
| `build` | `list` | ❌ 路由不存在 | HTTP request failed: 404 接口不存在（404）：确认 ZENTAO_BASE_URL 指向站点根目录，且当前 API 版本（v2）与禅道实际版本匹配 |
| `testtask` | `list` | ✅ 可用（空） | 已扫描：本页 0 条（"scope":"products","scopeID":8） |
| `release` | `list` | ✅ 可用（空） | 已扫描：本页 0 条（"productID":8） |
| `workflow` | `list` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `workflow` | `getContract` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `mySpaces` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `teamSpaces` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `productSpaces` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `projectSpaces` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `myLibs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `teamLibs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `productLibs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `projectLibs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `myDocs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `teamDocs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `productDocs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `projectDocs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `myModules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `teamModules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `productModules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `projectModules` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `getSpace` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `getLib` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `doc` | `get` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `todos` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `tasks` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `bugs` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `stories` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `epics` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `requirements` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `testtasks` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `projects` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `feedbacks` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `tickets` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `testcases` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `meetings` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `issues` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
| `my` | `risks` | 🚫 门槛拒绝 | 需要 22.5 / biz13.5 / max8.5 / ipd5.5 |
