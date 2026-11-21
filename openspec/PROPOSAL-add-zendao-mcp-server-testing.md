# OpenSpec 提案：禅道 MCP 服务器测试增强计划

## 📋 提案概述

**提案名称**: add-zendao-mcp-server-testing-enhancement
**类型**: 功能增强
**优先级**: P0 (最高)
**预估工时**: 3-5 天

### 目标

建立一个全面、自动化、可靠的测试体系，确保禅道 MCP 服务器：
- ✅ 所有 MCP 工具功能正确
- ✅ Token 认证机制可靠
- ✅ 错误处理完善
- ✅ 性能稳定
- ✅ 集成测试完整

---

## 🎯 背景与问题

### 当前问题
1. **测试覆盖不足** - 缺乏完整的单元测试和集成测试
2. **Token 验证不完整** - 仅依赖基础诊断脚本
3. **MCP 工具未充分测试** - 每个工具的具体功能未验证
4. **错误场景未覆盖** - 网络错误、API 错误等场景缺失
5. **性能测试缺失** - 并发、缓存等未测试

### 目标收益
- 🎯 提升代码质量和可靠性
- 🎯 减少生产环境问题
- 🎯 加快开发迭代速度
- 🎯 提供完整的测试文档

---

## 📐 方案设计

### 阶段一：环境准备与启动测试 (1 天)

#### 1.1 启动流程测试
```bash
# 测试脚本: tests/startup.test.ts
describe('MCP Server Startup', () => {
  test('should start successfully with valid token', async () => {
    // 1. 检查构建产物
    expect(fs.existsSync('dist/index.js')).toBe(true);

    // 2. 验证环境配置
    await loadConfig();

    // 3. 启动服务器
    const serverProcess = await startServer();

    // 4. 验证启动日志
    expect(serverProcess.output).toContain('MCP 服务器已启动');

    // 5. 清理
    await serverProcess.kill();
  });

  test('should fail with invalid token', async () => {
    // 测试无效 token 场景
  });

  test('should handle missing configuration', async () => {
    // 测试缺失配置场景
  });
});
```

#### 1.2 连接验证测试
```typescript
// 测试脚本: tests/connection.test.ts
describe('Connection Verification', () => {
  test('should verify connection to ZenTao server', async () => {
    const client = new ZenTaoClient(config, logger);
    const isConnected = await client.verifyConnection();
    expect(isConnected).toBe(true);
  });

  test('should get ZenTao version', async () => {
    const version = await client.getVersion();
    expect(version).toMatch(/开源版 \d+\.\d+/);
  });
});
```

### 阶段二：Token 认证测试 (0.5 天)

#### 2.1 Token 获取测试
```bash
# 测试脚本: tests/token/token-acquisition.test.ts
describe('Token Acquisition', () => {
  test('should extract valid zentaosid from browser', async () => {
    // 1. 启动浏览器并登录
    const browser = await launchBrowser();
    await loginToZenTao(browser, 's000001', 'q1w2E#R$');

    // 2. 获取 cookies
    const cookies = await browser.getCookies();
    const zentaosid = cookies.find(c => c.name === 'zentaosid');

    // 3. 验证格式
    expect(zentaosid.value).toMatch(/^s\d+:[a-f0-9]{32}$/i);

    // 4. 测试 API 访问
    const response = await testApiAccess(zentaosid.value);
    expect(response.status).toBe(200);
  });

  test('should detect expired token', async () => {
    const expiredToken = 's000001:expired_md5_hash';
    const client = new ZenTaoClient({ ...config, token: expiredToken });
    await expect(client.verifyConnection()).rejects.toThrow('Unauthorized');
  });
});
```

#### 2.2 Token 更新测试
```bash
# 测试脚本: tests/token/token-update.test.ts
describe('Token Update', () => {
  test('should update token via interactive script', async () => {
    // 模拟用户输入
    const newToken = 's000001:new_valid_token_hash';
    const output = await exec('./update-token.sh', {
      input: newToken
    });

    expect(output).toContain('Token 更新成功');

    // 验证 .env 文件更新
    const envContent = fs.readFileSync('.env', 'utf8');
    expect(envContent).toContain(`ZENTAO_TOKEN=${newToken}`);
  });
});
```

### 阶段三：MCP 工具功能测试 (2 天)

