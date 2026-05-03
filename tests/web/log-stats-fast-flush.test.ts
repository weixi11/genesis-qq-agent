import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
let tempCwd = '';

let initGenesisDb: (() => Promise<void>) | undefined;
let closeGenesisDb: (() => void) | undefined;
let ToolStatsStoreClass: typeof import('../../src/web/store/tool_stats.ts').ToolStatsStore | undefined;
let LlmStatsStoreClass: typeof import('../../src/web/store/llm_stats.ts').LlmStatsStore | undefined;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-log-flush-'));
    process.chdir(tempCwd);

    const dbModule = await import('../../src/storage/genesis-db.ts');
    initGenesisDb = dbModule.initGenesisDb;
    closeGenesisDb = dbModule.closeGenesisDb;

    await initGenesisDb();

    const toolStatsModule = await import('../../src/web/store/tool_stats.ts');
    ToolStatsStoreClass = toolStatsModule.ToolStatsStore;

    const llmStatsModule = await import('../../src/web/store/llm_stats.ts');
    LlmStatsStoreClass = llmStatsModule.LlmStatsStore;
});

after(() => {
    closeGenesisDb?.();
    process.chdir(originalCwd);
});

test('tool stats flush latest log to disk quickly for web readers', async () => {
    assert.ok(ToolStatsStoreClass);

    const writer = new ToolStatsStoreClass();
    writer.add({
        name: 'chrome_screenshot',
        params: { url: 'https://example.com' },
        result: '截图成功',
        success: true,
        duration: 123,
        time: Date.now(),
        user: {
            id: 10001,
            name: '测试用户',
        },
        taskId: 'task_fast_flush_tool',
    });

    await sleep(450);

    const reader = new ToolStatsStoreClass();
    await reader.reloadFromDisk();
    const logs = reader.getLogs();

    assert.equal(logs[0]?.name, 'chrome_screenshot');
    assert.equal(logs[0]?.taskId, 'task_fast_flush_tool');
    assert.equal(logs[0]?.result, '截图成功');
});

test('llm stats flush latest log to disk quickly for web readers', async () => {
    assert.ok(LlmStatsStoreClass);

    const writer = new LlmStatsStoreClass();
    writer.add({
        time: Date.now(),
        caller: 'persona',
        model: 'gpt-test',
        request: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'ping' }],
        },
        response: {
            content: 'pong',
            input_tokens: 12,
            output_tokens: 8,
        },
        duration: 234,
        success: true,
    });

    await sleep(450);

    const reader = new LlmStatsStoreClass();
    await reader.reloadFromDisk();
    const logs = reader.getLogs();

    assert.equal(logs[0]?.caller, 'persona');
    assert.equal(logs[0]?.model, 'gpt-test');
    assert.equal(logs[0]?.response.content, 'pong');
    assert.equal(logs[0]?.response.output_tokens, 8);
});

test('llm stats truncate oversized payloads before writing to disk', async () => {
    assert.ok(LlmStatsStoreClass);

    const writer = new LlmStatsStoreClass();
    writer.add({
        time: Date.now(),
        caller: 'vision_batch',
        model: 'gpt-test',
        request: {
            model: 'gpt-test',
            messages: [{
                role: 'user',
                content: 'x'.repeat(20000),
            }],
        },
        response: {
            content: 'y'.repeat(20000),
        },
        duration: 321,
        success: true,
    });

    await sleep(450);

    const reader = new LlmStatsStoreClass();
    await reader.reloadFromDisk();
    const logs = reader.getLogs();
    const requestContent = logs[0]?.request.messages?.[0]?.content;
    const responseContent = logs[0]?.response.content;

    assert.equal(typeof requestContent, 'string');
    assert.equal(typeof responseContent, 'string');
    assert.match(String(requestContent), /\[truncated /);
    assert.match(String(responseContent), /\[truncated /);
    assert.ok(String(requestContent).length < 5000);
    assert.ok(String(responseContent).length < 5000);
});
