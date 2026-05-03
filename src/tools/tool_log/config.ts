/**
 * Tool Log 模块配置
 */

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_TOOL_LOG_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0';
    })(),

    timeoutMs: parseInt(process.env.TOOL_LOG_TIMEOUT_MS || '5000', 10),
    concurrency: parseInt(process.env.TOOL_LOG_CONCURRENCY || '2', 10),
    defaultLimit: parseInt(process.env.TOOL_LOG_DEFAULT_LIMIT || '5', 10),
    maxLimit: parseInt(process.env.TOOL_LOG_MAX_LIMIT || '20', 10),
    maxParamsLength: parseInt(process.env.TOOL_LOG_MAX_PARAMS_LENGTH || '160', 10),
    maxResultLength: parseInt(process.env.TOOL_LOG_MAX_RESULT_LENGTH || '220', 10),
};