#### 3.1 项目管理工具测试

**3.1.1 get_projects 测试**
```typescript
// tests/tools/get-projects.test.ts
describe('get_projects Tool', () => {
  test('should fetch project list successfully', async () => {
    const result = await getProjects(client, cache, {
      page: 1,
      limit: 50
    });

    expect(result).toHaveProperty('projects');
    expect(Array.isArray(result.projects)).toBe(true);
    expect(result.projects.length).toBeGreaterThan(0);

    // 验证项目字段
    result.projects.forEach(project => {
      expect(project).toHaveProperty('id');
      expect(project).toHaveProperty('name');
      expect(project).toHaveProperty('status');
    });
  });

  test('should filter projects by status', async () => {
    const result = await getProjects(client, cache, {
      status: 'doing'
    });

    result.projects.forEach(project => {
      expect(project.status).toBe('doing');
    });
  });

  test('should cache project list', async () => {
    const cacheKey = 'projects:{"page":1,"limit":50}';
    await getProjects(client, cache, { page: 1, limit: 50 });

    expect(cache.get(cacheKey)).toBeDefined();

    // 第二次调用应该从缓存返回
    const startTime = Date.now();
    await getProjects(client, cache, { page: 1, limit: 50 });
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(100); // 缓存命中应该很快
  });

  test('should handle invalid parameters', async () => {
    await expect(getProjects(client, cache, {
      page: -1,
      limit: 'invalid'
    })).rejects.toThrow();
  });
});
```

**3.1.2 get_project_by_id 测试**
```typescript
// tests/tools/get-project-by-id.test.ts
describe('get_project_by_id Tool', () => {
  test('should fetch project details by ID', async () => {
    const projectId = 2; // 使用已存在的项目 ID
    const result = await getProjectById(client, cache, projectId);

    expect(result.id).toBe(projectId);
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('code');
    expect(result).toHaveProperty('begin');
    expect(result).toHaveProperty('end');
  });

  test('should return error for non-existent project', async () => {
    const nonExistentId = 999999;
    await expect(getProjectById(client, cache, nonExistentId))
      .rejects.toThrow('Not Found');
  });

  test('should cache project details', async () => {
    const cacheKey = 'project:2';
    await getProjectById(client, cache, 2);
    expect(cache.get(cacheKey)).toBeDefined();
  });
});
```

**3.1.3 create_project 测试**
```typescript
// tests/tools/create-project.test.ts
describe('create_project Tool', () => {
  test('should create new project successfully', async () => {
    const newProject = {
      name: `测试项目-${Date.now()}`,
      code: `TEST${Date.now()}`,
      begin: '2025-11-01',
      end: '2025-12-31',
      acl: 'open'
    };

    const result = await createProject(client, cache, newProject);

    expect(result.id).toBeDefined();
    expect(result.name).toBe(newProject.name);
    expect(result.code).toBe(newProject.code);

    // 清理测试数据
    await client.delete(`/api.php/v1/projects/${result.id}`);
  });

  test('should reject duplicate project code', async () => {
    const duplicateProject = {
      name: '重复代码项目',
      code: 'DUPLICATE', // 使用已存在的代码
      begin: '2025-11-01',
      end: '2025-12-31'
    };

    await expect(createProject(client, cache, duplicateProject))
      .rejects.toThrow('项目代码已存在');
  });

  test('should validate required fields', async () => {
    await expect(createProject(client, cache, {
      name: '缺少代码的项目'
      // 缺少 required 字段
    })).rejects.toThrow();
  });

  test('should clear cache after creation', async () => {
    cache.set('projects:{}', 'some data', 5 * 60 * 1000);

    await createProject(client, cache, validProject);

    expect(cache.get('projects:{}')).toBeUndefined();
  });
});
```

#### 3.2 任务管理工具测试

