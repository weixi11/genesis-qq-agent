import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { ToolResult } from '../../src/tools/types.ts';

type ExecuteFn = (params: Record<string, unknown>, ctx: { senderId: number; groupId?: number }) => Promise<ToolResult>;

const originalCwd = process.cwd();
let tempCwd = '';
let executeScheduler: ExecuteFn;
let closeGenesisDb: (() => void) | undefined;
let stopModuleLoader: (() => void) | undefined;

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

function getStringField(source: Record<string, unknown>, key: string): string {
    const value = source[key];
    assert.equal(typeof value, 'string', `${key} should be a string`);
    return value;
}

function getNumberField(source: Record<string, unknown>, key: string): number {
    const value = source[key];
    assert.equal(typeof value, 'number', `${key} should be a number`);
    return value;
}

async function waitForMessages(messages: Array<string | unknown[]>, expectedCount: number): Promise<void> {
    const timeoutAt = Date.now() + 500;
    while (messages.length < expectedCount && Date.now() < timeoutAt) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-scheduler-'));
    process.chdir(tempCwd);
    process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';

    const dbModule = await import('../../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb();
    closeGenesisDb = dbModule.closeGenesisDb;

    const toolsModule = await import('../../src/tools/index.ts');
    await toolsModule.initModuleLoader(false);
    stopModuleLoader = toolsModule.stopModuleLoader;

    const schedulerModule = await import('../../src/tools/cron_scheduler/index.ts');
    executeScheduler = schedulerModule.execute;
});

after(() => {
    stopModuleLoader?.();
    closeGenesisDb?.();
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;
    process.chdir(originalCwd);
});

