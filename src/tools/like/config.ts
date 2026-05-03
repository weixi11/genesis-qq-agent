/**
 * Like 模块配置
 * 
 * 独立管理点赞模块的配置项
 */

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_LIKE_ENABLED?.toLowerCase();
        // 兼容旧的 TOOL_LIKE_ENABLED
        const oldEnabled = process.env.TOOL_LIKE_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),

    /** Bot QQ 号（用于过滤 @ 自己） */
    botQQ: parseInt(process.env.BOT_QQ || '0', 10),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.LIKE_TIMEOUT_MS || '5000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.LIKE_CONCURRENCY || '5', 10),
};
