import fs from 'fs';
import path from 'path';
import { config as appConfig, type LlmConfig } from '../config.js';
import { refreshRuntimeLlmClients } from '../llm.js';
import { log } from '../logger.js';
import { config as audioToolConfig } from '../tools/read_audio/config.js';
import { config as bananaDrawToolConfig } from '../tools/banana_draw/config.js';
import { config as createSkillToolConfig } from '../tools/create_skill/config.js';
import { config as drawToolConfig } from '../tools/draw/config.js';
import { config as fileToolConfig } from '../tools/read_file/config.js';
import { config as manageSkillToolConfig } from '../tools/manage_skill/config.js';
import { config as videoToolConfig } from '../tools/read_video/config.js';
import { config as visionToolConfig } from '../tools/vision/config.js';
import { parseEnvFileSync, updateEnvVariable } from '../utils/env.js';
import { isRecord, safeParseJson } from '../utils/json.js';
import { refreshPersonaLoaderLlm } from '../utils/personaLoader.js';

const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const PROVIDER_REGISTRY_ENV_KEY = 'LLM_PROVIDER_REGISTRY';
const PROVIDER_MODEL_CACHE_FILE = path.resolve(process.cwd(), 'data', 'llm-provider-model-cache.json');

type ModuleGroup = 'agent' | 'tool';

export type LlmModuleId =
    | 'main'
    | 'sentry'
    | 'router'
    | 'profiler'
    | 'persona'
    | 'tech'
    | 'react'
    | 'personaLoader'
    | 'autoMeme'
    | 'embedding'
    | 'bananaDraw'
    | 'draw'
    | 'vision'
    | 'audio'
    | 'video'
    | 'file'
    | 'createSkill'
    | 'manageSkill';

export interface LlmProviderRecord {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    modelsUpdatedAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface LlmProviderView {
    id: string;
    name: string;
    baseUrl: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
    usedBy: string[];
    usedByLabels: string[];
    models: string[];
    modelCount: number;
    modelsUpdatedAt: number | null;
    updatedAt: number;
}

export interface LlmModuleView {
    id: LlmModuleId;
    label: string;
    group: ModuleGroup;
    providerId: string;
    providerName: string;
    model: string;
    baseUrl: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
    isManaged: boolean;
    bindingMode: 'provider' | 'matched' | 'legacy';
    configSource: 'provider_binding' | 'module_override' | 'inherited_main' | 'default_fallback';
    configSourceLabel: string;
    strictIsolationEnabled: boolean;
    independentConfigured: boolean;
    inheritedFromMain: boolean;
    available: boolean;
    availabilityReason?: string;
}

export interface LlmProviderTemplate {
    id: string;
    label: string;
    baseUrl: string;
}

interface ResolvedModuleConfig {
    providerId: string;
    providerName: string;
    bindingMode: 'provider' | 'matched' | 'legacy';
    baseUrl: string;
    apiKey: string;
    model: string;
}

interface ResolvedModuleState {
    resolved: ResolvedModuleConfig;
    configSource: LlmModuleView['configSource'];
    configSourceLabel: string;
    strictIsolationEnabled: boolean;
    independentConfigured: boolean;
    inheritedFromMain: boolean;
    available: boolean;
    availabilityReason?: string;
}

interface ModuleDescriptor {
    id: LlmModuleId;
    label: string;
    group: ModuleGroup;
    baseUrlEnvKey: string;
    apiKeyEnvKey: string;
    modelEnvKey: string;
    legacyBaseUrlEnvKeys?: string[];
    legacyApiKeyEnvKeys?: string[];
    legacyModelEnvKeys?: string[];
    providerEnvKey: string;
    defaultModel: string;
    defaultBaseUrl: string;
    inheritBaseUrlFromMain: boolean;
    inheritApiKeyFromMain: boolean;
    moduleToggleEnvKey?: string;
    legacyToggleEnvKey?: string;
    getAgentConfig?: () => LlmConfig;
    getToolConfig?: () => {
        enabled: boolean;
        baseUrl: string;
        apiKey: string;
        model: string;
    };
}

interface ModelsApiResponse {
    data?: Array<{
        id?: string;
        owned_by?: string;
        object?: string;
    }>;
}

interface ChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
    }>;
}

interface LlmProviderModelCacheRecord {
    models: string[];
    modelsUpdatedAt: number | null;
}

type LlmProviderModelCacheMap = Record<string, LlmProviderModelCacheRecord>;

const PROVIDER_TEMPLATES: LlmProviderTemplate[] = [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
    { id: 'gptgod', label: 'GPTGod', baseUrl: 'https://api.gptgod.online/v1' },
    { id: 'senapi', label: 'SenAPI', baseUrl: 'https://senapi.fun/v1' },
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
];

