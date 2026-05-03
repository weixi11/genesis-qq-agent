import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';

import { __processControlTestUtils } from '../../src/web/services/process_control.ts';

const originalCwd = process.cwd();
const originalRole = process.env.GENESIS_PROCESS_ROLE;

let tempCwd = '';
let assetsDir = '';
let closeGenesisDb: (() => void) | undefined;
let closeProfilesDb: (() => void) | undefined;
let resourcesRouter: express.Router | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
let baseUrl = '';

async function writeManifest(files: string[]) {
    const manifestPath = path.join(tempCwd, 'data', 'meme_packs', 'luoluo', 'manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
        version: '1.0.0',
        sourceDir: assetsDir,
        packs: [
            {
                id: 'existing_pack',
                label: '已有分组',
                description: '已有图片',
                aliases: ['已有'],
                scenes: ['daily'],
                weight: 1,
                cooldownSec: 30,
                files,
            },
        ],
    }, null, 2), 'utf-8');
}

async function writeTinyPng(filePath: string) {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
    await writeFile(filePath, Buffer.from(pngBase64, 'base64'));
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-web-memes-'));
    process.chdir(tempCwd);
    assetsDir = path.join(tempCwd, 'data', 'meme-assets');
    await mkdir(assetsDir, { recursive: true });

    const genesisDbModule = await import('../../src/storage/genesis-db.ts');
    await genesisDbModule.initGenesisDb();
    closeGenesisDb = genesisDbModule.closeGenesisDb;

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;

    resourcesRouter = (await import(`../../src/web/routes/resources.ts?test=${Date.now()}-${Math.random()}`)).resourcesRouter;

    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api', resourcesRouter);
    server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
        const activeServer = app.listen(0, () => resolve(activeServer));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to start meme resources test server');
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

    await rm(assetsDir, { recursive: true, force: true });
    await mkdir(assetsDir, { recursive: true });
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
});

test('meme resources can report and clean orphan files', async () => {
    await writeTinyPng(path.join(assetsDir, 'kept.png'));
    await writeTinyPng(path.join(assetsDir, 'orphan.png'));
    await writeManifest(['kept.png']);

    const beforeResponse = await fetch(`${baseUrl}/memes`);
    const beforeData = await beforeResponse.json() as { orphanFiles: string[] };
    assert.deepEqual(beforeData.orphanFiles, ['orphan.png']);

    const cleanupResponse = await fetch(`${baseUrl}/memes/cleanup-orphans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
    });
    const cleanupData = await cleanupResponse.json() as { success: boolean; deletedCount: number; deletedFiles: string[] };

    assert.equal(cleanupResponse.status, 200);
    assert.equal(cleanupData.success, true);
    assert.equal(cleanupData.deletedCount, 1);
    assert.deepEqual(cleanupData.deletedFiles, ['orphan.png']);

    const afterResponse = await fetch(`${baseUrl}/memes`);
    const afterData = await afterResponse.json() as { orphanFiles: string[] };
    assert.deepEqual(afterData.orphanFiles, []);
});

test('meme resources can import an archive into a new pack', async () => {
    const pngPath = path.join(tempCwd, 'tiny.png');
    const zipPath = path.join(tempCwd, 'bundle.zip');
    await writeTinyPng(pngPath);
    execFileSync('python3', [
        '-c',
        'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], arcname="inside/tiny.png"); z.close()',
        zipPath,
        pngPath,
    ]);

    await writeManifest([]);
    const archiveDataUrl = `data:application/zip;base64,${(await readFile(zipPath)).toString('base64')}`;

    const response = await fetch(`${baseUrl}/memes/import-archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            id: 'archive_pack',
            label: '压缩包导入',
            description: '整包导入测试',
            aliases: ['导入'],
            scenes: ['daily'],
            weight: 2,
            cooldownSec: 45,
            name: 'bundle.zip',
            dataUrl: archiveDataUrl,
        }),
    });
    const data = await response.json() as {
        success: boolean;
        importedCount: number;
        pack: { id: string; label: string; description: string; files: string[] };
    };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.importedCount, 1);
    assert.equal(data.pack.id, 'archive_pack');
    assert.equal(data.pack.description, '整包导入测试');
    assert.equal(data.pack.files.length, 1);
    assert.equal(data.pack.files[0]?.endsWith('.png'), true);
});

test('meme resources tolerate invalid manifest json', async () => {
    const manifestPath = path.join(tempCwd, 'data', 'meme_packs', 'luoluo', 'manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{broken-json', 'utf-8');

    const response = await fetch(`${baseUrl}/memes`);
    const data = await response.json() as { success: boolean; packs: unknown[]; orphanFiles: string[] };

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.deepEqual(data.packs, []);
    assert.deepEqual(data.orphanFiles, []);
});
