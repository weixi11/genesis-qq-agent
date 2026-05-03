import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
let tempCwd = '';

let initGenesisDb: (() => Promise<void>) | undefined;
let saveGenesisDbNow: (() => void) | undefined;
let closeGenesisDb: (() => void) | undefined;
let mutateGenesisDbSnapshot:
    | (<T>(mutator: (database: import('sql.js').Database) => T | Promise<T>) => Promise<T>)
    | undefined;
let ToolStatsStoreClass: typeof import('../../src/web/store/tool_stats.ts').ToolStatsStore | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-tool-stats-'));
    process.chdir(tempCwd);

    const dbModule = await import('../../src/storage/genesis-db.ts');
    initGenesisDb = dbModule.initGenesisDb;
    saveGenesisDbNow = dbModule.saveGenesisDbNow;
    closeGenesisDb = dbModule.closeGenesisDb;
    mutateGenesisDbSnapshot = dbModule.mutateGenesisDbSnapshot;

    await initGenesisDb();

    const toolStatsModule = await import('../../src/web/store/tool_stats.ts');
    ToolStatsStoreClass = toolStatsModule.ToolStatsStore;
});

after(() => {
    closeGenesisDb?.();
    process.chdir(originalCwd);
});

test('tool stats can reload latest records from disk', async () => {
    assert.ok(ToolStatsStoreClass);
    assert.ok(saveGenesisDbNow);

    const writer = new ToolStatsStoreClass();
    writer.add({
        name: 'vision',
        params: { imageUrl: 'https://example.com/a.png' },
        result: '识图成功',
        success: true,
        duration: 321,
        time: Date.now(),
        user: {
            id: 10001,
            name: '测试用户',
        },
        taskId: 'task_reload_disk',
    });

    saveGenesisDbNow();

    const reader = new ToolStatsStoreClass();
    await reader.reloadFromDisk();
    const logs = reader.getLogs();

    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.name, 'vision');
    assert.equal(logs[0]?.result, '识图成功');
    assert.equal(logs[0]?.taskId, 'task_reload_disk');
    assert.deepEqual(logs[0]?.params, { imageUrl: 'https://example.com/a.png' });
});

test('tool stats fallback to empty params when params_json is invalid', async () => {
    assert.ok(ToolStatsStoreClass);
    assert.ok(mutateGenesisDbSnapshot);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run('DELETE FROM tool_logs');
        db.run(
            `INSERT INTO tool_logs (time, name, params_json, result, success, duration, user_id, user_name, task_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [Date.now(), 'draw', '{bad', '失败', 0, 120, 10001, '测试用户', 'task_bad_params'],
        );
    });

    const reader = new ToolStatsStoreClass();
    await reader.reloadFromDisk();
    const logs = reader.getLogs();

    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.taskId, 'task_bad_params');
    assert.deepEqual(logs[0]?.params, {});
});
