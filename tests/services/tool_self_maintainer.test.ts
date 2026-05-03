import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { config } from '../../src/config.ts';
import type { ToolResult } from '../../src/tools/types.ts';
import type { ToolUsageParams } from '../../src/web/store/tool_stats.ts';
import {
    ToolSelfMaintainer,
    buildMaintenanceDescription,
    collectMaintenanceCandidates,
    type MaintenanceCandidate,
    type SelfMaintainerState,
} from '../../src/services/tool_self_maintainer.ts';

const originalSelfMaintainerConfig = { ...config.selfMaintainer };
const originalMasterQQ = config.masterQQ;

function createFailureLog(toolName: string, time: number, result: string): ToolUsageParams {
    return {
        name: toolName,
        params: { keyword: '随机老歌' },
        result,
        success: false,
        duration: 320,
        time,
        user: {
            id: 2148941548,
            name: '踟蹰',
        },
    };
}

function createState(): SelfMaintainerState {
    return {
        lastAttemptAt: new Map(),
        lastHandledFailureTime: new Map(),
    };
}

function applyTestConfig(): void {
    config.selfMaintainer.enabled = true;
    config.selfMaintainer.intervalMs = 60000;
    config.selfMaintainer.failureWindowMs = 30 * 60 * 1000;
    config.selfMaintainer.minFailures = 2;
    config.selfMaintainer.cooldownMs = 10 * 60 * 1000;
    config.selfMaintainer.maxToolsPerRun = 1;
    config.selfMaintainer.allowedTools = [];
    config.selfMaintainer.blockedTools = [];
    config.masterQQ = 2148941548;
}

afterEach(() => {
    config.selfMaintainer.enabled = originalSelfMaintainerConfig.enabled;
    config.selfMaintainer.intervalMs = originalSelfMaintainerConfig.intervalMs;
    config.selfMaintainer.failureWindowMs = originalSelfMaintainerConfig.failureWindowMs;
    config.selfMaintainer.minFailures = originalSelfMaintainerConfig.minFailures;
    config.selfMaintainer.cooldownMs = originalSelfMaintainerConfig.cooldownMs;
    config.selfMaintainer.maxToolsPerRun = originalSelfMaintainerConfig.maxToolsPerRun;
    config.selfMaintainer.allowedTools = [...originalSelfMaintainerConfig.allowedTools];
    config.selfMaintainer.blockedTools = [...originalSelfMaintainerConfig.blockedTools];
    config.masterQQ = originalMasterQQ;
});

test('collectMaintenanceCandidates picks repeated failures and skips protected tools', () => {
    applyTestConfig();
    const now = Date.now();
    const logs = [
        createFailureLog('music', now - 1000, 'send_group_msg timeout'),
        createFailureLog('music', now - 2000, 'send_group_msg timeout'),
        createFailureLog('manage_skill', now - 3000, 'llm timeout'),
        createFailureLog('manage_skill', now - 4000, 'llm timeout'),
    ];

    const candidates = collectMaintenanceCandidates(logs, now, createState());

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.toolName, 'music');
    assert.match(buildMaintenanceDescription(candidates[0] as MaintenanceCandidate), /自动维护触发/);
});

test('ToolSelfMaintainer avoids duplicate maintenance until new failures appear', async () => {
    applyTestConfig();
    let now = Date.now();
    const logs = [
        createFailureLog('weather', now - 1000, '天气接口超时'),
        createFailureLog('weather', now - 2000, '天气接口超时'),
    ];
    const calls: string[] = [];

    const service = new ToolSelfMaintainer({
        getLogs: () => logs,
        maintainTool: async (toolName: string, _description: string): Promise<ToolResult> => {
            calls.push(toolName);
            return {
                success: true,
                text: `${toolName} maintained`,
            };
        },
        recordMaintenance: () => undefined,
        now: () => now,
    });

    await service.runOnce();
    assert.deepEqual(calls, ['weather']);

    now += 60 * 1000;
    await service.runOnce();
    assert.deepEqual(calls, ['weather']);

    logs.unshift(createFailureLog('weather', now, '天气接口超时'));
    now += 11 * 60 * 1000;
    await service.runOnce();
    assert.deepEqual(calls, ['weather', 'weather']);
});
