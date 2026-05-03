import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
    __processControlTestUtils,
    controlGenesisAgentProcess,
    isManagedProcessActionApplied,
    parsePm2DescribeOutput,
    syncGenesisAgentProcess,
} from '../../src/web/services/process_control.ts';

const originalRole = process.env.GENESIS_PROCESS_ROLE;

afterEach(() => {
    __processControlTestUtils.resetDriverForTests();
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
});

test('parsePm2DescribeOutput extracts basic process fields', () => {
    const output = `
 Describing process with id 8 - name genesis-agent
┌───────────────────┬────────────────────────────────────────────┐
│ status            │ online                                     │
│ name              │ genesis-agent                              │
│ namespace         │ default                                    │
│ version           │ N/A                                        │
│ restarts          │ 11                                         │
│ uptime            │ 6m                                         │
│ script path       │ /root/.nvm/versions/node/v22.20.0/bin/node │
│ pid               │ 2468100                                    │
└───────────────────┴────────────────────────────────────────────┘
`;

    const parsed = parsePm2DescribeOutput('genesis-agent', output);
    assert.deepEqual(parsed, {
        name: 'genesis-agent',
        status: 'online',
        pid: 2468100,
        uptimeText: '6m',
        restarts: 11,
    });
});

test('isManagedProcessActionApplied matches expected target states', () => {
    assert.equal(isManagedProcessActionApplied('start', 'online'), true);
    assert.equal(isManagedProcessActionApplied('restart', 'online'), true);
    assert.equal(isManagedProcessActionApplied('stop', 'stopped'), true);
    assert.equal(isManagedProcessActionApplied('stop', 'missing'), true);
    assert.equal(isManagedProcessActionApplied('start', 'stopped'), false);
    assert.equal(isManagedProcessActionApplied('restart', 'errored'), false);
    assert.equal(isManagedProcessActionApplied('stop', 'online'), false);
    assert.equal(isManagedProcessActionApplied('stop', 'stopping'), false);
    assert.equal(isManagedProcessActionApplied('stop', 'errored'), false);
});

test('controlGenesisAgentProcess reports failure when target state is not reached', async () => {
    let describeCalls = 0;
    __processControlTestUtils.setDriverForTests({
        describePm2Process: async () => {
            describeCalls += 1;
            return {
                name: 'genesis-agent',
                status: describeCalls === 1 ? 'stopped' : 'errored',
                pid: null,
                uptimeText: '-',
                restarts: 0,
            };
        },
        runPm2Action: async () => undefined,
        sleep: async () => undefined,
    });

    const result = await controlGenesisAgentProcess('start');
    assert.equal(result.success, false);
    assert.equal(result.action, 'start');
    assert.equal(result.process.status, 'errored');
    assert.match(result.message, /未进入运行状态/u);
});

test('syncGenesisAgentProcess verifies restart result in web role', async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    __processControlTestUtils.setDriverForTests({
        restartPm2Process: async () => ({ restarted: true }),
        describePm2Process: async () => ({
            name: 'genesis-agent',
            status: 'errored',
            pid: null,
            uptimeText: '-',
            restarts: 3,
        }),
    });

    const result = await syncGenesisAgentProcess();
    assert.equal(result.requested, true);
    assert.equal(result.restarted, true);
    assert.equal(result.applied, false);
    assert.equal(result.mode, 'restart');
    assert.match(result.error || '', /errored/u);
});