**3.2.1 get_tasks 测试**
```typescript
// tests/tools/get-tasks.test.ts
describe('get_tasks Tool', () => {
  test('should fetch task list by project', async () => {
    const result = await getTasks(client, cache, {
      projectId: 2,
      page: 1,
      limit: 50
    });

    expect(result).toHaveProperty('tasks');
    expect(Array.isArray(result.tasks)).toBe(true);
  });

  test('should filter tasks by status', async () => {
    const result = await getTasks(client, cache, {
      projectId: 2,
      status: 'doing'
    });

    result.tasks.forEach(task => {
      expect(task.status).toBe('doing');
    });
  });

  test('should filter tasks by assignee', async () => {
    const result = await getTasks(client, cache, {
      projectId: 2,
      assignedTo: 's000001'
    });

    result.tasks.forEach(task => {
      expect(task.assignedTo).toBe('s000001');
    });
  });

  test('should sort tasks by priority', async () => {
    const result = await getTasks(client, cache, {
      projectId: 2,
      orderBy: 'pri_desc'
    });

    // 验证排序（优先级从高到低）
    for (let i = 0; i < result.tasks.length - 1; i++) {
      expect(result.tasks[i].pri).toBeLessThanOrEqual(result.tasks[i + 1].pri);
    }
  });
});
```

**3.2.2 create_task 测试**
```typescript
// tests/tools/create-task.test.ts
describe('create_task Tool', () => {
  test('should create new task successfully', async () => {
    const newTask = {
      name: `测试任务-${Date.now()}`,
      project: 2,
      assignedTo: 's000001',
      pri: 1,
      estimate: 8,
      deadline: '2025-11-15'
    };

    const result = await createTask(client, cache, newTask);

    expect(result.id).toBeDefined();
    expect(result.name).toBe(newTask.name);
    expect(result.project).toBe(newTask.project);
    expect(result.assignedTo).toBe(newTask.assignedTo);

    // 清理测试数据
    await client.delete(`/api.php/v1/tasks/${result.id}`);
  });

  test('should validate project existence', async () => {
    const taskWithInvalidProject = {
      name: '无效项目任务',
      project: 999999, // 不存在的项目 ID
      assignedTo: 's000001'
    };

    await expect(createTask(client, cache, taskWithInvalidProject))
      .rejects.toThrow('项目不存在');
  });

  test('should validate assignee existence', async () => {
    const taskWithInvalidAssignee = {
      name: '无效负责人任务',
      project: 2,
      assignedTo: 'invalid_user'
    };

    await expect(createTask(client, cache, taskWithInvalidAssignee))
      .rejects.toThrow('用户不存在');
  });

  test('should set default priority if not specified', async () => {
    const taskWithoutPri = {
      name: '无优先级任务',
      project: 2,
      assignedTo: 's000001'
      // 没有设置 pri
    };

    const result = await createTask(client, cache, taskWithoutPri);
    expect(result.pri).toBe(3); // 默认优先级
  });
});
```

**3.2.3 update_task_status 测试**
```typescript
// tests/tools/update-task-status.test.ts
describe('update_task_status Tool', () => {
  test('should update task status successfully', async () => {
    // 创建测试任务
    const task = await createTask(client, cache, {
      name: '状态更新测试任务',
      project: 2,
      assignedTo: 's000001'
    });

    // 更新状态
    const result = await updateTaskStatus(client, cache, task.id, 'doing');

    expect(result.id).toBe(task.id);
    expect(result.status).toBe('doing');

    // 验证状态确实已更新
    const updatedTask = await client.get(`/api.php/v1/tasks/${task.id}`);
    expect(updatedTask.status).toBe('doing');

    // 清理
    await client.delete(`/api.php/v1/tasks/${task.id}`);
  });

  test('should allow valid status transitions', async () => {
    // 测试状态转换：wait -> doing -> done
    const task = await createTask(client, cache, validTask);

    await updateTaskStatus(client, cache, task.id, 'doing');
    await updateTaskStatus(client, cache, task.id, 'done');

    const finalTask = await client.get(`/api.php/v1/tasks/${task.id}`);
    expect(finalTask.status).toBe('done');
  });

  test('should reject invalid status transitions', async () => {
    const task = await createTask(client, cache, validTask);

    // 尝试无效转换：wait -> closed (需要先进行中)
    await expect(updateTaskStatus(client, cache, task.id, 'closed'))
      .rejects.toThrow('无效的状态转换');
  });

  test('should clear cache after status update', async () => {
    const task = await createTask(client, cache, validTask);

    cache.set(`task:${task.id}`, task, 10 * 60 * 1000);
    cache.set(`tasks:${JSON.stringify({ projectId: task.project })}`, [task], 5 * 60 * 1000);

    await updateTaskStatus(client, cache, task.id, 'done');

    expect(cache.get(`task:${task.id}`)).toBeUndefined();
    expect(cache.get(`tasks:${JSON.stringify({ projectId: task.project })}`)).toBeUndefined();
  });
});
```

