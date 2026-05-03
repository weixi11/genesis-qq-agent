import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
let tempCwd = '';
let closeGenesisDb: (() => void) | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-llm-fallback-'));
    process.chdir(tempCwd);

    const dbModule = await import('../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb();
    closeGenesisDb = dbModule.closeGenesisDb;
});

after(() => {
    globalThis.fetch = originalFetch;
    closeGenesisDb?.();
    process.chdir(originalCwd);
});

test('LLMClient falls back to reasoning_content when content is empty', async () => {
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            choices: [{
                message: {
                    reasoning_content: 'fallback answer',
                },
                finish_reason: 'stop',
            }],
            usage: {},
        }),
    })) as typeof fetch;

    const { LLMClient } = await import('../src/llm.ts');
    const client = new LLMClient('http://example.com/v1', 'token', 'model');
    const result = await client.chat([{ role: 'user', content: 'hi' }], {}, 'test');

    assert.equal(result, 'fallback answer');
});

test('LLMClient keeps assistant tool-call content empty when only reasoning_content is returned', async () => {
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            choices: [{
                message: {
                    reasoning_content: 'internal reasoning',
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: {
                            name: 'draw',
                            arguments: '{"prompt":"test"}',
                        },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: {},
        }),
    })) as typeof fetch;

    const { LLMClient } = await import('../src/llm.ts');
    const client = new LLMClient('http://example.com/v1', 'token', 'model');
    const result = await client.chatWithTools([{ role: 'user', content: 'hi' }], [{
        name: 'draw',
        description: 'draw image',
        parameters: {
            type: 'object',
            properties: {},
        },
    }], {}, 'test');

    assert.equal(result.type, 'tool_calls');
    if (result.type === 'tool_calls') {
        assert.equal(result.message.content, null);
    }
});

test('LLMClient chatWithImage keeps explicit caller label in llm logs', async () => {
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            choices: [{
                message: {
                    content: 'image answer',
                },
                finish_reason: 'stop',
            }],
            usage: {},
        }),
    })) as typeof fetch;

    const { LLMClient } = await import('../src/llm.ts');
    const { llmStats } = await import('../src/web/store/llm_stats.ts');
    llmStats.clear();

    const client = new LLMClient('http://example.com/v1', 'token', 'model');
    const result = await client.chatWithImage('data:image/png;base64,AAA', 'describe', undefined, 'vision_test');

    assert.equal(result, 'image answer');
    assert.equal(llmStats.getLogs()[0]?.caller, 'vision_test');
});
