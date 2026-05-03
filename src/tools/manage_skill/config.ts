/**
 * Manage Skill 模块配置
 */

const strictIsolationEnabled = ['true', '1'].includes((process.env.LLM_STRICT_ISOLATION || '').trim().toLowerCase());
const manageSkillApiKey = process.env.MANAGE_SKILL_LLM_API_KEY || (!strictIsolationEnabled ? process.env.LLM_API_KEY || '' : '');
const manageSkillBaseUrl = process.env.MANAGE_SKILL_LLM_BASE_URL || (!strictIsolationEnabled ? process.env.LLM_BASE_URL || 'http://127.0.0.1:8317/v1' : 'http://127.0.0.1:8317/v1');

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_MANAGE_SKILL_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0' && !!manageSkillApiKey;
    })(),

    /** LLM API 地址（代码修改/修复专用） */
    baseUrl: manageSkillBaseUrl,

    /** LLM API 密钥 */
    apiKey: manageSkillApiKey,

    /** LLM 模型名 */
    model: process.env.MANAGE_SKILL_LLM_MODEL || 'gpt-5.3-codex',

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.MANAGE_SKILL_TIMEOUT_MS || '120000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.MANAGE_SKILL_CONCURRENCY || '1', 10),
};
