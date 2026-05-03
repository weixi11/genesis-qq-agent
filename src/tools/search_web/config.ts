/**
 * search_web 模块配置
 *
 * 独立管理联网搜索模块的配置项
 * 使用 Tavily Search API（专为 AI Agent 优化的搜索引擎）
 */

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_SEARCH_WEB_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_SEARCH_WEB_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        const apiKey = process.env.TAVILY_API_KEY;
        // 必须有 Tavily API Key 才能启用
        return (value !== 'false' && value !== '0') && !!apiKey;
    })(),

    /** Tavily API Key */
    apiKey: process.env.TAVILY_API_KEY || '',

    /** Tavily API 地址 */
    apiUrl: process.env.TAVILY_API_URL || 'https://api.tavily.com',

    /** 每次搜索返回的最大结果数 */
    maxResults: parseInt(process.env.SEARCH_WEB_MAX_RESULTS || '5', 10),

    /** 搜索深度：basic（快速）或 advanced（深度，消耗更多 credits） */
    searchDepth: (process.env.SEARCH_WEB_DEPTH || 'basic') as 'basic' | 'advanced',

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.SEARCH_WEB_TIMEOUT_MS || '15000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.SEARCH_WEB_CONCURRENCY || '3', 10),
};
