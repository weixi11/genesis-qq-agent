/**
 * Poke 模块配置
 */

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_POKE_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_POKE_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),
    botQQ: parseInt(process.env.BOT_QQ || '0', 10),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.POKE_TIMEOUT_MS || '5000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.POKE_CONCURRENCY || '5', 10),
};
