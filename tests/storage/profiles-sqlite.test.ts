import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createDefaultProfile } from '../../src/types.ts';

const originalCwd = process.cwd();
let tempCwd = '';
let closeProfilesDb: (() => void) | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-profiles-db-'));
    process.chdir(tempCwd);

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;
});

after(() => {
    closeProfilesDb?.();
    process.chdir(originalCwd);
});

test('Profile SQLite persistence is deferred until an explicit flush', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const dbPath = path.join(tempCwd, 'data', 'profiles.db');

    profilesModule.saveProfileToSqlite(createDefaultProfile(10001, '落落'));
    assert.equal(existsSync(dbPath), false);

    profilesModule.flushProfilesDbToFile();
    assert.equal(existsSync(dbPath), true);
    assert.ok(statSync(dbPath).size > 0);
});

test('Legacy tags are converted to evidence and manual edits replace visible tags', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const profile = createDefaultProfile(10002, '画像测试');
    profile.traits = ['细腻', '爱吐槽'];
    profile.interests = ['音乐', '动漫'];

    profilesModule.saveProfileToSqlite(profile);

    const legacyLoaded = profilesModule.getProfileFromSqlite(10002);
    assert.ok(legacyLoaded);
    assert.deepEqual(legacyLoaded.traits, ['细腻', '爱吐槽']);
    assert.deepEqual(
        legacyLoaded.traitEvidence.map(item => item.value),
        ['细腻', '爱吐槽'],
    );
    assert.ok(legacyLoaded.traitEvidence.every(item => item.source === 'legacy'));

    const updated = profilesModule.updateProfileInSqlite(10002, {
        traits: ['靠谱'],
        interests: ['编程'],
    });

    assert.ok(updated);
    assert.deepEqual(updated.traits, ['靠谱']);
    assert.deepEqual(updated.interests, ['编程']);
    assert.deepEqual(
        updated.traitEvidence.map(item => item.value),
        ['靠谱'],
    );
    assert.deepEqual(
        updated.interestEvidence.map(item => item.value),
        ['编程'],
    );
    assert.equal(updated.traitEvidence[0]?.source, 'manual');
    assert.equal(updated.interestEvidence[0]?.source, 'manual');
});

test('Favorability decays toward the baseline when a profile is loaded', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
    const profile = createDefaultProfile(10003, '时间旅人');
    profile.favorability = 80;
    profile.favorabilityUpdatedAt = tenDaysAgo;
    profile.lastSeen = tenDaysAgo;

    profilesModule.saveProfileToSqlite(profile);

    const loaded = profilesModule.getProfileFromSqlite(10003);
    assert.ok(loaded);
    assert.ok(loaded.favorability < 80);
    assert.ok(loaded.favorability > 76);
    assert.ok(loaded.favorabilityUpdatedAt >= tenDaysAgo);
});

test('Long-term dossier sections persist and important memories merge by summary', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const now = Date.now();
    const profile = createDefaultProfile(10004, '长期画像');
    profile.identityFacts = ['群管理'];
    profile.likes = ['老歌'];
    profile.redLines = ['被敷衍'];
    profile.importantMemories = [
        {
            summary: '曾让机器人代发博客并接受自主发挥',
            importance: 4,
            sentiment: 'positive',
            happenedAt: now - 5000,
            lastSeen: now - 5000,
            count: 1,
            source: 'llm',
        },
        {
            summary: '曾让机器人代发博客并接受自主发挥',
            importance: 5,
            sentiment: 'positive',
            happenedAt: now - 1000,
            lastSeen: now - 1000,
            count: 1,
            source: 'llm',
        },
    ];

    profilesModule.saveProfileToSqlite(profile);

    const loaded = profilesModule.getProfileFromSqlite(10004);
    assert.ok(loaded);
    assert.deepEqual(loaded.identityFacts, ['群管理']);
    assert.deepEqual(loaded.likes, ['老歌']);
    assert.deepEqual(loaded.redLines, ['被敷衍']);
    assert.equal(loaded.identityEvidence[0]?.source, 'legacy');
    assert.equal(loaded.importantMemories.length, 1);
    assert.equal(loaded.importantMemories[0]?.count, 2);
    assert.equal(loaded.importantMemories[0]?.importance, 5);
});

