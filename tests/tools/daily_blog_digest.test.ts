import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = {
    DAILY_BLOG_DIGEST_BLOG_BASE_URL: process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL,
    DAILY_BLOG_DIGEST_BLOG_API_KEY: process.env.DAILY_BLOG_DIGEST_BLOG_API_KEY,
    BLOG_API_TOKEN: process.env.BLOG_API_TOKEN,
    BLOG_API_USERNAME: process.env.BLOG_API_USERNAME,
    BLOG_API_PASSWORD: process.env.BLOG_API_PASSWORD,
    DAILY_BLOG_DIGEST_SEARCH_BASE_URL: process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL,
    DAILY_BLOG_DIGEST_SEARCH_PATH: process.env.DAILY_BLOG_DIGEST_SEARCH_PATH,
    DAILY_BLOG_DIGEST_SEARCH_API_KEY: process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
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

async function loadDigestModule(seed: string) {
    return import(`../../src/tools/daily_blog_digest/index.ts?test=${seed}`);
}

test('daily_blog_digest publishes via legacy local blog api paths and payload', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    delete process.env.DAILY_BLOG_DIGEST_BLOG_API_KEY;
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    delete process.env.BLOG_API_USERNAME;
    delete process.env.BLOG_API_PASSWORD;
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9901';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push({
            url,
            method,
            headers: Object.fromEntries(headers.entries()),
            body,
        });

        if (url === 'http://127.0.0.1:9901/search') {
            return new Response(JSON.stringify({
                results: [
                    {
                        title: '今天的 AI 焦点',
                        url: 'https://example.com/news',
                        snippet: '一条可用于生成日报的摘要内容。',
                        image: 'https://example.com/cover.jpg',
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: '落落日报', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'AI', articleCount: 0 },
                    { id: 22, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 99 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('legacy-publish');
    const result = await digestModule.execute({
        topic_hint: '未知专题',
        category_name: '落落日报',
        tag_names: ['AI'],
        require_cover: true,
        signature: '作者：落落（Luoluo）',
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    assert.match(result.text, /博客已生成并发布/u);

    const publishCall = calls.find((item) => item.url === 'http://127.0.0.1:8088/article/publish');
    assert.ok(publishCall, 'publish call should exist');
    assert.equal(publishCall.method, 'POST');
    assert.equal(publishCall.headers.authorization, 'Bearer token-from-blog-api');

    const publishBody = JSON.parse(publishCall.body) as Record<string, unknown>;
    assert.equal(typeof publishBody.articleTitle, 'string');
    assert.equal(typeof publishBody.articleContent, 'string');
    assert.deepEqual(publishBody.tagId, [21, 22]);
    assert.equal(publishBody.categoryId, 11);
    assert.equal(typeof publishBody.articleCover, 'string');
    assert.equal(publishBody.status, 1);
});

test('daily_blog_digest falls back to offline article when search fails by default', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    delete process.env.BLOG_API_USERNAME;
    delete process.env.BLOG_API_PASSWORD;
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9902';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const calls: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push({ url, method, body });

        if (url === 'http://127.0.0.1:9902/search') {
            return new Response(JSON.stringify({
                error: 'unauthorized',
            }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: '落落日报', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'AI', articleCount: 0 },
                    { id: 22, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 101 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('offline-fallback');
    const result = await digestModule.execute({
        topic_hint: 'AI 焦点',
        category_name: '落落日报',
        tag_names: ['AI'],
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    assert.match(result.text, /离线模式生成/u);
    const publishCall = calls.find((item) => item.url === 'http://127.0.0.1:8088/article/publish');
    assert.ok(publishCall, 'publish call should exist');
    const publishBody = JSON.parse(publishCall.body) as Record<string, unknown>;
    assert.match(String(publishBody.articleContent), /离线主题整理/u);
    assert.match(String(publishBody.articleContent), /主题背景/u);
});

test('daily_blog_digest can still cancel publish when allow_empty_sources is false', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    delete process.env.BLOG_API_USERNAME;
    delete process.env.BLOG_API_PASSWORD;
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9903';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${String(init?.method || 'GET').toUpperCase()} ${url}`);

        if (url === 'http://127.0.0.1:9903/search') {
            return new Response(JSON.stringify({
                error: 'unauthorized',
            }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('cancel-when-disallowed');
    const result = await digestModule.execute({
        topic_hint: 'AI 焦点',
        category_name: '落落日报',
        allow_empty_sources: false,
    }, {
        senderId: 1,
    });

    assert.equal(result.success, false);
    assert.match(result.text, /已取消发布/u);
    assert.match(result.text, /DAILY_BLOG_DIGEST_SEARCH_API_KEY/u);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^POST http:\/\/127\.0\.0\.1:\d+\/search$/);
});

test('daily_blog_digest reuses TAVILY_API_KEY when dedicated search key is absent', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9904';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    delete process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY;
    process.env.TAVILY_API_KEY = 'shared-tavily-key';

    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
            url,
            authorization: headers.get('authorization'),
        });

        if (url === 'http://127.0.0.1:9904/search') {
            return new Response(JSON.stringify({
                results: [],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: '落落日报', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'AI', articleCount: 0 },
                    { id: 22, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 102 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('reuse-shared-tavily-key');
    const result = await digestModule.execute({
        topic_hint: 'AI 焦点',
        category_name: '落落日报',
        tag_names: ['AI'],
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    const searchCall = calls.find((item) => item.url === 'http://127.0.0.1:9904/search');
    assert.ok(searchCall, 'search call should exist');
    assert.equal(searchCall.authorization, 'Bearer shared-tavily-key');
});

test('daily_blog_digest treats long topic_hint as writing requirements and keeps cover url safe', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9905';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const calls: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push({ url, method, body });

        if (url === 'http://127.0.0.1:9905/search') {
            return new Response(JSON.stringify({
                results: [
                    {
                        title: 'Project Alpha: GitHub',
                        url: 'https://github.com/example/project-alpha',
                        snippet: '一个适合独立开发者部署的 AI 效率工具。',
                        image: `https://cdn.example.com/${'a'.repeat(1200)}.png`,
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'https://github.com/example/project-alpha') {
            return new Response(`
                <html>
                    <head>
                        <meta property="og:description" content="Project Alpha 是一个面向独立开发者的 AI 自动化工作台，支持本地部署与工作流编排。" />
                    </head>
                    <body>
                        <article class="markdown-body">
                            <h2>Highlights</h2>
                            <ul>
                                <li>支持多种 AI 工作流编排</li>
                                <li>内置可直接复用的自动化模板</li>
                            </ul>
                            <h2>Installation</h2>
                            <pre><code>git clone https://github.com/example/project-alpha.git
cd project-alpha
pnpm install
pnpm dev</code></pre>
                            <h2>Usage</h2>
                            <p>配置环境变量后启动后台服务，并在浏览器中打开控制台。</p>
                            <pre><code>cp .env.example .env
pnpm start</code></pre>
                        </article>
                    </body>
                </html>
            `, {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
            });
        }

        if (url === 'https://api.github.com/repos/example/project-alpha') {
            return new Response(JSON.stringify({
                full_name: 'example/project-alpha',
                description: 'Project Alpha 是一个面向独立开发者的 AI 自动化工作台，支持本地部署与工作流编排。',
                stargazers_count: 4321,
                language: 'TypeScript',
                updated_at: '2026-04-20T08:00:00Z',
                default_branch: 'main',
                homepage: 'https://project-alpha.example.com',
                license: { spdx_id: 'MIT' },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'https://raw.githubusercontent.com/example/project-alpha/main/docker-compose.yml') {
            return new Response(`
services:
  app:
    image: example/project-alpha:latest
    ports:
      - "3000:3000"
`, {
                status: 200,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
            });
        }

        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: 'GitHub开源项目推荐', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'GitHub', articleCount: 0 },
                    { id: 22, tagName: '开源项目', articleCount: 0 },
                    { id: 23, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 103 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('long-topic-instruction');
    const result = await digestModule.execute({
        topic_hint: '请现在立即生成并发布一篇高质量、实用、可部署的 GitHub 开源项目推荐文章。优先选择 AI 工具、开发效率工具、实用脚本、生产力应用、独立开发相关项目。文章需包含：1. 项目简介；2. 适用场景与核心用途；3. 功能亮点；4. 安装与部署教程；5. 基础使用说明；6. 适合什么人；7. 注意事项与简评。',
        category_name: 'GitHub开源项目推荐',
        tag_names: ['GitHub', '开源项目'],
        require_cover: true,
        style: '技术推荐/实用教程',
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    const searchCall = calls.find((item) => item.url === 'http://127.0.0.1:9905/search');
    assert.ok(searchCall, 'search call should exist');
    const searchBody = JSON.parse(searchCall.body) as Record<string, unknown>;
    assert.match(String(searchBody.query), /AI 工具/u);
    assert.match(String(searchBody.query), /-awesome/u);
    assert.doesNotMatch(String(searchBody.query), /请现在立即生成/u);

    const publishCall = calls.find((item) => item.url === 'http://127.0.0.1:8088/article/publish');
    assert.ok(publishCall, 'publish call should exist');
    const publishBody = JSON.parse(publishCall.body) as Record<string, unknown>;
    assert.match(String(publishBody.articleTitle), /Project Alpha/u);
    assert.match(String(publishBody.articleContent), /## 1\. 项目简介/u);
    assert.match(String(publishBody.articleContent), /仓库地址：https:\/\/github\.com\/example\/project-alpha/u);
    assert.match(String(publishBody.articleContent), /项目主页：https:\/\/project-alpha\.example\.com/u);
    assert.match(String(publishBody.articleContent), /开源协议：MIT/u);
    assert.match(String(publishBody.articleContent), /主要语言：TypeScript/u);
    assert.match(String(publishBody.articleContent), /GitHub Stars：4321/u);
    assert.match(String(publishBody.articleContent), /git clone https:\/\/github\.com\/example\/project-alpha\.git/u);
    assert.match(String(publishBody.articleContent), /docker compose up -d/u);
    assert.match(String(publishBody.articleContent), /pnpm install/u);
    assert.match(String(publishBody.articleContent), /pnpm start/u);
    assert.doesNotMatch(String(publishBody.articleContent), /建议优先选择和「/u);
    assert.ok(String(publishBody.articleCover).length > 0);
    assert.ok(String(publishBody.articleCover).length < 1024);
});

test('daily_blog_digest skips collection repos and chooses a deployable project repo', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9907';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const calls: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push({ url, method, body });

        if (url === 'http://127.0.0.1:9907/search') {
            return new Response(JSON.stringify({
                results: [
                    {
                        title: 'GitHub - chenhaoact/github-project-recommend: Github优秀开源项目整理',
                        url: 'https://github.com/chenhaoact/github-project-recommend',
                        snippet: '以后每周会整理一些不错的 Github 开源项目（每周 3-6 个）。',
                    },
                    {
                        title: 'FlowLaunch: GitHub',
                        url: 'https://github.com/example/flowlaunch',
                        snippet: '一个面向独立开发者的自托管 AI 工作流应用，支持 Docker 部署。',
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'https://github.com/example/flowlaunch') {
            return new Response(`
                <html>
                    <head>
                        <meta property="og:description" content="FlowLaunch 是一个面向独立开发者的自托管 AI 工作流应用，支持 Docker 部署与可视化编排。" />
                    </head>
                    <body>
                        <article class="markdown-body">
                            <h2>Highlights</h2>
                            <ul>
                                <li>可视化编排 AI 工作流</li>
                                <li>内置队列与任务追踪面板</li>
                            </ul>
                            <h2>Installation</h2>
                            <pre><code>git clone https://github.com/example/flowlaunch.git
cd flowlaunch
docker compose up -d</code></pre>
                            <h2>Usage</h2>
                            <p>启动后访问 Web 控制台并创建第一个工作流。</p>
                            <pre><code>cp .env.example .env
docker compose exec app node scripts/init.js</code></pre>
                        </article>
                    </body>
                </html>
            `, {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
            });
        }

        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: 'GitHub开源项目推荐', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'GitHub', articleCount: 0 },
                    { id: 22, tagName: '开源项目', articleCount: 0 },
                    { id: 23, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 104 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('skip-collection-repo');
    const result = await digestModule.execute({
        topic_hint: 'GitHub 开源项目推荐',
        category_name: 'GitHub开源项目推荐',
        tag_names: ['GitHub', '开源项目'],
        writing_requirements: '优先选择 AI 工具、开发效率工具、独立开发可部署项目。',
        style: '技术推荐/实用教程',
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    const publishCall = calls.find((item) => item.url === 'http://127.0.0.1:8088/article/publish');
    assert.ok(publishCall, 'publish call should exist');
    const publishBody = JSON.parse(publishCall.body) as Record<string, unknown>;
    assert.match(String(publishBody.articleTitle), /FlowLaunch/u);
    assert.match(String(publishBody.articleContent), /https:\/\/github\.com\/example\/flowlaunch/u);
    assert.match(String(publishBody.articleContent), /docker compose up -d/u);
    assert.doesNotMatch(String(publishBody.articleContent), /github-project-recommend/u);
});

test('daily_blog_digest retries with fallback project queries when first search only returns weak repos', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9908';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const searchQueries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? init.body : '';

        if (url === 'http://127.0.0.1:9908/search') {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const query = String(parsed.query || '');
            searchQueries.push(query);

            if (searchQueries.length === 1) {
                return new Response(JSON.stringify({
                    results: [
                        {
                            title: 'GitHub - ai-chen2050/blogit · GitHub',
                            url: 'https://github.com/ai-chen2050/blogit',
                            snippet: '开源工具、效率方法、心理学探索的自我提升笔记。',
                        },
                    ],
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            return new Response(JSON.stringify({
                results: [
                    {
                        title: 'Claw Cowork: GitHub',
                        url: 'https://github.com/Sompote/Claw_Cowork',
                        snippet: 'A self-hosted AI workspace with Docker deployment and agent workflow support.',
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'https://github.com/ai-chen2050/blogit') {
            return new Response(`
                <html>
                    <head><meta property="og:description" content="Contribute to ai-chen2050/blogit development by creating an account on GitHub." /></head>
                    <body><article class="markdown-body"><ul><li>笔记结构</li><li>网站部署</li></ul></article></body>
                </html>
            `, {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
            });
        }

        if (url === 'https://github.com/Sompote/Claw_Cowork') {
            return new Response(`
                <html>
                    <head><meta property="og:description" content="A self-hosted AI workspace that merges a React frontend with an agent architecture on a single port." /></head>
                    <body>
                        <article class="markdown-body">
                            <h2>Highlights</h2>
                            <ul>
                                <li>Single-port self-hosted AI workspace</li>
                                <li>Built-in multi-agent workflow orchestration</li>
                            </ul>
                            <h2>Installation</h2>
                            <pre><code>git clone https://github.com/Sompote/Claw_Cowork.git
cd Claw_Cowork
docker compose up -d</code></pre>
                            <h2>Usage</h2>
                            <pre><code>cp .env.example .env
docker compose exec app npm run seed</code></pre>
                        </article>
                    </body>
                </html>
            `, {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
            });
        }

        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: 'GitHub开源项目推荐', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'GitHub', articleCount: 0 },
                    { id: 22, tagName: '开源项目', articleCount: 0 },
                    { id: 23, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 105 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('fallback-search-queries');
    const result = await digestModule.execute({
        topic_hint: '请生成 GitHub 开源项目推荐',
        category_name: 'GitHub开源项目推荐',
        tag_names: ['GitHub', '开源项目'],
        writing_requirements: '优先选择 AI 工具、开发效率工具、独立开发可部署项目。',
        style: '技术推荐/实用教程',
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    assert.ok(searchQueries.length >= 2);
    assert.match(searchQueries[1] || '', /self-hosted|workflow|install/u);
});

test('daily_blog_digest ignores github issue and blob pages as project candidates', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9909';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:9909/search') {
            return new Response(JSON.stringify({
                results: [
                    {
                        title: 'Issue page',
                        url: 'https://github.com/example/agents-radar/issues/318',
                        snippet: '这是一条 issue 页面，不是仓库首页。',
                    },
                    {
                        title: 'Blob page',
                        url: 'https://github.com/example/easy-vibe/blob/main/README.md',
                        snippet: '这是一条 README blob 页面，不是仓库首页。',
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('ignore-non-repo-subpaths');
    const result = await digestModule.execute({
        topic_hint: 'GitHub 开源项目推荐',
        category_name: 'GitHub开源项目推荐',
        tag_names: ['GitHub', '开源项目'],
        allow_empty_sources: true,
    }, {
        senderId: 1,
    });

    assert.equal(result.success, false);
    assert.match(result.text, /没有找到合适的可部署 GitHub 项目/u);
});

test('daily_blog_digest cancels project recommendation when no concrete github repo is found', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9906';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        calls.push({ url, method });

        if (url === 'http://127.0.0.1:9906/search') {
            return new Response(JSON.stringify({
                results: [
                    {
                        title: 'GitHub 开源项目推荐写作技巧',
                        url: 'https://example.com/how-to-write-project-review',
                        snippet: '这是一篇教你如何写 GitHub 项目推荐文章的教程，不是具体仓库。',
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('project-mode-needs-repo');
    const result = await digestModule.execute({
        topic_hint: 'GitHub 开源项目推荐',
        category_name: 'GitHub开源项目推荐',
        tag_names: ['GitHub', '开源项目'],
        allow_empty_sources: true,
    }, {
        senderId: 1,
    });

    assert.equal(result.success, false);
    assert.match(result.text, /没有找到合适的可部署 GitHub 项目/u);
    assert.ok(calls.length >= 1);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:9906/search');
});

test('daily_blog_digest falls back when search endpoint returns invalid json', async () => {
    process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL = 'http://127.0.0.1:8088';
    process.env.BLOG_API_TOKEN = 'token-from-blog-api';
    process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL = 'http://127.0.0.1:9907';
    process.env.DAILY_BLOG_DIGEST_SEARCH_PATH = '/search';
    process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:9907/search') {
            return new Response('not-json', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url === 'http://127.0.0.1:8088/category/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [{ id: 11, categoryName: '落落日报', articleCount: 0 }],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url === 'http://127.0.0.1:8088/tag/list') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: [
                    { id: 21, tagName: 'AI', articleCount: 0 },
                    { id: 22, tagName: '日报', articleCount: 0 },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url === 'http://127.0.0.1:8088/tag/back/add') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 22 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url === 'http://127.0.0.1:8088/article/publish') {
            return new Response(JSON.stringify({
                code: 200,
                msg: 'success',
                data: { id: 103 },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const digestModule = await loadDigestModule('invalid-search-json');
    const result = await digestModule.execute({
        topic_hint: 'AI 焦点',
        category_name: '落落日报',
        tag_names: ['AI'],
    }, {
        senderId: 1,
    });

    assert.equal(result.success, true);
    assert.match(result.text, /离线模式生成/u);
});
