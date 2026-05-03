import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';

import { __processControlTestUtils } from '../../src/web/services/process_control.ts';
import { createDefaultProfile } from '../../src/types.ts';
import type { FormattedMessage } from '../../src/types.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
let tempCwd = '';
let closeProfilesDb: (() => void) | undefined;
let closeGenesisDb: (() => void) | undefined;
let saveGenesisDbNow: (() => void) | undefined;
let mutateGenesisDbSnapshot:
    | (<T>(mutator: (database: import('sql.js').Database) => T | Promise<T>) => Promise<T>)
    | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let baseUrl = '';

let saveProfileToSqlite: ((profile: ReturnType<typeof createDefaultProfile>) => void) | undefined;
let getProfileFromSqlite: ((userId: number) => ReturnType<typeof createDefaultProfile> | undefined) | undefined;
let updateProfile: ((userId: number, updates: Partial<ReturnType<typeof createDefaultProfile>>) => ReturnType<typeof createDefaultProfile> | undefined) | undefined;
let resourcesRouter: express.Router | undefined;
let memoryModule: typeof import('../../src/memory.ts') | undefined;
let profilerModule: typeof import('../../src/agents/profiler.ts') | undefined;
let reanalyzeStoreModule: typeof import('../../src/profiler/reanalyze_request_store.ts') | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-web-resources-'));
    process.chdir(tempCwd);

    const genesisDbModule = await import('../../src/storage/genesis-db.ts');
    await genesisDbModule.initGenesisDb();
    closeGenesisDb = genesisDbModule.closeGenesisDb;
    saveGenesisDbNow = genesisDbModule.saveGenesisDbNow;
    mutateGenesisDbSnapshot = genesisDbModule.mutateGenesisDbSnapshot;

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;
    saveProfileToSqlite = profilesModule.saveProfileToSqlite;
    getProfileFromSqlite = profilesModule.getProfileFromSqlite;

    const storeModule = await import('../../src/profiler/store.ts');
    updateProfile = storeModule.updateProfile;

    memoryModule = await import('../../src/memory.ts');
    profilerModule = await import('../../src/agents/profiler.ts');
    reanalyzeStoreModule = await import('../../src/profiler/reanalyze_request_store.ts');
    resourcesRouter = (await import('../../src/web/routes/resources.ts')).resourcesRouter;

    const app = express();
    app.use(express.json());
    app.use('/api', resourcesRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
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

    closeProfilesDb?.();
    closeGenesisDb?.();
    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
    process.chdir(originalCwd);
});

beforeEach(() => {
    assert.ok(memoryModule);
    assert.ok(profilerModule);
    __processControlTestUtils.resetDriverForTests();
    process.env.GENESIS_PROCESS_ROLE = 'agent';

    const memoryLike = memoryModule.memory as unknown as {
        getAllSessions: () => Array<{ key: string; count: number }>;
        getSessionByKey: (key: string) => FormattedMessage[] | undefined;
        clearAll: () => void;
    };
    memoryLike.clearAll();
    saveGenesisDbNow?.();
    memoryLike.getAllSessions = () => [];
    memoryLike.getSessionByKey = () => undefined;

    const profilerLike = profilerModule.profiler as unknown as {
        reanalyzeMessages: (messages: unknown[]) => Promise<void>;
    };
    profilerLike.reanalyzeMessages = async () => undefined;
});