test('cron_scheduler execute supports create, update, get, list, toggle, run_now and delete', async () => {
    const personaModule = await import('../../src/agents/persona.ts');
    const connectorModule = await import('../../src/connector.ts');
    const originalEnhanceToolResult = personaModule.persona.enhanceToolResult.bind(personaModule.persona);
    const originalSendGroup = connectorModule.connector.sendGroup.bind(connectorModule.connector);
    const originalConnectedDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(connectorModule.connector),
        'connected',
    );
    let deliveredGroupId: number | undefined;
    let deliveredText = '';

    const patchedPersona = personaModule.persona as unknown as {
        enhanceToolResult: typeof personaModule.persona.enhanceToolResult;
    };
    const patchedConnector = connectorModule.connector as unknown as {
        sendGroup: typeof connectorModule.connector.sendGroup;
    };

    patchedPersona.enhanceToolResult = async () => '润色后的定时结果';
    patchedConnector.sendGroup = async (groupId: number, message: string) => {
        deliveredGroupId = groupId;
        deliveredText = message;
        return undefined;
    };
    Object.defineProperty(connectorModule.connector, 'connected', {
        configurable: true,
        get: () => true,
    });

    try {
    const createWithGroup = await executeScheduler({
        action: 'create',
        name: 'roundtrip-task',
        schedule_type: 'cron',
        cron: '0 9 * * 1',
        timezone: 'Asia/Shanghai',
        tool_name: 'cron_scheduler',
        tool_params: { action: 'list' },
        group_id: '123456',
    }, { senderId: 0, groupId: undefined });

    assert.equal(createWithGroup.success, true);
    const createWithGroupPayload = getPayload(createWithGroup);
    const createWithGroupData = getNestedRecord(createWithGroupPayload, 'data');
    const createdTask = getNestedRecord(createWithGroupData, 'task');
    const createdTaskId = getStringField(createWithGroupData, 'task_id');
    assert.equal(getNumberField(createdTask, 'group_id'), 123456);

    const updateTask = await executeScheduler({
        action: 'update',
        task_id: createdTaskId,
        group_id: '654321',
        name: 'roundtrip-task-updated',
    }, { senderId: 0, groupId: undefined });

    assert.equal(updateTask.success, true);
    const updatePayload = getPayload(updateTask);
    const updateData = getNestedRecord(updatePayload, 'data');
    const updatedTask = getNestedRecord(updateData, 'task');
    assert.equal(getNumberField(updatedTask, 'group_id'), 654321);
    assert.equal(getStringField(updatedTask, 'name'), 'roundtrip-task-updated');

    const clearGroup = await executeScheduler({
        action: 'update',
        task_id: createdTaskId,
        group_id: null,
    }, { senderId: 0, groupId: undefined });

    assert.equal(clearGroup.success, true);
    const clearGroupPayload = getPayload(clearGroup);
    const clearGroupData = getNestedRecord(clearGroupPayload, 'data');
    const clearedGroupTask = getNestedRecord(clearGroupData, 'task');
    assert.equal(clearedGroupTask.group_id, undefined);

    const getTask = await executeScheduler({
        action: 'get',
        task_id: createdTaskId,
    }, { senderId: 0, groupId: undefined });

    assert.equal(getTask.success, true);
    const getPayloadData = getNestedRecord(getPayload(getTask), 'data');
    const fetchedTask = getNestedRecord(getPayloadData, 'task');
    assert.equal(fetchedTask.group_id, undefined);

    const listTasks = await executeScheduler({
        action: 'list',
        filters: { tool_name: 'cron_scheduler' },
    }, { senderId: 0, groupId: undefined });

    assert.equal(listTasks.success, true);
    const listData = getNestedRecord(getPayload(listTasks), 'data');
    const items = listData.items;
    assert.ok(Array.isArray(items), 'list items should be an array');
    assert.ok(items.some((item) => isRecord(item) && item.task_id === createdTaskId), 'created task should appear in list');

    const disableTask = await executeScheduler({
        action: 'disable',
        task_id: createdTaskId,
    }, { senderId: 0, groupId: undefined });

    assert.equal(disableTask.success, true);
    const disableData = getNestedRecord(getPayload(disableTask), 'data');
    const disabledTask = getNestedRecord(disableData, 'task');
    assert.equal(disabledTask.enabled, false);
    assert.equal(disabledTask.next_run_time, undefined);

    const enableTask = await executeScheduler({
        action: 'enable',
        task_id: createdTaskId,
    }, { senderId: 0, groupId: undefined });

    assert.equal(enableTask.success, true);
    const enableData = getNestedRecord(getPayload(enableTask), 'data');
    const enabledTask = getNestedRecord(enableData, 'task');
    assert.equal(enabledTask.enabled, true);
    assert.equal(typeof enabledTask.next_run_time, 'string');

    const createDisabled = await executeScheduler({
        action: 'create',
        name: 'disabled-cron-task',
        schedule_type: 'cron',
        cron: '0 10 * * 2',
        timezone: 'Asia/Shanghai',
        tool_name: 'cron_scheduler',
        tool_params: { action: 'list' },
        enabled: false,
    }, { senderId: 0, groupId: undefined });

    assert.equal(createDisabled.success, true);
    const createDisabledData = getNestedRecord(getPayload(createDisabled), 'data');
    const disabledTaskId = getStringField(createDisabledData, 'task_id');
    const createdDisabledTask = getNestedRecord(createDisabledData, 'task');
    assert.equal(createdDisabledTask.enabled, false);
    assert.equal(createdDisabledTask.next_run_time, undefined);

    const updateDisabled = await executeScheduler({
        action: 'update',
        task_id: disabledTaskId,
        name: 'disabled-cron-task-updated',
    }, { senderId: 0, groupId: undefined });

    assert.equal(updateDisabled.success, true);
    const updateDisabledData = getNestedRecord(getPayload(updateDisabled), 'data');
    const updatedDisabledTask = getNestedRecord(updateDisabledData, 'task');
    assert.equal(updatedDisabledTask.enabled, false);
    assert.equal(updatedDisabledTask.next_run_time, undefined);

    const enableViaUpdate = await executeScheduler({
        action: 'update',
        task_id: disabledTaskId,
        enabled: true,
    }, { senderId: 0, groupId: undefined });

    assert.equal(enableViaUpdate.success, true);
    const enableViaUpdateData = getNestedRecord(getPayload(enableViaUpdate), 'data');
    const enabledViaUpdateTask = getNestedRecord(enableViaUpdateData, 'task');
    assert.equal(enabledViaUpdateTask.enabled, true);
    assert.equal(typeof enabledViaUpdateTask.next_run_time, 'string');

    const createRunNow = await executeScheduler({
        action: 'create',
        name: 'run-now-task',
        schedule_type: 'cron',
        cron: '0 8 1 * 1',
        timezone: 'Asia/Shanghai',
        tool_name: 'cron_scheduler',
        tool_params: { action: 'list' },
        group_id: '778899',
    }, { senderId: 0, groupId: undefined });

    assert.equal(createRunNow.success, true);
    const createRunNowData = getNestedRecord(getPayload(createRunNow), 'data');
    const runNowTaskId = getStringField(createRunNowData, 'task_id');

    const runNowResult = await executeScheduler({
        action: 'run_now',
        task_id: runNowTaskId,
    }, { senderId: 0, groupId: undefined });

    assert.equal(runNowResult.success, true);
    const runNowData = getNestedRecord(getPayload(runNowResult), 'data');
    assert.equal(getStringField(runNowData, 'result'), 'executed');
    const runNowTask = getNestedRecord(runNowData, 'task');
    assert.equal(getStringField(runNowTask, 'last_status'), 'success');
    const logs = runNowData.logs;
    assert.ok(Array.isArray(logs), 'run_now logs should be an array');
    assert.ok(logs.length > 0, 'run_now should produce at least one log');
    assert.equal(deliveredGroupId, 778899);
    assert.equal(deliveredText, '润色后的定时结果');

    const deleteFirst = await executeScheduler({
        action: 'delete',
        task_id: createdTaskId,
    }, { senderId: 0, groupId: undefined });
    assert.equal(deleteFirst.success, true);

    const deleteSecond = await executeScheduler({
        action: 'delete',
        task_id: runNowTaskId,
    }, { senderId: 0, groupId: undefined });
    assert.equal(deleteSecond.success, true);

    const deleteThird = await executeScheduler({
        action: 'delete',
        task_id: disabledTaskId,
    }, { senderId: 0, groupId: undefined });
    assert.equal(deleteThird.success, true);
    } finally {
        patchedPersona.enhanceToolResult = originalEnhanceToolResult;
        patchedConnector.sendGroup = originalSendGroup;
        if (originalConnectedDescriptor) {
            Object.defineProperty(Object.getPrototypeOf(connectorModule.connector), 'connected', originalConnectedDescriptor);
        }
        delete (connectorModule.connector as Record<string, unknown>).connected;
    }
});

