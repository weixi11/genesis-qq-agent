import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { TaskManager } from '../../src/task/manager.ts';
import type { Task } from '../../src/task/types.ts';

const managers: Array<TaskManager> = [];

afterEach(() => {
    for (const manager of managers.splice(0)) {
        const internal = manager as unknown as { cleanupTimer?: NodeJS.Timeout };
        if (internal.cleanupTimer) {
            clearInterval(internal.cleanupTimer);
        }
    }
});

function createTask(overrides: Partial<Task> = {}): Task {
    const now = Date.now();
    return {
        id: 'task-default',
        userId: 10001,
        groupId: 20001,
        toolName: 'demo_tool',
        params: {},
        hash: 'hash-default',
        status: 'pending',
        priority: 'normal',
        createdAt: now,
        timeoutMs: 30000,
        retryCount: 0,
        maxRetries: 0,
        cancelled: false,
        ...overrides,
    };
}

test('TaskManager rebuildIndexes keeps the newest cached task per hash', () => {
    const manager = new TaskManager();
    managers.push(manager);

    const internal = manager as unknown as {
        tasks: Map<string, { id: string; hash: string; createdAt: number; userId: number }>;
        cacheIndex: Map<string, string>;
        userTasks: Map<number, string[]>;
        rebuildIndexes: () => void;
    };

    internal.tasks.set('task-new', {
        id: 'task-new',
        hash: 'same-hash',
        createdAt: 2000,
        userId: 10001,
    });
    internal.tasks.set('task-old', {
        id: 'task-old',
        hash: 'same-hash',
        createdAt: 1000,
        userId: 10001,
    });

    internal.rebuildIndexes();

    assert.equal(internal.cacheIndex.get('same-hash'), 'task-new');
    assert.deepEqual(internal.userTasks.get(10001), ['task-new', 'task-old']);
});

test('TaskManager marks stale running tasks as timeout before reads', () => {
    const manager = new TaskManager();
    managers.push(manager);
    const now = Date.now();

    const internal = manager as unknown as {
        tasks: Map<string, Task>;
        saveTaskToDb: () => void;
        expireTimedOutTasks: (now?: number) => void;
    };
    internal.saveTaskToDb = () => undefined;

    internal.tasks.set('task-timeout', createTask({
        id: 'task-timeout',
        hash: 'hash-timeout',
        status: 'running',
        createdAt: now - 3000,
        startedAt: now - 2000,
        timeoutMs: 1000,
    }));

    internal.expireTimedOutTasks(now);

    const task = manager.getTask('task-timeout');
    assert.equal(task?.status, 'timeout');
    assert.equal(task?.error, '执行超时');
});

test('TaskManager keeps cancelled status when late completion arrives', () => {
    const manager = new TaskManager();
    managers.push(manager);
    const now = Date.now();

    const internal = manager as unknown as {
        tasks: Map<string, Task>;
        saveTaskToDb: () => void;
    };
    internal.saveTaskToDb = () => undefined;

    internal.tasks.set('task-cancel', createTask({
        id: 'task-cancel',
        hash: 'hash-cancel',
        status: 'running',
        createdAt: now,
        startedAt: now,
    }));

    assert.equal(manager.cancelTask('task-cancel'), true);
    manager.completeTask('task-cancel', true, 'late success');

    const task = manager.getTask('task-cancel');
    assert.equal(task?.status, 'cancelled');
    assert.equal(task?.result?.success, false);
    assert.equal(task?.result?.text, '任务已取消');
});

test('TaskManager exposes running group tasks for the whole group session', () => {
    const manager = new TaskManager();
    managers.push(manager);
    const now = Date.now();

    const internal = manager as unknown as {
        tasks: Map<string, Task>;
        saveTaskToDb: () => void;
    };
    internal.saveTaskToDb = () => undefined;

    internal.tasks.set('task-a', createTask({
        id: 'task-a',
        hash: 'hash-a',
        userId: 10001,
        groupId: 30001,
        status: 'running',
        createdAt: now,
        startedAt: now,
    }));
    internal.tasks.set('task-b', createTask({
        id: 'task-b',
        hash: 'hash-b',
        userId: 10002,
        groupId: 30001,
        status: 'running',
        createdAt: now,
        startedAt: now,
    }));

    const running = manager.getRunningTasksForSession('group:30001', 10001);
    assert.deepEqual(running.map(task => task.id), ['task-a', 'task-b']);
});
