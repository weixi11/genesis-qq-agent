import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { PlanExecutor } from '../../src/agents/orchestrator/executor.ts';
import { taskManager } from '../../src/task/index.ts';

const originalCreateTask = taskManager.createTask.bind(taskManager);
const originalStartTask = taskManager.startTask.bind(taskManager);
const originalCompleteTask = taskManager.completeTask.bind(taskManager);
const originalCheckCache = taskManager.checkCache.bind(taskManager);

afterEach(() => {
    taskManager.createTask = originalCreateTask;
    taskManager.startTask = originalStartTask;
    taskManager.completeTask = originalCompleteTask;
    taskManager.checkCache = originalCheckCache;
});

test('PlanExecutor completes task when module execution throws', async () => {
    const executor = new PlanExecutor() as unknown as {
        executeNode: (
            node: { id: string; toolName: string; dependsOn: string[] },
            params: Record<string, unknown>,
            ctx: { senderId: number; groupId?: number },
        ) => Promise<{ success: boolean; text: string; error?: string }>;
        runModule: () => Promise<never>;
    };

    let completed: {
        id: string;
        success: boolean;
        text?: string;
        error?: string;
    } | null = null;

    taskManager.createTask = (() => ({ id: 'task-1' })) as typeof taskManager.createTask;
    taskManager.startTask = (() => undefined) as typeof taskManager.startTask;
    taskManager.completeTask = ((id, success, text, _data, error) => {
        completed = { id, success, text, error };
    }) as typeof taskManager.completeTask;

    executor.runModule = async () => {
        throw new Error('boom');
    };

    const result = await executor.executeNode(
        { id: 'step1', toolName: 'broken_tool', params: {}, dependsOn: [] },
        {},
        { senderId: 1, groupId: 2 },
    );

    assert.equal(result.success, false);
    assert.match(result.text, /boom/u);
    assert.deepEqual(completed, {
        id: 'task-1',
        success: false,
        text: '执行失败: boom',
        error: 'boom',
    });
});

test('PlanExecutor skips duplicate node execution when cache already has a running task', async () => {
    const executor = new PlanExecutor() as unknown as {
        executeNode: (
            node: { id: string; toolName: string; dependsOn: string[] },
            params: Record<string, unknown>,
            ctx: { senderId: number; groupId?: number; atUsers?: number[]; imageUrls?: string[]; videoPaths?: string[]; audioPaths?: string[]; filePaths?: string[] },
        ) => Promise<{ success: boolean; text: string }>;
        runModule: () => Promise<never>;
    };

    let createTaskCalled = false;
    taskManager.checkCache = (() => ({
        id: 'task-running',
        status: 'running',
    })) as typeof taskManager.checkCache;
    taskManager.createTask = (() => {
        createTaskCalled = true;
        throw new Error('should not create task');
    }) as typeof taskManager.createTask;

    executor.runModule = async () => {
        throw new Error('should not run module');
    };

    const result = await executor.executeNode(
        { id: 'step1', toolName: 'draw', params: {}, dependsOn: [] },
        { prompt: 'test' },
        { senderId: 1, groupId: 2 },
    );

    assert.equal(result.success, true);
    assert.match(result.text, /已在执行中/u);
    assert.equal(createTaskCalled, false);
});
