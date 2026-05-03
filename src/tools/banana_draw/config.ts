import { resolveImageToolSendMode } from '../../utils/file_send_mode.js';

/**
 * Banana Draw 模块配置
 */

const strictIsolationEnabled = ['true', '1'].includes((process.env.LLM_STRICT_ISOLATION || '').trim().toLowerCase());
const bananaApiKey = process.env.BANANA_DRAW_LLM_API_KEY
    || (!strictIsolationEnabled ? process.env.LLM_API_KEY || '' : '');
const bananaBaseUrl = process.env.BANANA_DRAW_LLM_BASE_URL
    || 'https://senapi.fun/v1';
const defaultModel = process.env.BANANA_DRAW_LLM_MODEL || 'gpt-image-1';

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_BANANA_DRAW_ENABLED?.toLowerCase();
        return (envEnabled !== 'false' && envEnabled !== '0') && !!bananaApiKey;
    })(),

    /** Banana Draw API 地址 */
    baseUrl: bananaBaseUrl,

    /** Banana Draw API 密钥 */
    apiKey: bananaApiKey,

    /** 通用兜底模型 */
    model: defaultModel,

    /** chat/completions 模型 */
    chatModel: process.env.BANANA_DRAW_CHAT_MODEL || '',

    /** images API 专用模型，留空时跟随通用 model */
    imageModel: process.env.BANANA_DRAW_IMAGE_MODEL || '',

    /** API 模式: auto | chat | images */
    apiMode: (process.env.BANANA_DRAW_API_MODE || 'auto') as 'auto' | 'chat' | 'images',

    /** 普通文生图是否优先走 Banana */
    preferForTextToImage: ['true', '1'].includes((process.env.BANANA_DRAW_PREFER_FOR_TEXT2IMAGE || '').trim().toLowerCase()),

    /** 图片输入模式: multipart | url_array */
    imageInputMode: (process.env.BANANA_DRAW_IMAGE_INPUT_MODE || 'multipart') as 'multipart' | 'url_array',

    /** chat 接口路径 */
    chatPath: process.env.BANANA_DRAW_CHAT_PATH || '/chat/completions',

    /** 文生图接口路径 */
    generationPath: process.env.BANANA_DRAW_IMAGE_GENERATION_PATH || '/images/generations',

    /** 改图接口路径 */
    editPath: process.env.BANANA_DRAW_IMAGE_EDIT_PATH || '/images/edits',

    /** 默认图片尺寸 */
    imageSize: process.env.BANANA_DRAW_IMAGE_SIZE || '1024x1024',

    /** 图片质量 */
    imageQuality: process.env.BANANA_DRAW_IMAGE_QUALITY || '',

    /** 图片背景 */
    imageBackground: process.env.BANANA_DRAW_IMAGE_BACKGROUND || 'auto',

    /** 输出图片格式 */
    outputFormat: process.env.BANANA_DRAW_OUTPUT_FORMAT || 'png',

    /** 图片发送模式: BANANA_DRAW_SEND_MODE 单独覆盖；留空时继承全局 FILE_SEND_MODE */
    sendMode: resolveImageToolSendMode(process.env.BANANA_DRAW_SEND_MODE),

    /** 下载超时时间（毫秒） */
    downloadTimeoutMs: parseInt(process.env.BANANA_DRAW_DOWNLOAD_TIMEOUT_MS || '90000', 10),

    /** 输出图片下载代理，留空则直连 */
    downloadProxyUrl: process.env.BANANA_DRAW_DOWNLOAD_PROXY_URL || '',

    /** 输出图片下载重试次数（含首次请求） */
    downloadRetryCount: parseInt(process.env.BANANA_DRAW_DOWNLOAD_RETRY_COUNT || '3', 10),

    /** 请求超时时间（毫秒） */
    timeoutMs: parseInt(process.env.BANANA_DRAW_TIMEOUT_MS || '240000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.BANANA_DRAW_CONCURRENCY || '2', 10),
};
