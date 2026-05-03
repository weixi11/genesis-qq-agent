/**
 * Draw 模块配置
 *
 * 绘图模块独立 API 配置
 */

import { resolveImageToolSendMode } from '../../utils/file_send_mode.js';

const strictIsolationEnabled = ['true', '1'].includes((process.env.LLM_STRICT_ISOLATION || '').trim().toLowerCase());
const drawApiKey = process.env.DRAW_LLM_API_KEY || process.env.DRAW_API_KEY || (!strictIsolationEnabled ? process.env.LLM_API_KEY || '' : '');

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_DRAW_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_DRAW_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return (value !== 'false' && value !== '0') && !!drawApiKey;
    })(),

    /** 绘图 API 地址 */
    baseUrl: process.env.DRAW_LLM_BASE_URL || 'https://senapi.fun/v1',

    /** 绘图 API 密钥 */
    apiKey: drawApiKey,

    /** 绘图模型名 */
    model: process.env.DRAW_LLM_MODEL || process.env.DRAW_MODEL || 'anishadow-v10-plus',

    /** 图片发送模式: DRAW_IMAGE_SEND_MODE 单独覆盖；留空时继承全局 FILE_SEND_MODE */
    sendMode: resolveImageToolSendMode(process.env.DRAW_IMAGE_SEND_MODE),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.DRAW_TIMEOUT_MS || '120000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.DRAW_CONCURRENCY || '2', 10),
};
