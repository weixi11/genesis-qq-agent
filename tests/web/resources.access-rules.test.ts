import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';

import { __processControlTestUtils } from '../../src/web/services/process_control.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;
const originalAdapterEnvPath = process.env.GENESIS_ADAPTER_ENV_PATH;
const originalAdapterMetaPath = process.env.GENESIS_ADAPTER_FILTER_META_PATH;

let tempCwd = '';
let adapterEnvPath = '';
let adapterMetaPath = '';
let closeGenesisDb: (() => void) | undefined;
let closeProfilesDb: (() => void) | undefined;
let resourcesRouter: express.Router | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let baseUrl = '';

type AdapterEnvValues = Partial<Record<
    'WHITELIST_GROUPS' | 'WHITELIST_USERS' | 'BLACKLIST_GROUPS' | 'BLACKLIST_USERS',
    string
>>;

type AdapterFilterMetaRecord = {
    type: 'user' | 'group';
    listType: 'black' | 'white';
    targetId: number;
    reason: string;
    createdAt: string;
};

async function writeAdapterEnv(values: AdapterEnvValues = {}): Promise<void> {
    await mkdir(path.dirname(adapterEnvPath), { recursive: true });
    const lines = [
        `WHITELIST_GROUPS=${values.WHITELIST_GROUPS ?? ''}`,
        `WHITELIST_USERS=${values.WHITELIST_USERS ?? ''}`,
        `BLACKLIST_GROUPS=${values.BLACKLIST_GROUPS ?? ''}`,
        `BLACKLIST_USERS=${values.BLACKLIST_USERS ?? ''}`,
    ];
    await writeFile(adapterEnvPath, `${lines.join('\n')}\n`, 'utf-8');
}

async function readAdapterEnv(): Promise<Record<string, string>> {
    const content = await readFile(adapterEnvPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        if (!rawLine.trim() || rawLine.trim().startsWith('#')) {
            continue;
        }
        const equalsIndex = rawLine.indexOf('=');
        if (equalsIndex === -1) {
            continue;
        }
        const key = rawLine.slice(0, equalsIndex).trim();
        const value = rawLine.slice(equalsIndex + 1).trim();
        result[key] = value;
    }
    return result;
}

async function writeAdapterMeta(records: AdapterFilterMetaRecord[] = []): Promise<void> {
    await mkdir(path.dirname(adapterMetaPath), { recursive: true });
    await writeFile(adapterMetaPath, JSON.stringify(records, null, 2), 'utf-8');
}

