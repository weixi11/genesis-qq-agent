/**
 * Music 模块配置
 */

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_MUSIC_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_CLOUD_MUSIC_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.MUSIC_TIMEOUT_MS || '15000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.MUSIC_CONCURRENCY || '3', 10),
};