test('reset-evidence keeps only manual tags and clears summary state', async () => {
    assert.ok(saveProfileToSqlite);
    assert.ok(getProfileFromSqlite);

    const now = Date.now();
    const profile = createDefaultProfile(30001, '画像路由');
    profile.traits = ['毒舌', '靠谱'];
    profile.traitEvidence = [
        { value: '毒舌', score: 2, lastSeen: now, count: 2, source: 'llm' },
        { value: '靠谱', score: 1, lastSeen: now, count: 1, source: 'manual' },
    ];
    profile.interests = ['动漫', '摄影'];
    profile.interestEvidence = [
        { value: '动漫', score: 1.5, lastSeen: now, count: 2, source: 'legacy' },
        { value: '摄影', score: 1, lastSeen: now, count: 1, source: 'manual' },
    ];
    profile.likes = ['老歌', '长文解释'];
    profile.likeEvidence = [
        { value: '老歌', score: 1.2, lastSeen: now, count: 2, source: 'llm' },
        { value: '长文解释', score: 1, lastSeen: now, count: 1, source: 'manual' },
    ];
    profile.redLines = ['被敷衍'];
    profile.redLineEvidence = [
        { value: '被敷衍', score: 1, lastSeen: now, count: 1, source: 'manual' },
    ];
    profile.importantMemories = [
        {
            summary: '曾让机器人代发博客',
            importance: 4,
            sentiment: 'positive',
            happenedAt: now - 1000,
            lastSeen: now - 1000,
            count: 1,
            source: 'llm',
        },
        {
            summary: '手工确认对老歌有偏好',
            importance: 4,
            sentiment: 'positive',
            happenedAt: now - 900,
            lastSeen: now - 900,
            count: 1,
            source: 'manual',
        },
    ];
    profile.conflictRecords = [
        {
            summary: '工具失败时表达过不满',
            importance: 3,
            sentiment: 'negative',
            happenedAt: now - 2000,
            lastSeen: now - 2000,
            count: 1,
            source: 'llm',
            status: 'lingering',
        },
        {
            summary: '手工记录过一次误会已缓和',
            importance: 3,
            sentiment: 'neutral',
            happenedAt: now - 1500,
            lastSeen: now - 1500,
            count: 1,
            source: 'manual',
            status: 'resolved',
        },
    ];
    profile.notes = '旧画像摘要';
    profile.lastAnalyzed = now;
    saveProfileToSqlite(profile);

    const response = await fetch(`${baseUrl}/profiles/30001/reset-evidence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const data = await response.json() as { success: boolean; profile: ReturnType<typeof createDefaultProfile> };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(data.profile.traits, ['靠谱']);
    assert.deepEqual(data.profile.interests, ['摄影']);
    assert.deepEqual(data.profile.likes, ['长文解释']);
    assert.deepEqual(data.profile.redLines, ['被敷衍']);
    assert.deepEqual(
        data.profile.importantMemories.map(item => item.summary),
        ['手工确认对老歌有偏好'],
    );
    assert.deepEqual(
        data.profile.conflictRecords.map(item => item.summary),
        ['手工记录过一次误会已缓和'],
    );
    assert.equal(data.profile.notes, '');
    assert.equal(data.profile.lastAnalyzed, 0);
    assert.ok(data.profile.traitEvidence.every(item => item.source === 'manual'));
    assert.ok(data.profile.interestEvidence.every(item => item.source === 'manual'));
    assert.ok(data.profile.likeEvidence.every(item => item.source === 'manual'));
    assert.ok(data.profile.redLineEvidence.every(item => item.source === 'manual'));
    assert.ok(data.profile.importantMemories.every(item => item.source === 'manual'));
    assert.ok(data.profile.conflictRecords.every(item => item.source === 'manual'));

    const persisted = getProfileFromSqlite(30001);
    assert.ok(persisted);
    assert.deepEqual(persisted.traits, ['靠谱']);
    assert.deepEqual(persisted.interests, ['摄影']);
    assert.deepEqual(persisted.likes, ['长文解释']);
    assert.deepEqual(persisted.redLines, ['被敷衍']);
    assert.deepEqual(
        persisted.importantMemories.map(item => item.summary),
        ['手工确认对老歌有偏好'],
    );
    assert.deepEqual(
        persisted.conflictRecords.map(item => item.summary),
        ['手工记录过一次误会已缓和'],
    );
});

test('recalculate builds analysis input from recent memory sessions', async () => {
    assert.ok(saveProfileToSqlite);
    assert.ok(updateProfile);
    assert.ok(memoryModule);
    assert.ok(profilerModule);

    saveProfileToSqlite(createDefaultProfile(30002, '重算用户'));

    const sessionMessages: FormattedMessage[] = [
        {
            message_id: 1,
            time: 100,
            time_str: '00:01',
            type: 'group',
            summary: '',
            sender_id: 9527,
            sender_name: '朋友',
            text: '你最近在忙什么？',
            group_id: 10086,
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
        },
        {
            message_id: 2,
            time: 101,
            time_str: '00:02',
            type: 'group',
            summary: '',
            sender_id: 30002,
            sender_name: '重算用户',
            text: '最近在学 TypeScript 和画画',
            group_id: 10086,
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
        },
        {
            message_id: 3,
            time: 102,
            time_str: '00:03',
            type: 'group',
            summary: '',
            sender_id: 30002,
            sender_name: '重算用户',
            text: '最近还挺喜欢整理博客笔记',
            group_id: 10086,
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
        },
    ];

    const memoryLike = memoryModule.memory as unknown as {
        getAllSessions: () => Array<{ key: string; count: number }>;
        getSessionByKey: (key: string) => FormattedMessage[] | undefined;
    };
    memoryLike.getAllSessions = () => [{ key: 'group:10086', count: sessionMessages.length }];
    memoryLike.getSessionByKey = () => sessionMessages;

    let capturedMessages: Array<{ text: string; context?: Array<{ sender: string; text: string }> }> = [];
    const profilerLike = profilerModule.profiler as unknown as {
        reanalyzeMessages: (messages: Array<{ text: string; context?: Array<{ sender: string; text: string }> }>) => Promise<void>;
    };
    profilerLike.reanalyzeMessages = async (messages) => {
        capturedMessages = messages;
        updateProfile?.(30002, {
            notes: '已根据近期记忆重算',
            traits: ['认真'],
            interests: ['TypeScript'],
        });
    };

    const response = await fetch(`${baseUrl}/profiles/30002/recalculate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const data = await response.json() as {
        success: boolean;
        analyzedCount: number;
        profile: ReturnType<typeof createDefaultProfile>;
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.analyzedCount, 2);
    assert.equal(capturedMessages.length, 2);
    assert.equal(capturedMessages[0]?.text, '最近在学 TypeScript 和画画');
    assert.deepEqual(capturedMessages[0]?.context, [{ sender: '朋友', text: '你最近在忙什么？' }]);
    assert.equal(data.profile.notes, '已根据近期记忆重算');
    assert.deepEqual(data.profile.traits, ['认真']);
    assert.deepEqual(data.profile.interests, ['TypeScript']);
});

test('web recalculate queues request for agent instead of running local profiler', async () => {
    assert.ok(saveProfileToSqlite);
    assert.ok(updateProfile);
    assert.ok(memoryModule);
    assert.ok(profilerModule);
    assert.ok(reanalyzeStoreModule);

    process.env.GENESIS_PROCESS_ROLE = 'web';
    saveProfileToSqlite(createDefaultProfile(30003, '排队重算用户'));

    const sessionMessages: FormattedMessage[] = [
        {
            message_id: 11,
            time: 200,
            time_str: '00:01',
            type: 'group',
            summary: '',
            sender_id: 9527,
            sender_name: '朋友',
            text: '你最近又在折腾什么？',
            group_id: 10010,
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
        },
        {
            message_id: 12,
            time: 201,
            time_str: '00:02',
            type: 'group',
            summary: '',
            sender_id: 30003,
            sender_name: '排队重算用户',
            text: '最近在补移动端适配和日志体验',
            group_id: 10010,
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
        },
    ];

    const memoryLike = memoryModule.memory as unknown as {
        push: (message: FormattedMessage) => void;
    };
    for (const message of sessionMessages) {
        memoryLike.push(message);
    }
    saveGenesisDbNow?.();

    let localProfilerCalled = false;
    const profilerLike = profilerModule.profiler as unknown as {
        reanalyzeMessages: (messages: unknown[]) => Promise<void>;
    };
    profilerLike.reanalyzeMessages = async () => {
        localProfilerCalled = true;
    };

    const responsePromise = fetch(`${baseUrl}/profiles/30003/recalculate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const pending = await reanalyzeStoreModule.claimPendingProfilerReanalyzeRequest();
    assert.ok(pending);
    assert.equal(pending.userId, 30003);
    assert.equal(pending.messages.length, 1);
    assert.equal(pending.messages[0]?.text, '最近在补移动端适配和日志体验');
    assert.deepEqual(pending.messages[0]?.context, [{ sender: '朋友', text: '你最近又在折腾什么？' }]);

    updateProfile(30003, {
        notes: '已由 agent 队列重算',
        traits: ['执行力强'],
        interests: ['移动端适配'],
    });
    await reanalyzeStoreModule.completeProfilerReanalyzeRequest(pending.requestId, {
        status: 'success',
        analyzedCount: pending.messages.length,
    });

    const response = await responsePromise;
    const data = await response.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        analyzedCount: number;
        profile: ReturnType<typeof createDefaultProfile>;
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.queued, true);
    assert.equal(data.completed, true);
    assert.equal(data.analyzedCount, 1);
    assert.equal(data.profile.notes, '已由 agent 队列重算');
    assert.deepEqual(data.profile.traits, ['执行力强']);
    assert.deepEqual(data.profile.interests, ['移动端适配']);
    assert.equal(localProfilerCalled, false);
});

test('web recalculate status endpoint exposes pending and completed queued requests', async () => {
    assert.ok(saveProfileToSqlite);
    assert.ok(updateProfile);
    assert.ok(reanalyzeStoreModule);

    process.env.GENESIS_PROCESS_ROLE = 'web';
    saveProfileToSqlite(createDefaultProfile(30004, '状态轮询用户'));

    const queued = await reanalyzeStoreModule.enqueueProfilerReanalyzeRequest(30004, [
        {
            userId: 30004,
            nickname: '状态轮询用户',
            groupId: 10010,
            text: '我在继续补 web-only 队列状态同步',
            timestamp: Date.now(),
            context: [{ sender: '朋友', text: '你这两天在忙什么？' }],
        },
    ]);

    const pending = await reanalyzeStoreModule.claimPendingProfilerReanalyzeRequest();
    assert.ok(pending);
    assert.equal(pending.requestId, queued.requestId);

    const pendingResponse = await fetch(`${baseUrl}/profiles/30004/recalculate/${encodeURIComponent(pending.requestId)}`);
    const pendingData = await pendingResponse.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        requestId: string;
        message: string;
    };

    assert.equal(pendingResponse.status, 200);
    assert.equal(pendingData.success, true);
    assert.equal(pendingData.queued, true);
    assert.equal(pendingData.completed, false);
    assert.equal(pendingData.requestId, pending.requestId);
    assert.match(pendingData.message, /等待执行|正在执行/u);

    updateProfile(30004, {
        notes: '状态查询已完成',
        traits: ['细致'],
        interests: ['状态同步'],
    });
    await reanalyzeStoreModule.completeProfilerReanalyzeRequest(pending.requestId, {
        status: 'success',
        analyzedCount: pending.messages.length,
    });

    const completedResponse = await fetch(`${baseUrl}/profiles/30004/recalculate/${encodeURIComponent(pending.requestId)}`);
    const completedData = await completedResponse.json() as {
        success: boolean;
        queued: boolean;
        completed: boolean;
        requestId: string;
        analyzedCount: number;
        profile: ReturnType<typeof createDefaultProfile>;
    };

    assert.equal(completedResponse.status, 200);
    assert.equal(completedData.success, true);
    assert.equal(completedData.queued, true);
    assert.equal(completedData.completed, true);
    assert.equal(completedData.requestId, pending.requestId);
    assert.equal(completedData.analyzedCount, 1);
    assert.equal(completedData.profile.notes, '状态查询已完成');
    assert.deepEqual(completedData.profile.traits, ['细致']);
    assert.deepEqual(completedData.profile.interests, ['状态同步']);
});

test('reanalyze queue store skips invalid persisted messages', async () => {
    assert.ok(reanalyzeStoreModule);
    assert.ok(mutateGenesisDbSnapshot);

    await mutateGenesisDbSnapshot(async (db) => {
        db.run('DELETE FROM profiler_reanalyze_requests');
        db.run(
            `INSERT INTO profiler_reanalyze_requests (
                request_id, user_id, messages_json, status, requested_at, started_at, finished_at, analyzed_count, error_message
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
            [
                'prof_req_bad_json',
                30099,
                JSON.stringify([
                    { text: 'missing required fields' },
                    { userId: 30099, nickname: '有效消息', text: '保留这条', timestamp: Date.now() },
                ]),
                'pending',
                Date.now(),
            ],
        );
    });

    const pending = await reanalyzeStoreModule.claimPendingProfilerReanalyzeRequest();
    assert.ok(pending);
    assert.equal(pending.requestId, 'prof_req_bad_json');
    assert.deepEqual(pending.messages.map((item) => item.text), ['保留这条']);
});

