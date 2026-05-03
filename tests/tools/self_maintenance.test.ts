import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { ToolContext, ToolResult } from '../../src/tools/types.ts';
import type { ToolUsageParams, ToolStatsStore } from '../../src/web/store/tool_stats.ts';

const MASTER_QQ = 2148941548;
const originalCwd = process.cwd();

let tempCwd = '';
let closeGenesisDb: (() => void) | undefined;
let toolStats: ToolStatsStore;
let executeToolLog: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
let executeManageSkill: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getData(result: ToolResult): Record<string, unknown> {
    assert.ok(isRecord(result.data), 'result.data should be an object');
    return result.data;
}

function addToolLog(record: Partial<ToolUsageParams> & Pick<ToolUsageParams, 'name' | 'result' | 'success'>): void {
    toolStats.add({
        params: {},
        duration: 120,
        time: Date.now(),
        user: {
            id: MASTER_QQ,
            name: '踟蹰',
        },
        ...record,
    });
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-self-maintain-'));
    process.chdir(tempCwd);
    process.env.MASTER_QQ = String(MASTER_QQ);

    const dbModule = await import('../../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb();
    closeGenesisDb = dbModule.closeGenesisDb;

    const toolStatsModule = await import('../../src/web/store/tool_stats.ts');
    toolStats = toolStatsModule.toolStats;
    toolStats.clear();

    const toolLogModule = await import('../../src/tools/tool_log/index.ts');
    executeToolLog = toolLogModule.execute;

    const manageSkillModule = await import('../../src/tools/manage_skill/index.ts');
    executeManageSkill = manageSkillModule.execute;
});

after(() => {
    toolStats.clear();
    closeGenesisDb?.();
    delete process.env.MASTER_QQ;
    process.chdir(originalCwd);
});

test('tool_log can read recent failure logs for a specific tool', async () => {
    toolStats.clear();
    addToolLog({
        name: 'music',
        result: 'Timeout waiting response for action "send_group_msg"',
        success: false,
        params: { keyword: '经典老歌' },
    });
    addToolLog({
        name: 'weather',
        result: '查询成功',
        success: true,
        params: { city: '珠海' },
    });

    const result = await executeToolLog({
        action: 'failures',
        toolName: 'music',
        limit: 5,
    }, { senderId: MASTER_QQ });

    assert.equal(result.success, true);
    assert.match(result.text, /music/);
    assert.match(result.text, /send_group_msg/);

    const data = getData(result);
    assert.ok(Array.isArray(data.logs), 'logs should be an array');
    assert.equal(data.logs.length, 1);
});

test('manage_skill inspect includes recent logs for diagnosis context', async () => {
    toolStats.clear();
    addToolLog({
        name: 'music',
        result: '音乐卡片发送超时，降级为文本',
        success: false,
        params: { keyword: '随机老歌' },
    });

    const result = await executeManageSkill({
        action: 'inspect',
        toolName: 'music',
    }, { senderId: MASTER_QQ });

    assert.equal(result.success, true);
    assert.match(result.text, /最近日志/);
    assert.match(result.text, /music/);

    const data = getData(result);
    assert.ok(isRecord(data.files), 'files should be present');
    assert.ok(Array.isArray(data.recentLogs), 'recentLogs should be an array');
    assert.equal(data.recentLogs.length, 1);
});
