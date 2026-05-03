/**
 * Vision 模块配置
 */

const strictIsolationEnabled = ['true', '1'].includes((process.env.LLM_STRICT_ISOLATION || '').trim().toLowerCase());
const visionApiKey = process.env.VISION_LLM_API_KEY || (!strictIsolationEnabled ? process.env.LLM_API_KEY || '' : '');
const visionBaseUrl = process.env.VISION_LLM_BASE_URL || (!strictIsolationEnabled ? process.env.LLM_BASE_URL || 'https://api.openai.com/v1' : 'https://api.openai.com/v1');

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_VISION_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_VISION_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return (value !== 'false' && value !== '0') && !!visionApiKey;
    })(),

    /** Vision LLM API 地址 */
    baseUrl: visionBaseUrl,

    /** Vision LLM API 密钥 */
    apiKey: visionApiKey,

    /** Vision LLM 模型名 */
    model: process.env.VISION_LLM_MODEL || 'gemini-3-flash-preview',

    /** 最大文件大小 */
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || '20971520', 10),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.VISION_TIMEOUT_MS || '60000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.VISION_CONCURRENCY || '3', 10),
};