#### 3.3 批量操作工具测试

**3.3.1 batch_create_tasks 测试**
```typescript
// tests/tools/batch-create-tasks.test.ts
describe('batch_create_tasks Tool', () => {
  test('should create multiple tasks successfully', async () => {
    const tasks = [
      {
        name: '批量任务-1',
        project: 2,
        assignedTo: 's000001',
        pri: 1,
        estimate: 4
      },
      {
        name: '批量任务-2',
        project: 2,
        assignedTo: 's000001',
        pri: 2,
        estimate: 8
      },
      {
        name: '批量任务-3',
        project: 2,
        assignedTo: 's000001',
        pri: 3,
        estimate: 12
      }
    ];

    const result = await batchCreateTasks(client, cache, tasks, {
      continueOnError: true,
      reportMode: 'detailed',
      maxConcurrency: 5
    });

    expect(result.success).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(3);

    // 验证所有任务都被创建
    result.results.forEach(r => {
      expect(r.status).toBe('success');
      expect(r.id).toBeDefined();
    });

    // 清理测试数据
    for (const r of result.results) {
      await client.delete(`/api.php/v1/tasks/${r.id}`);
    }
  });

  test('should handle partial failures', async () => {
    const tasks = [
      { name: '有效任务', project: 2, assignedTo: 's000001' },
      { name: '无效项目任务', project: 999999, assignedTo: 's000001' },
      { name: '另一个有效任务', project: 2, assignedTo: 's000001' }
    ];

    const result = await batchCreateTasks(client, cache, tasks, {
      continueOnError: true,
      reportMode: 'detailed'
    });

    expect(result.success).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[1].status).toBe('failed');
    expect(result.results[1].error).toBeDefined();
  });

  test('should stop on first error when continueOnError is false', async () => {
    const tasks = [
      { name: '有效任务', project: 2, assignedTo: 's000001' },
      { name: '无效项目任务', project: 999999, assignedTo: 's000001' },
      { name: '不会被执行的任务', project: 2, assignedTo: 's000001' }
    ];

    const result = await batchCreateTasks(client, cache, tasks, {
      continueOnError: false,
      reportMode: 'detailed'
    });

    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(2); // 第三个任务不会执行
  });

  test('should respect maxConcurrency limit', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      name: `并发任务-${i}`,
      project: 2,
      assignedTo: 's000001'
    }));

    const startTime = Date.now();
    const result = await batchCreateTasks(client, cache, tasks, {
      maxConcurrency: 3 // 限制并发数
    });
    const duration = Date.now() - startTime;

    expect(result.success).toBe(20);

    // 验证并发控制（这里只是简单验证，实际应该更严格）
    expect(duration).toBeGreaterThan(0);

    // 清理
    for (const r of result.results) {
      await client.delete(`/api.php/v1/tasks/${r.id}`);
    }
  });

  test('should provide detailed report', async () => {
    const tasks = [
      { name: '成功任务', project: 2, assignedTo: 's000001' },
      { name: '失败任务', project: 999999, assignedTo: 's000001' }
    ];

    const result = await batchCreateTasks(client, cache, tasks, {
      reportMode: 'detailed'
    });

    expect(result.results[0]).toHaveProperty('id');
    expect(result.results[0]).toHaveProperty('index');
    expect(result.results[1]).toHaveProperty('error');
  });

  test('should provide summary report', async () => {
    const tasks = [{ name: '单个任务', project: 2, assignedTo: 's000001' }];

    const result = await batchCreateTasks(client, cache, tasks, {
      reportMode: 'summary'
    });

    // summary 模式下，结果应该只包含基本信息
    expect(result.results[0]).toHaveProperty('status');
    expect(result.results[0].id).toBeDefined();
  });
});
```

### 阶段四：错误处理测试 (0.5 天)

