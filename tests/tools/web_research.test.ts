import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = {
    WEB_RESEARCH_SEARCH_BASE_URL: process.env.WEB_RESEARCH_SEARCH_BASE_URL,
    WEB_RESEARCH_GITHUB_API_BASE_URL: process.env.WEB_RESEARCH_GITHUB_API_BASE_URL,
    WEB_RESEARCH_GITHUB_TOKEN: process.env.WEB_RESEARCH_GITHUB_TOKEN,
};

afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

async function loadTool(seed: string) {
    return import(`../../src/tools/web_research/index.ts?test=${seed}`);
}

test('web_research research mode uses bing rss and github direct fetch', async () => {
    process.env.WEB_RESEARCH_SEARCH_BASE_URL = 'https://cn.bing.com';
    process.env.WEB_RESEARCH_GITHUB_API_BASE_URL = 'https://api.github.com';

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);

        if (url.startsWith('https://cn.bing.com/search?')) {
            return new Response(`<?xml version="1.0" encoding="utf-8" ?>
                <rss version="2.0"><channel>
                    <item>
                        <title>GitHub - anthropics/claude-code</title>
                        <link>https://github.com/anthropics/claude-code</link>
                        <description>Claude Code latest repository overview.</description>
                        <pubDate>Wed, 22 Apr 2026 10:00:00 GMT</pubDate>
                    </item>
                    <item>
                        <title>Claude Code Docs</title>
                        <link>https://docs.example.com/claude-code-update</link>
                        <description>Documentation for the newest Claude Code workflow changes.</description>
                        <pubDate>Wed, 22 Apr 2026 09:00:00 GMT</pubDate>
                    </item>
                </channel></rss>`, {
                status: 200,
                headers: { 'content-type': 'application/rss+xml' },
            });
        }

        if (url === 'https://api.github.com/repos/anthropics/claude-code') {
            return new Response(JSON.stringify({
                default_branch: 'main',
                description: 'Claude Code is an agentic coding tool in your terminal.',
                homepage: 'https://code.claude.com/docs/en/overview',
                language: 'Shell',
                license: { spdx_id: 'MIT' },
                stargazers_count: 116806,
                updated_at: '2026-04-22T10:39:11Z',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'https://raw.githubusercontent.com/anthropics/claude-code/main/README.md') {
            return new Response(`
                # Claude Code
                Claude Code runs in your terminal and helps you code faster.
                ## Installation
                npm install -g @anthropic-ai/claude-code
                ## Usage
                claude
            `, {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            });
        }

        if (url === 'https://docs.example.com/claude-code-update') {
            return new Response(`
                <html>
                    <head>
                        <title>Claude Code Docs</title>
                        <meta name="description" content="Latest documentation updates for Claude Code." />
                    </head>
                    <body>
                        <main>
                            Claude Code docs now include updated installation steps and usage examples.
                            The latest version adds better workflow guidance and clearer terminal onboarding.
                        </main>
                    </body>
                </html>
            `, {
                status: 200,
                headers: { 'content-type': 'text/html' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const mod = await loadTool('research-direct');
    const result = await mod.execute({
        query: 'Claude Code 最新更新',
        objective: '重点看更新内容和使用方式',
        max_results: 5,
        max_extract: 2,
    }, { senderId: 1 });

    assert.equal(result.success, true);
    assert.equal(result.data?.mode, 'research');
    assert.equal(result.data?.resultCount, 2);
    assert.equal(result.data?.extractedCount, 2);
    assert.match(result.text, /## 提炼出的关键信息/u);
    assert.match(result.text, /GitHub Stars：116806/u);
    assert.match(result.text, /Claude Code Docs/u);
    assert.ok(calls.some((url) => url.startsWith('https://cn.bing.com/search?')));
    assert.ok(calls.includes('https://api.github.com/repos/anthropics/claude-code'));
});

test('web_research extract mode fetches page directly', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://example.com/page') {
            return new Response(`
                <html>
                    <head><title>Example Page</title></head>
                    <body>
                        This page includes release date, pricing details and setup steps.
                        Installation first runs pnpm install, then pnpm start.
                    </body>
                </html>
            `, {
                status: 200,
                headers: { 'content-type': 'text/html' },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const mod = await loadTool('extract-direct');
    const result = await mod.execute({
        mode: 'extract',
        urls: ['https://example.com/page'],
    }, { senderId: 1 });

    assert.equal(result.success, true);
    assert.equal(result.data?.mode, 'extract');
    assert.match(result.text, /Example Page/u);
    assert.match(result.text, /提取重点/u);
});
