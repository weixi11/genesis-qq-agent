import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test } from 'node:test';

import { config } from '../../src/tools/banana_draw/config.ts';
import { execute as executeBananaDraw } from '../../src/tools/banana_draw/index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('banana_draw uses module model for preset text-to-image when no image model override is set', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousSendMode = config.sendMode;
    const previousImageSize = config.imageSize;
    const previousImageQuality = config.imageQuality;
    const previousImageBackground = config.imageBackground;
    const previousOutputFormat = config.outputFormat;
    const savedFiles: string[] = [];

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-primary-model';
    config.imageModel = '';
    config.apiMode = 'images';
    config.sendMode = 'local';
    config.imageSize = '2160x3840';
    config.imageQuality = 'high';
    config.imageBackground = 'auto';
    config.outputFormat = 'png';

    const requestBodies: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/images/generations') {
            requestBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                revised_prompt: 'figurine revised',
                data: [{ url: 'https://cdn.example.com/banana-figurine.png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-figurine.png') {
            return new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            mode: 'figurine',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(requestBodies.length, 1);
        const payload = JSON.parse(requestBodies[0]) as {
            model: string;
            prompt: string;
            size: string;
            quality: string;
            background: string;
            output_format: string;
        };
        assert.equal(payload.model, 'banana-primary-model');
        assert.match(payload.prompt, /commercial 1\/7 scale figurine/i);
        assert.equal(payload.size, '2160x3840');
        assert.equal(payload.quality, 'high');
        assert.equal(payload.background, 'auto');
        assert.equal(payload.output_format, 'png');
        assert.equal(result.data?.model, 'banana-primary-model');
        assert.equal(result.data?.apiMode, 'images');
        assert.notEqual(result.segments?.[0]?.data?.file, 'https://cdn.example.com/banana-figurine.png');
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(result.segments?.[0]?.data?.file, localPaths[0]);
        if (typeof localPaths[0] === 'string' && fs.existsSync(localPaths[0])) {
            savedFiles.push(localPaths[0]);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.sendMode = previousSendMode;
        config.imageSize = previousImageSize;
        config.imageQuality = previousImageQuality;
        config.imageBackground = previousImageBackground;
        config.outputFormat = previousOutputFormat;
    }
});