#### 4.1 网络错误测试
```typescript
// tests/error-handling/network-errors.test.ts
describe('Network Error Handling', () => {
  test('should handle connection timeout', async () => {
    const slowClient = new ZenTaoClient({
      ...config,
      timeout: 100 // 很短的超时
    }, logger);

    await expect(slowClient.get('/api.php/v1/projects'))
      .rejects.toThrow('timeout');
  });

  test('should handle server unavailable', async () => {
    const unavailableClient = new ZenTaoClient({
      baseUrl: 'http://nonexistent-server',
      token: config.token
    }, logger);

    await expect(unavailableClient.verifyConnection())
      .rejects.toThrow();
  });

  test('should retry on temporary failures', async () => {
    // 模拟网络不稳定
    let attempt = 0;
    const mockClient = {
      get: jest.fn().mockImplementation(() => {
        attempt++;
        if (attempt < 3) {
          throw new Error('Temporary network error');
        }
        return Promise.resolve({ data: 'success' });
      })
    };

    const result = await clientWithRetry.get('/api.php/v1/projects');
    expect(result.data).toBe('success');
    expect(attempt).toBe(3); // 重试 3 次
  });
});
```

#### 4.2 API 错误测试
```typescript
// tests/error-handling/api-errors.test.ts
describe('API Error Handling', () => {
  test('should handle 401 Unauthorized', async () => {
    const clientWithBadToken = new ZenTaoClient({
      ...config,
      token: 'invalid_token'
    }, logger);

    await expect(clientWithBadToken.get('/api.php/v1/projects'))
      .rejects.toThrow('Unauthorized');
  });

  test('should handle 403 Forbidden', async () => {
    // 使用权限不足的 token
    await expect(client.get('/api.php/v1/admin/users'))
      .rejects.toThrow('Forbidden');
  });

  test('should handle 404 Not Found', async () => {
    await expect(client.get('/api.php/v1/projects/999999'))
      .rejects.toThrow('Not Found');
  });

  test('should handle 500 Internal Server Error', async () => {
    // 发送无效数据触发 500 错误
    await expect(client.post('/api.php/v1/projects', {
      invalid: 'data'
    })).rejects.toThrow('Internal Server Error');
  });
});
```

### 阶段五：性能测试 (0.5 天)

#### 5.1 缓存性能测试
```typescript
// tests/performance/cache-performance.test.ts
describe('Cache Performance', () => {
  test('should improve response time with cache', async () => {
    const projectId = 2;

    // 第一次请求（无缓存）
    const start1 = Date.now();
    await getProjectById(client, cache, projectId);
    const time1 = Date.now() - start1;

    // 第二次请求（有缓存）
    const start2 = Date.now();
    await getProjectById(client, cache, projectId);
    const time2 = Date.now() - start2;

    // 缓存命中应该显著更快
    expect(time2).toBeLessThan(time1 * 0.1);
  });

  test('should limit cache size', async () => {
    // 填充缓存到最大大小
    for (let i = 0; i < 1000; i++) {
      cache.set(`test:${i}`, `value:${i}`, 5 * 60 * 1000);
    }

    // 检查是否删除了最老的条目
    expect(cache.size()).toBeLessThanOrEqual(1000);
  });

  test('should expire stale entries', async () => {
    const key = 'test:expiry';
    cache.set(key, 'value', 100); // 100ms TTL

    await delay(200);

    expect(cache.get(key)).toBeUndefined();
  });
});
```

#### 5.2 并发性能测试
```typescript
// tests/performance/concurrency-performance.test.ts
describe('Concurrency Performance', () => {
  test('should handle multiple concurrent requests', async () => {
    const requests = Array.from({ length: 50 }, (_, i) =>
      getTasks(client, cache, { projectId: 2, page: 1, limit: 10 })
    );

    const startTime = Date.now();
    const results = await Promise.all(requests);
    const duration = Date.now() - startTime;

    expect(results).toHaveLength(50);
    expect(duration).toBeLessThan(10000); // 应该在 10 秒内完成

    // 验证所有结果都成功
    results.forEach(result => {
      expect(result.tasks).toBeDefined();
    });
  });

  test('should respect batch operation concurrency limits', async () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      name: `并发测试任务-${i}`,
      project: 2,
      assignedTo: 's000001'
    }));

    const startTime = Date.now();
    const result = await batchCreateTasks(client, cache, tasks, {
      maxConcurrency: 5
    });
    const duration = Date.now() - startTime;

    expect(result.success).toBe(30);
    expect(duration).toBeGreaterThan(0);

    // 清理
    for (const r of result.results) {
      await client.delete(`/api.php/v1/tasks/${r.id}`);
    }
  });
});
```

