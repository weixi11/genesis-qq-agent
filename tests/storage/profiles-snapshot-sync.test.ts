import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createDefaultProfile } from '../../src/types.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
let tempCwd = '';

let initProfilesDb: typeof import('../../src/storage/profiles-sqlite.ts').initProfilesDb;
let closeDb: typeof import('../../src/storage/profiles-sqlite.ts').closeDb;
let saveProfileToSqlite: typeof import('../../src/storage/profiles-sqlite.ts').saveProfileToSqlite;
let getAllProfilesFromSqlite: typeof import('../../src/storage/profiles-sqlite.ts').listAllProfilesFromSqlite;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-profiles-snapshot-sync-'));
    process.chdir(tempCwd);
    delete process.env.GENESIS_PROCESS_ROLE;

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    initProfilesDb = profilesModule.initProfilesDb;
    closeDb = profilesModule.closeDb;
    saveProfileToSqlite = profilesModule.saveProfileToSqlite;
    getAllProfilesFromSqlite = profilesModule.listAllProfilesFromSqlite;

    await initProfilesDb();
});

after(() => {
    closeDb();
    process.chdir(originalCwd);
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
});

test('web snapshot writes do not overwrite a profile saved by the agent process just before', async () => {
    saveProfileToSqlite(createDefaultProfile(101, 'agent-user'));

    process.env.GENESIS_PROCESS_ROLE = 'web';
    saveProfileToSqlite(createDefaultProfile(202, 'web-user'));
    delete process.env.GENESIS_PROCESS_ROLE;

    closeDb();
    await initProfilesDb();

    const profiles = getAllProfilesFromSqlite(10);
    assert.equal(profiles.some((profile) => profile.userId === 101), true);
    assert.equal(profiles.some((profile) => profile.userId === 202), true);
});
