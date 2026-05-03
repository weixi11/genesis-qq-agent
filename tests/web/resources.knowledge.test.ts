import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';

const originalCwd = process.cwd();
const originalFetch = global.fetch;
const originalRole = process.env.GENESIS_PROCESS_ROLE;
const originalEmbeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
const originalEmbeddingApiKey = process.env.EMBEDDING_API_KEY;
const originalEmbeddingModel = process.env.EMBEDDING_MODEL;
const originalEmbeddingDimension = process.env.EMBEDDING_DIMENSION;

let tempCwd = '';
let closeProfilesDb: (() => void) | undefined;
let closeGenesisDb: (() => void) | undefined;
let closeVectorDb: (() => void) | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let baseUrl = '';

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-web-knowledge-'));
    process.chdir(tempCwd);

    process.env.GENESIS_PROCESS_ROLE = 'agent';
    process.env.EMBEDDING_BASE_URL = 'http://embedding.test/v1';
    process.env.EMBEDDING_API_KEY = 'test-key';
    process.env.EMBEDDING_MODEL = 'test-embedding';
    process.env.EMBEDDING_DIMENSION = '4';

    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('/embeddings')) {
            if (!originalFetch) {
                throw new Error(`Unexpected fetch url: ${url}`);
            }
            return originalFetch(input as Parameters<typeof fetch>[0], init);
        }

        return new Response(JSON.stringify({
            data: [
                {
                    embedding: [0.1, 0.2, 0.3, 0.4],
                    index: 0,
                    object: 'embedding',
                },
            ],
            usage: {
                prompt_tokens: 4,
                total_tokens: 4,
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof global.fetch;

    const genesisDbModule = await import('../../src/storage/genesis-db.ts');
    await genesisDbModule.initGenesisDb();
    closeGenesisDb = genesisDbModule.closeGenesisDb;

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;

    const vectorClientModule = await import('../../src/vectordb/client.ts');
    closeVectorDb = vectorClientModule.closeDb;

    const { resourcesRouter } = await import('../../src/web/routes/resources.ts');
    const app = express();
    app.use(express.json());
    app.use('/api', resourcesRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start knowledge test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api`;
});

beforeEach(() => {
    process.env.GENESIS_PROCESS_ROLE = 'agent';
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

    closeVectorDb?.();
    closeProfilesDb?.();
    closeGenesisDb?.();
    global.fetch = originalFetch;
    process.chdir(originalCwd);

    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
    if (originalEmbeddingBaseUrl === undefined) {
        delete process.env.EMBEDDING_BASE_URL;
    } else {
        process.env.EMBEDDING_BASE_URL = originalEmbeddingBaseUrl;
    }
    if (originalEmbeddingApiKey === undefined) {
        delete process.env.EMBEDDING_API_KEY;
    } else {
        process.env.EMBEDDING_API_KEY = originalEmbeddingApiKey;
    }
    if (originalEmbeddingModel === undefined) {
        delete process.env.EMBEDDING_MODEL;
    } else {
        process.env.EMBEDDING_MODEL = originalEmbeddingModel;
    }
    if (originalEmbeddingDimension === undefined) {
        delete process.env.EMBEDDING_DIMENSION;
    } else {
        process.env.EMBEDDING_DIMENSION = originalEmbeddingDimension;
    }
});

test('knowledge update keeps original id and replaces content in place', async () => {
    const createResponse = await fetch(`${baseUrl}/knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            text: '旧知识内容',
            source: '初始来源',
            category: 'old',
        }),
    });
    const createText = await createResponse.text();
    const createData = JSON.parse(createText) as { success: boolean; count: number; error?: string };

    assert.equal(createResponse.status, 200, createText);
    assert.equal(createData.success, true);
    assert.equal(createData.count, 1);

    const listResponse = await fetch(`${baseUrl}/knowledge`);
    const listData = await listResponse.json() as Array<{
        id: string;
        text: string;
        source: string;
        category?: string;
    }>;
    assert.equal(listResponse.status, 200);
    assert.equal(listData.length, 1);

    const knowledgeId = listData[0]?.id;
    assert.ok(knowledgeId);

    const updateResponse = await fetch(`${baseUrl}/knowledge/${encodeURIComponent(knowledgeId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            text: '新知识内容',
            source: '更新来源',
            category: 'new',
        }),
    });
    const updateData = await updateResponse.json() as { success: boolean; id: string };

    assert.equal(updateResponse.status, 200);
    assert.equal(updateData.success, true);
    assert.equal(updateData.id, knowledgeId);

    const detailResponse = await fetch(`${baseUrl}/knowledge/${encodeURIComponent(knowledgeId)}`);
    const detailData = await detailResponse.json() as {
        id: string;
        text: string;
        source: string;
        category?: string;
    };

    assert.equal(detailResponse.status, 200);
    assert.equal(detailData.id, knowledgeId);
    assert.equal(detailData.text, '新知识内容');
    assert.equal(detailData.source, '更新来源');
    assert.equal(detailData.category, 'new');

    const finalListResponse = await fetch(`${baseUrl}/knowledge`);
    const finalListData = await finalListResponse.json() as Array<{ id: string; text: string }>;
    assert.equal(finalListResponse.status, 200);
    assert.equal(finalListData.length, 1);
    assert.equal(finalListData[0]?.id, knowledgeId);
    assert.equal(finalListData[0]?.text, '新知识内容');
});