test('banana_draw does not fall back to at-user avatar when no input image is provided', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousImageInputMode = config.imageInputMode;
    const previousSendMode = config.sendMode;
    const previousImageSize = config.imageSize;

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-edit-model';
    config.imageModel = '';
    config.apiMode = 'images';
    config.imageInputMode = 'multipart';
    config.sendMode = 'local';
    config.imageSize = '2160x3840';

    let generationRequested = false;
    const savedFiles: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/images/generations') {
            generationRequested = true;
            const payload = JSON.parse(String(init?.body || '{}')) as { model: string; prompt: string; image?: string[]; size?: string };
            assert.equal(payload.model, 'banana-edit-model');
            assert.equal(payload.image, undefined);
            assert.equal(payload.size, '2160x3840');
            assert.ok(payload.prompt.includes('Transform the character into a realistic person and create an iPhone-style casual selfie'));
            assert.ok(payload.prompt.includes('Preserve the person identity'));
            return new Response(JSON.stringify({
                data: [{ b64_json: Buffer.from([9, 8, 7, 6]).toString('base64'), mime_type: 'image/png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            mode: 'selfie',
        }, {
            senderId: 10001,
            groupId: 20001,
            atUsers: [30001],
        });

        assert.equal(result.success, true);
        assert.equal(generationRequested, true);
        assert.equal(result.data?.inputImageCount, 0);
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(localPaths.length, 1);
        const localPath = localPaths[0];
        assert.equal(typeof localPath, 'string');
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            savedFiles.push(localPath);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.imageInputMode = previousImageInputMode;
        config.sendMode = previousSendMode;
        config.imageSize = previousImageSize;
    }
});

test('banana_draw images mode sends reference image array and requested 4k portrait size', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousImageInputMode = config.imageInputMode;
    const previousSendMode = config.sendMode;
    const previousImageSize = config.imageSize;
    const previousImageQuality = config.imageQuality;
    const previousImageBackground = config.imageBackground;
    const previousOutputFormat = config.outputFormat;
    const savedFiles: string[] = [];

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'gpt-image-2';
    config.imageModel = '';
    config.apiMode = 'images';
    config.imageInputMode = 'url_array';
    config.sendMode = 'local';
    config.imageSize = '2160x3840';
    config.imageQuality = 'high';
    config.imageBackground = 'auto';
    config.outputFormat = 'png';

    let sawGenerationRequest = false;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://filesystem.site/cdn/source.jpg') {
            return new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB]), {
                status: 200,
                headers: { 'Content-Type': 'image/jpeg' },
            });
        }
        if (url === 'https://banana.example/v1/images/generations') {
            sawGenerationRequest = true;
            const payload = JSON.parse(String(init?.body || '{}')) as {
                model: string;
                prompt: string;
                image?: string[];
                size: string;
                quality: string;
                background: string;
                output_format: string;
            };
            assert.equal(payload.model, 'gpt-image-2');
            assert.match(payload.prompt, /改成黑发/u);
            assert.doesNotMatch(payload.prompt, /Preserve the person identity/u);
            assert.deepEqual(payload.image, ['https://filesystem.site/cdn/source.jpg']);
            assert.equal(payload.size, '2160x3840');
            assert.equal(payload.quality, 'high');
            assert.equal(payload.background, 'auto');
            assert.equal(payload.output_format, 'png');
            return new Response(JSON.stringify({
                data: [{ url: 'https://cdn.example.com/banana-reference.png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-reference.png') {
            return new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            prompt: '改成黑发',
            imageUrl: 'https://filesystem.site/cdn/source.jpg',
            preserveIdentity: false,
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(sawGenerationRequest, true);
        assert.equal(result.data?.apiMode, 'images');
        assert.equal(result.data?.model, 'gpt-image-2');
        assert.equal(result.data?.inputImageCount, 1);
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(localPaths.length, 1);
        assert.equal(result.segments?.[0]?.data?.file, localPaths[0]);
        if (typeof localPaths[0] === 'string' && fs.existsSync(localPaths[0])) {
            savedFiles.push(localPaths[0]);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.imageInputMode = previousImageInputMode;
        config.sendMode = previousSendMode;
        config.imageSize = previousImageSize;
        config.imageQuality = previousImageQuality;
        config.imageBackground = previousImageBackground;
        config.outputFormat = previousOutputFormat;
    }
});

test('banana_draw chat mode routes image requests through chat completions', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousChatModel = config.chatModel;
    const previousApiMode = config.apiMode;
    const previousSendMode = config.sendMode;
    const savedFiles: string[] = [];

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-chat-image-model';
    config.chatModel = '';
    config.apiMode = 'chat';
    config.sendMode = 'local';

    let sawChatRequest = false;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/chat/completions') {
            sawChatRequest = true;
            const payload = JSON.parse(String(init?.body || '{}')) as {
                model: string;
                messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url?: string } }> }>;
            };
            assert.equal(payload.model, 'banana-chat-image-model');
            assert.equal(payload.messages[0].content[0].type, 'text');
            assert.match(payload.messages[0].content[0].text || '', /turn this into a red square/i);
            assert.equal(payload.messages[0].content[1].type, 'image_url');
            assert.match(payload.messages[0].content[1].image_url?.url || '', /^data:image\/png;base64,/);
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        content: '![image](https://cdn.example.com/banana-chat-route.png)',
                    },
                }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-chat-route.png') {
            return new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            prompt: 'turn this into a red square',
            imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(sawChatRequest, true);
        assert.equal(result.data?.apiMode, 'chat');
        assert.equal(result.data?.model, 'banana-chat-image-model');
        assert.equal(result.data?.inputImageCount, 1);
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(localPaths.length, 1);
        assert.equal(result.segments?.[0]?.data?.file, localPaths[0]);
        const localPath = localPaths[0];
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            savedFiles.push(localPath);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.chatModel = previousChatModel;
        config.apiMode = previousApiMode;
        config.sendMode = previousSendMode;
    }
});

