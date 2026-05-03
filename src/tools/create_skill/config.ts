/**
 * Create Skill 模块配置
 */

const strictIsolationEnabled = ['true', '1'].includes((process.env.LLM_STRICT_ISOLATION || '').trim().toLowerCase());
const createSkillApiKey = process.env.CREATE_SKILL_LLM_API_KEY || (!strictIsolationEnabled ? process.env.LLM_API_KEY || '' : '');
const createSkillBaseUrl = process.env.CREATE_SKILL_LLM_BASE_URL || (!strictIsolationEnabled ? process.env.LLM_BASE_URL || 'http://127.0.0.1:8317/v1' : 'http://127.0.0.1:8317/v1');

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_CREATE_SKILL_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0' && !!createSkillApiKey;
    })(),

    /** LLM API 地址（代码生成专用，可回退） */
    baseUrl: createSkillBaseUrl,

    /** LLM API 密钥 */
    apiKey: createSkillApiKey,

    /** LLM 模型名（建议用能力强的模型） */
    model: process.env.CREATE_SKILL_LLM_MODEL || 'gpt-5.3-codex',

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.CREATE_SKILL_TIMEOUT_MS || '120000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.CREATE_SKILL_CONCURRENCY || '1', 10),
};
