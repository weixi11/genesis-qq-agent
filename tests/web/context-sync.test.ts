import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';

import { __processControlTestUtils } from '../../src/web/services/process_control.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
let tempCwd = '';
let closeGenesisDb: (() => void) | undefined;
let mutateGenesisDbSnapshot:
    | (<T>(mutator: (database: import('sql.js').Database) => T | Promise<T>) => Promise<T>)
    | undefined;
let contextRouter: express.Router | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let baseUrl = '';

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-web-context-sync-'));
    process.chdir(tempCwd);

    const dbModule = await import('../../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb();
    closeGenesisDb = dbModule.closeGenesisDb;
    mutateGenesisDbSnapshot = dbModule.mutateGenesisDbSnapshot;

    contextRouter = (await import('../../src/web/routes/context.ts')).contextRouter;

    const app = express();
    app.use(express.json());
    app.use('/api', contextRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start context test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api`;
});

beforeEach(async () => {
    __processControlTestUtils.resetDriverForTests();
    process.env.GENESIS_PROCESS_ROLE = 'web';
    await mutateGenesisDbSnapshot?.((db) => {
        db.run('DELETE FROM context_messages');
        db.run('DELETE FROM media_references');
    });
});

after(async () => {
    __processControlTestUtils.resetDriverForTests();
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

    closeGenesisDb?.();
    process.chdir(originalCwd);
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
});

test('web context delete returns warning message when genesis-agent sync fails', async () => {
    assert.ok(mutateGenesisDbSnapshot);

    await mutateGenesisDbSnapshot((db) => {
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:1', JSON.stringify({ text: 'hello', time: 1, sender_id: 10001 }), 1000],
        );
    });

    __processControlTestUtils.setDriverForTests({
        restartPm2Process: async () => ({ restarted: true }),
        describePm2Process: async () => ({
            name: 'genesis-agent',
            status: 'errored',
            pid: null,
            uptimeText: '-',
            restarts: 0,
        }),
    });

    const response = await fetch(`${baseUrl}/context/${encodeURIComponent('group:1')}`, {
        method: 'DELETE',
    });
    const data = await response.json() as {
        success: boolean;
        message: string;
        agentSync: { applied: boolean; error?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.agentSync.applied, false);
    assert.match(data.message, /同步失败/u);
});

test('web clear-all context returns warning message when genesis-agent sync fails', async () => {
    assert.ok(mutateGenesisDbSnapshot);

    await mutateGenesisDbSnapshot((db) => {
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:1', JSON.stringify({ text: 'hello', time: 1, sender_id: 10001 }), 1000],
        );
        db.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['private:2', JSON.stringify({ text: 'world', time: 2, sender_id: 10002 }), 2000],
        );
    });

    __processControlTestUtils.setDriverForTests({
        restartPm2Process: async () => ({ restarted: true }),
        describePm2Process: async () => ({
            name: 'genesis-agent',
            status: 'stopped',
            pid: null,
            uptimeText: '-',
            restarts: 1,
        }),
    });

    const response = await fetch(`${baseUrl}/context`, {
        method: 'DELETE',
    });
    const data = await response.json() as {
        success: boolean;
        message: string;
        agentSync: { applied: boolean; error?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.agentSync.applied, false);
    assert.match(data.message, /同步失败/u);
});