test('banana_draw retries remote output download and still sends local file', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousSendMode = config.sendMode;
    const previousDownloadTimeoutMs = config.downloadTimeoutMs;
    const previousDownloadRetryCount = config.downloadRetryCount;
    const previousDownloadProxyUrl = config.downloadProxyUrl;
    const savedFiles: string[] = [];

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-primary-model';
    config.imageModel = '';
    config.apiMode = 'images';
    config.sendMode = 'local';
    config.downloadTimeoutMs = 10;
    config.downloadRetryCount = 3;
    config.downloadProxyUrl = '';

    let downloadAttempts = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/images/generations') {
            return new Response(JSON.stringify({
                data: [{ url: 'https://cdn.example.com/banana-retry.png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-retry.png') {
            downloadAttempts += 1;
            if (downloadAttempts === 1) {
                const timeoutError = new Error('The operation was aborted due to timeout');
                timeoutError.name = 'TimeoutError';
                throw timeoutError;
            }
            return new Response(new Uint8Array([5, 4, 3, 2]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            prompt: 'draw a banana mage',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(downloadAttempts, 2);
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(localPaths.length, 1);
        assert.equal(result.segments?.[0]?.data?.file, localPaths[0]);
        const localPath = localPaths[0];
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            savedFiles.push(localPath);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.sendMode = previousSendMode;
        config.downloadTimeoutMs = previousDownloadTimeoutMs;
        config.downloadRetryCount = previousDownloadRetryCount;
        config.downloadProxyUrl = previousDownloadProxyUrl;
    }
});

test('banana_draw retries transient fetch failed output download', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousSendMode = config.sendMode;
    const previousDownloadTimeoutMs = config.downloadTimeoutMs;
    const previousDownloadRetryCount = config.downloadRetryCount;
    const previousDownloadProxyUrl = config.downloadProxyUrl;
    const savedFiles: string[] = [];

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-primary-model';
    config.imageModel = '';
    config.apiMode = 'images';
    config.sendMode = 'local';
    config.downloadTimeoutMs = 10;
    config.downloadRetryCount = 3;
    config.downloadProxyUrl = '';

    let downloadAttempts = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/images/generations') {
            return new Response(JSON.stringify({
                data: [{ url: 'https://cdn.example.com/banana-fetch-retry.png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-fetch-retry.png') {
            downloadAttempts += 1;
            if (downloadAttempts === 1) {
                throw new Error('fetch failed');
            }
            return new Response(new Uint8Array([5, 4, 3, 2]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            prompt: 'draw a banana mage',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(downloadAttempts, 2);
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(localPaths.length, 1);
        assert.equal(result.segments?.[0]?.data?.file, localPaths[0]);
        const localPath = localPaths[0];
        if (typeof localPath === 'string' && fs.existsSync(localPath)) {
            savedFiles.push(localPath);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.sendMode = previousSendMode;
        config.downloadTimeoutMs = previousDownloadTimeoutMs;
        config.downloadRetryCount = previousDownloadRetryCount;
        config.downloadProxyUrl = previousDownloadProxyUrl;
    }
});

test('banana_draw uses configured proxy when downloading remote output image', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousSendMode = config.sendMode;
    const previousDownloadProxyUrl = config.downloadProxyUrl;
    const savedFiles: string[] = [];

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-primary-model';
    config.imageModel = '';
    config.apiMode = 'images';
    config.sendMode = 'local';
    config.downloadProxyUrl = 'http://127.0.0.1:2098';

    let sawDispatcher = false;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/images/generations') {
            return new Response(JSON.stringify({
                data: [{ url: 'https://cdn.example.com/banana-proxy.png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-proxy.png') {
            sawDispatcher = Boolean(init?.dispatcher);
            return new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            prompt: 'draw a banana mage',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, true);
        assert.equal(sawDispatcher, true);
        const localPaths = Array.isArray(result.data?.localPaths) ? result.data.localPaths : [];
        assert.equal(result.segments?.[0]?.data?.file, localPaths[0]);
        if (typeof localPaths[0] === 'string' && fs.existsSync(localPaths[0])) {
            savedFiles.push(localPaths[0]);
        }
    } finally {
        for (const file of savedFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.sendMode = previousSendMode;
        config.downloadProxyUrl = previousDownloadProxyUrl;
    }
});

test('banana_draw local send mode does not fall back to remote URL when output download fails', async () => {
    const previousEnabled = config.enabled;
    const previousApiKey = config.apiKey;
    const previousBaseUrl = config.baseUrl;
    const previousModel = config.model;
    const previousImageModel = config.imageModel;
    const previousApiMode = config.apiMode;
    const previousSendMode = config.sendMode;
    const previousDownloadProxyUrl = config.downloadProxyUrl;
    const previousDownloadRetryCount = config.downloadRetryCount;

    config.enabled = true;
    config.apiKey = 'banana-secret';
    config.baseUrl = 'https://banana.example/v1';
    config.model = 'banana-primary-model';
    config.imageModel = '';
    config.apiMode = 'images';
    config.sendMode = 'local';
    config.downloadProxyUrl = '';
    config.downloadRetryCount = 1;

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://banana.example/v1/images/generations') {
            return new Response(JSON.stringify({
                data: [{ url: 'https://cdn.example.com/banana-fail.png' }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === 'https://cdn.example.com/banana-fail.png') {
            throw new Error('fetch failed');
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
        const result = await executeBananaDraw({
            prompt: 'draw a banana mage',
        }, {
            senderId: 10001,
            groupId: 20001,
        });

        assert.equal(result.success, false);
        assert.equal(result.segments?.length || 0, 0);
        assert.match(result.text, /没有返回可发送的内容/u);
    } finally {
        config.enabled = previousEnabled;
        config.apiKey = previousApiKey;
        config.baseUrl = previousBaseUrl;
        config.model = previousModel;
        config.imageModel = previousImageModel;
        config.apiMode = previousApiMode;
        config.sendMode = previousSendMode;
        config.downloadProxyUrl = previousDownloadProxyUrl;
        config.downloadRetryCount = previousDownloadRetryCount;
    }
});
