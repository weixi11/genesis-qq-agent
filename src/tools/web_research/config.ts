/**
 * web_research 模块配置
 *
 * 独立管理深度联网研究模块
 */

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_WEB_RESEARCH_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_WEB_RESEARCH_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),

    /** Bing 搜索入口 */
    searchBaseUrl: process.env.WEB_RESEARCH_SEARCH_BASE_URL || 'https://cn.bing.com',

    /** GitHub API */
    githubApiBaseUrl: process.env.WEB_RESEARCH_GITHUB_API_BASE_URL || 'https://api.github.com',

    /** GitHub Token，可选 */
    githubToken: process.env.WEB_RESEARCH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '',

    /** 搜索最大结果数 */
    maxResults: parseInt(process.env.WEB_RESEARCH_MAX_RESULTS || '5', 10),

    /** 自动深读网页数量 */
    maxExtractResults: parseInt(process.env.WEB_RESEARCH_MAX_EXTRACT_RESULTS || '3', 10),

    /** 超时时间 */
    timeoutMs: parseInt(process.env.WEB_RESEARCH_TIMEOUT_MS || '20000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.WEB_RESEARCH_CONCURRENCY || '2', 10),
};
