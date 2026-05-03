import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
const originalSessionCooldown = process.env.AUTO_MEME_PER_SESSION_COOLDOWN_MS;
const originalUserCooldown = process.env.AUTO_MEME_PER_USER_COOLDOWN_MS;
let tempCwd = '';

async function writeManifest() {
    const assetsDir = path.join(tempCwd, 'data', 'meme-assets');
    const manifestPath = path.join(tempCwd, 'data', 'meme_packs', 'luoluo', 'manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, 'a.png'), 'a');
    await writeFile(path.join(assetsDir, 'b.png'), 'b');
    await writeFile(path.join(assetsDir, 'night.png'), 'night');

    await writeFile(manifestPath, JSON.stringify({
        version: '1.0.0',
        sourceDir: assetsDir,
        packs: [
            {
                id: 'support_affection',
                label: '安慰鼓劲',
                description: '抱抱和加油',
                aliases: ['加油', '抱抱'],
                scenes: ['comfort'],
                weight: 4,
                cooldownSec: 0,
                files: ['a.png', 'b.png'],
            },
            {
                id: 'greeting_daily',
                label: '问候日常',
                description: '晚安和问候',
                aliases: ['晚安'],
                scenes: ['daily'],
                weight: 2,
                cooldownSec: 0,
                files: ['night.png'],
            },
        ],
    }, null, 2), 'utf-8');
}

before(async () => {
    process.env.AUTO_MEME_PER_SESSION_COOLDOWN_MS = '0';
    process.env.AUTO_MEME_PER_USER_COOLDOWN_MS = '0';
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-meme-decider-'));
    process.chdir(tempCwd);
    await writeManifest();
});

after(() => {
    process.chdir(originalCwd);
    if (originalSessionCooldown === undefined) {
        delete process.env.AUTO_MEME_PER_SESSION_COOLDOWN_MS;
    } else {
        process.env.AUTO_MEME_PER_SESSION_COOLDOWN_MS = originalSessionCooldown;
    }
    if (originalUserCooldown === undefined) {
        delete process.env.AUTO_MEME_PER_USER_COOLDOWN_MS;
    } else {
        process.env.AUTO_MEME_PER_USER_COOLDOWN_MS = originalUserCooldown;
    }
});

test('auto meme dedupes recent files within the same pack and session', async () => {
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    Math.random = () => 0;

    try {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        shouldSend: true,
                        scene: 'comfort',
                        reason: '安慰场景',
                    }),
                },
            }],
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;
        const mod = await import(`../../src/services/meme_decider.ts?test=${Date.now()}-${Math.random()}`);
        const message = {
            type: 'group',
            group_id: 10001,
            sender_id: 20001,
            text: '今天好累啊',
        } as any;

        const first = await mod.decideAutoMeme({ message, replyText: '抱抱你，加油' });
        const second = await mod.decideAutoMeme({ message, replyText: '没事的，加油' });

        assert.equal(first.shouldSend, true);
        assert.equal(second.shouldSend, true);
        assert.notEqual(first.files[0], second.files[0]);
        assert.equal(first.packId, 'support_affection');
        assert.equal(second.packId, 'support_affection');
    } finally {
        globalThis.fetch = originalFetch;
        Math.random = originalRandom;
    }
});

test('auto meme can infer daily greeting scene from casual wording', async () => {
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    Math.random = () => 0;

    try {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        shouldSend: true,
                        scene: 'daily',
                        reason: '日常问候场景',
                    }),
                },
            }],
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;
        const mod = await import(`../../src/services/meme_decider.ts?test=${Date.now()}-${Math.random()}`);
        const message = {
            type: 'group',
            group_id: 10002,
            sender_id: 20002,
            text: '该睡了',
        } as any;

        const decision = await mod.decideAutoMeme({ message, replyText: '晚安啦，早点休息' });
        assert.equal(decision.shouldSend, true);
        assert.equal(decision.packId, 'greeting_daily');
    } finally {
        globalThis.fetch = originalFetch;
        Math.random = originalRandom;
    }
});