async function readAdapterMeta(): Promise<AdapterFilterMetaRecord[]> {
    const content = await readFile(adapterMetaPath, 'utf-8');
    return JSON.parse(content) as AdapterFilterMetaRecord[];
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-web-access-rules-'));
    process.chdir(tempCwd);

    adapterEnvPath = path.join(tempCwd, 'adapter', '.env');
    adapterMetaPath = path.join(tempCwd, 'adapter', 'cache', 'access-rules.json');
    process.env.GENESIS_ADAPTER_ENV_PATH = adapterEnvPath;
    process.env.GENESIS_ADAPTER_FILTER_META_PATH = adapterMetaPath;

    const genesisDbModule = await import('../../src/storage/genesis-db.ts');
    await genesisDbModule.initGenesisDb();
    closeGenesisDb = genesisDbModule.closeGenesisDb;

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;

    resourcesRouter = (await import('../../src/web/routes/resources.ts')).resourcesRouter;

    const app = express();
    app.use(express.json());
    app.use('/api', resourcesRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start access rules test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api`;
});

beforeEach(async () => {
    process.env.GENESIS_PROCESS_ROLE = 'web';
    __processControlTestUtils.setDriverForTests({
        restartPm2Process: async () => ({ restarted: true }),
        describePm2Process: async (name) => ({
            name,
            status: 'online',
            pid: 12345,
            uptimeText: '1m',
            restarts: 0,
        }),
        sleep: async () => undefined,
    });
    await writeAdapterEnv();
    await writeAdapterMeta([]);
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

    closeProfilesDb?.();
    closeGenesisDb?.();
    process.chdir(originalCwd);

    if (originalRole === undefined) {
        delete process.env.GENESIS_PROCESS_ROLE;
    } else {
        process.env.GENESIS_PROCESS_ROLE = originalRole;
    }
    if (originalAdapterEnvPath === undefined) {
        delete process.env.GENESIS_ADAPTER_ENV_PATH;
    } else {
        process.env.GENESIS_ADAPTER_ENV_PATH = originalAdapterEnvPath;
    }
    if (originalAdapterMetaPath === undefined) {
        delete process.env.GENESIS_ADAPTER_FILTER_META_PATH;
    } else {
        process.env.GENESIS_ADAPTER_FILTER_META_PATH = originalAdapterMetaPath;
    }
});

test('access rule list reads adapter env values and prunes stale meta records', async () => {
    await writeAdapterEnv({
        WHITELIST_GROUPS: '10001,10002',
        WHITELIST_USERS: '40001',
        BLACKLIST_GROUPS: '20001',
        BLACKLIST_USERS: '30001',
    });
    await writeAdapterMeta([
        {
            listType: 'black',
            type: 'group',
            targetId: 20001,
            reason: '拉黑测试群',
            createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
            listType: 'white',
            type: 'group',
            targetId: 10002,
            reason: '白名单测试群',
            createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
            listType: 'white',
            type: 'user',
            targetId: 40001,
            reason: '白名单私聊用户',
            createdAt: '2026-01-03T00:00:00.000Z',
        },
        {
            listType: 'black',
            type: 'user',
            targetId: 99999,
            reason: '应被清理的脏数据',
            createdAt: '2026-01-04T00:00:00.000Z',
        },
    ]);

    const response = await fetch(`${baseUrl}/blacklist`);
    const data = await response.json() as {
        blacklist: Array<{ id: number; ruleId: string; type: 'user' | 'group'; targetId: number; reason: string }>;
        whitelist: Array<{ id: number; ruleId: string; type: 'user' | 'group'; targetId: number; reason: string }>;
    };

    assert.equal(response.status, 200);
    assert.deepEqual(data.blacklist, [
        { id: 1, ruleId: 'black:group:20001', type: 'group', targetId: 20001, reason: '拉黑测试群' },
        { id: 2, ruleId: 'black:user:30001', type: 'user', targetId: 30001, reason: '直接丢弃该私聊用户消息' },
    ]);
    assert.deepEqual(data.whitelist, [
        { id: 1, ruleId: 'white:group:10001', type: 'group', targetId: 10001, reason: '仅允许该群聊消息进入 genesis' },
        { id: 2, ruleId: 'white:group:10002', type: 'group', targetId: 10002, reason: '白名单测试群' },
        { id: 3, ruleId: 'white:user:40001', type: 'user', targetId: 40001, reason: '白名单私聊用户' },
    ]);

    const meta = await readAdapterMeta();
    assert.equal(meta.some((item) => item.targetId === 99999), false);
});

test('adding access rule persists adapter env and meta files', async () => {
    const response = await fetch(`${baseUrl}/blacklist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'group',
            targetId: '123456',
            reason: '手机端白名单测试群',
            listType: 'white',
        }),
    });
    const data = await response.json() as {
        success: boolean;
        message: string;
        adapterSync: { applied: boolean };
        entry: { id: number; ruleId: string; type: 'user' | 'group'; targetId: number; reason: string };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.adapterSync.applied, true);
    assert.equal(data.entry.id, 1);
    assert.deepEqual(data.entry, {
        id: 1,
        ruleId: 'white:group:123456',
        type: 'group',
        targetId: 123456,
        reason: '手机端白名单测试群',
    });

    const env = await readAdapterEnv();
    assert.equal(env.WHITELIST_GROUPS, '123456');

    const meta = await readAdapterMeta();
    assert.equal(meta.length, 1);
    assert.equal(meta[0]?.listType, 'white');
    assert.equal(meta[0]?.type, 'group');
    assert.equal(meta[0]?.targetId, 123456);
    assert.equal(meta[0]?.reason, '手机端白名单测试群');
});

