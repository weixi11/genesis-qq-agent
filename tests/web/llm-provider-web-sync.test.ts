import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { config } from '../../src/config.ts';
import { getLlmDashboardState, syncRuntimeLlmProviders } from '../../src/services/llm_provider_service.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
const originalProviderRegistry = process.env.LLM_PROVIDER_REGISTRY;
const originalProviderId = process.env.LLM_PROVIDER_ID;
const originalBaseUrl = process.env.LLM_BASE_URL;
const originalApiKey = process.env.LLM_API_KEY;
const originalModel = process.env.LLM_MODEL;
const originalStrictIsolation = process.env.LLM_STRICT_ISOLATION;

let tempCwd = '';

async function writeEnvFile(content: string): Promise<void> {
    await writeFile(path.join(tempCwd, '.env'), content, 'utf-8');
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-llm-provider-web-'));
    process.chdir(tempCwd);
    process.env.GENESIS_PROCESS_ROLE = 'web';
});

after(() => {
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }

    if (originalProviderRegistry === undefined) {
        delete process.env.LLM_PROVIDER_REGISTRY;
    } else {
        process.env.LLM_PROVIDER_REGISTRY = originalProviderRegistry;
    }

    if (originalProviderId === undefined) {
        delete process.env.LLM_PROVIDER_ID;
    } else {
        process.env.LLM_PROVIDER_ID = originalProviderId;
    }

    if (originalBaseUrl === undefined) {
        delete process.env.LLM_BASE_URL;
    } else {
        process.env.LLM_BASE_URL = originalBaseUrl;
    }

    if (originalApiKey === undefined) {
        delete process.env.LLM_API_KEY;
    } else {
        process.env.LLM_API_KEY = originalApiKey;
    }

    if (originalModel === undefined) {
        delete process.env.LLM_MODEL;
    } else {
        process.env.LLM_MODEL = originalModel;
    }

    if (originalStrictIsolation === undefined) {
        delete process.env.LLM_STRICT_ISOLATION;
    } else {
        process.env.LLM_STRICT_ISOLATION = originalStrictIsolation;
    }

    process.chdir(originalCwd);
});

test('web llm dashboard reads provider snapshot from env file instead of process.env', async () => {
    process.env.LLM_PROVIDER_REGISTRY = JSON.stringify([
        {
            id: 'provider-process',
            name: 'Process Provider',
            baseUrl: 'https://process.example/v1',
            apiKey: 'process-secret',
            createdAt: 1,
            updatedAt: 1,
        },
    ]);
    process.env.LLM_PROVIDER_ID = 'provider-process';
    process.env.LLM_BASE_URL = 'https://process.example/v1';
    process.env.LLM_API_KEY = 'process-secret';
    process.env.LLM_MODEL = 'process-model';

    await writeEnvFile([
        'LLM_PROVIDER_REGISTRY=' + JSON.stringify(JSON.stringify([
            {
                id: 'provider-env',
                name: 'Env Provider',
                baseUrl: 'https://env.example/v1',
                apiKey: 'env-secret',
                createdAt: 2,
                updatedAt: 2,
            },
        ])),
        'LLM_PROVIDER_ID=provider-env',
        'LLM_BASE_URL=https://env.example/v1',
        'LLM_API_KEY=env-secret',
        'LLM_MODEL=env-model',
        '',
    ].join('\n'));

    const state = getLlmDashboardState({ persistChanges: false });
    const mainModule = state.modules.find((item) => item.id === 'main');
    const envProvider = state.providers.find((item) => item.id === 'provider-env');

    assert.ok(mainModule);
    assert.ok(envProvider);
    assert.equal(mainModule.providerId, 'provider-env');
    assert.equal(mainModule.baseUrl, 'https://env.example/v1');
    assert.equal(mainModule.model, 'env-model');
    assert.equal(envProvider.name, 'Env Provider');
});

test('web syncRuntimeLlmProviders does not hot-mutate local runtime config', async () => {
    config.llm.baseUrl = 'https://runtime.example/v1';
    config.llm.apiKey = 'runtime-secret';
    config.llm.model = 'runtime-model';

    await writeEnvFile([
        'LLM_PROVIDER_REGISTRY=' + JSON.stringify(JSON.stringify([
            {
                id: 'provider-env',
                name: 'Env Provider',
                baseUrl: 'https://env.example/v1',
                apiKey: 'env-secret',
                createdAt: 2,
                updatedAt: 2,
            },
        ])),
        'LLM_PROVIDER_ID=provider-env',
        'LLM_BASE_URL=https://env.example/v1',
        'LLM_API_KEY=env-secret',
        'LLM_MODEL=env-model',
        '',
    ].join('\n'));

    syncRuntimeLlmProviders();

    assert.equal(config.llm.baseUrl, 'https://runtime.example/v1');
    assert.equal(config.llm.apiKey, 'runtime-secret');
    assert.equal(config.llm.model, 'runtime-model');
});