const LLM_MODULES: readonly ModuleDescriptor[] = [
    {
        id: 'main',
        label: '主回复 Main',
        group: 'agent',
        baseUrlEnvKey: 'LLM_BASE_URL',
        apiKeyEnvKey: 'LLM_API_KEY',
        modelEnvKey: 'LLM_MODEL',
        providerEnvKey: 'LLM_PROVIDER_ID',
        defaultModel: 'gpt-4o',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: false,
        inheritApiKeyFromMain: false,
        getAgentConfig: () => appConfig.llm,
    },
    {
        id: 'sentry',
        label: '哨兵 Sentry',
        group: 'agent',
        baseUrlEnvKey: 'SENTRY_LLM_BASE_URL',
        apiKeyEnvKey: 'SENTRY_LLM_API_KEY',
        modelEnvKey: 'SENTRY_LLM_MODEL',
        providerEnvKey: 'SENTRY_LLM_PROVIDER_ID',
        defaultModel: 'gpt-4o-mini',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.sentryLlm,
    },
    {
        id: 'router',
        label: '路由 Router',
        group: 'agent',
        baseUrlEnvKey: 'ROUTER_LLM_BASE_URL',
        apiKeyEnvKey: 'ROUTER_LLM_API_KEY',
        modelEnvKey: 'ROUTER_LLM_MODEL',
        providerEnvKey: 'ROUTER_LLM_PROVIDER_ID',
        defaultModel: 'gpt-4o-mini',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.routerLlm,
    },
    {
        id: 'profiler',
        label: '画像 Profiler',
        group: 'agent',
        baseUrlEnvKey: 'PROFILER_LLM_BASE_URL',
        apiKeyEnvKey: 'PROFILER_LLM_API_KEY',
        modelEnvKey: 'PROFILER_LLM_MODEL',
        providerEnvKey: 'PROFILER_LLM_PROVIDER_ID',
        defaultModel: 'gpt-4o-mini',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.profilerLlm,
    },
    {
        id: 'persona',
        label: '人设 Persona',
        group: 'agent',
        baseUrlEnvKey: 'PERSONA_LLM_BASE_URL',
        apiKeyEnvKey: 'PERSONA_LLM_API_KEY',
        modelEnvKey: 'PERSONA_LLM_MODEL',
        providerEnvKey: 'PERSONA_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.personaLlm,
    },
    {
        id: 'tech',
        label: '工具 Tech',
        group: 'agent',
        baseUrlEnvKey: 'TECH_LLM_BASE_URL',
        apiKeyEnvKey: 'TECH_LLM_API_KEY',
        modelEnvKey: 'TECH_LLM_MODEL',
        providerEnvKey: 'TECH_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.techLlm,
    },
    {
        id: 'react',
        label: '推理 ReAct',
        group: 'agent',
        baseUrlEnvKey: 'REACT_LLM_BASE_URL',
        apiKeyEnvKey: 'REACT_LLM_API_KEY',
        modelEnvKey: 'REACT_LLM_MODEL',
        providerEnvKey: 'REACT_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.reactLlm,
    },
    {
        id: 'personaLoader',
        label: '人设加载 Persona Loader',
        group: 'agent',
        baseUrlEnvKey: 'PERSONA_LOADER_LLM_BASE_URL',
        apiKeyEnvKey: 'PERSONA_LOADER_LLM_API_KEY',
        modelEnvKey: 'PERSONA_LOADER_LLM_MODEL',
        providerEnvKey: 'PERSONA_LOADER_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.personaLoaderLlm,
    },
    {
        id: 'autoMeme',
        label: '自动表情 Auto Meme',
        group: 'agent',
        baseUrlEnvKey: 'AUTO_MEME_LLM_BASE_URL',
        apiKeyEnvKey: 'AUTO_MEME_LLM_API_KEY',
        modelEnvKey: 'AUTO_MEME_LLM_MODEL',
        providerEnvKey: 'AUTO_MEME_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.autoMemeLlm,
    },
    {
        id: 'embedding',
        label: '向量 Embedding',
        group: 'agent',
        baseUrlEnvKey: 'EMBEDDING_BASE_URL',
        apiKeyEnvKey: 'EMBEDDING_API_KEY',
        modelEnvKey: 'EMBEDDING_MODEL',
        providerEnvKey: 'EMBEDDING_PROVIDER_ID',
        defaultModel: 'text-embedding-004',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        getAgentConfig: () => appConfig.embeddingLlm,
    },
    {
        id: 'vision',
        label: '识图 Vision',
        group: 'tool',
        baseUrlEnvKey: 'VISION_LLM_BASE_URL',
        apiKeyEnvKey: 'VISION_LLM_API_KEY',
        modelEnvKey: 'VISION_LLM_MODEL',
        providerEnvKey: 'VISION_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_VISION_ENABLED',
        legacyToggleEnvKey: 'TOOL_VISION_ENABLED',
        getToolConfig: () => visionToolConfig,
    },
    {
        id: 'bananaDraw',
        label: 'Banana 绘图',
        group: 'tool',
        baseUrlEnvKey: 'BANANA_DRAW_LLM_BASE_URL',
        apiKeyEnvKey: 'BANANA_DRAW_LLM_API_KEY',
        modelEnvKey: 'BANANA_DRAW_LLM_MODEL',
        providerEnvKey: 'BANANA_DRAW_LLM_PROVIDER_ID',
        defaultModel: 'gpt-image-1',
        defaultBaseUrl: 'https://senapi.fun/v1',
        inheritBaseUrlFromMain: false,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_BANANA_DRAW_ENABLED',
        getToolConfig: () => bananaDrawToolConfig,
    },
    {
        id: 'draw',
        label: '绘图 Draw',
        group: 'tool',
        baseUrlEnvKey: 'DRAW_LLM_BASE_URL',
        apiKeyEnvKey: 'DRAW_LLM_API_KEY',
        modelEnvKey: 'DRAW_LLM_MODEL',
        legacyApiKeyEnvKeys: ['DRAW_API_KEY'],
        legacyModelEnvKeys: ['DRAW_MODEL'],
        providerEnvKey: 'DRAW_LLM_PROVIDER_ID',
        defaultModel: 'anishadow-v10-plus',
        defaultBaseUrl: 'https://senapi.fun/v1',
        inheritBaseUrlFromMain: false,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_DRAW_ENABLED',
        legacyToggleEnvKey: 'TOOL_DRAW_ENABLED',
        getToolConfig: () => drawToolConfig,
    },
    {
        id: 'audio',
        label: '音频 Audio',
        group: 'tool',
        baseUrlEnvKey: 'AUDIO_LLM_BASE_URL',
        apiKeyEnvKey: 'AUDIO_LLM_API_KEY',
        modelEnvKey: 'AUDIO_LLM_MODEL',
        providerEnvKey: 'AUDIO_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_READ_AUDIO_ENABLED',
        legacyToggleEnvKey: 'TOOL_READ_AUDIO_ENABLED',
        getToolConfig: () => audioToolConfig,
    },
    {
        id: 'video',
        label: '视频 Video',
        group: 'tool',
        baseUrlEnvKey: 'VIDEO_LLM_BASE_URL',
        apiKeyEnvKey: 'VIDEO_LLM_API_KEY',
        modelEnvKey: 'VIDEO_LLM_MODEL',
        providerEnvKey: 'VIDEO_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_READ_VIDEO_ENABLED',
        legacyToggleEnvKey: 'TOOL_READ_VIDEO_ENABLED',
        getToolConfig: () => videoToolConfig,
    },
    {
        id: 'file',
        label: '文件 File',
        group: 'tool',
        baseUrlEnvKey: 'FILE_LLM_BASE_URL',
        apiKeyEnvKey: 'FILE_LLM_API_KEY',
        modelEnvKey: 'FILE_LLM_MODEL',
        providerEnvKey: 'FILE_LLM_PROVIDER_ID',
        defaultModel: 'gemini-3-flash-preview',
        defaultBaseUrl: DEFAULT_LLM_BASE_URL,
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_READ_FILE_ENABLED',
        legacyToggleEnvKey: 'TOOL_READ_FILE_ENABLED',
        getToolConfig: () => fileToolConfig,
    },
    {
        id: 'createSkill',
        label: '造技能 Create Skill',
        group: 'tool',
        baseUrlEnvKey: 'CREATE_SKILL_LLM_BASE_URL',
        apiKeyEnvKey: 'CREATE_SKILL_LLM_API_KEY',
        modelEnvKey: 'CREATE_SKILL_LLM_MODEL',
        providerEnvKey: 'CREATE_SKILL_LLM_PROVIDER_ID',
        defaultModel: 'gpt-5.3-codex',
        defaultBaseUrl: 'http://127.0.0.1:8317/v1',
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_CREATE_SKILL_ENABLED',
        getToolConfig: () => createSkillToolConfig,
    },
    {
        id: 'manageSkill',
        label: '管技能 Manage Skill',
        group: 'tool',
        baseUrlEnvKey: 'MANAGE_SKILL_LLM_BASE_URL',
        apiKeyEnvKey: 'MANAGE_SKILL_LLM_API_KEY',
        modelEnvKey: 'MANAGE_SKILL_LLM_MODEL',
        providerEnvKey: 'MANAGE_SKILL_LLM_PROVIDER_ID',
        defaultModel: 'gpt-5.3-codex',
        defaultBaseUrl: 'http://127.0.0.1:8317/v1',
        inheritBaseUrlFromMain: true,
        inheritApiKeyFromMain: true,
        moduleToggleEnvKey: 'MODULE_MANAGE_SKILL_ENABLED',
        getToolConfig: () => manageSkillToolConfig,
    },
] as const;