test('adding access rule rolls back env changes when meta write fails', async () => {
    const brokenMetaDir = path.join(tempCwd, 'adapter', 'broken-meta');
    await mkdir(brokenMetaDir, { recursive: true });
    process.env.GENESIS_ADAPTER_FILTER_META_PATH = brokenMetaDir;

    const response = await fetch(`${baseUrl}/blacklist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'group',
            targetId: '445566',
            reason: 'should rollback',
            listType: 'white',
        }),
    });
    const data = await response.json() as { success: boolean; error: string };

    assert.equal(response.status, 500);
    assert.equal(data.success, false);
    assert.match(data.error, /保存规则备注失败/u);

    const env = await readAdapterEnv();
    assert.equal(env.WHITELIST_GROUPS, '');

    process.env.GENESIS_ADAPTER_FILTER_META_PATH = adapterMetaPath;
});

test('adding duplicate rule can create missing meta reason record', async () => {
    await writeAdapterEnv({
        BLACKLIST_GROUPS: '112233',
        BLACKLIST_USERS: '778899',
    });

    const response = await fetch(`${baseUrl}/blacklist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'user',
            targetId: '778899',
            reason: '后补备注',
            listType: 'black',
        }),
    });
    const data = await response.json() as {
        success: boolean;
        duplicate: boolean;
        message: string;
        entry: { id: number; ruleId: string; type: 'user' | 'group'; targetId: number; reason: string };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.duplicate, true);
    assert.equal(data.message, '规则已存在，备注已更新');
    assert.deepEqual(data.entry, {
        id: 2,
        ruleId: 'black:user:778899',
        type: 'user',
        targetId: 778899,
        reason: '后补备注',
    });

    const env = await readAdapterEnv();
    assert.equal(env.BLACKLIST_USERS, '778899');

    const meta = await readAdapterMeta();
    assert.equal(meta.length, 1);
    assert.equal(meta[0]?.listType, 'black');
    assert.equal(meta[0]?.type, 'user');
    assert.equal(meta[0]?.targetId, 778899);
    assert.equal(meta[0]?.reason, '后补备注');
});

test('adding conflict rule rejects opposite list duplicates', async () => {
    await writeAdapterEnv({
        WHITELIST_USERS: '556677',
    });

    const response = await fetch(`${baseUrl}/blacklist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'user',
            targetId: '556677',
            reason: '冲突规则',
            listType: 'black',
        }),
    });
    const data = await response.json() as {
        success: boolean;
        error: string;
    };

    assert.equal(response.status, 409);
    assert.equal(data.success, false);
    assert.match(data.error, /已存在于白名单/u);
});

test('deleting access rule removes adapter env value and meta record', async () => {
    await writeAdapterEnv({
        BLACKLIST_GROUPS: '112233',
        BLACKLIST_USERS: '445566',
    });
    await writeAdapterMeta([
        {
            listType: 'black',
            type: 'group',
            targetId: 112233,
            reason: '群黑名单',
            createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
            listType: 'black',
            type: 'user',
            targetId: 445566,
            reason: '用户黑名单',
            createdAt: '2026-01-02T00:00:00.000Z',
        },
    ]);

    const listResponse = await fetch(`${baseUrl}/blacklist`);
    const listData = await listResponse.json() as {
        blacklist: Array<{ id: number; ruleId: string; targetId: number }>;
    };
    const targetEntry = listData.blacklist.find((item) => item.targetId === 445566);
    assert.ok(targetEntry);

    const response = await fetch(`${baseUrl}/blacklist/${encodeURIComponent(targetEntry.ruleId)}?listType=black`, {
        method: 'DELETE',
    });
    const data = await response.json() as {
        success: boolean;
        adapterSync: { applied: boolean };
        entry: { targetId: number };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.adapterSync.applied, true);
    assert.equal(data.entry.targetId, 445566);

    const env = await readAdapterEnv();
    assert.equal(env.BLACKLIST_GROUPS, '112233');
    assert.equal(env.BLACKLIST_USERS, '');

    const meta = await readAdapterMeta();
    assert.deepEqual(meta, [
        {
            listType: 'black',
            type: 'group',
            targetId: 112233,
            reason: '群黑名单',
            createdAt: '2026-01-01T00:00:00.000Z',
        },
    ]);
});
