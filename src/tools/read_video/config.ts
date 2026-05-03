/**
 * Read Video 模块配置
 */

const strictIsolationEnabled = ['true', '1'].includes((process.env.LLM_STRICT_ISOLATION || '').trim().toLowerCase());
const videoApiKey = process.env.VIDEO_LLM_API_KEY || (!strictIsolationEnabled ? process.env.LLM_API_KEY || '' : '');
const videoBaseUrl = process.env.VIDEO_LLM_BASE_URL || (!strictIsolationEnabled ? process.env.LLM_BASE_URL || 'https://api.openai.com/v1' : 'https://api.openai.com/v1');

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_READ_VIDEO_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_READ_VIDEO_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return (value !== 'false' && value !== '0') && !!videoApiKey;
    })(),

    baseUrl: videoBaseUrl,
    apiKey: videoApiKey,
    model: process.env.VIDEO_LLM_MODEL || 'gemini-3-flash-preview',
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || '20971520', 10),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.READ_VIDEO_TIMEOUT_MS || '60000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.READ_VIDEO_CONCURRENCY || '2', 10),
};
