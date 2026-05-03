import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { ToolResult } from '../../src/tools/types.ts';
import type { SchedulerTask } from '../../src/tools/cron_scheduler/types.ts';

type ExecuteFn = (params: Record<string, unknown>, ctx: { senderId: number; groupId?: number }) => Promise<ToolResult>;

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
let tempCwd = '';
let executeScheduler: ExecuteFn;
let startScheduler: (() => void) | undefined;
let closeGenesisDb: (() => void) | undefined;
let stopModuleLoader: (() => void) | undefined;
let getAllTasksFromDisk: (() => Promise<SchedulerTask[]>) | undefined;
let saveTaskToDisk: ((task: SchedulerTask) => Promise<void>) | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPayload(result: ToolResult): Record<string, unknown> {
    assert.ok(isRecord(result.data), 'result.data should be an object');
    return result.data;
}

function getNestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    assert.ok(isRecord(value), `${key} should be an object`);
    return value;
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-scheduler-web-'));
    process.chdir(tempCwd);
    process.env.GENESIS_PROCESS_ROLE = 'web';
    process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';

    const dbModule = await import('../../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb({ mode: 'readonly' });
    closeGenesisDb = dbModule.closeGenesisDb;

    const toolsModule = await import('../../src/tools/index.ts');
    await toolsModule.initModuleLoader(false);
    stopModuleLoader = toolsModule.stopModuleLoader;

    const storeModule = await import('../../src/tools/cron_scheduler/store.ts');
    getAllTasksFromDisk = storeModule.getAllTasksFromDisk;
    saveTaskToDisk = storeModule.saveTaskToDisk;

    const schedulerModule = await import('../../src/tools/cron_scheduler/index.ts');
    executeScheduler = schedulerModule.execute;
    startScheduler = schedulerModule.startScheduler;
});

after(() => {
    stopModuleLoader?.();
    closeGenesisDb?.();
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
    process.chdir(originalCwd);
});

test('web-role scheduler execute refreshes task state from disk before reads', async () => {
    assert.ok(getAllTasksFromDisk);
    assert.ok(saveTaskToDisk);

    const created = await executeScheduler({
        action: 'create',
        name: 'web-role-task',
        schedule_type: 'cron',
        cron: '0 9 * * 1',
        timezone: 'Asia/Shanghai',
        tool_name: 'cron_scheduler',
        tool_params: { action: 'list' },
    }, { senderId: 10001, groupId: undefined });

    assert.equal(created.success, true);
    const createData = getNestedRecord(getPayload(created), 'data');
    const taskId = String(createData.task_id);

    const persisted = await getAllTasksFromDisk();
    const task = persisted.find((item) => item.taskId === taskId);
    assert.ok(task, 'created task should be persisted to disk');

    const updatedTask: SchedulerTask = {
        ...task,
        name: 'web-role-task-updated-on-disk',
        updatedAt: new Date().toISOString(),
    };
    await saveTaskToDisk(updatedTask);

    const fetched = await executeScheduler({
        action: 'get',
        task_id: taskId,
    }, { senderId: 10001, groupId: undefined });

    assert.equal(fetched.success, true);
    const getData = getNestedRecord(getPayload(fetched), 'data');
    const fetchedTask = getNestedRecord(getData, 'task');
    assert.equal(fetchedTask.name, 'web-role-task-updated-on-disk');
});

test('web-role run_now is executed by agent queue instead of local web process', async () => {
    assert.ok(startScheduler);

    process.env.GENESIS_PROCESS_ROLE = 'web';
    const created = await executeScheduler({
        action: 'create',
        name: 'queued-run-now-task',
        schedule_type: 'cron',
        cron: '0 9 * * 1',
        timezone: 'Asia/Shanghai',
        tool_name: 'cron_scheduler',
        tool_params: { action: 'list' },
    }, { senderId: 10002, groupId: undefined });

    assert.equal(created.success, true);
    const createData = getNestedRecord(getPayload(created), 'data');
    const taskId = String(createData.task_id);

    const queuedPromise = executeScheduler({
        action: 'run_now',
        task_id: taskId,
    }, { senderId: 10002, groupId: undefined });

    await new Promise((resolve) => setTimeout(resolve, 200));

    process.env.GENESIS_PROCESS_ROLE = 'agent';
    startScheduler();

    const result = await queuedPromise;
    assert.equal(result.success, true);
    const data = getNestedRecord(getPayload(result), 'data');
    assert.ok(data.result === 'queued' || data.result === 'executed');
    assert.equal(typeof data.request_id, 'string');
});
