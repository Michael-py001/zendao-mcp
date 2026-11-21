/**
 * 测试数据辅助函数
 */

import { ZenTaoClient } from '../../src/client';
import { generateTestName } from '../setup';

/**
 * 创建测试项目
 */
export async function createTestProject(client: ZenTaoClient): Promise<any> {
  const projectName = generateTestName('TEST项目');
  const projectCode = `TEST${Date.now()}`;

  try {
    const project = await client.post('/api.php/v1/projects', {
      name: projectName,
      code: projectCode,
      begin: '2025-11-01',
      end: '2025-12-31',
      acl: 'open'
    });

    return project;
  } catch (error) {
    console.error('创建测试项目失败:', error);
    throw error;
  }
}

/**
 * 创建测试任务
 */
export async function createTestTask(client: ZenTaoClient, projectId: number): Promise<any> {
  const taskName = generateTestName('TEST任务');

  try {
    const task = await client.post('/api.php/v1/tasks', {
      name: taskName,
      project: projectId,
      assignedTo: 's000001',
      pri: 1,
      estimate: 8
    });

    return task;
  } catch (error) {
    console.error('创建测试任务失败:', error);
    throw error;
  }
}

/**
 * 清理测试数据
 */
export async function cleanupTestData(client: ZenTaoClient): Promise<void> {
  try {
    // 获取所有项目
    const projects = await client.get('/api.php/v1/projects', {
      begin: '2025-01-01',
      end: '2025-12-31',
      limit: 100
    });

    // 清理以 TEST 或 E2E 开头的项目和任务
    for (const project of projects.projects) {
      if (project.name.startsWith('TEST') || project.name.startsWith('E2E')) {
        console.log(`清理项目: ${project.name} (ID: ${project.id})`);

        // 先清理项目下的所有任务
        try {
          const tasks = await client.get('/api.php/v1/tasks', {
            projectId: project.id,
            limit: 100
          });

          for (const task of tasks.tasks) {
            await client.delete(`/api.php/v1/tasks/${task.id}`);
          }
        } catch (error) {
          // 忽略任务清理错误
        }

        // 删除项目
        await client.delete(`/api.php/v1/projects/${project.id}`);
      }
    }
  } catch (error) {
    console.error('清理测试数据时出错:', error);
  }
}

/**
 * 清理单个项目及其任务
 */
export async function cleanupProject(client: ZenTaoClient, projectId: number): Promise<void> {
  try {
    // 获取项目下的所有任务
    const tasks = await client.get('/api.php/v1/tasks', {
      projectId: projectId,
      limit: 100
    });

    // 删除所有任务
    for (const task of tasks.tasks) {
      await client.delete(`/api.php/v1/tasks/${task.id}`);
    }

    // 删除项目
    await client.delete(`/api.php/v1/projects/${projectId}`);
  } catch (error) {
    console.error(`清理项目 ${projectId} 时出错:`, error);
  }
}

/**
 * 清理单个任务
 */
export async function cleanupTask(client: ZenTaoClient, taskId: number): Promise<void> {
  try {
    await client.delete(`/api.php/v1/tasks/${taskId}`);
  } catch (error) {
    console.error(`清理任务 ${taskId} 时出错:`, error);
  }
}

/**
 * 验证项目对象
 */
export function validateProject(project: any): void {
  expect(project).toHaveProperty('id');
  expect(project).toHaveProperty('name');
  expect(project).toHaveProperty('status');
  expect(typeof project.id).toBe('number');
  expect(typeof project.name).toBe('string');
}

/**
 * 验证任务对象
 */
export function validateTask(task: any): void {
  expect(task).toHaveProperty('id');
  expect(task).toHaveProperty('name');
  expect(task).toHaveProperty('project');
  expect(task).toHaveProperty('status');
  expect(typeof task.id).toBe('number');
  expect(typeof task.name).toBe('string');
  expect(typeof task.project).toBe('number');
}

/**
 * 验证项目列表响应
 */
export function validateProjectListResponse(response: any): void {
  expect(response).toHaveProperty('projects');
  expect(response).toHaveProperty('total');
  expect(Array.isArray(response.projects)).toBe(true);
  expect(typeof response.total).toBe('number');

  // 验证每个项目
  response.projects.forEach((project: any) => {
    validateProject(project);
  });
}

/**
 * 验证任务列表响应
 */
export function validateTaskListResponse(response: any): void {
  expect(response).toHaveProperty('tasks');
  expect(response).toHaveProperty('total');
  expect(Array.isArray(response.tasks)).toBe(true);
  expect(typeof response.total).toBe('number');

  // 验证每个任务
  response.tasks.forEach((task: any) => {
    validateTask(task);
  });
}

/**
 * 验证批量操作结果
 */
export function validateBatchResult(result: any): void {
  expect(result).toHaveProperty('success');
  expect(result).toHaveProperty('failed');
  expect(result).toHaveProperty('total');
  expect(result).toHaveProperty('results');
  expect(result).toHaveProperty('duration');

  expect(typeof result.success).toBe('number');
  expect(typeof result.failed).toBe('number');
  expect(typeof result.total).toBe('number');
  expect(Array.isArray(result.results)).toBe(true);
  expect(typeof result.duration).toBe('number');

  expect(result.success + result.failed).toBe(result.total);

  // 验证每个结果
  result.results.forEach((r: any) => {
    expect(r).toHaveProperty('status');
    expect(r).toHaveProperty('item');
    expect(r).toHaveProperty('index');
    expect(r.status).toMatch(/^(success|failed)$/);
    expect(typeof r.index).toBe('number');
  });
}

/**
 * 有效的测试项目数据
 */
export const validProjectData = {
  name: generateTestName('有效项目'),
  code: `VALID${Date.now()}`,
  begin: '2025-11-01',
  end: '2025-12-31',
  acl: 'open'
};

/**
 * 有效的测试任务数据
 */
export const validTaskData = {
  name: generateTestName('有效任务'),
  project: 2, // 使用已存在的项目 ID
  assignedTo: 's000001',
  pri: 1,
  estimate: 8,
  deadline: '2025-11-15'
};

/**
 * 批量任务数据
 */
export function createBatchTaskData(count: number, projectId: number = 2): any[] {
  return Array.from({ length: count }, (_, i) => ({
    name: generateTestName(`批量任务${i + 1}`),
    project: projectId,
    assignedTo: 's000001',
    pri: (i % 4) + 1,
    estimate: (i + 1) * 2
  }));
}
