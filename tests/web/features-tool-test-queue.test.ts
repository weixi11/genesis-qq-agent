import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;

let tempCwd = '';
let closeGenesisDb: (() => void) | undefined;
let mutateGenesisDbSnapshot:
    | (<T>(mutator: (database: import('sql.js').Database) => T | Promise<T>) => Promise<T>)
    | undefined;
let stopModuleLoader: (() => void) | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let baseUrl = '';
let queueStoreModule: typeof import('../../src/services/tool_test_request_store.ts') | undefined;
let runnerModule: typeof import('../../src/services/tool_test_runner.ts') | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-tool-test-queue-'));
    process.chdir(tempCwd);
    process.env.GENESIS_PROCESS_ROLE = 'web';
    await writeFile(path.join(tempCwd, '.env'), '', 'utf-8');

    const dbModule = await import('../../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb();
    closeGenesisDb = dbModule.closeGenesisDb;
    mutateGenesisDbSnapshot = dbModule.mutateGenesisDbSnapshot;

    const toolsModule = await import('../../src/tools/index.ts');
    await toolsModule.initModuleLoader(false);
    stopModuleLoader = toolsModule.stopModuleLoader;

    queueStoreModule = await import('../../src/services/tool_test_request_store.ts');
    runnerModule = await import('../../src/services/tool_test_runner.ts');
    const { featuresRouter } = await import('../../src/web/routes/features.ts');

    const app = express();
    app.use(express.json());
    app.use('/api', featuresRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start test server');
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
    closeGenesisDb?.();

    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }

    process.chdir(originalCwd);
});

test('web tools/test queues execution for agent instead of running tool locally', async () => {
    assert.ok(queueStoreModule);

    const responsePromise = fetch(`${baseUrl}/tools/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            toolName: 'vision',
            params: {
                imagePath: 'https://example.com/demo.png',
                prompt: 'describe',
            },
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const pending = await queueStoreModule.claimPendingToolTestRequest();
    assert.ok(pending);
    assert.equal(pending.toolName, 'vision');
    assert.equal(pending.payload.requestParams.imagePath, 'https://example.com/demo.png');
    assert.equal(pending.payload.toolParams.imagePath, undefined);
    assert.deepEqual(pending.payload.context.imageUrls, ['https://example.com/demo.png']);

    await queueStoreModule.completeToolTestRequest(pending.requestId, {
        status: 'success',
        durationMs: 123,
        response: {
            success: true,
            text: '识图完成',
            data: { caption: 'demo' },
        },
    });

    const response = await responsePromise;
    const data = await response.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        requestId: string;
        message: string;
        duration: number;
        response: {
            success: boolean;
            text?: string;
            data?: { caption?: string };
        };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.queued, true);
    assert.equal(data.completed, true);
    assert.equal(typeof data.requestId, 'string');
    assert.equal(data.message, '工具测试已由 genesis-agent 执行完成');
    assert.equal(data.duration, 123);
    assert.equal(data.response.success, true);
    assert.equal(data.response.text, '识图完成');
    assert.equal(data.response.data?.caption, 'demo');
});

test('web tools/test status endpoint exposes pending queued requests', async () => {
    assert.ok(queueStoreModule);
    assert.ok(runnerModule);

    const queued = await queueStoreModule.enqueueToolTestRequest(
        runnerModule.prepareToolTestPayload('vision', {
            imagePath: 'https://example.com/pending.png',
            prompt: 'describe pending',
        }),
    );

    const response = await fetch(`${baseUrl}/tools/test/${encodeURIComponent(queued.requestId)}`);
    const data = await response.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        requestId: string;
        message: string;
        response: {
            success: boolean;
            error?: string;
        };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.queued, true);
    assert.equal(data.completed, false);
    assert.equal(data.requestId, queued.requestId);
    assert.equal(data.message, '工具测试请求已提交给 genesis-agent，等待执行');
    assert.equal(data.response.success, false);
});

test('banana_draw tool test payload moves remote imagePath into context without mapping targetId to atUsers', async () => {
    assert.ok(runnerModule);

    const payload = runnerModule.prepareToolTestPayload('banana_draw', {
        imagePath: 'https://example.com/banana-input.png',
        targetId: '30001',
        mode: 'figurine',
    });

    assert.equal(payload.toolName, 'banana_draw');
    assert.equal(payload.toolParams.imagePath, undefined);
    assert.deepEqual(payload.context.imageUrls, ['https://example.com/banana-input.png']);
    assert.deepEqual(payload.context.atUsers, []);
    assert.equal(payload.toolParams.mode, 'figurine');
});

test('tool test queue store tolerates invalid persisted json payloads', async () => {
    assert.ok(queueStoreModule);
    assert.ok(mutateGenesisDbSnapshot);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run('DELETE FROM tool_test_requests');
        db.run(
            `INSERT INTO tool_test_requests (
                request_id, tool_name, params_json, context_json, status, requested_at,
                started_at, finished_at, duration_ms, response_json, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'tool_test_bad_json',
                'vision',
                '{bad',
                '{"senderId":"oops"}',
                'success',
                Date.now(),
                null,
                Date.now(),
                33,
                '{"success":"wrong"}',
                null,
            ],
        );
    });

    const record = await queueStoreModule.getToolTestRequest('tool_test_bad_json');
    assert.ok(record);
    assert.equal(record.toolName, 'vision');
    assert.deepEqual(record.payload.requestParams, {});
    assert.deepEqual(record.payload.toolParams, {});
    assert.deepEqual(record.payload.context.imageUrls, []);
    assert.equal(record.response, undefined);
});
