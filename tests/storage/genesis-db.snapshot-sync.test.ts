import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
let tempCwd = '';

let initGenesisDb: typeof import('../../src/storage/genesis-db.ts').initGenesisDb;
let closeGenesisDb: typeof import('../../src/storage/genesis-db.ts').closeGenesisDb;
let getGenesisDb: typeof import('../../src/storage/genesis-db.ts').getGenesisDb;
let markDirty: typeof import('../../src/storage/genesis-db.ts').markDirty;
let mutateGenesisDbSnapshot: typeof import('../../src/storage/genesis-db.ts').mutateGenesisDbSnapshot;
let readGenesisDbSnapshot: typeof import('../../src/storage/genesis-db.ts').readGenesisDbSnapshot;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-db-snapshot-sync-'));
    process.chdir(tempCwd);

    const dbModule = await import('../../src/storage/genesis-db.ts');
    initGenesisDb = dbModule.initGenesisDb;
    closeGenesisDb = dbModule.closeGenesisDb;
    getGenesisDb = dbModule.getGenesisDb;
    markDirty = dbModule.markDirty;
    mutateGenesisDbSnapshot = dbModule.mutateGenesisDbSnapshot;
    readGenesisDbSnapshot = dbModule.readGenesisDbSnapshot;

    await initGenesisDb();
});

after(() => {
    closeGenesisDb();
    process.chdir(originalCwd);
});

test('mutating genesis db snapshot does not drop unflushed in-memory writes', async () => {
    const db = getGenesisDb();
    db.run(
        'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
        ['group:1', '{"text":"first"}', 1],
    );
    markDirty();

    await mutateGenesisDbSnapshot((snapshot) => {
        snapshot.run(
            'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
            ['group:1', '{"text":"second"}', 2],
        );
    });

    const count = await readGenesisDbSnapshot((snapshot) => {
        const stmt = snapshot.prepare('SELECT COUNT(*) AS count FROM context_messages');
        stmt.step();
        const row = stmt.getAsObject() as { count: number };
        stmt.free();
        return Number(row.count);
    });

    assert.equal(count, 2);
});

test('readonly genesis db mode does not persist accidental in-memory writes on close', async () => {
    closeGenesisDb();
    await initGenesisDb({ mode: 'readonly' });

    const readonlyDb = getGenesisDb();
    readonlyDb.run(
        'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
        ['group:2', '{"text":"readonly"}', 3],
    );
    markDirty();

    closeGenesisDb();
    await initGenesisDb();

    const count = await readGenesisDbSnapshot((snapshot) => {
        const stmt = snapshot.prepare('SELECT COUNT(*) AS count FROM context_messages WHERE session_key = ?');
        stmt.bind(['group:2']);
        stmt.step();
        const row = stmt.getAsObject() as { count: number };
        stmt.free();
        return Number(row.count);
    });

    assert.equal(count, 0);
});
