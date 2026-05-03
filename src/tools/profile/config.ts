/**
 * Profile 模块配置
 */

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_PROFILE_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_PROFILE_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),
    botQQ: parseInt(process.env.BOT_QQ || '0', 10),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.PROFILE_TIMEOUT_MS || '5000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.PROFILE_CONCURRENCY || '5', 10),
};