test('cron_scheduler run_now preserves rich segments before persona text', async () => {
    const personaModule = await import('../../src/agents/persona.ts');
    const connectorModule = await import('../../src/connector.ts');

    const originalEnhanceToolResult = personaModule.persona.enhanceToolResult.bind(personaModule.persona);
    const originalSendGroup = connectorModule.connector.sendGroup.bind(connectorModule.connector);
    const originalCallData = connectorModule.connector.callData.bind(connectorModule.connector);
    const originalConnectedDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(connectorModule.connector),
        'connected',
    );

    const sentMessages: Array<string | unknown[]> = [];
    const callDataRequests: Array<{ action: string; params: Record<string, unknown> }> = [];

    const patchedPersona = personaModule.persona as unknown as {
        enhanceToolResult: typeof personaModule.persona.enhanceToolResult;
    };
    const patchedConnector = connectorModule.connector as unknown as {
        sendGroup: typeof connectorModule.connector.sendGroup;
        callData: typeof connectorModule.connector.callData;
    };

    patchedPersona.enhanceToolResult = async () => '定时任务润色文本';
    patchedConnector.sendGroup = async (_groupId: number, message: string | unknown[]) => {
        sentMessages.push(message);
        return undefined;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        callDataRequests.push({ action, params });
        if (callDataRequests.length === 1) {
            throw new Error('force-avatar-segment-fallback');
        }
        return undefined;
    };
    Object.defineProperty(connectorModule.connector, 'connected', {
        configurable: true,
        get: () => true,
    });

    try {
        const createRunNow = await executeScheduler({
            action: 'create',
            name: 'run-now-rich-result-task',
            schedule_type: 'cron',
            cron: '0 8 1 * 1',
            timezone: 'Asia/Shanghai',
            tool_name: 'avatar',
            tool_params: { action: 'send', type: 'user', target_id: '12345678' },
            group_id: '990011',
        }, { senderId: 0, groupId: undefined });

        assert.equal(createRunNow.success, true);
        const createRunNowData = getNestedRecord(getPayload(createRunNow), 'data');
        const runNowTaskId = getStringField(createRunNowData, 'task_id');

        const runNowResult = await executeScheduler({
            action: 'run_now',
            task_id: runNowTaskId,
        }, { senderId: 0, groupId: undefined });

        assert.equal(runNowResult.success, true);
        await waitForMessages(sentMessages, 1);
        assert.equal(callDataRequests.length, 2);
        assert.equal(callDataRequests[1].action, 'send_group_msg');
        assert.deepEqual(callDataRequests[1].params, {
            group_id: 990011,
            message: [{
                type: 'image',
                data: { file: 'https://q1.qlogo.cn/g?b=qq&nk=12345678&s=640' },
            }],
        });
        assert.equal(sentMessages.length, 1);
        assert.deepEqual((callDataRequests[1].params.message as unknown[])[0], {
            type: 'image',
            data: { file: 'https://q1.qlogo.cn/g?b=qq&nk=12345678&s=640' },
        });
        assert.equal(sentMessages[0], '定时任务润色文本');
    } finally {
        patchedPersona.enhanceToolResult = originalEnhanceToolResult;
        patchedConnector.sendGroup = originalSendGroup;
        patchedConnector.callData = originalCallData;
        if (originalConnectedDescriptor) {
            Object.defineProperty(Object.getPrototypeOf(connectorModule.connector), 'connected', originalConnectedDescriptor);
        }
        delete (connectorModule.connector as Record<string, unknown>).connected;
    }
});

