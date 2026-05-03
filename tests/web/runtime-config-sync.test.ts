import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { config } from '../../src/config.ts';
import { __testables } from '../../src/web/routes/system.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
const originalAdapterEnvPath = process.env.GENESIS_ADAPTER_ENV_PATH;
const originalStrictIsolation = process.env.LLM_STRICT_ISOLATION;
let tempCwd = '';
let adapterEnvPath = '';

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-runtime-config-'));
    process.chdir(tempCwd);
    adapterEnvPath = path.join(tempCwd, 'adapter', '.env');
    process.env.GENESIS_ADAPTER_ENV_PATH = adapterEnvPath;
});

after(() => {
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
    if (originalAdapterEnvPath === undefined) {
        delete process.env.GENESIS_ADAPTER_ENV_PATH;
    } else {
        process.env.GENESIS_ADAPTER_ENV_PATH = originalAdapterEnvPath;
    }
    if (originalStrictIsolation === undefined) {
        delete process.env.LLM_STRICT_ISOLATION;
    } else {
        process.env.LLM_STRICT_ISOLATION = originalStrictIsolation;
    }
    process.chdir(originalCwd);
});

test('buildRuntimeSyncPlan skips only scopes with unsaved fields', () => {
    const plan = __testables.buildRuntimeSyncPlan({
        savedKeys: ['SHOW_REASONING_CHAIN', 'adapter:MODE'],
        unsavedKeys: ['SELF_MAINTAINER_ENABLED'],
        scopes: {
            agent: {
                changed: true,
                savedKeys: ['SHOW_REASONING_CHAIN'],
                unsavedKeys: ['SELF_MAINTAINER_ENABLED'],
            },
            adapter: {
                changed: true,
                savedKeys: ['adapter:MODE'],
                unsavedKeys: [],
            },
        },
    });

    assert.deepEqual(plan.agent, {
        requested: true,
        shouldSync: false,
        reason: 'genesis-agent配置存在未保存字段，已跳过同步',
    });
    assert.deepEqual(plan.adapter, {
        requested: true,
        shouldSync: true,
    });
});

test('buildRuntimeSettingsMessage reports hot-applied agent changes clearly', () => {
    const message = __testables.buildRuntimeSettingsMessage(true, {
        agent: {
            requested: true,
            applied: true,
            restarted: false,
            mode: 'hot',
        },
        adapter: {
            requested: false,
            applied: true,
            restarted: false,
            mode: 'none',
        },
    });

    assert.equal(message, '运行时配置已保存，当前 agent 已即时生效');
});

test('buildRuntimeSettingsMessage reports partial process sync failures', () => {
    const message = __testables.buildRuntimeSettingsMessage(true, {
        agent: {
            requested: true,
            applied: false,
            restarted: false,
            mode: 'none',
            skippedReason: 'genesis-agent配置存在未保存字段，已跳过同步',
        },
        adapter: {
            requested: true,
            applied: true,
            restarted: true,
            mode: 'restart',
        },
    });

    assert.equal(
        message,
        '运行时配置已保存，NapCat 适配器 已重启并生效；genesis-agent配置存在未保存字段，已跳过同步',
    );
});

test('buildRuntimeSettingsMessage reports no-op saves clearly', () => {
    const message = __testables.buildRuntimeSettingsMessage(true, {
        agent: {
            requested: false,
            applied: true,
            restarted: false,
            mode: 'none',
        },
        adapter: {
            requested: false,
            applied: true,
            restarted: false,
            mode: 'none',
        },
    });

    assert.equal(message, '未检测到配置变更');
});

test('parseRuntimeSettingsUpdate rejects conflicting adapter token actions', () => {
    assert.throws(
        () => __testables.parseRuntimeSettingsUpdate({
            napcatWsUrl: 'ws://127.0.0.1:6702',
            adapterAccessToken: 'secret-token',
            adapterClearAccessToken: true,
        }),
        /不能同时设置新的适配器访问令牌并勾选清空令牌/u,
    );
});

