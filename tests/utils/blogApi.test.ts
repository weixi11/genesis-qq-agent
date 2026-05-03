import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { __blogApiTestUtils, requestBlogApi } from '../../src/utils/blogApi.ts';

const originalFetch = globalThis.fetch;

function createJsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    __blogApiTestUtils.clearAuthCache();
});

test('requestBlogApi skips password login for anonymous endpoints', async () => {
    const urls: string[] = [];

    globalThis.fetch = (async (input, init) => {
        urls.push(String(input));
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('Authorization'), null);
        return createJsonResponse({ code: 200, msg: 'ok', data: [] });
    }) as typeof fetch;

    await requestBlogApi(
        {
            apiBaseUrl: 'https://example.com',
            apiUsername: 'tester',
            apiPassword: 'secret',
        },
        {
            method: 'GET',
            path: '/category/list',
            requiredAuth: false,
        },
    );

    assert.deepEqual(urls, ['https://example.com/category/list']);
});

test('requestBlogApi reuses cached static token after password login fails once', async () => {
    let loginCount = 0;
    const authHeaders: string[] = [];

    globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.endsWith('/user/login')) {
            loginCount += 1;
            return createJsonResponse({ code: 500, msg: 'login failed', data: {} });
        }

        authHeaders.push(new Headers(init?.headers).get('Authorization') || '');
        return createJsonResponse({ code: 200, msg: 'ok', data: {} });
    }) as typeof fetch;

    const config = {
        apiBaseUrl: 'https://example.com',
        apiUsername: 'tester',
        apiPassword: 'wrong-password',
        apiToken: 'static-token',
    };

    await requestBlogApi(config, {
        method: 'POST',
        path: '/article/publish',
        body: { title: 'a' },
        requiredAuth: true,
    });
    await requestBlogApi(config, {
        method: 'POST',
        path: '/article/publish',
        body: { title: 'b' },
        requiredAuth: true,
    });

    assert.equal(loginCount, 1);
    assert.deepEqual(authHeaders, ['Bearer static-token', 'Bearer static-token']);
});

test('requestBlogApi invalidates cache when static token changes', async () => {
    const authHeaders: string[] = [];

    globalThis.fetch = (async (_input, init) => {
        authHeaders.push(new Headers(init?.headers).get('Authorization') || '');
        return createJsonResponse({ code: 200, msg: 'ok', data: {} });
    }) as typeof fetch;

    await requestBlogApi(
        {
            apiBaseUrl: 'https://example.com',
            apiToken: 'token-a',
        },
        {
            method: 'GET',
            path: '/article/list',
            requiredAuth: true,
        },
    );

    await requestBlogApi(
        {
            apiBaseUrl: 'https://example.com',
            apiToken: 'token-b',
        },
        {
            method: 'GET',
            path: '/article/list',
            requiredAuth: true,
        },
    );

    assert.deepEqual(authHeaders, ['Bearer token-a', 'Bearer token-b']);
});
