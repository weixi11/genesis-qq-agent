import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
let tempCwd = '';

let initGenesisDb: (() => Promise<void>) | undefined;
let closeGenesisDb: (() => void) | undefined;
let mutateGenesisDbSnapshot:
    | (<T>(mutator: (database: import('sql.js').Database) => T | Promise<T>) => Promise<T>)
    | undefined;
let listContextSessionsFromDisk:
    | (() => Promise<Array<{ key: string; count: number; lastActivity: number }>>)
    | undefined;
let getContextSessionFromDisk:
    | ((key: string, limit?: number) => Promise<Array<{ text?: string }> | undefined>)
    | undefined;
let clearContextSessionFromDisk: ((key: string) => Promise<void>) | undefined;
let clearAllContextFromDisk: (() => Promise<void>) | undefined;
let listTasksFromDisk:
    | ((limit?: number, userId?: number) => Promise<Array<{ id: string; status: string }>>)
    | undefined;
let getTaskFromDisk:
    | ((taskId: string) => Promise<{ id: string; status: string } | undefined>)
    | undefined;
let getTaskStatsFromDisk:
    | ((limit?: number) => Promise<{ total: number; byStatus: Record<string, number>; avgDuration: number }>)
    | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-disk-state-'));
    process.chdir(tempCwd);

    const dbModule = await import('../../src/storage/genesis-db.ts');
    initGenesisDb = dbModule.initGenesisDb;
    closeGenesisDb = dbModule.closeGenesisDb;
    mutateGenesisDbSnapshot = dbModule.mutateGenesisDbSnapshot;

    const memoryModule = await import('../../src/memory.ts');
    listContextSessionsFromDisk = memoryModule.listContextSessionsFromDisk;
    getContextSessionFromDisk = memoryModule.getContextSessionFromDisk as typeof getContextSessionFromDisk;
    clearContextSessionFromDisk = memoryModule.clearContextSessionFromDisk;
    clearAllContextFromDisk = memoryModule.clearAllContextFromDisk;

    const taskModule = await import('../../src/task/manager.ts');
    listTasksFromDisk = taskModule.listTasksFromDisk as typeof listTasksFromDisk;
    getTaskFromDisk = taskModule.getTaskFromDisk as typeof getTaskFromDisk;
    getTaskStatsFromDisk = taskModule.getTaskStatsFromDisk as typeof getTaskStatsFromDisk;

    await initGenesisDb?.();
});

after(() => {
    closeGenesisDb?.();
    process.chdir(originalCwd);
});