### 阶段六：集成测试 (0.5 天)

#### 6.1 端到端测试
```typescript
// tests/integration/e2e.test.ts
describe('End-to-End Integration', () => {
  test('should complete full project lifecycle', async () => {
    // 1. 创建项目
    const project = await createProject(client, cache, {
      name: `E2E测试项目-${Date.now()}`,
      code: `E2E${Date.now()}`,
      begin: '2025-11-01',
      end: '2025-12-31'
    });

    expect(project.id).toBeDefined();

    // 2. 创建任务
    const task1 = await createTask(client, cache, {
      name: 'E2E测试任务-1',
      project: project.id,
      assignedTo: 's000001',
      pri: 1,
      estimate: 8
    });

    const task2 = await createTask(client, cache, {
      name: 'E2E测试任务-2',
      project: project.id,
      assignedTo: 's000001',
      pri: 2,
      estimate: 4
    });

    // 3. 更新任务状态
    await updateTaskStatus(client, cache, task1.id, 'doing');
    await updateTaskStatus(client, cache, task1.id, 'done');

    // 4. 验证任务列表
    const tasks = await getTasks(client, cache, { projectId: project.id });
    expect(tasks.tasks.length).toBeGreaterThanOrEqual(2);

    // 5. 验证项目详情
    const projectDetails = await getProjectById(client, cache, project.id);
    expect(projectDetails.name).toBe(project.name);

    // 清理
    await client.delete(`/api.php/v1/tasks/${task1.id}`);
    await client.delete(`/api.php/v1/tasks/${task2.id}`);
    await client.delete(`/api.php/v1/projects/${project.id}`);
  });

  test('should handle batch operations in workflow', async () => {
    // 1. 创建项目
    const project = await createProject(client, cache, validProject);

    // 2. 批量创建任务
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      name: `批量E2E任务-${i}`,
      project: project.id,
      assignedTo: 's000001',
      pri: (i % 4) + 1
    }));

    const batchResult = await batchCreateTasks(client, cache, tasks, {
      continueOnError: true,
      reportMode: 'detailed'
    });

    expect(batchResult.success).toBe(10);

    // 3. 批量更新状态
    for (const result of batchResult.results) {
      if (result.status === 'success') {
        await updateTaskStatus(client, cache, result.id, 'doing');
        await updateTaskStatus(client, cache, result.id, 'done');
      }
    }

    // 4. 验证所有任务已完成
    const finalTasks = await getTasks(client, cache, {
      projectId: project.id,
      status: 'done'
    });

    expect(finalTasks.tasks.length).toBe(10);

    // 清理
    for (const result of batchResult.results) {
      if (result.status === 'success') {
        await client.delete(`/api.php/v1/tasks/${result.id}`);
      }
    }
    await client.delete(`/api.php/v1/projects/${project.id}`);
  });
});
```

### 阶段七：测试自动化与 CI/CD (0.5 天)

#### 7.1 测试脚本创建
```bash
#!/bin/bash
# tests/run-all-tests.sh

echo "========================================="
echo "  禅道 MCP 服务器 - 全面测试套件"
echo "========================================="

# 1. 启动测试
echo ""
echo "🚀 运行启动测试..."
npm run test:startup

# 2. Token 测试
echo ""
echo "🔑 运行 Token 测试..."
npm run test:token

# 3. 功能测试
echo ""
echo "🛠️ 运行 MCP 工具功能测试..."
npm run test:tools

# 4. 错误处理测试
echo ""
echo "❌ 运行错误处理测试..."
npm run test:errors

# 5. 性能测试
echo ""
echo "⚡ 运行性能测试..."
npm run test:performance

# 6. 集成测试
echo ""
echo "🔗 运行集成测试..."
npm run test:integration

# 7. 生成报告
echo ""
echo "📊 生成测试报告..."
npm run test:coverage

echo ""
echo "========================================="
echo "  ✅ 所有测试完成！"
echo "========================================="
```

