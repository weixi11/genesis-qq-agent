/**
 * search_web 模块
 *
 * 联网搜索（Tavily Search API）
 * 为 AI Agent 提供实时网络信息检索能力
 */

import { z } from 'zod';
import { log } from '../../logger.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== Zod Schemas ====================

const TavilySearchResultSchema = z.object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
    score: z.number(),
    raw_content: z.string().nullish(),
});

const TavilySearchResponseSchema = z.object({
    query: z.string(),
    answer: z.string().nullish(),
    results: z.array(TavilySearchResultSchema),
});

type TavilySearchResponse = z.infer<typeof TavilySearchResponseSchema>;

const TavilyExtractResultSchema = z.object({
    url: z.string(),
    raw_content: z.string().nullish(),
});

const TavilyExtractResponseSchema = z.object({
    results: z.array(TavilyExtractResultSchema),
    failed_results: z.array(z.object({
        url: z.string(),
        error: z.string().optional(),
    })).optional(),
});

/** 工具参数 */
interface SearchWebParams {
    mode?: 'search' | 'extract';
    query?: string;
    text?: string;
    keyword?: string;
    urls?: string[] | string;
}

// ==================== 常量 ====================

/** 单条摘要最大字符数 */
const MAX_SNIPPET_LENGTH = 300;

// ==================== 模块元数据 ====================

export const name = 'search_web';
export const description = '联网搜索实时信息';
export const keywords = [
    '搜索', '搜一下', '查一下', '查询', '百度',
    '谷歌', 'google', 'search', 'bing',
    '最新', '新闻', '今日', '今天',
    '汇率', '股价', '比分', '比赛结果',
    '现在', '目前', '当前',
];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

/** 调用 Tavily Search API */
async function callTavilySearch(query: string): Promise<TavilySearchResponse> {
    const url = `${config.apiUrl}/search`;

    const body = {
        query,
        search_depth: config.searchDepth,
        max_results: config.maxResults,
        include_answer: true,
        include_raw_content: false,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`Tavily API 错误 (${response.status}): ${errorText}`);
    }

    const jsonRaw = await response.json() as unknown;
    const result = TavilySearchResponseSchema.safeParse(jsonRaw);
    if (!result.success) {
        throw new Error(`Tavily 搜索返回格式异常: ${result.error.message}`);
    }

    return result.data;
}

/** 调用 Tavily Extract API */
async function callTavilyExtract(urls: string[]) {
    const url = `${config.apiUrl}/extract`;

    const body = { urls };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`Tavily API 错误 (${response.status}): ${errorText}`);
    }

    const jsonRaw = await response.json() as unknown;
    const result = TavilyExtractResponseSchema.safeParse(jsonRaw);
    if (!result.success) {
        throw new Error(`Tavily 网页提取返回格式异常: ${result.error.message}`);
    }

    return result.data;
}

/** 截断过长的摘要文本 */
function truncateSnippet(text: string, maxLength: number = MAX_SNIPPET_LENGTH): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '…';
}

/** 格式化搜索结果为可读文本 */
function formatSearchResults(data: TavilySearchResponse): string {
    const lines: string[] = [];

    lines.push(`🔍 搜索: ${data.query}`);
    lines.push('');

    // Tavily 的 AI 摘要回答
    if (data.answer) {
        lines.push(`📝 摘要: ${data.answer}`);
        lines.push('');
    }

    // 详细搜索结果
    if (data.results.length > 0) {
        lines.push(`📋 搜索结果 (${data.results.length} 条):`);
        lines.push('');

        for (let i = 0; i < data.results.length; i++) {
            const result = data.results[i];
            lines.push(`${i + 1}. ${result.title}`);
            lines.push(`   ${truncateSnippet(result.content)}`);
            lines.push(`   🔗 ${result.url}`);
            lines.push('');
        }
    } else {
        lines.push('没有找到相关结果。');
    }

    return lines.join('\n');
}

/** 格式化提取结果为可读文本 */
function formatExtractResults(data: z.infer<typeof TavilyExtractResponseSchema>): string {
    const lines: string[] = [];

    lines.push(`📄 网页提取结果 (${data.results.length} 篇):`);
    lines.push('');

    if (data.results.length > 0) {
        for (let i = 0; i < data.results.length; i++) {
            const result = data.results[i];
            lines.push(`[🔗 URL ${i + 1}]: ${result.url}`);
            if (result.raw_content) {
                lines.push(`📝 正文摘要:`);
                // LLM 会阅读该文本，过长的网页文本可以交由 LLM 处理，
                // 但为了避免超长 context window，也可适当截断，当前按原样输出。
                lines.push(result.raw_content);
            } else {
                lines.push(`⚠️ 提取失败: 未获取到任何正文内容`);
            }
            lines.push('---');
            lines.push('');
        }
    }

    if (data.failed_results && data.failed_results.length > 0) {
        lines.push(`❌ 提取失败的链接 (${data.failed_results.length} 个):`);
        for (const fail of data.failed_results) {
            lines.push(`   - ${fail.url} (${fail.error || 'Unknown error'})`);
        }
    }

    if (data.results.length === 0 && (!data.failed_results || data.failed_results.length === 0)) {
        lines.push('没有提取到任何内容。');
    }

    return lines.join('\n');
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    _ctx: ToolContext
): Promise<ToolResult> {
    const p = params as SearchWebParams;
    const mode = p.mode || 'search';

    if (mode === 'extract') {
        // 兼容 urls 为字符串的情况（LLM 可能传入单个 URL 字符串）
        const urls: string[] = Array.isArray(p.urls)
            ? p.urls
            : (typeof p.urls === 'string' && p.urls.trim() ? [p.urls.trim()] : []);

        if (urls.length === 0) {
            return { success: false, text: '请提供要提取的网页链接 (urls) 喵~' };
        }

        try {
            log.info(`🔧 模块: 网页正文提取 (共 ${urls.length} 个链接)`);
            const data = await callTavilyExtract(urls);
            const formattedText = formatExtractResults(data);

            return {
                success: true,
                text: formattedText,
                data: {
                    extractedCount: data.results.length,
                    failedCount: data.failed_results?.length || 0
                }
            };
        } catch (err) {
            log.error('网页正文提取失败:', err);
            const errMsg = err instanceof Error ? err.message : '未知错误';
            return { success: false, text: `网页正文提取失败了喵: ${errMsg}` };
        }
    }

    // 默认 search 模式
    // 兼容多种参数名
    const query = p.query ?? p.keyword ?? p.text;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return { success: false, text: '请告诉我要搜索什么内容喵~' };
    }

    const trimmedQuery = query.trim();

    try {
        log.info(`🔧 模块: 联网搜索 "${trimmedQuery}"`);

        const data = await callTavilySearch(trimmedQuery);
        const formattedText = formatSearchResults(data);

        return {
            success: true,
            text: formattedText,
            data: {
                query: data.query,
                answer: data.answer,
                resultCount: data.results.length,
                sources: data.results.map(r => ({ title: r.title, url: r.url })),
            },
        };
    } catch (err) {
        log.error('联网搜索失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `搜索失败了喵: ${errMsg}` };
    }
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
