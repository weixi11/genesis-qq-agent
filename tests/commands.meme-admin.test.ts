import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const originalCwd = process.cwd();
const originalAdminQQ = process.env.ADMIN_QQ;
const originalMasterQQ = process.env.MASTER_QQ;
let tempCwd = '';

function makeMessage(text: string, senderId = 10001) {
    return {
        message_id: 1,
        time: Date.now(),
        time_str: new Date().toISOString(),
        type: 'group',
        summary: text,
        sender_id: senderId,
        sender_name: 'tester',
        sender_role: 'owner',
        group_id: 20001,
        group_name: 'test-group',
        text,
        images: [],
        videos: [],
        records: [],
        at_users: [],
        at_all: false,
        files: [],
        cards: [],
        mface_urls: [],
    } as const;
}

async function writeManifest() {
    const assetsDir = path.join(tempCwd, 'data', 'meme-assets');
    const manifestPath = path.join(tempCwd, 'data', 'meme_packs', 'luoluo', 'manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, 'hello.png'), 'hello');
    await writeFile(path.join(assetsDir, 'hug.png'), 'hug');
    await writeFile(path.join(assetsDir, 'orphan.png'), 'orphan');

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

async function loadCommandsModule() {
    return import(`../src/commands.ts?test=${Date.now()}-${Math.random()}`);
}

before(async () => {
    process.env.ADMIN_QQ = '10001';
    process.env.MASTER_QQ = '90001';
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-commands-'));
    process.chdir(tempCwd);
    await writeManifest();
});

after(() => {
    process.chdir(originalCwd);
    if (originalAdminQQ === undefined) {
        delete process.env.ADMIN_QQ;
    } else {
        process.env.ADMIN_QQ = originalAdminQQ;
    }
    if (originalMasterQQ === undefined) {
        delete process.env.MASTER_QQ;
    } else {
        process.env.MASTER_QQ = originalMasterQQ;
    }
});

test('admin and meme menus are exposed to admins and master', async () => {
    const mod = await loadCommandsModule();

    assert.equal(mod.isAdmin(10001), true);
    assert.equal(mod.isAdmin(90001), true);
    assert.equal(mod.isAdmin(12345), false);

    const adminMenu = mod.handleAdminCommand(makeMessage('#管理菜单'));
    assert.equal(adminMenu.handled, true);
    assert.match(adminMenu.response || '', /#表情 菜单/);
    assert.match(adminMenu.response || '', /#测试消息/);

    const memeMenu = mod.handleAdminCommand(makeMessage('#表情 帮助'));
    assert.equal(memeMenu.handled, true);
    assert.match(memeMenu.response || '', /#表情 列表/);
    assert.match(memeMenu.response || '', /#表情 清理孤儿/);
});

test('meme admin commands can list stats orphan and cleanup files', async () => {
    const mod = await loadCommandsModule();

    const listResult = mod.handleAdminCommand(makeMessage('#表情 列表'));
    assert.equal(listResult.handled, true);
    const listText = await listResult.asyncHandler?.();
    assert.match(listText || '', /问候日常 \[greeting_daily\]/);
    assert.match(listText || '', /安慰鼓劲 \[support_affection\]/);
    assert.match(listText || '', /早安晚安和普通招呼/);

    const statsResult = mod.handleAdminCommand(makeMessage('#表情 统计'));
    const statsText = await statsResult.asyncHandler?.();
    assert.match(statsText || '', /分组: 2 组/);
    assert.match(statsText || '', /manifest 引用图片: 2 张/);
    assert.match(statsText || '', /素材目录图片: 3 张/);
    assert.match(statsText || '', /孤儿图片: 1 张/);

    const orphanResult = mod.handleAdminCommand(makeMessage('#表情 孤儿'));
    const orphanText = await orphanResult.asyncHandler?.();
    assert.match(orphanText || '', /orphan\.png/);

    const orphanPath = path.join(tempCwd, 'data', 'meme-assets', 'orphan.png');
    assert.equal(fs.existsSync(orphanPath), true);
    const cleanupResult = mod.handleAdminCommand(makeMessage('#表情 清理孤儿'));
    const cleanupText = await cleanupResult.asyncHandler?.();
    assert.match(cleanupText || '', /已清理孤儿图片 1 张/);
    assert.equal(fs.existsSync(orphanPath), false);

    const reloadResult = mod.handleAdminCommand(makeMessage('#表情 重载'));
    assert.equal(reloadResult.handled, true);
    assert.match(reloadResult.response || '', /缓存已重载/);
});

test('meme admin stats tolerate invalid manifest json', async () => {
    const manifestPath = path.join(tempCwd, 'data', 'meme_packs', 'luoluo', 'manifest.json');
    await writeFile(manifestPath, '{broken-json', 'utf-8');

    const mod = await loadCommandsModule();
    const statsResult = mod.handleAdminCommand(makeMessage('#表情 统计'));
    const statsText = await statsResult.asyncHandler?.();

    assert.match(statsText || '', /分组: 0 组/);
    assert.match(statsText || '', /孤儿图片: 0 张/);
});
