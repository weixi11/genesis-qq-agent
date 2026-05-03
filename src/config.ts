/**
 * Genesis 配置管理
 * 从环境变量加载配置
 * 
 * 注意：工具相关配置已迁移到各工具文件内部
 * - 工具开关：各工具的 enabled() 读取 TOOL_XXX_ENABLED
 * - 工具 LLM：各工具内部创建自己的 LLMClient
 */

import 'dotenv/config';

export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface EmotionServiceConfig {
    baseUrl: string;
    healthTimeoutMs: number;
}

export interface WebConsoleConfig {
    port: number;
    host: string;
    apiToken: string;
    password: string;
    basePath: string;
}

/** Agent 功能开关配置 */
export interface AgentsConfig {
    /** 是否使用真正的多轮 ReAct 引擎（跳过 Router） */
    useTrueReAct: boolean;
    /** 哨兵 Agent 开关（false 时始终响应被 @ 的消息） */
    sentryEnabled: boolean;
    /** Router LLM 开关（false 时仅用规则匹配） */
    routerLlmEnabled: boolean;
    /** Router 规则匹配开关（false 时跳过快速规则匹配，全部走 LLM） */
    routerRuleMatchEnabled: boolean;
    /** Profiler Agent 开关（用户画像分析） */
    profilerEnabled: boolean;
    /** VectorDB 记忆存储开关 */
    vectordbEnabled: boolean;
    /** 情感分析开关 */
    emotionEnabled: boolean;
}

export interface Config {
    napcatWsUrl: string;

    // ============ Agent LLM 配置 ============
    llm: LlmConfig;
    sentryLlm: LlmConfig;
    routerLlm: LlmConfig;
    profilerLlm: LlmConfig;
    personaLlm: LlmConfig;
    techLlm: LlmConfig;
    reactLlm: LlmConfig;
    personaLoaderLlm: LlmConfig;  // 人设加载器专用
    autoMemeLlm: LlmConfig;
    embeddingLlm: LlmConfig;
    llmStrictIsolation: boolean;

    // Agent 开关
    agents: AgentsConfig;

    // 工具自维护
    selfMaintainer: {
        enabled: boolean;
        intervalMs: number;
        failureWindowMs: number;
        minFailures: number;
        cooldownMs: number;
        maxToolsPerRun: number;
        allowedTools: string[];
        blockedTools: string[];
    };

    // 管理员
    adminQQ: number[];
    masterQQ: number;     // 主人 QQ
    botQQ?: number;

    // 消息处理
    debounceDelayMs: number;
    memoryWindowSize: number;

    // 工具响应润色（true 时经过 Persona 润色，false 时直接返回原始结果）
    toolEnhanceResponse: boolean;

    // Tech 判断无需工具时是否交给 Persona 处理（true 时保持人设一致性）
    techFallbackToPersona: boolean;

    // 是否在最终回复中展示模型思考链/推理内容
    showReasoningChain: boolean;

    // 自动表情包
    autoMeme: {
        enabled: boolean;
        manifestPath: string;
        sourceDir: string;
        probability: number;
        perSessionCooldownMs: number;
        perUserCooldownMs: number;
        disableInPrivate: boolean;
        disableWhenToolSentMedia: boolean;
        maxRecentPerSession: number;
        maxRecentPerPackPerSession: number;
    };

    // 文件大小限制
    maxFileSizeBytes: number;

    // 日志
    logLevel: 'debug' | 'info' | 'warn' | 'error';

    // 上下文格式化配置
    context: {
        /** 默认最大消息数 */
        maxCount: number;
        /** 是否显示序号（默认 false） */
        showIndex: boolean;
        /** 是否显示媒体文件完整路径（默认 false 只显示标签） */
        showMediaPaths: boolean;
    };
}

