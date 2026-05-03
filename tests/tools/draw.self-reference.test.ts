import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { buildPersonaSelfDrawPrompt, clearPersonaCache, getSelfReferenceDrawIntent } from '../../src/utils/personaLoader.ts';
import { execute as executeDraw } from '../../src/tools/draw/index.ts';

test('buildPersonaSelfDrawPrompt uses compact visual reference instead of full persona text', () => {
    clearPersonaCache();

    const prompt = buildPersonaSelfDrawPrompt(
        '画你自己在街头',
        '平时伪装成人类少女，长发，粉色头发，紫色眼睛，低双马尾。主人QQ:123456，活跃在QQ群中的群友身份。外貌特征包含：solo, pink_hair, purple_eyes, cat_ears, low_twintails。',
    );

    assert.match(prompt, /pink_hair/);
    assert.match(prompt, /purple_eyes/);
    assert.match(prompt, /cat_ears/);
    assert.match(prompt, /平时伪装成人类少女/);
    assert.doesNotMatch(prompt, /主人QQ:123456/);
    assert.doesNotMatch(prompt, /群友身份/);
    assert.match(prompt, /在街头/);
});

test('getSelfReferenceDrawIntent distinguishes self portrait from persona-inspired draw', () => {
    assert.equal(getSelfReferenceDrawIntent('画个你自己在街头'), 'selfPortrait');
    assert.equal(getSelfReferenceDrawIntent('画一个像落落一样的猫娘在街头'), 'personaInspired');
    assert.equal(getSelfReferenceDrawIntent('画一个银发猫娘在街头'), 'none');
});

test('draw self reference uses persona appearance even without botAppearance param', async () => {
    clearPersonaCache();

    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
            requestBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                created: Date.now(),
                data: [{ url: 'https://example.com/test-draw.webp' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
        });
    }) as typeof fetch;

    try {
        const result = await executeDraw({
            prompt: '画你自己在街头',
            selfReference: true,
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(requestBodies.length, 1);
        const payload = JSON.parse(requestBodies[0]) as { prompt: string };
        assert.match(payload.prompt, /平时伪装成人类少女/);
        assert.match(payload.prompt, /pink_hair/);
        assert.match(payload.prompt, /purple_eyes/);
        assert.match(payload.prompt, /cat_ears/);
        assert.match(payload.prompt, /catmask_on_head/);
        assert.match(payload.prompt, /金铃铛|bell/);
        assert.doesNotMatch(payload.prompt, /活跃在QQ群中的群友身份/);
        assert.doesNotMatch(payload.prompt, /专属所有物|QQ[:：]/u);
        assert.match(payload.prompt, /在街头/);

        const localPath = result.data?.localPath;
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('draw keeps non-self prompt unchanged before generation', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
            requestBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                created: Date.now(),
                data: [{ url: 'https://example.com/test-draw-2.webp' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
        });
    }) as typeof fetch;

    try {
        const result = await executeDraw({
            prompt: '二次元猫娘少女，粉发，紫瞳，低双马尾，猫耳，半身肖像',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(requestBodies.length, 1);
        const payload = JSON.parse(requestBodies[0]) as { prompt: string };
        assert.equal(payload.prompt, '二次元猫娘少女，粉发，紫瞳，低双马尾，猫耳，半身肖像');

        const localPath = result.data?.localPath;
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('draw accepts b64_json-only image responses', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
            return new Response(JSON.stringify({
                created: Date.now(),
                data: [{ b64_json: Buffer.from([1, 2, 3, 4]).toString('base64') }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeDraw({
            prompt: 'a cat on the moon',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(result.text, '🎨 画好啦喵~');
        assert.equal(result.data?.remoteUrl, null);
        const localPath = result.data?.localPath;
        assert.equal(typeof localPath, 'string');
        assert.equal(result.segments?.[0]?.type, 'image');
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('draw keeps upstream-resolved self prompt unchanged before generation', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
            requestBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                created: Date.now(),
                data: [{ url: 'https://example.com/test-draw-3.webp' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
        });
    }) as typeof fetch;

    try {
        const result = await executeDraw({
            prompt: '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron',
            selfReference: true,
            personaPromptResolved: true,
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(requestBodies.length, 1);
        const payload = JSON.parse(requestBodies[0]) as { prompt: string };
        assert.equal(payload.prompt, '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('draw auto-detects direct self portrait prompt even without selfReference flag', async () => {
    clearPersonaCache();

    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
            requestBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                created: Date.now(),
                data: [{ url: 'https://example.com/test-draw-4.webp' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
        });
    }) as typeof fetch;

    try {
        const result = await executeDraw({
            prompt: '画你自己在街头',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        const payload = JSON.parse(requestBodies[0] || '{}') as { prompt: string };
        assert.match(payload.prompt, /pink_hair/);
        assert.match(payload.prompt, /在街头/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('draw does not treat persona-inspired request as strict self portrait', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
            requestBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                created: Date.now(),
                data: [{ url: 'https://example.com/test-draw-5.webp' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
        });
    }) as typeof fetch;

    try {
        const result = await executeDraw({
            prompt: '画一个像落落一样的猫娘在街头',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        const payload = JSON.parse(requestBodies[0] || '{}') as { prompt: string };
        assert.equal(payload.prompt, '画一个像落落一样的猫娘在街头');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
