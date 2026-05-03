/**
 * Weather 模块配置
 * 
 * 独立管理天气模块的配置项
 */

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_WEATHER_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_WEATHER_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        const apiKey = process.env.QWEATHER_API_KEY;
        // 必须有 API Key 才能启用
        return (value !== 'false' && value !== '0') && !!apiKey;
    })(),

    /** 和风天气 API 域名 */
    apiHost: process.env.QWEATHER_API_HOST || '',

    /** 和风天气 API Key */
    apiKey: process.env.QWEATHER_API_KEY || '',

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.WEATHER_TIMEOUT_MS || '10000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.WEATHER_CONCURRENCY || '5', 10),
};
