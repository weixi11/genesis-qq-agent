import { log } from '../../logger.js';
import { config } from './config.js';
import { schema } from './schema.js';
import { isRecord, safeParseJson } from '../../utils/json.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

interface WebResearchParams {
    mode?: 'research' | 'search' | 'extract';
    query?: string;
    text?: string;
    keyword?: string;
    urls?: string[] | string;
    objective?: string;
    max_results?: number;
    max_extract?: number;
}

interface SearchResultItem {
    title: string;
    url: string;
    snippet: string;
    publishedAt?: string;
}

interface ExtractedPage {
    url: string;
    title?: string;
    summary?: string;
    keyPoints: string[];
    excerpt?: string;
}

interface GitHubRepoInfo {
    owner: string;
    repo: string;
    defaultBranch?: string;
    description?: string;
    homepage?: string;
    language?: string;
    license?: string;
    stars?: number;
    updatedAt?: string;
}

const MAX_SNIPPET_LENGTH = 220;
const MAX_EXCERPT_LENGTH = 900;
const MAX_PAGE_POINTS = 4;
const MAX_RESEARCH_POINTS = 6;
const MAX_SEARCH_RESULTS = 8;
const MAX_EXTRACT_RESULTS = 4;
const REQUEST_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36';

export const name = 'web_research';
export const description = '深度联网搜索与网页信息提炼';
export const keywords = [
    '联网查', '在线查', '查资料', '深度搜索', '在线研究',
    '在线调研', '搜索', '搜一下', '查一下', '最新',
    '新闻', '资料', '现在', '当前', '目前',
];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function truncateSnippet(text: string, maxLength = MAX_SNIPPET_LENGTH): string {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxLength) return normalized;
    return normalized.slice(0, maxLength).trimEnd() + '…';
}

function clampInteger(value: unknown, fallback: number, max: number): number {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? parseInt(value, 10)
            : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function resolveQuery(params: WebResearchParams): string | undefined {
    const query = params.query ?? params.keyword ?? params.text;
    if (typeof query !== 'string') return undefined;
    const trimmed = query.trim();
    return trimmed || undefined;
}

function uniqueLines(lines: string[], maxItems: number): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
        const normalized = normalizeWhitespace(line);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
        if (result.length >= maxItems) break;
    }
    return result;
}

function stripHtml(html: string): string {
    return decodeHtmlEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<li[^>]*>/gi, '\n- ')
            .replace(/<(br|\/p|\/div|\/section|\/article|\/h[1-6]|\/tr)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\r/g, ''),
    )
        .split('\n')
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean)
        .join('\n');
}

async function fetchText(url: string, accept?: string): Promise<string> {
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': REQUEST_USER_AGENT,
            'Accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            ...(config.githubToken && url.startsWith(config.githubApiBaseUrl) ? { Authorization: `Bearer ${config.githubToken}` } : {}),
        },
        signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`request failed: ${response.status} ${response.statusText}`);
    }

    return await response.text();
}

function extractXmlTag(xml: string, tagName: string): string | undefined {
    const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match?.[1] ? decodeHtmlEntities(match[1]).trim() : undefined;
}

function parseBingRss(xml: string): SearchResultItem[] {
    const items: SearchResultItem[] = [];
    const seen = new Set<string>();
    const matches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

    for (const raw of matches) {
        const title = extractXmlTag(raw, 'title');
        const url = extractXmlTag(raw, 'link');
        const snippet = extractXmlTag(raw, 'description');
        const publishedAt = extractXmlTag(raw, 'pubDate');
        if (!title || !url || !snippet) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        items.push({
            title: normalizeWhitespace(title),
            url: normalizeWhitespace(url),
            snippet: truncateSnippet(snippet),
            publishedAt,
        });
    }

    return items;
}