test('web profile mutation returns sync warning message when genesis-agent restart fails', async () => {
    assert.ok(saveProfileToSqlite);

    process.env.GENESIS_PROCESS_ROLE = 'web';
    saveProfileToSqlite(createDefaultProfile(30005, '同步告警用户'));

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

    const response = await fetch(`${baseUrl}/profiles/30005`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes: '需要告警' }),
    });
    const data = await response.json() as {
        success: boolean;
        message: string;
        profile: ReturnType<typeof createDefaultProfile>;
        agentSync: { applied: boolean; error?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.profile.notes, '需要告警');
    assert.equal(data.agentSync.applied, false);
    assert.match(data.message, /同步失败/u);
});

test('delete all profiles removes every stored dossier entry', async () => {
    assert.ok(saveProfileToSqlite);
    assert.ok(getProfileFromSqlite);

    saveProfileToSqlite(createDefaultProfile(31001, '批量删除甲'));
    saveProfileToSqlite(createDefaultProfile(31002, '批量删除乙'));

    const beforeResponse = await fetch(`${baseUrl}/profiles`);
    const beforeProfiles = await beforeResponse.json() as Array<ReturnType<typeof createDefaultProfile>>;

    const response = await fetch(`${baseUrl}/profiles`, {
        method: 'DELETE',
    });
    const data = await response.json() as { success: boolean; deletedCount: number };

    const afterResponse = await fetch(`${baseUrl}/profiles`);
    const afterProfiles = await afterResponse.json() as Array<ReturnType<typeof createDefaultProfile>>;

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.deletedCount, beforeProfiles.length);
    assert.deepEqual(afterProfiles, []);
    assert.equal(getProfileFromSqlite(31001), undefined);
    assert.equal(getProfileFromSqlite(31002), undefined);
});
