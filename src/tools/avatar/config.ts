/**
 * Avatar 模块配置
 */

import { config as globalConfig } from '../../config.js';

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_AVATAR_ENABLED?.toLowerCase();
        const value = envEnabled;
        return value !== 'false' && value !== '0';
    })(),

    /** Bot QQ */
    botQQ: globalConfig.botQQ,

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.AVATAR_TIMEOUT_MS || '5000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.AVATAR_CONCURRENCY || '5', 10),
};
