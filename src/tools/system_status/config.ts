/**
 * System Status 模块配置
 */

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_SYSTEM_STATUS_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0';
    })(),

    /** 超时时间（毫秒） */
    timeoutMs: parseInt(process.env.SYSTEM_STATUS_TIMEOUT_MS || '3000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.SYSTEM_STATUS_CONCURRENCY || '5', 10),
};
