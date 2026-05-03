import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

import { __processControlTestUtils } from '../../src/web/services/process_control.ts';
import type { SchedulerTask } from '../../src/tools/cron_scheduler/types.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
let tempCwd = '';
let closeGenesisDb: (() => void) | undefined;
let schedulerRouter: express.Router | undefined;
let baseUrl = '';
let saveTaskToDisk: ((task: SchedulerTask) => Promise<void>) | undefined;
let enqueueRunRequest: ((taskId: string, triggeredBy: number) => Promise<{ requestId: string }>) | undefined;
let claimPendingRunRequest: (() => Promise<{ requestId: string; taskId: string; status: string } | undefined>) | undefined;
let completeRunRequest: ((
    requestId: string,
    result: { status: 'success' | 'failed'; resultMessage: string; errorCode?: string; errorMessage?: string },
) => Promise<void>) | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let stopModuleLoader: (() => void) | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-web-scheduler-run-'));
    process.chdir(tempCwd);
    process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';

    const genesisDbModule = await import('../../src/storage/genesis-db.ts');
    await genesisDbModule.initGenesisDb();
    closeGenesisDb = genesisDbModule.closeGenesisDb;

    const toolsModule = await import('../../src/tools/index.ts');
    await toolsModule.initModuleLoader(false);
    stopModuleLoader = toolsModule.stopModuleLoader;

    const storeModule = await import('../../src/tools/cron_scheduler/store.ts');
    saveTaskToDisk = storeModule.saveTaskToDisk;
    enqueueRunRequest = storeModule.enqueueRunRequest;
    claimPendingRunRequest = storeModule.claimPendingRunRequest;
    completeRunRequest = storeModule.completeRunRequest;

    schedulerRouter = (await import('../../src/web/routes/scheduler.ts')).schedulerRouter;

    const app = express();
    app.use(express.json());
    app.use('/api', schedulerRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start scheduler test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
    await new Promise<void>((resolve, reject) => {
        if (!server) {
            resolve();
            return;
        }
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });

    stopModuleLoader?.();
    __processControlTestUtils.resetDriverForTests();
    closeGenesisDb?.();
    process.chdir(originalCwd);
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
});

test('scheduler run-request endpoint exposes pending and completed queued runs', async () => {
    assert.ok(saveTaskToDisk);
    assert.ok(enqueueRunRequest);
    assert.ok(claimPendingRunRequest);
    assert.ok(completeRunRequest);

    process.env.GENESIS_PROCESS_ROLE = 'web';

    const task: SchedulerTask = {
        taskId: 'sched-web-run-status',
        name: '状态轮询任务',
        scheduleType: 'once',
        runAt: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'Asia/Shanghai',
        toolName: 'avatar',
        toolParams: { prompt: 'hello' },
        enabled: true,
        retries: 0,
        timeoutSec: 10,
        maxConcurrency: 1,
        notifyOnFail: false,
        createdBy: 0,
        createdAt: new Date().toISOString(),
        updatedBy: 0,
        updatedAt: new Date().toISOString(),
        nextRunTime: new Date(Date.now() + 3600_000).toISOString(),
        lastStatus: 'never',
        runCount: 0,
        runningCount: 0,
    };

    await saveTaskToDisk(task);

    const queued = await enqueueRunRequest(task.taskId, 0);
    const pending = await claimPendingRunRequest();
    assert.ok(pending);
    assert.equal(pending.requestId, queued.requestId);

    const pendingResponse = await fetch(`${baseUrl}/scheduler/run-requests/${encodeURIComponent(queued.requestId)}`);
    const pendingData = await pendingResponse.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        requestId: string;
        data: {
            result: string;
            request_id: string;
            task_id: string;
        };
    };

    assert.equal(pendingResponse.status, 200);
    assert.equal(pendingData.success, true);
    assert.equal(pendingData.queued, true);
    assert.equal(pendingData.completed, false);
    assert.equal(pendingData.requestId, queued.requestId);
    assert.equal(pendingData.data.result, 'queued');
    assert.equal(pendingData.data.request_id, queued.requestId);
    assert.equal(pendingData.data.task_id, task.taskId);

    await completeRunRequest(queued.requestId, {
        status: 'success',
        resultMessage: '任务执行成功',
    });

    const completedResponse = await fetch(`${baseUrl}/scheduler/run-requests/${encodeURIComponent(queued.requestId)}`);
    const completedData = await completedResponse.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        requestId: string;
        data: {
            result: string;
            request_id: string;
            task_id: string;
            message: string;
            task: { task_id: string };
        };
    };

    assert.equal(completedResponse.status, 200);
    assert.equal(completedData.success, true);
    assert.equal(completedData.queued, true);
    assert.equal(completedData.completed, true);
    assert.equal(completedData.requestId, queued.requestId);
    assert.equal(completedData.data.result, 'executed');
    assert.equal(completedData.data.request_id, queued.requestId);
    assert.equal(completedData.data.task_id, task.taskId);
    assert.equal(completedData.data.message, '任务执行成功');
    assert.equal(completedData.data.task.task_id, task.taskId);
});

test('scheduler create endpoint returns sync warning message when genesis-agent sync fails', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    __processControlTestUtils.setDriverForTests({
        restartPm2Process: async () => ({ restarted: true }),
        describePm2Process: async () => ({
            name: 'genesis-agent',
            status: 'errored',
            pid: null,
            uptimeText: '-',
            restarts: 0,
        }),
    });

    const response = await fetch(`${baseUrl}/scheduler/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: '调度同步告警任务',
            schedule_type: 'once',
            run_at: new Date(Date.now() + 3600_000).toISOString(),
            timezone: 'Asia/Shanghai',
            tool_name: 'avatar',
            tool_params: { prompt: 'hello' },
        }),
    });
    const data = await response.json() as {
        success: boolean;
        message: string;
        agentSync: { applied: boolean; error?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.agentSync.applied, false);
    assert.match(data.message, /同步失败/u);
});

test('scheduler config endpoint exposes dynamic allowed-tools metadata when env is unset', async () => {
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;

    try {
        const response = await fetch(`${baseUrl}/scheduler/config`);
        const data = await response.json() as {
            enabled: boolean;
            allowedTools: string[];
            allowedToolsSource: string;
        };

        assert.equal(response.status, 200);
        assert.equal(Array.isArray(data.allowedTools), true);
        assert.equal(data.allowedToolsSource, 'enabled_modules');
        assert.ok(data.allowedTools.includes('daily_blog_digest'));
    } finally {
        process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';
    }
});

test('scheduler create endpoint returns allowed tools when tool is rejected by whitelist', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'agent';
    process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'avatar';

    try {
        const response = await fetch(`${baseUrl}/scheduler/tasks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: '白名单校验任务',
                schedule_type: 'once',
                run_at: new Date(Date.now() + 3600_000).toISOString(),
                timezone: 'Asia/Shanghai',
                tool_name: 'daily_blog_digest',
                tool_params: {},
            }),
        });
        const data = await response.json() as {
            success: boolean;
            data: {
                error_code: string;
                error_message: string;
                tool_name: string;
                allowed_tools: string[];
                allowed_tools_source: string;
            };
        };

        assert.equal(response.status, 200);
        assert.equal(data.success, false);
        assert.equal(data.data.error_code, 'INVALID_PARAMS');
        assert.match(data.data.error_message, /daily_blog_digest/u);
        assert.deepEqual(data.data.allowed_tools, ['avatar']);
        assert.equal(data.data.allowed_tools_source, 'env');
    } finally {
        process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'cron_scheduler,avatar';
    }
});