test('validateRuntimeSettingsUpdate rejects blank active adapter fields', () => {
    const currentConfig = {
        adapter: {
            mode: 'reverse',
            napcatWsUrl: 'ws://127.0.0.1:6700',
            enableStream: false,
            reverseHost: '0.0.0.0',
            reversePath: '/onebot',
            streamHost: '0.0.0.0',
        },
    } as ReturnType<typeof __testables.getRuntimeConfig>;

    assert.throws(
        () => __testables.validateRuntimeSettingsUpdate({
            adapterMode: 'forward',
            adapterNapcatWsUrl: '',
        }, currentConfig),
        /forward 模式下，上游 NapCat 地址不能为空/u,
    );

    assert.throws(
        () => __testables.validateRuntimeSettingsUpdate({
            adapterMode: 'reverse',
            adapterReverseHost: '',
        }, currentConfig),
        /reverse 模式下，适配器反向监听地址不能为空/u,
    );

    assert.throws(
        () => __testables.validateRuntimeSettingsUpdate({
            adapterEnableStream: true,
            adapterStreamHost: '',
        }, currentConfig),
        /启用消息流服务时，适配器消息流监听地址不能为空/u,
    );
});

test('getRuntimeConfig prefers env snapshot values in web-only mode', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    config.showReasoningChain = false;
    config.memoryWindowSize = 10;
    config.llmStrictIsolation = false;
    config.selfMaintainer.enabled = false;
    config.agents.profilerEnabled = false;
    config.autoMeme.enabled = true;
    config.autoMeme.probability = 0.24;
    config.autoMeme.disableInPrivate = false;
    config.autoMeme.disableWhenToolSentMedia = true;
    config.autoMeme.perSessionCooldownMs = 90000;
    config.autoMeme.perUserCooldownMs = 120000;
    config.autoMeme.maxRecentPerSession = 6;
    config.autoMeme.maxRecentPerPackPerSession = 3;
    await mkdir(path.dirname(adapterEnvPath), { recursive: true });

    await writeFile(path.join(tempCwd, '.env'), [
        'SHOW_REASONING_CHAIN=true',
        'MEMORY_WINDOW_SIZE=42',
        'LLM_STRICT_ISOLATION=true',
        'SELF_MAINTAINER_ENABLED=true',
        'AGENT_PROFILER_ENABLED=true',
        'AUTO_MEME_ENABLED=false',
        'AUTO_MEME_PROBABILITY=0.36',
        'AUTO_MEME_PER_SESSION_COOLDOWN_MS=5000',
        'AUTO_MEME_PER_USER_COOLDOWN_MS=7000',
        'AUTO_MEME_DISABLE_IN_PRIVATE=true',
        'AUTO_MEME_DISABLE_WHEN_TOOL_SENT_MEDIA=false',
        'AUTO_MEME_MAX_RECENT_PER_SESSION=9',
        'AUTO_MEME_MAX_RECENT_PER_PACK_PER_SESSION=4',
        'MODULE_AVATAR_ENABLED=false',
        '',
    ].join('\n'), 'utf-8');
    await writeFile(adapterEnvPath, [
        'MODE=forward',
        'NAPCAT_WS_URL=ws://127.0.0.1:6800',
        'REVERSE_HOST=::',
        'REVERSE_PORT=6801',
        '',
    ].join('\n'), 'utf-8');

    const runtimeConfig = __testables.getRuntimeConfig();
    const envContent = await readFile(path.join(tempCwd, '.env'), 'utf-8');
    assert.equal(runtimeConfig.settings.showReasoningChain, true);
    assert.equal(runtimeConfig.settings.memoryWindowSize, 42);
    assert.equal(runtimeConfig.settings.llmStrictIsolation, true);
    assert.equal(runtimeConfig.settings.selfMaintainerEnabled, true);
    assert.equal(runtimeConfig.settings.autoMemeEnabled, false);
    assert.equal(runtimeConfig.settings.autoMemeProbability, 0.36);
    assert.equal(runtimeConfig.autoMeme.enabled, false);
    assert.equal(runtimeConfig.autoMeme.probability, 0.36);
    assert.equal(runtimeConfig.autoMeme.perSessionCooldownMs, 5000);
    assert.equal(runtimeConfig.autoMeme.perUserCooldownMs, 7000);
    assert.equal(runtimeConfig.autoMeme.disableInPrivate, true);
    assert.equal(runtimeConfig.autoMeme.disableWhenToolSentMedia, false);
    assert.equal(runtimeConfig.autoMeme.maxRecentPerSession, 9);
    assert.equal(runtimeConfig.autoMeme.maxRecentPerPackPerSession, 4);
    assert.equal(runtimeConfig.agents.profilerEnabled, true);
    assert.equal(runtimeConfig.runtimeMeta.processRole, 'web');
    assert.equal(runtimeConfig.runtimeMeta.agentConfigSource, 'saved_env');
    assert.equal(runtimeConfig.runtimeMeta.adapterConfigSource, 'saved_env');
    assert.equal(runtimeConfig.adapter.mode, 'forward');
    assert.equal(runtimeConfig.adapter.napcatWsUrl, 'ws://127.0.0.1:6800');
    assert.equal(runtimeConfig.adapter.reverseHost, '::');
    assert.equal(runtimeConfig.adapter.reversePort, 6801);
    assert.doesNotMatch(envContent, /LLM_PROVIDER_REGISTRY=/);
});