test('cron_scheduler run_now skips async delivery when connector is offline', async () => {
    const personaModule = await import('../../src/agents/persona.ts');
    const connectorModule = await import('../../src/connector.ts');

    const originalEnhanceToolResult = personaModule.persona.enhanceToolResult.bind(personaModule.persona);
    let enhanceCallCount = 0;

    const patchedPersona = personaModule.persona as unknown as {
        enhanceToolResult: typeof personaModule.persona.enhanceToolResult;
    };

    patchedPersona.enhanceToolResult = async () => {
        enhanceCallCount += 1;
        return '不应触发的润色文本';
    };

    try {
        const createRunNow = await executeScheduler({
            action: 'create',
            name: 'run-now-offline-delivery-task',
            schedule_type: 'cron',
            cron: '0 8 1 * 1',
            timezone: 'Asia/Shanghai',
            tool_name: 'cron_scheduler',
            tool_params: { action: 'list' },
        }, { senderId: 0, groupId: undefined });

        assert.equal(createRunNow.success, true);
        const createRunNowData = getNestedRecord(getPayload(createRunNow), 'data');
        const runNowTaskId = getStringField(createRunNowData, 'task_id');

        const runNowResult = await executeScheduler({
            action: 'run_now',
            task_id: runNowTaskId,
        }, { senderId: 0, groupId: undefined });

        assert.equal(runNowResult.success, true);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(enhanceCallCount, 0);
    } finally {
        patchedPersona.enhanceToolResult = originalEnhanceToolResult;
    }
});

test('cron_scheduler falls back to enabled tools when whitelist env is unset', async () => {
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;

    try {
        const created = await executeScheduler({
            action: 'create',
            name: 'dynamic-allowed-tool-task',
            schedule_type: 'once',
            run_at: new Date(Date.now() + 3600_000).toISOString(),
            timezone: 'Asia/Shanghai',
            tool_name: 'daily_blog_digest',
            tool_params: {},
        }, { senderId: 10003, groupId: undefined });

        assert.equal(created.success, true);
        const createData = getNestedRecord(getPayload(created), 'data');
        assert.equal(getStringField(createData, 'task_id').startsWith('task_'), true);
        const task = getNestedRecord(createData, 'task');
        assert.equal(getStringField(task, 'tool_name'), 'daily_blog_digest');
    } finally {
        process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';
    }
});

test('cron_scheduler update keeps existing tool when whitelist changes later', async () => {
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;

    try {
        const created = await executeScheduler({
            action: 'create',
            name: 'legacy-tool-task',
            schedule_type: 'once',
            run_at: new Date(Date.now() + 3600_000).toISOString(),
            timezone: 'Asia/Shanghai',
            tool_name: 'daily_blog_digest',
            tool_params: {},
        }, { senderId: 10004, groupId: undefined });

        assert.equal(created.success, true);
        const createData = getNestedRecord(getPayload(created), 'data');
        const taskId = getStringField(createData, 'task_id');

        process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'avatar';

        const updated = await executeScheduler({
            action: 'update',
            task_id: taskId,
            name: 'legacy-tool-task-renamed',
            tool_name: 'daily_blog_digest',
        }, { senderId: 10004, groupId: undefined });

        assert.equal(updated.success, true);
        const updateData = getNestedRecord(getPayload(updated), 'data');
        const task = getNestedRecord(updateData, 'task');
        assert.equal(getStringField(task, 'tool_name'), 'daily_blog_digest');
        assert.equal(getStringField(task, 'name'), 'legacy-tool-task-renamed');
    } finally {
        process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';
    }
});