test('Low-value old auto memories decay out while manual memories are preserved', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const sixtyDaysAgo = Date.now() - (60 * 24 * 60 * 60 * 1000);
    const profile = createDefaultProfile(10005, '记忆筛选');
    profile.importantMemories = [
        {
            summary: '一次普通问候',
            importance: 1,
            sentiment: 'neutral',
            happenedAt: sixtyDaysAgo,
            lastSeen: sixtyDaysAgo,
            count: 1,
            source: 'llm',
        },
        {
            summary: '手工保留的重要约定',
            importance: 2,
            sentiment: 'positive',
            happenedAt: sixtyDaysAgo,
            lastSeen: sixtyDaysAgo,
            count: 1,
            source: 'manual',
        },
    ];

    profilesModule.saveProfileToSqlite(profile);

    const loaded = profilesModule.getProfileFromSqlite(10005);
    assert.ok(loaded);
    assert.deepEqual(
        loaded.importantMemories.map(item => item.summary),
        ['手工保留的重要约定'],
    );
});

test('Favorability changes record profiler and manual event history', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const profile = createDefaultProfile(10006, '好感记录');
    profilesModule.saveProfileToSqlite(profile);

    profilesModule.adjustFavorabilityInSqlite(10006, 0.4, 2, 0.2);
    const afterProfiler = profilesModule.getProfileFromSqlite(10006);
    assert.ok(afterProfiler);
    assert.equal(afterProfiler.favorabilityEvents.length, 1);
    assert.equal(afterProfiler.favorabilityEvents[0]?.source, 'profiler');
    assert.equal(afterProfiler.favorabilityEvents[0]?.reason, 'analysis');
    assert.equal(afterProfiler.favorabilityEvents[0]?.before, 35);
    assert.equal(afterProfiler.favorabilityEvents[0]?.after, 42);

    const afterManual = profilesModule.updateProfileInSqlite(10006, {
        favorability: 62.5,
    });
    assert.ok(afterManual);
    assert.equal(afterManual.favorabilityEvents.length, 2);
    assert.equal(afterManual.favorabilityEvents[0]?.source, 'manual');
    assert.equal(afterManual.favorabilityEvents[0]?.reason, 'manual_edit');
    assert.equal(afterManual.favorabilityEvents[0]?.after, 62.5);
});

test('Web-role profile writes go directly through disk snapshots', async () => {
    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    const previousRole = process.env.GENESIS_PROCESS_ROLE;
    process.env.GENESIS_PROCESS_ROLE = 'web';

    try {
        const dbPath = path.join(tempCwd, 'data', 'profiles.db');
        const profile = createDefaultProfile(10007, '网页画像');
        profilesModule.saveProfileToSqlite(profile);
        assert.equal(existsSync(dbPath), true);

        const updated = profilesModule.updateProfileInSqlite(10007, {
            notes: '来自 web 的人工修改',
            likes: ['手动维护'],
        });

        assert.ok(updated);
        assert.equal(updated.notes, '来自 web 的人工修改');
        assert.deepEqual(updated.likes, ['手动维护']);

        const loaded = profilesModule.getProfileFromSqlite(10007);
        assert.ok(loaded);
        assert.equal(loaded.notes, '来自 web 的人工修改');
        assert.deepEqual(loaded.likes, ['手动维护']);
    } finally {
        if (previousRole === undefined) {
            delete process.env.GENESIS_PROCESS_ROLE;
        } else {
            process.env.GENESIS_PROCESS_ROLE = previousRole;
        }
    }
});
