/**
 * AnimeTrace 模块配置
 *
 * 使用 AnimeTrace API 识别动漫/Galgame/二次元游戏角色
 * API 文档: https://ai.animedb.cn/api-docs/
 */

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_ANIME_TRACE_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_ANIME_TRACE_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),

    /** AnimeTrace API 地址 */
    apiUrl: process.env.ANIME_TRACE_API_URL || 'https://api.animetrace.com/v1/search',

    /** 默认识别模型 */
    defaultModel: process.env.ANIME_TRACE_MODEL || 'anime',

    /** 是否默认开启多角色识别 */
    defaultMulti: process.env.ANIME_TRACE_MULTI === '1' ? 1 : 0,

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.ANIME_TRACE_TIMEOUT_MS || '30000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.ANIME_TRACE_CONCURRENCY || '3', 10),
};
