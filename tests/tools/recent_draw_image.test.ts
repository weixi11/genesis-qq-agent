import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import { execute as executeRecentDrawImage } from '../../src/tools/recent_draw_image/index.ts';

const drawDir = path.join(process.cwd(), 'data', 'images');
const bananaDir = path.join(process.cwd(), 'data', 'images', 'banana_draw');

function writeTestImage(filePath: string, mtimeMs: number): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const date = new Date(mtimeMs);
    fs.utimesSync(filePath, date, date);
}

test('recent_draw_image resends latest generated images from draw and banana caches', async () => {
    const now = Date.now();
    const drawPath = path.join(drawDir, `recent_draw_image_test_${now}.png`);
    const bananaPath = path.join(bananaDir, `recent_draw_image_test_${now}.png`);

    try {
        writeTestImage(drawPath, now - 10_000);
        writeTestImage(bananaPath, now);

        const result = await executeRecentDrawImage({ count: 1, source: 'all' }, {
            senderId: 10001,
        });

        assert.equal(result.success, true);
        assert.equal(result.segments?.length, 1);
        assert.equal(result.segments?.[0]?.type, 'image');
        assert.equal(result.segments?.[0]?.data.file, bananaPath);
        assert.deepEqual(result.data?.localPaths, [bananaPath]);
    } finally {
        for (const file of [drawPath, bananaPath]) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
    }
});

test('recent_draw_image can filter normal draw cache only', async () => {
    const now = Date.now();
    const drawPath = path.join(drawDir, `recent_draw_image_test_draw_${now}.webp`);
    const bananaPath = path.join(bananaDir, `recent_draw_image_test_banana_${now}.png`);

    try {
        writeTestImage(drawPath, now - 20_000);
        writeTestImage(bananaPath, now);

        const result = await executeRecentDrawImage({ count: 1, source: 'draw' }, {
            senderId: 10001,
        });

        assert.equal(result.success, true);
        assert.equal(result.segments?.length, 1);
        assert.equal(result.segments?.[0]?.data.file, drawPath);
        assert.deepEqual(result.data?.sources, ['draw']);
    } finally {
        for (const file of [drawPath, bananaPath]) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
    }
});
