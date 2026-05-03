/**
 * Blog Tag 模块配置
 *
 * 独立管理博客标签模块的配置项
 */

export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_BLOG_TAG_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_BLOG_TAG_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        const apiBase = process.env.BLOG_API_BASE_URL?.trim();
        return (value !== 'false' && value !== '0') && !!apiBase;
    })(),

    /** 博客 API 基础地址 */
    apiBaseUrl: process.env.BLOG_API_BASE_URL?.trim() || '',

    /** 博客 API 认证 Token（Bearer） */
    apiToken: process.env.BLOG_API_TOKEN?.trim() || '',

    /** 博客后台登录用户名 */
    apiUsername: process.env.BLOG_API_USERNAME?.trim() || '',

    /** 博客后台登录密码 */
    apiPassword: process.env.BLOG_API_PASSWORD?.trim() || '',

    /** 博客后台登录请求头类型 */
    loginClientType: process.env.BLOG_API_LOGIN_CLIENT_TYPE?.trim() || 'Backend',

    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.BLOG_TAG_TIMEOUT_MS || '10000', 10),

    /** 最大并发数 */
    concurrency: parseInt(process.env.BLOG_TAG_CONCURRENCY || '5', 10),
};
