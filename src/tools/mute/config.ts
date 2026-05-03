/**
 * Mute 模块配置
 */

import { config as globalConfig } from '../../config.js';

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_MUTE_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_MUTE_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),

    /** 主人 QQ（从全局配置获取） */
    masterQQ: globalConfig.masterQQ,

    /** 机器人 QQ */
    botQQ: parseInt(process.env.BOT_QQ || '0', 10),

    /** 默认禁言时长（分钟） */
    defaultDuration: parseInt(process.env.MUTE_DEFAULT_DURATION || '10', 10),

    /** 最大禁言时长（分钟），0 表示无限制 */
    maxDuration: parseInt(process.env.MUTE_MAX_DURATION || '43200', 10), // 30天

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.MUTE_TIMEOUT_MS || '5000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.MUTE_CONCURRENCY || '5', 10),
};
