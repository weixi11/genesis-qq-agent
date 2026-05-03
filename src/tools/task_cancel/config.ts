/**
 * Task Cancel 模块配置
 */

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_TASK_CANCEL_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0';
    })(),

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.TASK_CANCEL_TIMEOUT_MS || '3000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.TASK_CANCEL_CONCURRENCY || '5', 10),
};