#### 7.2 package.json 测试脚本
```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage --coverageReporters=text --coverageReporters=html",
    "test:startup": "jest --testPathPattern=startup",
    "test:token": "jest --testPathPattern=token",
    "test:tools": "jest --testPathPattern='tools/'",
    "test:errors": "jest --testPathPattern=errors",
    "test:performance": "jest --testPathPattern=performance",
    "test:integration": "jest --testPathPattern=integration",
    "test:all": "./tests/run-all-tests.sh"
  }
}
```

#### 7.3 Jest 配置
```javascript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/tests/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000
};
```

#### 7.4 测试环境设置
```typescript
// tests/setup.ts
import { config as loadEnvConfig } from 'dotenv';

beforeAll(async () => {
  // 加载测试环境变量
  loadEnvConfig({ path: '.env' });

  // 等待服务就绪
  await waitForZenTaoService();
});

afterEach(async () => {
  // 清理测试数据
  await cleanupTestData();
});

afterAll(async () => {
  // 关闭连接
  await closeConnections();
});
```

### 阶段八：测试文档与报告 (0.5 天)

#### 8.1 测试文档
```markdown
# 测试文档: tests/README.md

## 测试概述
本文档描述了禅道 MCP 服务器的完整测试体系。

## 测试分类

### 1. 启动测试 (Startup Tests)
- **文件**: `tests/startup.test.ts`
- **目的**: 验证服务器启动流程
- **覆盖场景**:
  - 有效 Token 启动
  - 无效 Token 失败处理
  - 配置缺失处理

### 2. Token 测试 (Token Tests)
- **文件**: `tests/token/*.test.ts`
- **目的**: 验证 Token 获取和验证机制
- **覆盖场景**:
  - 从浏览器获取 Token
  - Token 格式验证
  - Token 过期检测
  - Token 更新流程

### 3. MCP 工具测试 (Tool Tests)
- **文件**: `tests/tools/*.test.ts`
- **目的**: 验证每个 MCP 工具的功能
- **工具覆盖**:
  - get_projects
  - get_project_by_id
  - create_project
  - get_tasks
  - create_task
  - update_task_status
  - batch_create_tasks

### 4. 错误处理测试 (Error Handling Tests)
- **文件**: `tests/error-handling/*.test.ts`
- **目的**: 验证错误场景处理
- **场景覆盖**:
  - 网络错误
  - API 错误
  - 参数验证错误
  - 权限错误

### 5. 性能测试 (Performance Tests)
- **文件**: `tests/performance/*.test.ts`
- **目的**: 验证性能和稳定性
- **指标覆盖**:
  - 缓存命中率
  - 并发处理能力
  - 响应时间
  - 内存使用

### 6. 集成测试 (Integration Tests)
- **文件**: `tests/integration/*.test.ts`
- **目的**: 验证端到端工作流
- **场景覆盖**:
  - 完整项目生命周期
  - 批量操作工作流
  - 缓存一致性

## 运行测试

```bash
# 运行所有测试
npm run test:all

# 运行特定类型测试
npm run test:startup
npm run test:token
npm run test:tools
npm run test:errors
npm run test:performance
npm run test:integration

# 运行带覆盖率的测试
npm run test:coverage

# 监视模式
npm run test:watch
```

## 测试数据管理

### 测试数据创建
- 所有测试应创建自己的测试数据
- 使用时间戳确保唯一性
- 测试完成后自动清理

### 测试数据清理
```typescript
// tests/helpers/cleanup.ts
export async function cleanupTestData() {
  // 清理所有以 'TEST' 或 'E2E' 开头的项目和任务
  const projects = await client.get('/api.php/v1/projects', {
    begin: '2025-01-01',
    end: '2025-12-31'
  });

  for (const project of projects.projects) {
    if (project.name.startsWith('TEST') || project.name.startsWith('E2E')) {
      await client.delete(`/api.php/v1/projects/${project.id}`);
    }
  }
}
```

## 测试环境要求

### 前置条件
1. 禅道服务器运行在 `http://localhost`
2. 测试账号: `s000001` / `q1w2E#R$`
3. Node.js >= 16.0.0
4. 项目已构建: `npm run build`

### 环境变量
```env
ZENTAO_BASE_URL=http://localhost
ZENTAO_TOKEN=s000001:valid_token_hash
ZENTAO_TIMEOUT=30000
ZENTAO_RETRY=3
ZENTAO_RETRY_DELAY=1000
```

## 测试覆盖率目标

- **行覆盖率**: >= 90%
- **分支覆盖率**: >= 85%
- **函数覆盖率**: >= 95%
- **语句覆盖率**: >= 90%

## 持续集成

测试在以下情况下自动运行:
1. 每次代码提交
2. 每次 Pull Request
3. 每日定时构建

## 问题排查

如果测试失败，请检查:
1. 禅道服务是否运行
2. Token 是否有效
3. 网络连接是否正常
4. 测试数据是否被清理
```

#### 8.2 测试报告模板
```typescript
// tests/helpers/generate-report.ts
export function generateTestReport(results: any) {
  return {
    summary: {
      total: results.numTotalTests,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      skipped: results.numPendingTests,
      coverage: results.coverageMap
    },
    duration: results.testResults[0].duration,
    timestamp: new Date().toISOString(),
    details: {
      startup: results.testResults.find(r => r.testPath.includes('startup')),
      token: results.testResults.find(r => r.testPath.includes('token')),
      tools: results.testResults.filter(r => r.testPath.includes('tools')),
      errors: results.testResults.find(r => r.testPath.includes('errors')),
      performance: results.testResults.find(r => r.testPath.includes('performance')),
      integration: results.testResults.find(r => r.testPath.includes('integration'))
    }
  };
}
```

---

## 📅 实施计划

| 阶段 | 工作内容 | 预估时间 | 交付物 |
|------|----------|----------|--------|
| 1 | 环境准备与启动测试 | 1 天 | startup.test.ts, connection.test.ts |
| 2 | Token 认证测试 | 0.5 天 | token/*.test.ts |
| 3 | MCP 工具功能测试 | 2 天 | tools/*.test.ts (7 个工具) |
| 4 | 错误处理测试 | 0.5 天 | error-handling/*.test.ts |
| 5 | 性能测试 | 0.5 天 | performance/*.test.ts |
| 6 | 集成测试 | 0.5 天 | integration/*.test.ts |
| 7 | 自动化与 CI/CD | 0.5 天 | 测试脚本, Jest 配置 |
| 8 | 测试文档与报告 | 0.5 天 | 测试文档, 报告模板 |

**总预估时间**: 3-5 天

---

## 🎯 验收标准

### 必须满足的条件
- [ ] 所有测试用例通过率 100%
- [ ] 测试覆盖率 >= 90%
- [ ] 每个 MCP 工具都有完整的单元测试
- [ ] 端到端测试覆盖主要工作流
- [ ] 错误场景测试覆盖率 >= 80%
- [ ] 性能测试验证缓存和并发处理
- [ ] 测试文档完整且易于理解
- [ ] 自动化测试脚本可重复执行

### 质量标准
- [ ] 测试代码符合 TypeScript 最佳实践
- [ ] 每个测试用例都有清晰的断言
- [ ] 测试数据自动清理
- [ ] 测试报告自动生成
- [ ] 持续集成配置完整

---

## 🔍 风险与缓解

### 风险 1: Token 过期导致测试失败
**缓解方案**:
- 在测试开始前自动验证 Token
- 如果 Token 过期，自动提示用户更新
- 使用重试机制处理临时认证失败

### 风险 2: 测试数据污染
**缓解方案**:
- 所有测试使用唯一标识符
- 测试完成后自动清理
- 定期清理孤立测试数据

### 风险 3: 性能测试不稳定
**缓解方案**:
- 多次运行取平均值
- 设置合理的超时时间
- 隔离性能测试

---

## 📚 参考资料

- [Jest 测试框架文档](https://jestjs.io/docs)
- [TypeScript 测试最佳实践](https://typescript-eslint.io/docs/linting/testing-linting)
- [禅道 API 文档](https://www.zentao.net/book/zentao_help/book/zentao_api.html)
- [MCP 协议规范](https://modelcontextprotocol.io/)

---

## ✅ 提案状态

- [x] 提案已创建
- [ ] 提案已评审
- [ ] 提案已批准
- [ ] 开始实施
- [ ] 测试用例开发
- [ ] 测试执行
- [ ] 报告生成
- [ ] 验收完成

---

**创建日期**: 2025-11-01
**提案作者**: Claude Code
**版本**: v1.0