test('web llm dashboard marks inherited modules and respects strict isolation availability', async () => {
    await writeEnvFile([
        'LLM_PROVIDER_REGISTRY=' + JSON.stringify(JSON.stringify([
            {
                id: 'provider-env',
                name: 'Env Provider',
                baseUrl: 'https://env.example/v1',
                apiKey: 'env-secret',
                createdAt: 2,
                updatedAt: 2,
            },
        ])),
        'LLM_PROVIDER_ID=provider-env',
        'LLM_BASE_URL=https://env.example/v1',
        'LLM_API_KEY=env-secret',
        'LLM_MODEL=env-model',
        'SENTRY_LLM_MODEL=sentry-model',
        'LLM_STRICT_ISOLATION=false',
        '',
    ].join('\n'));

    const inheritedState = getLlmDashboardState({ persistChanges: false });
    const inheritedSentry = inheritedState.modules.find((item) => item.id === 'sentry');
    assert.ok(inheritedSentry);
    assert.equal(inheritedSentry.configSource, 'inherited_main');
    assert.equal(inheritedSentry.configSourceLabel, '继承主配置');
    assert.equal(inheritedSentry.available, true);

    await writeEnvFile([
        'LLM_PROVIDER_REGISTRY=' + JSON.stringify(JSON.stringify([
            {
                id: 'provider-env',
                name: 'Env Provider',
                baseUrl: 'https://env.example/v1',
                apiKey: 'env-secret',
                createdAt: 2,
                updatedAt: 2,
            },
        ])),
        'LLM_PROVIDER_ID=provider-env',
        'LLM_BASE_URL=https://env.example/v1',
        'LLM_API_KEY=env-secret',
        'LLM_MODEL=env-model',
        'SENTRY_LLM_MODEL=sentry-model',
        'LLM_STRICT_ISOLATION=true',
        '',
    ].join('\n'));

    const strictState = getLlmDashboardState({ persistChanges: false });
    const strictSentry = strictState.modules.find((item) => item.id === 'sentry');
    assert.ok(strictSentry);
    assert.equal(strictSentry.configSource, 'inherited_main');
    assert.equal(strictSentry.available, false);
    assert.match(strictSentry.availabilityReason || '', /严格隔离已开启/u);
});

test('web llm dashboard includes service, draw and skill modules with independent config', async () => {
    await writeEnvFile([
        'LLM_PROVIDER_REGISTRY=' + JSON.stringify(JSON.stringify([
            {
                id: 'provider-env',
                name: 'Env Provider',
                baseUrl: 'https://env.example/v1',
                apiKey: 'env-secret',
                createdAt: 2,
                updatedAt: 2,
            },
        ])),
        'LLM_PROVIDER_ID=provider-env',
        'LLM_BASE_URL=https://env.example/v1',
        'LLM_API_KEY=env-secret',
        'LLM_MODEL=env-model',
        'AUTO_MEME_LLM_BASE_URL=https://meme.example/v1',
        'AUTO_MEME_LLM_API_KEY=meme-secret',
        'AUTO_MEME_LLM_MODEL=meme-model',
        'EMBEDDING_BASE_URL=https://embed.example/v1',
        'EMBEDDING_API_KEY=embed-secret',
        'EMBEDDING_MODEL=embed-model',
        'BANANA_DRAW_LLM_BASE_URL=https://banana.example/v1',
        'BANANA_DRAW_LLM_API_KEY=banana-secret',
        'BANANA_DRAW_LLM_MODEL=banana-model',
        'DRAW_LLM_BASE_URL=https://draw.example/v1',
        'DRAW_API_KEY=draw-secret',
        'DRAW_MODEL=draw-model-legacy',
        'CREATE_SKILL_LLM_BASE_URL=https://skills.example/v1',
        'CREATE_SKILL_LLM_API_KEY=create-secret',
        'CREATE_SKILL_LLM_MODEL=create-model',
        'MANAGE_SKILL_LLM_BASE_URL=https://skills.example/v1',
        'MANAGE_SKILL_LLM_API_KEY=manage-secret',
        'MANAGE_SKILL_LLM_MODEL=manage-model',
        '',
    ].join('\n'));

    const state = getLlmDashboardState({ persistChanges: false });
    const autoMemeModule = state.modules.find((item) => item.id === 'autoMeme');
    const embeddingModule = state.modules.find((item) => item.id === 'embedding');
    const bananaDrawModule = state.modules.find((item) => item.id === 'bananaDraw');
    const drawModule = state.modules.find((item) => item.id === 'draw');
    const createSkillModule = state.modules.find((item) => item.id === 'createSkill');
    const manageSkillModule = state.modules.find((item) => item.id === 'manageSkill');

    assert.ok(autoMemeModule);
    assert.equal(autoMemeModule.baseUrl, 'https://meme.example/v1');
    assert.equal(autoMemeModule.model, 'meme-model');
    assert.equal(autoMemeModule.configSource, 'module_override');

    assert.ok(embeddingModule);
    assert.equal(embeddingModule.baseUrl, 'https://embed.example/v1');
    assert.equal(embeddingModule.model, 'embed-model');
    assert.equal(embeddingModule.configSource, 'module_override');

    assert.ok(bananaDrawModule);
    assert.equal(bananaDrawModule.baseUrl, 'https://banana.example/v1');
    assert.equal(bananaDrawModule.model, 'banana-model');
    assert.equal(bananaDrawModule.configSource, 'module_override');

    assert.ok(drawModule);
    assert.equal(drawModule.baseUrl, 'https://draw.example/v1');
    assert.equal(drawModule.model, 'draw-model-legacy');
    assert.equal(drawModule.configSource, 'module_override');

    assert.ok(createSkillModule);
    assert.equal(createSkillModule.baseUrl, 'https://skills.example/v1');
    assert.equal(createSkillModule.model, 'create-model');
    assert.equal(createSkillModule.configSource, 'module_override');

    assert.ok(manageSkillModule);
    assert.equal(manageSkillModule.baseUrl, 'https://skills.example/v1');
    assert.equal(manageSkillModule.model, 'manage-model');
    assert.equal(manageSkillModule.configSource, 'module_override');
});
