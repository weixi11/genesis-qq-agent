import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
const originalAvatarToggle = process.env.MODULE_AVATAR_ENABLED;

let tempCwd = '';
let configModule: typeof import('../../src/config.ts');
let featuresModule: typeof import('../../src/web/routes/features.ts');

async function writeEnvFile(content: string): Promise<void> {
    await writeFile(path.join(tempCwd, '.env'), content, 'utf-8');
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-features-env-'));
    process.chdir(tempCwd);
    process.env.GENESIS_PROCESS_ROLE = 'web';

    await writeEnvFile([
        'AGENT_PROFILER_ENABLED=false',
        'MODULE_AVATAR_ENABLED=false',
        '',
    ].join('\n'));

    configModule = await import('../../src/config.ts');
    featuresModule = await import('../../src/web/routes/features.ts');
});

after(() => {
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }

    if (originalAvatarToggle === undefined) {
        delete process.env.MODULE_AVATAR_ENABLED;
    } else {
        process.env.MODULE_AVATAR_ENABLED = originalAvatarToggle;
    }

    process.chdir(originalCwd);
});

test('web feature toggles read agent state from env snapshot instead of local runtime config', async () => {
    configModule.config.agents.profilerEnabled = false;
    await writeEnvFile([
        'AGENT_PROFILER_ENABLED=true',
        'MODULE_AVATAR_ENABLED=false',
        '',
    ].join('\n'));

    const toggles = featuresModule.__featureToggleTestUtils.getAgentToggles();
    assert.equal(toggles.profiler.enabled, true);
});

test('web applyAgentToggle persists desired state without mutating local agent runtime switch', async () => {
    configModule.config.agents.profilerEnabled = false;
    await writeEnvFile([
        'AGENT_PROFILER_ENABLED=false',
        'MODULE_AVATAR_ENABLED=false',
        '',
    ].join('\n'));

    const result = featuresModule.__featureToggleTestUtils.applyAgentToggle('profiler', true);
    assert.ok(result);
    assert.equal(result.saved, true);
    assert.equal(result.actualEnabled, true);
    assert.equal(configModule.config.agents.profilerEnabled, false);
});

test('web tool state can reflect newer env snapshot without relying on process.env hot state', async () => {
    process.env.MODULE_AVATAR_ENABLED = 'false';
    await writeEnvFile([
        'AGENT_PROFILER_ENABLED=false',
        'MODULE_AVATAR_ENABLED=true',
        '',
    ].join('\n'));

    const env = featuresModule.__featureToggleTestUtils.readFeatureEnvSnapshot();
    const enabled = featuresModule.__featureToggleTestUtils.readToolEnabled('avatar', env, false);
    assert.equal(enabled, true);
    assert.equal(process.env.MODULE_AVATAR_ENABLED, 'false');
});

test('web feature env snapshot parses quoted boolean values correctly', async () => {
    await writeEnvFile([
        'AGENT_PROFILER_ENABLED=\"true\"',
        'MODULE_AVATAR_ENABLED=\"false\"',
        '',
    ].join('\n'));

    const toggles = featuresModule.__featureToggleTestUtils.getAgentToggles();
    const env = featuresModule.__featureToggleTestUtils.readFeatureEnvSnapshot();
    const toolEnabled = featuresModule.__featureToggleTestUtils.readToolEnabled('avatar', env, true);

    assert.equal(toggles.profiler.enabled, true);
    assert.equal(toolEnabled, false);
});