test('applyRuntimeSettings in web-only mode persists env without mutating local runtime config', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    config.showReasoningChain = false;
    config.memoryWindowSize = 10;
    config.llmStrictIsolation = false;
    config.autoMeme.enabled = true;
    config.autoMeme.probability = 0.24;
    config.autoMeme.perSessionCooldownMs = 90000;
    config.autoMeme.perUserCooldownMs = 120000;
    config.autoMeme.disableInPrivate = false;
    config.autoMeme.disableWhenToolSentMedia = true;
    config.autoMeme.maxRecentPerSession = 6;
    config.autoMeme.maxRecentPerPackPerSession = 3;

    await writeFile(path.join(tempCwd, '.env'), '', 'utf-8');
    await mkdir(path.dirname(adapterEnvPath), { recursive: true });
    await writeFile(adapterEnvPath, '', 'utf-8');

    const result = await __testables.applyRuntimeSettings({
        showReasoningChain: true,
        memoryWindowSize: 25,
        llmStrictIsolation: true,
        autoMemeEnabled: false,
        autoMemeProbability: 0.36,
        autoMemePerSessionCooldownMs: 5000,
        autoMemePerUserCooldownMs: 7000,
        autoMemeDisableInPrivate: true,
        autoMemeDisableWhenToolSentMedia: false,
        autoMemeMaxRecentPerSession: 9,
        autoMemeMaxRecentPerPackPerSession: 4,
        adapterMode: 'forward',
        adapterReverseHost: '::',
    });

    const envContent = await readFile(path.join(tempCwd, '.env'), 'utf-8');
    const adapterEnvContent = await readFile(adapterEnvPath, 'utf-8');
    assert.deepEqual(result.scopes.agent.changed, true);
    assert.deepEqual(result.scopes.adapter.changed, true);
    assert.equal(config.showReasoningChain, false);
    assert.equal(config.memoryWindowSize, 10);
    assert.equal(config.llmStrictIsolation, false);
    assert.equal(config.autoMeme.enabled, true);
    assert.equal(config.autoMeme.probability, 0.24);
    assert.equal(config.autoMeme.perSessionCooldownMs, 90000);
    assert.equal(config.autoMeme.perUserCooldownMs, 120000);
    assert.match(envContent, /SHOW_REASONING_CHAIN=true/);
    assert.match(envContent, /MEMORY_WINDOW_SIZE=25/);
    assert.match(envContent, /LLM_STRICT_ISOLATION=true/);
    assert.match(envContent, /AUTO_MEME_ENABLED=false/);
    assert.match(envContent, /AUTO_MEME_PROBABILITY=0.36/);
    assert.match(envContent, /AUTO_MEME_PER_SESSION_COOLDOWN_MS=5000/);
    assert.match(envContent, /AUTO_MEME_PER_USER_COOLDOWN_MS=7000/);
    assert.match(envContent, /AUTO_MEME_DISABLE_IN_PRIVATE=true/);
    assert.match(envContent, /AUTO_MEME_DISABLE_WHEN_TOOL_SENT_MEDIA=false/);
    assert.match(envContent, /AUTO_MEME_MAX_RECENT_PER_SESSION=9/);
    assert.match(envContent, /AUTO_MEME_MAX_RECENT_PER_PACK_PER_SESSION=4/);
    assert.match(adapterEnvContent, /MODE=forward/);
    assert.match(adapterEnvContent, /REVERSE_HOST=::/);
});