function parseNumberArray(str: string | undefined): number[] {
    if (!str) return [];
    return str.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

function parseBool(str: string | undefined, defaultVal = false): boolean {
    if (!str) return defaultVal;
    return str.toLowerCase() === 'true' || str === '1';
}

function parseStringArray(str: string | undefined): string[] {
    if (!str) return [];
    return str.split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

export function normalizeWebBasePath(rawValue: string | undefined): string {
    const trimmed = (rawValue || '').trim();
    if (!trimmed || trimmed === '/') {
        return '';
    }

    const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
    return normalized === '/.' ? '' : normalized;
}

const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const llmStrictIsolation = parseBool(process.env.LLM_STRICT_ISOLATION, false);

function resolveModuleLlmConfig(
    baseUrlEnvKey: string,
    apiKeyEnvKey: string,
    modelEnvKey: string,
    defaultModel: string,
    options: {
        inheritBaseUrlFromMain?: boolean;
        inheritApiKeyFromMain?: boolean;
    } = {},
): LlmConfig {
    const explicitBaseUrl = process.env[baseUrlEnvKey]?.trim() || '';
    const explicitApiKey = process.env[apiKeyEnvKey] || '';
    const explicitModel = process.env[modelEnvKey]?.trim() || '';
    const mainBaseUrl = process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
    const mainApiKey = process.env.LLM_API_KEY || '';

    const baseUrl = explicitBaseUrl
        || (!llmStrictIsolation && options.inheritBaseUrlFromMain ? mainBaseUrl : DEFAULT_LLM_BASE_URL);
    const apiKey = explicitApiKey
        || (!llmStrictIsolation && options.inheritApiKeyFromMain ? mainApiKey : '');

    return {
        baseUrl,
        apiKey,
        model: explicitModel || defaultModel,
    };
}

export function getEmotionServiceConfig(): EmotionServiceConfig {
    return {
        baseUrl: process.env.SENTRA_EMO_URL || 'http://localhost:7200',
        healthTimeoutMs: parseInt(process.env.SENTRA_EMO_HEALTH_TIMEOUT_MS || '3000', 10),
    };
}

export function getWebConsoleConfig(): WebConsoleConfig {
    return {
        port: parseInt(process.env.WEB_PORT || '7300', 10),
        host: process.env.WEB_HOST || '127.0.0.1',
        apiToken: process.env.WEB_API_TOKEN?.trim() || '',
        password: process.env.WEB_PASSWORD?.trim() || '',
        basePath: normalizeWebBasePath(process.env.WEB_BASE_PATH),
    };
}

export const config: Config = {
    napcatWsUrl: process.env.NAPCAT_WS_URL || 'ws://localhost:6702',

    // 主 LLM
    llm: resolveModuleLlmConfig('LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'gpt-4o'),

    // 哨兵 LLM
    sentryLlm: resolveModuleLlmConfig(
        'SENTRY_LLM_BASE_URL',
        'SENTRY_LLM_API_KEY',
        'SENTRY_LLM_MODEL',
        'gpt-4o-mini',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Router LLM
    routerLlm: resolveModuleLlmConfig(
        'ROUTER_LLM_BASE_URL',
        'ROUTER_LLM_API_KEY',
        'ROUTER_LLM_MODEL',
        'gpt-4o-mini',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Profiler LLM
    profilerLlm: resolveModuleLlmConfig(
        'PROFILER_LLM_BASE_URL',
        'PROFILER_LLM_API_KEY',
        'PROFILER_LLM_MODEL',
        'gpt-4o-mini',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Persona LLM
    personaLlm: resolveModuleLlmConfig(
        'PERSONA_LLM_BASE_URL',
        'PERSONA_LLM_API_KEY',
        'PERSONA_LLM_MODEL',
        'gemini-3-flash-preview',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Tech LLM
    techLlm: resolveModuleLlmConfig(
        'TECH_LLM_BASE_URL',
        'TECH_LLM_API_KEY',
        'TECH_LLM_MODEL',
        'gemini-3-flash-preview',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // ReAct LLM
    reactLlm: resolveModuleLlmConfig(
        'REACT_LLM_BASE_URL',
        'REACT_LLM_API_KEY',
        'REACT_LLM_MODEL',
        'gemini-3-flash-preview',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Persona Loader LLM（人设文件解析专用）
    personaLoaderLlm: resolveModuleLlmConfig(
        'PERSONA_LOADER_LLM_BASE_URL',
        'PERSONA_LOADER_LLM_API_KEY',
        'PERSONA_LOADER_LLM_MODEL',
        'gemini-3-flash-preview',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Auto Meme LLM（自动表情判定专用）
    autoMemeLlm: resolveModuleLlmConfig(
        'AUTO_MEME_LLM_BASE_URL',
        'AUTO_MEME_LLM_API_KEY',
        'AUTO_MEME_LLM_MODEL',
        'gemini-3-flash-preview',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),

    // Embedding LLM（向量生成专用）
    embeddingLlm: resolveModuleLlmConfig(
        'EMBEDDING_BASE_URL',
        'EMBEDDING_API_KEY',
        'EMBEDDING_MODEL',
        'text-embedding-004',
        { inheritBaseUrlFromMain: true, inheritApiKeyFromMain: true },
    ),
    llmStrictIsolation,

    // Agent 开关
    agents: {
        useTrueReAct: parseBool(process.env.AGENT_USE_TRUE_REACT, true),
        sentryEnabled: parseBool(process.env.AGENT_SENTRY_ENABLED, true),
        routerLlmEnabled: parseBool(process.env.AGENT_ROUTER_LLM_ENABLED, true),
        routerRuleMatchEnabled: parseBool(process.env.AGENT_ROUTER_RULE_MATCH_ENABLED, true),
        profilerEnabled: parseBool(process.env.AGENT_PROFILER_ENABLED, true),
        vectordbEnabled: parseBool(process.env.AGENT_VECTORDB_ENABLED, true),
        emotionEnabled: parseBool(process.env.AGENT_EMOTION_ENABLED, true),
    },

    selfMaintainer: {
        enabled: parseBool(process.env.SELF_MAINTAINER_ENABLED, false),
        intervalMs: parseInt(process.env.SELF_MAINTAINER_INTERVAL_MS || '900000', 10),
        failureWindowMs: parseInt(process.env.SELF_MAINTAINER_FAILURE_WINDOW_MS || '1800000', 10),
        minFailures: parseInt(process.env.SELF_MAINTAINER_MIN_FAILURES || '2', 10),
        cooldownMs: parseInt(process.env.SELF_MAINTAINER_COOLDOWN_MS || '3600000', 10),
        maxToolsPerRun: parseInt(process.env.SELF_MAINTAINER_MAX_TOOLS_PER_RUN || '1', 10),
        allowedTools: parseStringArray(process.env.SELF_MAINTAINER_ALLOWED_TOOLS),
        blockedTools: parseStringArray(process.env.SELF_MAINTAINER_BLOCKED_TOOLS),
    },

    adminQQ: parseNumberArray(process.env.ADMIN_QQ),
    masterQQ: parseInt(process.env.MASTER_QQ || '0', 10),
    botQQ: process.env.BOT_QQ ? parseInt(process.env.BOT_QQ, 10) : undefined,

    debounceDelayMs: parseInt(process.env.DEBOUNCE_DELAY_MS || '1500', 10),
    memoryWindowSize: parseInt(process.env.MEMORY_WINDOW_SIZE || '10', 10),

    // 工具响应润色开关（默认开启）
    toolEnhanceResponse: parseBool(process.env.TOOL_ENHANCE_RESPONSE, false),

    // Tech 判断无需工具时是否交给 Persona 处理（默认开启）
    techFallbackToPersona: parseBool(process.env.TECH_FALLBACK_TO_PERSONA, false),

    // 最终回复默认隐藏思考链，避免把推理内容直接发给用户
    showReasoningChain: parseBool(process.env.SHOW_REASONING_CHAIN, false),

    autoMeme: {
        enabled: parseBool(process.env.AUTO_MEME_ENABLED, true),
        manifestPath: process.env.AUTO_MEME_MANIFEST_PATH || 'data/meme_packs/luoluo/manifest.json',
        sourceDir: process.env.AUTO_MEME_SOURCE_DIR || 'data/meme_packs/luoluo/assets',
        probability: Math.max(0, Math.min(1, Number(process.env.AUTO_MEME_PROBABILITY || '0.24'))),
        perSessionCooldownMs: parseInt(process.env.AUTO_MEME_PER_SESSION_COOLDOWN_MS || '90000', 10),
        perUserCooldownMs: parseInt(process.env.AUTO_MEME_PER_USER_COOLDOWN_MS || '120000', 10),
        disableInPrivate: parseBool(process.env.AUTO_MEME_DISABLE_IN_PRIVATE, false),
        disableWhenToolSentMedia: parseBool(process.env.AUTO_MEME_DISABLE_WHEN_TOOL_SENT_MEDIA, true),
        maxRecentPerSession: parseInt(process.env.AUTO_MEME_MAX_RECENT_PER_SESSION || '6', 10),
        maxRecentPerPackPerSession: parseInt(process.env.AUTO_MEME_MAX_RECENT_PER_PACK_PER_SESSION || '3', 10),
    },


    // 上传文件大小限制（默认 20MB）
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || '20971520', 10),

    logLevel: (process.env.LOG_LEVEL?.toLowerCase() as Config['logLevel']) || 'info',

    // 上下文格式化配置
    context: {
        maxCount: parseInt(process.env.CONTEXT_MAX_COUNT || '30', 10),
        showIndex: parseBool(process.env.CONTEXT_SHOW_INDEX, false),
        showMediaPaths: parseBool(process.env.CONTEXT_SHOW_MEDIA_PATHS, false),
    },
};