test('context disk helpers read and clear persisted sessions', async () => {
    assert.ok(mutateGenesisDbSnapshot);
    assert.ok(listContextSessionsFromDisk);
    assert.ok(getContextSessionFromDisk);
    assert.ok(clearContextSessionFromDisk);
    assert.ok(clearAllContextFromDisk);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:1', JSON.stringify({ text: 'hello', time: 1, sender_id: 10001 }), 1000],
        );
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:1', JSON.stringify({ text: 'world', time: 2, sender_id: 10001 }), 2000],
        );
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:1', JSON.stringify({ text: 'latest', time: 4, sender_id: 10001 }), 4000],
        );
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['private:2', JSON.stringify({ text: 'solo', time: 3, sender_id: 10002 }), 3000],
        );
        db.run(
            `INSERT INTO media_references
             (id, session_key, sender_id, sender_name, type, path, timestamp, user_index, global_index, filename, message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['m1', 'group:1', 10001, 'tester', 'image', '/tmp/a.png', 1, 1, 1, 'a.png', 1],
        );
    });

    const sessions = await listContextSessionsFromDisk();
    assert.deepEqual(
        sessions.map((item) => ({ key: item.key, count: item.count, lastActivity: item.lastActivity })),
        [
            { key: 'group:1', count: 3, lastActivity: 4000 },
            { key: 'private:2', count: 1, lastActivity: 3000 },
        ],
    );

    const groupMessages = await getContextSessionFromDisk('group:1');
    assert.equal(groupMessages?.length, 3);
    assert.equal(groupMessages?.[0]?.text, 'hello');
    assert.equal(groupMessages?.[1]?.text, 'world');
    assert.equal(groupMessages?.[2]?.text, 'latest');

    const recentGroupMessages = await getContextSessionFromDisk('group:1', 2);
    assert.deepEqual(recentGroupMessages?.map((message) => message.text), ['world', 'latest']);

    await clearContextSessionFromDisk('group:1');
    assert.equal(await getContextSessionFromDisk('group:1'), undefined);

    await clearAllContextFromDisk();
    assert.deepEqual(await listContextSessionsFromDisk(), []);
});

test('task disk helpers expose latest persisted tasks', async () => {
    assert.ok(mutateGenesisDbSnapshot);
    assert.ok(listTasksFromDisk);
    assert.ok(getTaskFromDisk);
    assert.ok(getTaskStatsFromDisk);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run('DELETE FROM tasks');
        db.run(
            `INSERT INTO tasks
             (id, user_id, group_id, tool_name, params_json, hash, status, priority, progress, result_json, error, created_at, started_at, finished_at, timeout_ms, retry_count, max_retries, cancelled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['task_new', 10001, 20001, 'vision', '{"image":"a"}', 'hash_new', 'pending', 'normal', null, null, null, 3000, null, null, 60000, 0, 0, 0],
        );
        db.run(
            `INSERT INTO tasks
             (id, user_id, group_id, tool_name, params_json, hash, status, priority, progress, result_json, error, created_at, started_at, finished_at, timeout_ms, retry_count, max_retries, cancelled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['task_ok', 10001, 20001, 'draw', '{"prompt":"x"}', 'hash_ok', 'success', 'normal', null, '{"success":true,"text":"ok"}', null, 2000, 2100, 2600, 60000, 0, 0, 0],
        );
        db.run(
            `INSERT INTO tasks
             (id, user_id, group_id, tool_name, params_json, hash, status, priority, progress, result_json, error, created_at, started_at, finished_at, timeout_ms, retry_count, max_retries, cancelled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['task_fail', 10002, null, 'read_file', '{"path":"x"}', 'hash_fail', 'failed', 'normal', null, null, 'boom', 1000, 1100, 1900, 60000, 0, 0, 0],
        );
    });

    const tasks = await listTasksFromDisk(10);
    assert.deepEqual(tasks.map((item) => item.id), ['task_new', 'task_ok', 'task_fail']);

    const task = await getTaskFromDisk('task_ok');
    assert.equal(task?.id, 'task_ok');
    assert.equal(task?.status, 'success');

    const stats = await getTaskStatsFromDisk(10);
    assert.equal(stats.total, 3);
    assert.equal(stats.byStatus.pending, 1);
    assert.equal(stats.byStatus.success, 1);
    assert.equal(stats.byStatus.failed, 1);
    assert.equal(stats.avgDuration, 650);
});

test('task disk helpers tolerate invalid persisted task json', async () => {
    assert.ok(mutateGenesisDbSnapshot);
    assert.ok(getTaskFromDisk);
    assert.ok(listTasksFromDisk);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run('DELETE FROM tasks');
        db.run(
            `INSERT INTO tasks
             (id, user_id, group_id, tool_name, params_json, hash, status, priority, progress, result_json, error, created_at, started_at, finished_at, timeout_ms, retry_count, max_retries, cancelled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['task_bad_json', 10001, 20001, 'draw', '{broken', 'hash_bad', 'failed', 'normal', null, '{bad', 'boom', 1000, null, null, 60000, 0, 0, 0],
        );
    });

    const task = await getTaskFromDisk('task_bad_json') as { id: string; params?: Record<string, unknown>; result?: unknown } | undefined;
    assert.equal(task?.id, 'task_bad_json');
    assert.deepEqual(task?.params, {});
    assert.equal(task?.result, undefined);

    const tasks = await listTasksFromDisk(10) as Array<{ id: string; params?: Record<string, unknown> }>;
    assert.equal(tasks[0]?.id, 'task_bad_json');
    assert.deepEqual(tasks[0]?.params, {});
});

test('context disk helpers skip invalid persisted messages but keep legacy minimal rows', async () => {
    assert.ok(mutateGenesisDbSnapshot);
    assert.ok(getContextSessionFromDisk);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run('DELETE FROM context_messages');
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:legacy', JSON.stringify({ text: 'legacy', time: 1, sender_id: 10001 }), 1000],
        );
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:legacy', JSON.stringify({ text: 'broken' }), 2000],
        );
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:legacy', '{bad', 3000],
        );
    });

    const messages = await getContextSessionFromDisk('group:legacy', 10);
    assert.deepEqual(messages?.map((message) => message.text), ['legacy']);
    assert.equal(messages?.[0]?.sender_id, 10001);
});