test('parseRuntimeSettingsUpdate accepts meme probability and rejects out-of-range values', () => {
    const parsed = __testables.parseRuntimeSettingsUpdate({
        autoMemeEnabled: false,
        autoMemeProbability: 0.48,
    });

    assert.equal(parsed.autoMemeEnabled, false);
    assert.equal(parsed.autoMemeProbability, 0.48);

    assert.throws(
        () => __testables.parseRuntimeSettingsUpdate({
            autoMemeProbability: 1.2,
        }),
        /自动表情包概率 必须在 0 ~ 1 范围内/u,
    );
});

test('applyRuntimeSettings skips unchanged values without marking scopes changed', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    config.showReasoningChain = true;
    config.memoryWindowSize = 42;

    await writeFile(path.join(tempCwd, '.env'), [
        'SHOW_REASONING_CHAIN=true',
        'MEMORY_WINDOW_SIZE=42',
        '',
    ].join('\n'), 'utf-8');
    await mkdir(path.dirname(adapterEnvPath), { recursive: true });
    await writeFile(adapterEnvPath, [
        'MODE=forward',
        'NAPCAT_ACCESS_TOKEN=',
        '',
    ].join('\n'), 'utf-8');

    const result = await __testables.applyRuntimeSettings({
        showReasoningChain: true,
        memoryWindowSize: 42,
        adapterMode: 'forward',
        adapterClearAccessToken: true,
    });

    assert.equal(result.savedKeys.length, 0);
    assert.equal(result.unsavedKeys.length, 0);
    assert.equal(result.scopes.agent.changed, false);
    assert.equal(result.scopes.adapter.changed, false);
});

test('applyRuntimeSettings skips unchanged fields in web-only mode', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    config.showReasoningChain = false;
    config.memoryWindowSize = 10;
    config.selfMaintainer.allowedTools = ['avatar'];
    config.selfMaintainer.blockedTools = ['search'];

    await writeFile(path.join(tempCwd, '.env'), [
        'SHOW_REASONING_CHAIN=true',
        'MEMORY_WINDOW_SIZE=25',
        'SELF_MAINTAINER_ALLOWED_TOOLS=avatar',
        'SELF_MAINTAINER_BLOCKED_TOOLS=search',
        '',
    ].join('\n'), 'utf-8');
    await mkdir(path.dirname(adapterEnvPath), { recursive: true });
    await writeFile(adapterEnvPath, [
        'MODE=forward',
        'REVERSE_HOST=::',
        '',
    ].join('\n'), 'utf-8');

    const result = await __testables.applyRuntimeSettings({
        showReasoningChain: true,
        memoryWindowSize: 25,
        adapterMode: 'forward',
        adapterReverseHost: '::',
        selfMaintainerAllowedTools: ['avatar'],
        selfMaintainerBlockedTools: ['search'],
    });

    assert.deepEqual(result.savedKeys, []);
    assert.deepEqual(result.unsavedKeys, []);
    assert.equal(result.scopes.agent.changed, false);
    assert.equal(result.scopes.adapter.changed, false);
});

test('applyRuntimeSettings treats reordered self-maintainer tool lists as no-op', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';

    await writeFile(path.join(tempCwd, '.env'), [
        'SELF_MAINTAINER_ALLOWED_TOOLS=avatar,search',
        'SELF_MAINTAINER_BLOCKED_TOOLS=cron_scheduler,avatar',
        '',
    ].join('\n'), 'utf-8');
    await mkdir(path.dirname(adapterEnvPath), { recursive: true });
    await writeFile(adapterEnvPath, '', 'utf-8');

    const result = await __testables.applyRuntimeSettings({
        selfMaintainerAllowedTools: ['search', 'avatar'],
        selfMaintainerBlockedTools: ['avatar', 'cron_scheduler'],
    });

    assert.equal(result.savedKeys.length, 0);
    assert.equal(result.unsavedKeys.length, 0);
    assert.equal(result.scopes.agent.changed, false);
    assert.equal(result.scopes.adapter.changed, false);
});
