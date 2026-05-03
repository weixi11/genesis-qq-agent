import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
let tempCwd = '';

async function writeManifest() {
    const assetsDir = path.join(tempCwd, 'data', 'meme-assets');
    const manifestPath = path.join(tempCwd, 'data', 'meme_packs', 'luoluo', 'manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, 'hello.png'), 'hello');
    await writeFile(path.join(assetsDir, 'hug.png'), 'hug');

    await writeFile(manifestPath, JSON.stringify({
        version: '1.0.0',
        sourceDir: assetsDir,
        packs: [
            {
                id: 'greeting_daily',
                label: '问候日常',
                description: '早安晚安和普通招呼',
                aliases: ['早安', '晚安', '你好'],
                scenes: ['daily'],
                weight: 2,
                cooldownSec: 60,
                files: ['hello.png'],
            },
            {
                id: 'support_affection',
                label: '安慰鼓劲',
                description: '抱抱、谢谢、加油',
                aliases: ['抱抱', '加油'],
                scenes: ['comfort'],
                weight: 3,
                cooldownSec: 90,
                files: ['hug.png'],
            },
        ],
    }, null, 2), 'utf-8');
}

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-meme-catalog-'));
    process.chdir(tempCwd);
    await writeManifest();
});

after(() => {
    process.chdir(originalCwd);
});

test('meme catalog loads descriptions and can query by alias', async () => {
    const mod = await import(`../../src/services/meme_catalog.ts?test=${Date.now()}-${Math.random()}`);
    const packs = mod.memeCatalog.listPacks();
    assert.equal(packs.length, 2);
    assert.equal(packs[0]?.description, '早安晚安和普通招呼');

    const supportPack = mod.memeCatalog.findPackByQuery('给我加油');
    assert.equal(supportPack?.id, 'support_affection');
    assert.deepEqual(mod.memeCatalog.pickFiles(supportPack!, 1), [path.join(tempCwd, 'data', 'meme-assets', 'hug.png')]);
});
