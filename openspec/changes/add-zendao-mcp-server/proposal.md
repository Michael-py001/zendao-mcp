## Why
目前没有标准的 MCP 服务器可以让 LLM 直接与禅道项目管理系统交互。用户需要通过 MCP 协议操作禅道的数据，包括项目、任务、产品、需求等。这将提高工作效率，让 AI 能够自动化处理项目管理相关任务。

## What Changes
创建一个基于 TypeScript 的 zendao-mcp-server，实现以下功能：

### 新增的核心功能：
- **禅道 API 连接器**：实现与禅道 REST API 的完整集成
- **项目管理模块**：支持项目创建、查询、更新、状态管理等
- **任务管理模块**：支持任务 CRUD 操作、状态流转、任务分配等
- **产品管理模块**：支持产品管理、产品线操作等
- **需求管理模块**：支持需求创建、评审、状态跟踪等
- **用户权限模块**：支持用户查询、权限验证等

### 支持的 MCP 工具：
- `get_projects` - 获取项目列表
- `create_project` - 创建新项目
- `get_project_by_id` - 根据 ID 获取项目详情
- `get_tasks` - 获取任务列表
- `create_task` - 创建新任务
- `update_task_status` - 更新任务状态
- `get_products` - 获取产品列表
- `create_product` - 创建新产品
- `get_stories` - 获取需求列表
- `create_story` - 创建新需求
- `get_users` - 获取用户列表
- `zendao_request` - 通用 API 请求接口

### 技术特性：
- 基于 TypeScript 开发，提供类型安全
- 使用 axios 进行 HTTP 通信
- 支持 Token 认证
- 提供完整的错误处理机制
- 遵循 MCP 协议规范
- 提供详细的文档和使用示例

## Impact
- **影响的功能模块**：新增 zendao-api 能力规范
- **影响的核心代码**：`src/index.ts`, `src/server.ts`, `src/tools/` 目录下的工具实现
- **依赖项**：需要安装 axios、mcp 协议相关依赖
- **测试**：需要编写单元测试和集成测试
- **文档**：需要更新 README.md，添加使用说明和 API 文档

## Breaking Changes
无破坏性变更，这是全新的功能模块。

## Migration Plan
N/A - 新增功能