async function searchBing(query: string, maxResults: number): Promise<SearchResultItem[]> {
    const url = new URL('/search', config.searchBaseUrl);
    url.searchParams.set('format', 'rss');
    url.searchParams.set('q', query);
    url.searchParams.set('setlang', 'en-US');
    const xml = await fetchText(url.toString(), 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8');
    return parseBingRss(xml).slice(0, maxResults);
}

function tokenizeText(text: string): string[] {
    const normalized = normalizeWhitespace(text).toLowerCase();
    if (!normalized) return [];

    return uniqueLines(
        normalized
            .split(/[\s,.;:!?，。；：！？/()\-_"'`]+/u)
            .filter(Boolean)
            .filter((part) => !(/^[a-z0-9]+$/u.test(part) && part.length < 3))
            .filter((part) => !(/^[\u4e00-\u9fa5]+$/u.test(part) && part.length < 2)),
        12,
    );
}

function sentenceScore(line: string, keywords: string[]): number {
    const normalized = normalizeWhitespace(line).toLowerCase();
    if (!normalized) return 0;

    let score = 0;
    for (const keyword of keywords) {
        if (normalized.includes(keyword)) score += 3;
    }
    if (/版本|更新|发布|时间|日期|价格|费用|支持|新增|变更|部署|安装|用法|api|model|release|pricing|version|update|support|install|usage|github|stars/u.test(normalized)) {
        score += 1;
    }
    if (/^\d+[.)、]/u.test(normalized)) score += 1;
    if (/https?:\/\//iu.test(normalized)) score -= 2;
    if (normalized.length < 16) score -= 1;
    return score;
}

function splitIntoLines(text: string): string[] {
    return text
        .replace(/\r/g, '\n')
        .split(/\n+/u)
        .flatMap((line) => line.split(/[。！？!?]/u))
        .map((line) => normalizeWhitespace(line))
        .filter((line) => line.length >= 12 && line.length <= 220)
        .filter((line) => !/^[-=*_#|[\]<>]+$/u.test(line))
        .filter((line) => !/^(home|about|login|sign up|cookie|privacy)$/iu.test(line));
}

function summarizeRawContent(rawContent: string | null | undefined, searchText: string): { summary?: string; keyPoints: string[]; excerpt?: string } {
    const text = normalizeWhitespace(rawContent || '');
    if (!text) return { keyPoints: [] };

    const keywords = tokenizeText(searchText);
    const lines = splitIntoLines(text);
    const scored = lines
        .map((line) => ({ line, score: sentenceScore(line, keywords) }))
        .sort((a, b) => b.score - a.score || a.line.length - b.line.length);

    const selected = uniqueLines([
        ...scored.filter((item) => item.score > 0).map((item) => item.line),
        ...lines,
    ], MAX_PAGE_POINTS);

    return {
        summary: selected[0] ? truncateSnippet(selected[0], 160) : truncateSnippet(text, 160),
        keyPoints: selected,
        excerpt: truncateSnippet(text, MAX_EXCERPT_LENGTH),
    };
}

function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | undefined {
    try {
        const parsed = new URL(url);
        if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return undefined;
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length < 2) return undefined;
        const owner = segments[0];
        const repo = segments[1].replace(/\.git$/i, '');
        if (!owner || !repo) return undefined;
        if (segments.length > 2) return undefined;
        return { owner, repo };
    } catch {
        return undefined;
    }
}

function extractMetaContent(html: string, attrName: 'property' | 'name', attrValue: string): string | undefined {
    const pattern = new RegExp(`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["']`, 'i');
    const match = html.match(pattern);
    return match?.[1] ? decodeHtmlEntities(match[1]).trim() : undefined;
}

async function fetchGitHubRepoInfo(owner: string, repo: string): Promise<GitHubRepoInfo | undefined> {
    try {
        const jsonText = await fetchText(`${config.githubApiBaseUrl}/repos/${owner}/${repo}`, 'application/json');
        const data = safeParseJson(jsonText);
        if (!isRecord(data)) {
            return undefined;
        }
        const licenseRecord = data.license && typeof data.license === 'object' ? data.license as Record<string, unknown> : undefined;
        return {
            owner,
            repo,
            defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : undefined,
            description: typeof data.description === 'string' ? data.description : undefined,
            homepage: typeof data.homepage === 'string' ? data.homepage : undefined,
            language: typeof data.language === 'string' ? data.language : undefined,
            license: typeof licenseRecord?.spdx_id === 'string' ? String(licenseRecord.spdx_id) : undefined,
            stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined,
            updatedAt: typeof data.updated_at === 'string' ? data.updated_at : undefined,
        };
    } catch (error) {
        log.warn(`[web_research] github api failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

async function fetchGitHubReadme(owner: string, repo: string, branch?: string): Promise<string> {
    const branches = uniqueLines([branch || '', 'main', 'master'], 3).filter(Boolean);
    for (const item of branches) {
        try {
            const text = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${item}/README.md`, 'text/plain');
            if (text.trim()) return text;
        } catch {
            continue;
        }
    }
    return '';
}

async function fetchGenericPage(url: string, searchText: string): Promise<ExtractedPage> {
    const html = await fetchText(url);
    const title = extractMetaContent(html, 'property', 'og:title')
        || extractMetaContent(html, 'name', 'title')
        || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const description = extractMetaContent(html, 'property', 'og:description')
        || extractMetaContent(html, 'name', 'description');
    const text = stripHtml(html);
    const merged = `${description || ''}\n${text}`;
    const summary = summarizeRawContent(merged, searchText);

    return {
        url,
        title: title ? normalizeWhitespace(decodeHtmlEntities(title)) : undefined,
        summary: summary.summary,
        keyPoints: summary.keyPoints,
        excerpt: summary.excerpt,
    };
}

async function fetchGitHubPage(url: string, searchText: string): Promise<ExtractedPage> {
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed) {
        return fetchGenericPage(url, searchText);
    }

    const repoInfo = await fetchGitHubRepoInfo(parsed.owner, parsed.repo);
    const readme = await fetchGitHubReadme(parsed.owner, parsed.repo, repoInfo?.defaultBranch);
    const metadataLines = [
        repoInfo?.description ? `项目简介：${repoInfo.description}` : '',
        repoInfo?.homepage ? `项目主页：${repoInfo.homepage}` : '',
        repoInfo?.language ? `主要语言：${repoInfo.language}` : '',
        repoInfo?.license ? `开源协议：${repoInfo.license}` : '',
        typeof repoInfo?.stars === 'number' ? `GitHub Stars：${repoInfo.stars}` : '',
        repoInfo?.updatedAt ? `最近更新：${repoInfo.updatedAt}` : '',
    ].filter(Boolean);

    const merged = `${metadataLines.join('\n')}\n${readme}`;
    const summary = summarizeRawContent(merged, searchText);

    return {
        url,
        title: `${parsed.owner}/${parsed.repo}`,
        summary: summary.summary || repoInfo?.description,
        keyPoints: uniqueLines([
            ...metadataLines,
            ...summary.keyPoints,
        ], MAX_PAGE_POINTS),
        excerpt: summary.excerpt,
    };
}

async function extractPage(url: string, searchText: string): Promise<ExtractedPage> {
    if (parseGitHubRepoUrl(url)) {
        return fetchGitHubPage(url, searchText);
    }
    return fetchGenericPage(url, searchText);
}

function collectResearchFindings(searchResults: SearchResultItem[], pages: ExtractedPage[]): string[] {
    const findings = [
        ...searchResults.map((item) => item.snippet),
        ...pages.flatMap((page) => [page.summary || '', ...page.keyPoints.slice(0, 2)]),
    ].filter(Boolean);

    return uniqueLines(findings, MAX_RESEARCH_POINTS);
}

function formatSearchResults(query: string, results: SearchResultItem[]): string {
    const lines: string[] = [];
    lines.push(`🔍 搜索: ${query}`);
    lines.push('');

    if (results.length > 0) {
        lines.push(`## 搜索结果 (${results.length} 条)`);
        results.forEach((result, index) => {
            lines.push(`${index + 1}. ${result.title}`);
            lines.push(`- 摘要：${result.snippet}`);
            lines.push(`- 链接：${result.url}`);
            if (result.publishedAt) lines.push(`- 时间：${result.publishedAt}`);
        });
    } else {
        lines.push('没有找到相关结果。');
    }

    return lines.join('\n');
}

function formatExtractResults(pages: ExtractedPage[]): { text: string; dataPages: Array<Record<string, unknown>> } {
    const lines: string[] = [];
    const dataPages = pages.map((page) => ({
        url: page.url,
        title: page.title,
        summary: page.summary,
        keyPoints: page.keyPoints,
        excerpt: page.excerpt,
    }));

    lines.push(`📄 网页提取结果 (${pages.length} 篇)`);
    lines.push('');

    pages.forEach((page, index) => {
        lines.push(`## 页面 ${index + 1}`);
        lines.push(`- 链接：${page.url}`);
        if (page.title) lines.push(`- 标题：${page.title}`);
        if (page.summary) lines.push(`- 摘要：${page.summary}`);
        if (page.keyPoints.length > 0) {
            lines.push('- 提取重点:');
            page.keyPoints.forEach((item) => lines.push(`  - ${item}`));
        }
        if (page.excerpt) {
            lines.push('- 正文摘录:');
            lines.push(page.excerpt);
        }
        lines.push('');
    });

    if (pages.length === 0) {
        lines.push('没有提取到任何内容。');
    }

    return { text: lines.join('\n'), dataPages };
}

function formatResearchResults(
    query: string,
    objective: string | undefined,
    searchResults: SearchResultItem[],
    pages: ExtractedPage[],
): { text: string; findings: string[] } {
    const findings = collectResearchFindings(searchResults, pages);
    const lines: string[] = [];

    lines.push(`🔎 在线研究: ${query}`);
    if (objective) lines.push(`🎯 关注点: ${objective}`);
    lines.push('');

    if (findings.length > 0) {
        lines.push('## 提炼出的关键信息');
        findings.forEach((item) => lines.push(`- ${item}`));
        lines.push('');
    }

    if (pages.length > 0) {
        lines.push('## 深读网页结果');
        pages.forEach((page, index) => {
            lines.push(`### 来源 ${index + 1}: ${page.title || page.url}`);
            lines.push(`- 链接：${page.url}`);
            if (page.summary) lines.push(`- 页面总结：${page.summary}`);
            if (page.keyPoints.length > 0) {
                lines.push('- 命中重点:');
                page.keyPoints.forEach((item) => lines.push(`  - ${item}`));
            }
            lines.push('');
        });
    }

    if (searchResults.length > 0) {
        lines.push('## 来源列表');
        searchResults.forEach((item, index) => {
            lines.push(`${index + 1}. ${item.title}`);
            lines.push(`- 链接：${item.url}`);
            lines.push(`- 摘要：${item.snippet}`);
        });
    } else {
        lines.push('没有找到相关结果。');
    }

    return { text: lines.join('\n'), findings };
}

async function executeExtractMode(urls: string[]): Promise<ToolResult> {
    try {
        log.info(`🔧 模块: 在线研究提取网页 (共 ${urls.length} 个链接)`);
        const pages = await Promise.all(urls.map((url) => extractPage(url, url)));
        const formatted = formatExtractResults(pages);
        return {
            success: true,
            text: formatted.text,
            data: {
                mode: 'extract',
                extractedCount: pages.length,
                failedCount: 0,
                pages: formatted.dataPages,
            },
        };
    } catch (err) {
        log.error('在线研究提取失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `在线研究提取失败：${errMsg}` };
    }
}

async function executeSearchMode(query: string, maxResults: number): Promise<ToolResult> {
    try {
        log.info(`🔧 模块: 在线研究搜索 "${query}"`);
        const results = await searchBing(query, maxResults);
        return {
            success: true,
            text: formatSearchResults(query, results),
            data: {
                mode: 'search',
                query,
                resultCount: results.length,
                results,
                sources: results.map((item) => ({ title: item.title, url: item.url })),
            },
        };
    } catch (err) {
        log.error('在线研究搜索失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `在线研究搜索失败：${errMsg}` };
    }
}

async function executeResearchMode(query: string, objective: string | undefined, maxResults: number, maxExtract: number): Promise<ToolResult> {
    try {
        log.info(`🔧 模块: 在线研究 "${query}"`);
        const searchResults = await searchBing(query, maxResults);
        const targetResults = searchResults.slice(0, maxExtract);
        const pages = await Promise.all(targetResults.map((item) => extractPage(item.url, `${query}\n${objective || ''}\n${item.title}\n${item.snippet}`)));
        const formatted = formatResearchResults(query, objective, searchResults, pages);

        return {
            success: true,
            text: formatted.text,
            data: {
                mode: 'research',
                query,
                objective,
                resultCount: searchResults.length,
                extractedCount: pages.length,
                failedCount: 0,
                findings: formatted.findings,
                pages: pages.map((page) => ({
                    title: page.title,
                    url: page.url,
                    summary: page.summary,
                    keyPoints: page.keyPoints,
                })),
                sources: searchResults,
            },
        };
    } catch (err) {
        log.error('在线研究失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `在线研究失败：${errMsg}` };
    }
}

export async function execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const p = params as WebResearchParams;
    const mode = p.mode || 'research';

    if (mode === 'extract') {
        const urls = Array.isArray(p.urls)
            ? p.urls.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
            : (typeof p.urls === 'string' && p.urls.trim() ? [p.urls.trim()] : []);

        if (urls.length === 0) {
            return { success: false, text: '请提供要提取的网页链接 (urls)。' };
        }

        return executeExtractMode(urls);
    }

    const query = resolveQuery(p);
    if (!query) {
        return { success: false, text: '请告诉我要在线研究什么内容。' };
    }

    const maxResults = clampInteger(p.max_results, config.maxResults, MAX_SEARCH_RESULTS);
    if (mode === 'search') {
        return executeSearchMode(query, maxResults);
    }

    const objective = typeof p.objective === 'string' && p.objective.trim() ? p.objective.trim() : undefined;
    const maxExtract = clampInteger(p.max_extract, config.maxExtractResults, MAX_EXTRACT_RESULTS);
    return executeResearchMode(query, objective, maxResults, maxExtract);
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