function readModuleEnvValue(
    primaryKey: string,
    legacyKeys: string[] | undefined,
    envMap: Record<string, string> = getRuntimeEnvMap(),
): string | undefined {
    const primaryValue = readRuntimeEnvValue(primaryKey, envMap);
    if (primaryValue !== undefined && primaryValue !== '') {
        return primaryValue;
    }

    for (const key of legacyKeys || []) {
        const value = readRuntimeEnvValue(key, envMap);
        if (value !== undefined && value !== '') {
            return value;
        }
    }

    return primaryValue;
}

function isWebOnlyProcess(): boolean {
    return (process.env.GENESIS_PROCESS_ROLE || '').trim().toLowerCase() === 'web';
}

function getRuntimeEnvMap(): Record<string, string> {
    return isWebOnlyProcess() ? parseEnvFileSync(path.resolve(process.cwd(), '.env')) : {};
}

function readRuntimeEnvValue(key: string, envMap?: Record<string, string>): string | undefined {
    if (isWebOnlyProcess()) {
        return (envMap || getRuntimeEnvMap())[key];
    }
    return process.env[key];
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
    if (value === undefined) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
        return true;
    }
    if (normalized === 'false' || normalized === '0') {
        return false;
    }
    return fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
}

function maskApiKey(apiKey: string): string {
    if (!apiKey) return '';
    if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
    return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

function getLlmStrictIsolationEnabled(envMap?: Record<string, string>): boolean {
    return parseBooleanEnv(readRuntimeEnvValue('LLM_STRICT_ISOLATION', envMap), appConfig.llmStrictIsolation);
}

function getConfigSourceLabel(source: LlmModuleView['configSource']): string {
    switch (source) {
        case 'provider_binding':
            return '独立绑定供应商';
        case 'module_override':
            return '模块独立配置';
        case 'inherited_main':
            return '继承主配置';
        case 'default_fallback':
        default:
            return '默认回退';
    }
}

function normalizeModelList(models: unknown): string[] {
    if (!Array.isArray(models)) {
        return [];
    }

    return [...new Set(
        models
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
    )].sort((left, right) => left.localeCompare(right));
}

function serializeEnvValue(value: string): string {
    return JSON.stringify(value);
}

function ensureProviderModelCacheDir(): void {
    const dir = path.dirname(PROVIDER_MODEL_CACHE_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readProviderModelCache(): LlmProviderModelCacheMap {
    try {
        if (!fs.existsSync(PROVIDER_MODEL_CACHE_FILE)) {
            return {};
        }

        const raw = fs.readFileSync(PROVIDER_MODEL_CACHE_FILE, 'utf-8');
        if (!raw.trim()) {
            return {};
        }

        const parsed = safeParseJson(raw);
        if (!isRecord(parsed)) {
            return {};
        }

        const nextCache: LlmProviderModelCacheMap = {};
        for (const [providerId, value] of Object.entries(parsed)) {
            if (typeof providerId !== 'string' || !providerId.trim()) {
                continue;
            }

            if (!isRecord(value)) {
                continue;
            }

            const cacheValue = value as Partial<LlmProviderModelCacheRecord>;
            nextCache[providerId] = {
                models: normalizeModelList(cacheValue.models),
                modelsUpdatedAt: typeof cacheValue.modelsUpdatedAt === 'number'
                    ? cacheValue.modelsUpdatedAt || null
                    : null,
            };
        }

        return nextCache;
    } catch (error) {
        log.warn('读取 LLM 模型缓存失败，已忽略缓存文件', error);
        return {};
    }
}

function saveProviderModelCache(cache: LlmProviderModelCacheMap): boolean {
    try {
        ensureProviderModelCacheDir();
        fs.writeFileSync(PROVIDER_MODEL_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
        return true;
    } catch (error) {
        log.error('保存 LLM 模型缓存失败:', error);
        return false;
    }
}

function stripProviderCacheFields(providers: LlmProviderRecord[]) {
    return providers.map(({ models: _models, modelsUpdatedAt: _modelsUpdatedAt, ...provider }) => provider);
}

function mergeProviderModelCache(
    providers: LlmProviderRecord[],
    cacheMap: LlmProviderModelCacheMap
): { providers: LlmProviderRecord[]; migratedCache: LlmProviderModelCacheMap; hasLegacyCache: boolean } {
    let hasLegacyCache = false;
    const nextCache: LlmProviderModelCacheMap = { ...cacheMap };

    const nextProviders = providers.map((provider) => {
        const cached = nextCache[provider.id];
        if (cached) {
            return {
                ...provider,
                models: cached.models,
                modelsUpdatedAt: cached.modelsUpdatedAt,
            };
        }

        if (provider.models.length > 0 || provider.modelsUpdatedAt) {
            hasLegacyCache = true;
            nextCache[provider.id] = {
                models: provider.models,
                modelsUpdatedAt: provider.modelsUpdatedAt,
            };
        }

        return provider;
    });

    return {
        providers: nextProviders.map((provider) => {
            const cached = nextCache[provider.id];
            return {
                ...provider,
                models: cached?.models || [],
                modelsUpdatedAt: cached?.modelsUpdatedAt ?? null,
            };
        }),
        migratedCache: nextCache,
        hasLegacyCache,
    };
}

function getModuleDescriptor(moduleId: LlmModuleId): ModuleDescriptor {
    const descriptor = LLM_MODULES.find((item) => item.id === moduleId);
    if (!descriptor) {
        throw new Error(`未知的 LLM 模块: ${moduleId}`);
    }
    return descriptor;
}

function generateProviderId(): string {
    return `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getMainBaseUrl(envMap?: Record<string, string>): string {
    return normalizeBaseUrl(readRuntimeEnvValue('LLM_BASE_URL', envMap) || DEFAULT_LLM_BASE_URL);
}

function getMainApiKey(envMap?: Record<string, string>): string {
    return readRuntimeEnvValue('LLM_API_KEY', envMap) || '';
}

function readStoredProviders(): LlmProviderRecord[] {
    const raw = readRuntimeEnvValue(PROVIDER_REGISTRY_ENV_KEY);
    if (!raw) return [];

    try {
        const parsed = safeParseJson(raw);
        if (!Array.isArray(parsed)) return [];

        return parsed
            .filter((item): item is Partial<LlmProviderRecord> => isRecord(item))
            .map((item) => ({
                id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : generateProviderId(),
                name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名供应商',
                baseUrl: normalizeBaseUrl(typeof item.baseUrl === 'string' ? item.baseUrl : ''),
                apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
                models: normalizeModelList((item as { models?: unknown }).models),
                modelsUpdatedAt: typeof (item as { modelsUpdatedAt?: unknown }).modelsUpdatedAt === 'number'
                    ? (item as { modelsUpdatedAt?: number }).modelsUpdatedAt || null
                    : null,
                createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
                updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
            }))
            .filter((item) => item.baseUrl);
    } catch (error) {
        log.warn('解析 LLM_PROVIDER_REGISTRY 失败，已忽略旧值', error);
        return [];
    }
}

function saveProviderRegistry(providers: LlmProviderRecord[]): boolean {
    const strippedProviders = stripProviderCacheFields(providers);
    if (!isWebOnlyProcess()) {
        process.env[PROVIDER_REGISTRY_ENV_KEY] = JSON.stringify(strippedProviders);
    }
    return updateEnvVariable(PROVIDER_REGISTRY_ENV_KEY, serializeEnvValue(JSON.stringify(strippedProviders)));
}

function setProviderModelCache(providerId: string, models: string[], modelsUpdatedAt: number | null): boolean {
    const cacheMap = readProviderModelCache();
    cacheMap[providerId] = {
        models: normalizeModelList(models),
        modelsUpdatedAt,
    };
    return saveProviderModelCache(cacheMap);
}

function clearProviderModelCache(providerId: string): boolean {
    const cacheMap = readProviderModelCache();
    if (!(providerId in cacheMap)) {
        return true;
    }
    delete cacheMap[providerId];
    return saveProviderModelCache(cacheMap);
}

function resolveLegacyModuleConfig(
    moduleId: LlmModuleId,
    envMap: Record<string, string> = getRuntimeEnvMap(),
): Omit<ResolvedModuleConfig, 'providerId' | 'providerName' | 'bindingMode'> {
    const descriptor = getModuleDescriptor(moduleId);
    const fallbackBaseUrl = descriptor.inheritBaseUrlFromMain ? getMainBaseUrl(envMap) : descriptor.defaultBaseUrl;
    const fallbackApiKey = descriptor.inheritApiKeyFromMain ? getMainApiKey(envMap) : '';

    return {
        baseUrl: normalizeBaseUrl(readModuleEnvValue(descriptor.baseUrlEnvKey, descriptor.legacyBaseUrlEnvKeys, envMap) || fallbackBaseUrl),
        apiKey: readModuleEnvValue(descriptor.apiKeyEnvKey, descriptor.legacyApiKeyEnvKeys, envMap) || fallbackApiKey,
        model: (readModuleEnvValue(descriptor.modelEnvKey, descriptor.legacyModelEnvKeys, envMap) || descriptor.defaultModel).trim(),
    };
}

function findProviderByConfig(
    providers: LlmProviderRecord[],
    configToMatch: { baseUrl: string; apiKey: string }
): LlmProviderRecord | undefined {
    const baseUrl = normalizeBaseUrl(configToMatch.baseUrl);
    return providers.find(
        (provider) => normalizeBaseUrl(provider.baseUrl) === baseUrl && provider.apiKey === configToMatch.apiKey
    );
}

function buildSeedProviders(): LlmProviderRecord[] {
    const providers: LlmProviderRecord[] = [];
    const seen = new Set<string>();
    let index = 1;
    const envMap = getRuntimeEnvMap();
    const strictIsolationEnabled = getLlmStrictIsolationEnabled(envMap);

    for (const descriptor of LLM_MODULES) {
        const hasExplicitProvider = Boolean(readRuntimeEnvValue(descriptor.providerEnvKey, envMap)?.trim());
        const hasExplicitBaseUrl = Boolean(readModuleEnvValue(descriptor.baseUrlEnvKey, descriptor.legacyBaseUrlEnvKeys, envMap)?.trim());
        const hasExplicitApiKey = Boolean(readModuleEnvValue(descriptor.apiKeyEnvKey, descriptor.legacyApiKeyEnvKeys, envMap));
        if (
            strictIsolationEnabled
            && descriptor.id !== 'main'
            && !hasExplicitProvider
            && !hasExplicitBaseUrl
            && !hasExplicitApiKey
        ) {
            continue;
        }

        const resolved = resolveLegacyModuleConfig(descriptor.id, envMap);
        if (!resolved.baseUrl) continue;

        const signature = `${normalizeBaseUrl(resolved.baseUrl)}:::${resolved.apiKey}`;
        if (seen.has(signature)) continue;
        seen.add(signature);

        providers.push({
            id: `provider-seed-${index}`,
            name: index === 1 ? '默认供应商' : `导入供应商 ${index}`,
            baseUrl: normalizeBaseUrl(resolved.baseUrl),
            apiKey: resolved.apiKey,
            models: [],
            modelsUpdatedAt: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        index += 1;
    }

    return providers;
}

function ensureProviders(options: { persistChanges?: boolean } = {}): LlmProviderRecord[] {
    const persistChanges = options.persistChanges ?? true;
    const existing = readStoredProviders();
    if (existing.length > 0) {
        const merged = mergeProviderModelCache(existing, readProviderModelCache());
        if (merged.hasLegacyCache && persistChanges) {
            saveProviderModelCache(merged.migratedCache);
            saveProviderRegistry(merged.providers);
            log.info('🧠 已将 LLM 模型缓存迁移到 data/llm-provider-model-cache.json');
        }
        return merged.providers;
    }

    const seeded = buildSeedProviders();
    if (seeded.length > 0 && persistChanges) {
        saveProviderRegistry(seeded);
        log.info(`🧠 已从现有配置自动导入 ${seeded.length} 个 LLM 供应商`);
    }
    return seeded;
}

function resolveModuleConfig(moduleId: LlmModuleId, providers: LlmProviderRecord[]): ResolvedModuleConfig {
    const descriptor = getModuleDescriptor(moduleId);
    const envMap = getRuntimeEnvMap();
    const legacyConfig = resolveLegacyModuleConfig(moduleId, envMap);
    const boundProviderId = readRuntimeEnvValue(descriptor.providerEnvKey)?.trim() || '';

    if (boundProviderId) {
        const provider = providers.find((item) => item.id === boundProviderId);
        if (provider) {
            return {
                providerId: provider.id,
                providerName: provider.name,
                bindingMode: 'provider',
                baseUrl: normalizeBaseUrl(provider.baseUrl),
                apiKey: provider.apiKey,
                model: legacyConfig.model,
            };
        }
    }

    const matchedProvider = findProviderByConfig(providers, legacyConfig);
    if (matchedProvider) {
        return {
            providerId: matchedProvider.id,
            providerName: matchedProvider.name,
            bindingMode: 'matched',
            baseUrl: normalizeBaseUrl(matchedProvider.baseUrl),
            apiKey: matchedProvider.apiKey,
            model: legacyConfig.model,
        };
    }

    return {
        providerId: '',
        providerName: '未绑定供应商',
        bindingMode: 'legacy',
        baseUrl: legacyConfig.baseUrl,
        apiKey: legacyConfig.apiKey,
        model: legacyConfig.model,
    };
}

function getToolEnabledValue(descriptor: ModuleDescriptor, envMap: Record<string, string> = getRuntimeEnvMap()): boolean {
    const envEnabled = descriptor.moduleToggleEnvKey ? readRuntimeEnvValue(descriptor.moduleToggleEnvKey, envMap)?.toLowerCase() : undefined;
    const legacyEnabled = descriptor.legacyToggleEnvKey ? readRuntimeEnvValue(descriptor.legacyToggleEnvKey, envMap)?.toLowerCase() : undefined;
    const value = envEnabled ?? legacyEnabled;
    return value !== 'false' && value !== '0';
}

function resolveModuleState(moduleId: LlmModuleId, providers: LlmProviderRecord[]): ResolvedModuleState {
    const descriptor = getModuleDescriptor(moduleId);
    const envMap = getRuntimeEnvMap();
    const resolved = resolveModuleConfig(moduleId, providers);
    const boundProviderId = readRuntimeEnvValue(descriptor.providerEnvKey, envMap)?.trim() || '';
    const explicitBaseUrl = normalizeBaseUrl(readModuleEnvValue(descriptor.baseUrlEnvKey, descriptor.legacyBaseUrlEnvKeys, envMap) || '');
    const explicitApiKey = readModuleEnvValue(descriptor.apiKeyEnvKey, descriptor.legacyApiKeyEnvKeys, envMap) || '';
    const hasExplicitBaseUrl = explicitBaseUrl.length > 0;
    const hasExplicitApiKey = explicitApiKey.length > 0;
    const strictIsolationEnabled = getLlmStrictIsolationEnabled(envMap);
    const inheritedBaseUrl = descriptor.id !== 'main'
        && descriptor.inheritBaseUrlFromMain
        && !boundProviderId
        && !hasExplicitBaseUrl;
    const inheritedApiKey = descriptor.id !== 'main'
        && descriptor.inheritApiKeyFromMain
        && !boundProviderId
        && !hasExplicitApiKey;
    const inheritedFromMain = inheritedBaseUrl || inheritedApiKey;
    const independentConfigured = descriptor.id === 'main' || Boolean(boundProviderId || hasExplicitBaseUrl || hasExplicitApiKey);

    const configSource: LlmModuleView['configSource'] = boundProviderId
        ? 'provider_binding'
        : descriptor.id !== 'main' && independentConfigured
            ? 'module_override'
            : inheritedFromMain
                ? 'inherited_main'
                : 'default_fallback';

    let available = true;
    let availabilityReason: string | undefined;

    if (descriptor.id !== 'main' && strictIsolationEnabled && inheritedFromMain) {
        available = false;
        availabilityReason = '严格隔离已开启，当前模块仍在继承主配置';
    } else if (!resolved.apiKey) {
        available = false;
        availabilityReason = '未配置 API Key';
    } else if (descriptor.group === 'tool' && !getToolEnabledValue(descriptor, envMap)) {
        available = false;
        availabilityReason = '模块已禁用';
    }

    return {
        resolved,
        configSource,
        configSourceLabel: getConfigSourceLabel(configSource),
        strictIsolationEnabled,
        independentConfigured,
        inheritedFromMain,
        available,
        availabilityReason,
    };
}

function applyResolvedConfig(descriptor: ModuleDescriptor, state: ResolvedModuleState): void {
    const effectiveApiKey = state.available ? state.resolved.apiKey : '';

    if (descriptor.getAgentConfig) {
        const target = descriptor.getAgentConfig();
        target.baseUrl = state.resolved.baseUrl;
        target.apiKey = effectiveApiKey;
        target.model = state.resolved.model;
        return;
    }

    if (descriptor.getToolConfig) {
        const target = descriptor.getToolConfig();
        target.baseUrl = state.resolved.baseUrl;
        target.apiKey = effectiveApiKey;
        target.model = state.resolved.model;
        target.enabled = state.available && getToolEnabledValue(descriptor);
    }
}

export function syncRuntimeLlmProviders(): void {
    if (isWebOnlyProcess()) {
        return;
    }

    const providers = ensureProviders();
    for (const descriptor of LLM_MODULES) {
        applyResolvedConfig(descriptor, resolveModuleState(descriptor.id, providers));
    }

    refreshRuntimeLlmClients();
    refreshPersonaLoaderLlm();
}

function getModuleViews(providers: LlmProviderRecord[]): LlmModuleView[] {
    return LLM_MODULES.map((descriptor) => {
        const state = resolveModuleState(descriptor.id, providers);
        return {
            id: descriptor.id,
            label: descriptor.label,
            group: descriptor.group,
            providerId: state.resolved.providerId,
            providerName: state.resolved.providerName,
            model: state.resolved.model,
            baseUrl: state.resolved.baseUrl,
            hasApiKey: state.resolved.apiKey.length > 0,
            apiKeyMasked: maskApiKey(state.resolved.apiKey),
            isManaged: Boolean(state.resolved.providerId),
            bindingMode: state.resolved.bindingMode,
            configSource: state.configSource,
            configSourceLabel: state.configSourceLabel,
            strictIsolationEnabled: state.strictIsolationEnabled,
            independentConfigured: state.independentConfigured,
            inheritedFromMain: state.inheritedFromMain,
            available: state.available,
            availabilityReason: state.availabilityReason,
        };
    });
}

function getProviderViews(providers: LlmProviderRecord[], modules: LlmModuleView[]): LlmProviderView[] {
    return providers.map((provider) => {
        const usedByModules = modules.filter((item) => item.providerId === provider.id);
        return {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            hasApiKey: provider.apiKey.length > 0,
            apiKeyMasked: maskApiKey(provider.apiKey),
            usedBy: usedByModules.map((item) => item.id),
            usedByLabels: usedByModules.map((item) => item.label),
            models: provider.models,
            modelCount: provider.models.length,
            modelsUpdatedAt: provider.modelsUpdatedAt,
            updatedAt: provider.updatedAt,
        };
    });
}

export function getLlmDashboardState(options: { persistChanges?: boolean } = {}): {
    modules: LlmModuleView[];
    providers: LlmProviderView[];
    templates: LlmProviderTemplate[];
} {
    const providers = ensureProviders(options);
    const modules = getModuleViews(providers);
    return {
        modules,
        providers: getProviderViews(providers, modules),
        templates: PROVIDER_TEMPLATES,
    };
}

function setEnvValue(key: string, value: string, sensitive = false): boolean {
    if (!isWebOnlyProcess()) {
        process.env[key] = value;
    }
    return updateEnvVariable(key, serializeEnvValue(value), sensitive ? { sensitive: true } : undefined);
}

function getModuleIdsUsingProvider(providerId: string, providers: LlmProviderRecord[]): LlmModuleId[] {
    return LLM_MODULES
        .filter((descriptor) => resolveModuleConfig(descriptor.id, providers).providerId === providerId)
        .map((descriptor) => descriptor.id);
}

function validateProviderInput(input: { name?: string; baseUrl?: string }) {
    const name = String(input.name || '').trim();
    const baseUrl = normalizeBaseUrl(String(input.baseUrl || ''));

    if (!name) {
        throw new Error('供应商名称不能为空');
    }

    if (!baseUrl) {
        throw new Error('Base URL 不能为空');
    }

    return { name, baseUrl };
}

export function createProvider(input: { name?: string; baseUrl?: string; apiKey?: string }) {
    const providers = ensureProviders();
    const { name, baseUrl } = validateProviderInput(input);
    const apiKey = String(input.apiKey || '').trim();

    if (providers.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('供应商名称已存在');
    }

    const provider: LlmProviderRecord = {
        id: generateProviderId(),
        name,
        baseUrl,
        apiKey,
        models: [],
        modelsUpdatedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const nextProviders = [...providers, provider];
    const saved = saveProviderRegistry(nextProviders);
    syncRuntimeLlmProviders();

    return {
        saved,
        provider: getProviderViews(nextProviders, getModuleViews(nextProviders)).find((item) => item.id === provider.id),
    };
}

export function updateProvider(providerId: string, input: { name?: string; baseUrl?: string; apiKey?: string }) {
    const providers = ensureProviders();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        throw new Error('供应商不存在');
    }

    const { name, baseUrl } = validateProviderInput(input);
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : provider.apiKey;
    const connectionChanged = normalizeBaseUrl(provider.baseUrl) !== baseUrl || provider.apiKey !== apiKey;

    if (providers.some((item) => item.id !== providerId && item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('供应商名称已存在');
    }

    const previousProviders = [...providers];
    const dependentModuleIds = getModuleIdsUsingProvider(providerId, previousProviders);

    const nextProviders = providers.map((item) =>
        item.id === providerId
            ? {
                ...item,
                name,
                baseUrl,
                apiKey,
                models: connectionChanged ? [] : item.models,
                modelsUpdatedAt: connectionChanged ? null : item.modelsUpdatedAt,
                updatedAt: Date.now(),
            }
            : item
    );

    const savedRegistry = saveProviderRegistry(nextProviders);
    const savedCache = connectionChanged
        ? clearProviderModelCache(providerId)
        : true;
    let savedBindings = true;
    for (const moduleId of dependentModuleIds) {
        const descriptor = getModuleDescriptor(moduleId);
        const model = resolveModuleConfig(moduleId, previousProviders).model;
        savedBindings = setEnvValue(descriptor.providerEnvKey, providerId) && savedBindings;
        savedBindings = setEnvValue(descriptor.baseUrlEnvKey, baseUrl) && savedBindings;
        savedBindings = setEnvValue(descriptor.apiKeyEnvKey, apiKey, true) && savedBindings;
        savedBindings = setEnvValue(descriptor.modelEnvKey, model) && savedBindings;
    }

    syncRuntimeLlmProviders();

    return {
        saved: savedRegistry && savedBindings && savedCache,
        provider: getProviderViews(nextProviders, getModuleViews(nextProviders)).find((item) => item.id === providerId),
    };
}

export function deleteProvider(providerId: string) {
    const providers = ensureProviders();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        throw new Error('供应商不存在');
    }

    const modules = getModuleViews(providers).filter((item) => item.providerId === providerId);
    if (modules.length > 0) {
        throw new Error(`该供应商仍被以下模块使用: ${modules.map((item) => item.label).join('、')}`);
    }

    const nextProviders = providers.filter((item) => item.id !== providerId);
    const saved = saveProviderRegistry(nextProviders) && clearProviderModelCache(providerId);
    syncRuntimeLlmProviders();
    return { saved };
}

export function saveModuleBinding(moduleId: LlmModuleId, input: { providerId?: string; model?: string }) {
    const providers = ensureProviders();
    const descriptor = getModuleDescriptor(moduleId);
    const providerId = String(input.providerId || '').trim();
    const model = String(input.model || '').trim();

    if (!providerId) {
        throw new Error('请选择供应商');
    }

    if (!model) {
        throw new Error('模型不能为空');
    }

    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        throw new Error('供应商不存在');
    }

    const savedProvider = setEnvValue(descriptor.providerEnvKey, provider.id);
    const savedBaseUrl = setEnvValue(descriptor.baseUrlEnvKey, provider.baseUrl);
    const savedApiKey = setEnvValue(descriptor.apiKeyEnvKey, provider.apiKey, true);
    const savedModel = setEnvValue(descriptor.modelEnvKey, model);

    syncRuntimeLlmProviders();

    return {
        saved: savedProvider && savedBaseUrl && savedApiKey && savedModel,
        module: getModuleViews(providers).find((item) => item.id === moduleId),
    };
}

function extractModelIds(data: ModelsApiResponse): string[] {
    return normalizeModelList(
        Array.isArray(data.data)
            ? data.data.map((item) => (typeof item.id === 'string' ? item.id : '')).filter(Boolean)
            : []
    );
}

function joinApiPath(baseUrl: string, path: string): string {
    return `${normalizeBaseUrl(baseUrl)}${path}`;
}

function createAuthHeaders(apiKey: string): Record<string, string> {
    return apiKey
        ? {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        }
        : {
            'Content-Type': 'application/json',
        };
}

function sortModelIds(modelIds: string[], query: string): string[] {
    const normalizedQuery = query.trim().toLowerCase();
    return [...modelIds].sort((left, right) => {
        const leftStarts = normalizedQuery ? left.toLowerCase().startsWith(normalizedQuery) : false;
        const rightStarts = normalizedQuery ? right.toLowerCase().startsWith(normalizedQuery) : false;
        if (leftStarts !== rightStarts) {
            return leftStarts ? -1 : 1;
        }
        return left.localeCompare(right);
    });
}

export function fetchProviderModels(providerId: string, query = '') {
    const providers = ensureProviders();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        throw new Error('供应商不存在');
    }
    const filtered = query
        ? provider.models.filter((item) => item.toLowerCase().includes(query.trim().toLowerCase()))
        : provider.models;

    return {
        provider: {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            modelCount: provider.models.length,
            modelsUpdatedAt: provider.modelsUpdatedAt,
        },
        models: sortModelIds(filtered, query),
    };
}

export async function refreshProviderModels(providerId: string) {
    const providers = ensureProviders();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        throw new Error('供应商不存在');
    }

    const response = await fetch(joinApiPath(provider.baseUrl, '/models'), {
        method: 'GET',
        headers: createAuthHeaders(provider.apiKey),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`拉取模型失败: ${response.status} ${errorText}`);
    }

    const data = await response.json() as ModelsApiResponse;
    const models = extractModelIds(data);
    const refreshedAt = Date.now();
    const nextProviders = providers.map((item) =>
        item.id === providerId
            ? { ...item, models, modelsUpdatedAt: refreshedAt }
            : item
    );
    const saved = setProviderModelCache(providerId, models, refreshedAt);

    return {
        saved,
        models,
        provider: getProviderViews(nextProviders, getModuleViews(nextProviders)).find((item) => item.id === providerId),
    };
}

export async function testProviderModel(providerId: string, model: string) {
    const providers = ensureProviders();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        throw new Error('供应商不存在');
    }

    const selectedModel = model.trim();
    if (!selectedModel) {
        throw new Error('测试模型不能为空');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const startedAt = Date.now();

    try {
        const response = await fetch(joinApiPath(provider.baseUrl, '/chat/completions'), {
            method: 'POST',
            headers: createAuthHeaders(provider.apiKey),
            signal: controller.signal,
            body: JSON.stringify({
                model: selectedModel,
                messages: [
                    { role: 'system', content: 'Reply with OK only.' },
                    { role: 'user', content: 'ping' },
                ],
                max_tokens: 8,
                temperature: 0,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`测试失败: ${response.status} ${errorText}`);
        }

        const data = await response.json() as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content?.trim() || '';

        return {
            success: true,
            latencyMs: Date.now() - startedAt,
            provider: {
                id: provider.id,
                name: provider.name,
            },
            model: selectedModel,
            preview: content,
        };
    } finally {
        clearTimeout(timeout);
    }
}
