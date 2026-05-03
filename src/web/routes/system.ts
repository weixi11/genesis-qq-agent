import express from 'express';
import type { Router, Request, Response } from 'express';
import os from 'os';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { debouncer } from '../../debouncer.js';
import { memory } from '../../memory.js';
import {
    createProvider,
    deleteProvider,
    fetchProviderModels,
    getLlmDashboardState,
    refreshProviderModels,
    saveModuleBinding,
    syncRuntimeLlmProviders,
    testProviderModel,
    type LlmModuleId,
    updateProvider,
} from '../../services/llm_provider_service.js';
import { toolSelfMaintainer } from '../../services/tool_self_maintainer.js';
import { taskManager } from '../../task/index.js';
import { getTaskFromDisk, getTaskStatsFromDisk, listTasksFromDisk } from '../../task/manager.js';
import { getAllModules, getEnabledModules } from '../../tools/index.js';
import { connector } from '../../connector.js';
import { parseEnvFileSync, updateEnvVariable } from '../../utils/env.js';
import { getBotAvatarUrl, getUserAvatarUrl } from '../../utils/urls.js';
import {
    controlGenesisAgentProcess,
    controlAdapterProcess,
    createNoProcessSyncResult,
    createSkippedProcessSyncResult,
    getGenesisProcessRole,
    getGenesisAgentProcessStatus,
    getAdapterProcessStatus,
    syncAdapterProcess,
    syncGenesisAgentProcess,
    type ManagedProcessAction,
    type ProcessSyncResult,
} from '../services/process_control.js';

const startTime = Date.now();
const DEFAULT_ADAPTER_ENV_PATH = '/root/ll/genesis-napcat-adapter/.env';

interface AdapterRuntimeConfig {
    mode: 'forward' | 'reverse';
    napcatWsUrl: string;
    accessTokenConfigured: boolean;
    accessTokenPreview: string;
    ownerQq: string;
    ownerNotifyText: string;
    reverseHost: string;
    reversePort: number;
    reversePath: string;
    enableStream: boolean;
    streamHost: string;
    streamPort: number;
}

interface RuntimeConfigMeta {
    processRole: 'agent' | 'web';
    agentConfigSource: 'live_memory' | 'saved_env';
    adapterConfigSource: 'saved_env';
}

function getAdapterEnvPath(): string {
    return path.resolve(process.env.GENESIS_ADAPTER_ENV_PATH || DEFAULT_ADAPTER_ENV_PATH);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumberArrayEnv(value: string | undefined, fallback: number[]): number[] {
    if (!value) return fallback;
    const parsed = value
        .split(',')
        .map(item => Number.parseInt(item.trim(), 10))
        .filter(item => Number.isFinite(item));
    return parsed.length > 0 ? parsed : fallback;
}

function parseStringArrayEnv(value: string | undefined, fallback: string[]): string[] {
    if (!value) return fallback;
    const parsed = value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
}

function readToolEnabledFromEnv(name: string, env: Record<string, string>, fallback: boolean): boolean {
    return parseBooleanEnv(env[`MODULE_${name.toUpperCase()}_ENABLED`], fallback);
}

function serializeEnvValue(value: string): string {
    return /[\s"'#]/.test(value) ? JSON.stringify(value) : value;
}

function maskSecretPreview(value: string): string {
    if (!value) return '';
    if (value.length <= 4) return '*'.repeat(value.length);
    return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

function getAdapterRuntimeConfig(): AdapterRuntimeConfig {
    const env = parseEnvFileSync(getAdapterEnvPath());
    const accessToken = env.NAPCAT_ACCESS_TOKEN || '';

    return {
        mode: env.MODE === 'forward' ? 'forward' : 'reverse',
        napcatWsUrl: env.NAPCAT_WS_URL || 'ws://127.0.0.1:6700',
        accessTokenConfigured: accessToken.length > 0,
        accessTokenPreview: maskSecretPreview(accessToken),
        ownerQq: env.OWNER_QQ || '',
        ownerNotifyText: env.OWNER_NOTIFY_TEXT || '',
        reverseHost: env.REVERSE_HOST || '0.0.0.0',
        reversePort: parseIntegerEnv(env.REVERSE_PORT, 6701),
        reversePath: env.REVERSE_PATH || '/onebot',
        enableStream: parseBooleanEnv(env.ENABLE_STREAM, true),
        streamHost: env.STREAM_HOST || '0.0.0.0',
        streamPort: parseIntegerEnv(env.STREAM_PORT, 6702),
    };
}

function isWebOnlyProcess(): boolean {
    return getGenesisProcessRole() === 'web';
}

function getRuntimeConfigMeta(): RuntimeConfigMeta {
    return {
        processRole: getGenesisProcessRole(),
        agentConfigSource: isWebOnlyProcess() ? 'saved_env' : 'live_memory',
        adapterConfigSource: 'saved_env',
    };
}

function getAppRuntimeEnvSnapshot(): Record<string, string> {
    return parseEnvFileSync(path.resolve(process.cwd(), '.env'));
}

// 获取磁盘信息（跨平台）
function getDiskInfo() {
    try {
        if (os.platform() === 'win32') {
            // Windows: 使用 wmic 命令
            const output = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf8' });
            const lines = output.trim().split('\n').slice(1);
            let totalSize = 0;
            let totalFree = 0;
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3 && parts[1] && parts[2]) {
                    totalFree += parseInt(parts[1], 10) || 0;
                    totalSize += parseInt(parts[2], 10) || 0;
                }
            }
            if (totalSize > 0) {
                const usedSize = totalSize - totalFree;
                return {
                    total: Math.round(totalSize / 1024 / 1024 / 1024 * 100) / 100,
                    used: Math.round(usedSize / 1024 / 1024 / 1024 * 100) / 100,
                    free: Math.round(totalFree / 1024 / 1024 / 1024 * 100) / 100,
                    usagePercent: Math.round(usedSize / totalSize * 100),
                };
            }
        } else {
            // Linux/macOS: 使用 df 命令
            const output = execSync("df -B1 / | tail -1", { encoding: 'utf8' });
            const parts = output.trim().split(/\s+/);
            if (parts.length >= 4) {
                const totalSize = parseInt(parts[1], 10);
                const usedSize = parseInt(parts[2], 10);
                const freeSize = parseInt(parts[3], 10);
                return {
                    total: Math.round(totalSize / 1024 / 1024 / 1024 * 100) / 100,
                    used: Math.round(usedSize / 1024 / 1024 / 1024 * 100) / 100,
                    free: Math.round(freeSize / 1024 / 1024 / 1024 * 100) / 100,
                    usagePercent: Math.round(usedSize / totalSize * 100),
                };
            }
        }
    } catch {
        // 忽略错误，返回默认值
    }
    return { total: 0, used: 0, free: 0, usagePercent: 0 };
}

function getSystemInfo() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // 计算 CPU 使用率（基于空闲时间）
    let cpuUsagePercent = 0;
    if (cpus.length > 0) {
        const totalIdle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
        const totalTick = cpus.reduce((acc, cpu) =>
            acc + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq, 0);
        cpuUsagePercent = Math.round((1 - totalIdle / totalTick) * 100);
    }

    // 网络接口信息
    const nets = os.networkInterfaces();
    const network = Object.entries(nets)
        .filter(([name]) => !name.toLowerCase().includes('loopback'))
        .map(([name, addrs]) => ({
            name,
            ipv4: addrs?.find(a => a.family === 'IPv4')?.address || null
        }))
        .filter(n => n.ipv4)
        .slice(0, 3); // 最多返回 3 个网卡

    // 磁盘信息
    const disk = getDiskInfo();

    return {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: Math.floor(os.uptime()),
        nodeVersion: process.version,
        cpu: {
            model: cpus[0]?.model || 'Unknown',
            cores: cpus.length,
            usagePercent: cpuUsagePercent,
        },
        memory: {
            total: Math.round(totalMem / 1024 / 1024 / 1024 * 100) / 100,
            used: Math.round(usedMem / 1024 / 1024 / 1024 * 100) / 100,
            free: Math.round(freeMem / 1024 / 1024 / 1024 * 100) / 100,
            usagePercent: Math.round(usedMem / totalMem * 100),
        },
        disk,
        process: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - startTime) / 1000),
        },
        network,
    };
}

function getRuntimeConfig() {
    const env = isWebOnlyProcess() ? getAppRuntimeEnvSnapshot() : {};
    const llm = getLlmDashboardState({ persistChanges: !isWebOnlyProcess() });
    const enabledNames = new Set(getEnabledModules().map(item => item.module.name));
    const tools = Object.fromEntries(
        getAllModules().map(item => [
            item.module.name,
            isWebOnlyProcess()
                ? readToolEnabledFromEnv(item.module.name, env, enabledNames.has(item.module.name))
                : enabledNames.has(item.module.name),
        ])
    );
    const adapter = getAdapterRuntimeConfig();

    return {
        napcatWsUrl: isWebOnlyProcess()
            ? (env.NAPCAT_WS_URL || config.napcatWsUrl)
            : config.napcatWsUrl,
        adapter,
        runtimeMeta: getRuntimeConfigMeta(),
        botQQ: isWebOnlyProcess()
            ? (env.BOT_QQ ? parseIntegerEnv(env.BOT_QQ, config.botQQ || 0) || undefined : config.botQQ)
            : config.botQQ,
        adminQQ: isWebOnlyProcess()
            ? parseNumberArrayEnv(env.ADMIN_QQ, config.adminQQ)
            : config.adminQQ,
        llm,
        agents: isWebOnlyProcess()
            ? {
                useTrueReAct: parseBooleanEnv(env.AGENT_USE_TRUE_REACT, config.agents.useTrueReAct),
                sentryEnabled: parseBooleanEnv(env.AGENT_SENTRY_ENABLED, config.agents.sentryEnabled),
                routerLlmEnabled: parseBooleanEnv(env.AGENT_ROUTER_LLM_ENABLED, config.agents.routerLlmEnabled),
                routerRuleMatchEnabled: parseBooleanEnv(env.AGENT_ROUTER_RULE_MATCH_ENABLED, config.agents.routerRuleMatchEnabled),
                profilerEnabled: parseBooleanEnv(env.AGENT_PROFILER_ENABLED, config.agents.profilerEnabled),
                vectordbEnabled: parseBooleanEnv(env.AGENT_VECTORDB_ENABLED, config.agents.vectordbEnabled),
                emotionEnabled: parseBooleanEnv(env.AGENT_EMOTION_ENABLED, config.agents.emotionEnabled),
            }
            : config.agents,
        tools,
        autoMeme: {
            enabled: isWebOnlyProcess()
                ? parseBooleanEnv(env.AUTO_MEME_ENABLED, config.autoMeme.enabled)
                : config.autoMeme.enabled,
            probability: isWebOnlyProcess()
                ? parseFloatEnv(env.AUTO_MEME_PROBABILITY, config.autoMeme.probability)
                : config.autoMeme.probability,
            perSessionCooldownMs: isWebOnlyProcess()
                ? parseIntegerEnv(env.AUTO_MEME_PER_SESSION_COOLDOWN_MS, config.autoMeme.perSessionCooldownMs)
                : config.autoMeme.perSessionCooldownMs,
            perUserCooldownMs: isWebOnlyProcess()
                ? parseIntegerEnv(env.AUTO_MEME_PER_USER_COOLDOWN_MS, config.autoMeme.perUserCooldownMs)
                : config.autoMeme.perUserCooldownMs,
            disableInPrivate: isWebOnlyProcess()
                ? parseBooleanEnv(env.AUTO_MEME_DISABLE_IN_PRIVATE, config.autoMeme.disableInPrivate)
                : config.autoMeme.disableInPrivate,
            disableWhenToolSentMedia: isWebOnlyProcess()
                ? parseBooleanEnv(env.AUTO_MEME_DISABLE_WHEN_TOOL_SENT_MEDIA, config.autoMeme.disableWhenToolSentMedia)
                : config.autoMeme.disableWhenToolSentMedia,
            maxRecentPerSession: isWebOnlyProcess()
                ? parseIntegerEnv(env.AUTO_MEME_MAX_RECENT_PER_SESSION, config.autoMeme.maxRecentPerSession)
                : config.autoMeme.maxRecentPerSession,
            maxRecentPerPackPerSession: isWebOnlyProcess()
                ? parseIntegerEnv(env.AUTO_MEME_MAX_RECENT_PER_PACK_PER_SESSION, config.autoMeme.maxRecentPerPackPerSession)
                : config.autoMeme.maxRecentPerPackPerSession,
        },
        settings: {
            debounceDelayMs: isWebOnlyProcess()
                ? parseIntegerEnv(env.DEBOUNCE_DELAY_MS, config.debounceDelayMs)
                : config.debounceDelayMs,
            memoryWindowSize: isWebOnlyProcess()
                ? parseIntegerEnv(env.MEMORY_WINDOW_SIZE, config.memoryWindowSize)
                : config.memoryWindowSize,
            llmStrictIsolation: isWebOnlyProcess()
                ? parseBooleanEnv(env.LLM_STRICT_ISOLATION, config.llmStrictIsolation)
                : config.llmStrictIsolation,
            showReasoningChain: isWebOnlyProcess()
                ? parseBooleanEnv(env.SHOW_REASONING_CHAIN, config.showReasoningChain)
                : config.showReasoningChain,
            toolEnhanceResponse: isWebOnlyProcess()
                ? parseBooleanEnv(env.TOOL_ENHANCE_RESPONSE, config.toolEnhanceResponse)
                : config.toolEnhanceResponse,
            techFallbackToPersona: isWebOnlyProcess()
                ? parseBooleanEnv(env.TECH_FALLBACK_TO_PERSONA, config.techFallbackToPersona)
                : config.techFallbackToPersona,
            selfMaintainerEnabled: isWebOnlyProcess()
                ? parseBooleanEnv(env.SELF_MAINTAINER_ENABLED, config.selfMaintainer.enabled)
                : config.selfMaintainer.enabled,
            autoMemeEnabled: isWebOnlyProcess()
                ? parseBooleanEnv(env.AUTO_MEME_ENABLED, config.autoMeme.enabled)
                : config.autoMeme.enabled,
            autoMemeProbability: isWebOnlyProcess()
                ? parseFloatEnv(env.AUTO_MEME_PROBABILITY, config.autoMeme.probability)
                : config.autoMeme.probability,
            logLevel: config.logLevel,
        },
        selfMaintainer: {
            intervalMs: isWebOnlyProcess()
                ? parseIntegerEnv(env.SELF_MAINTAINER_INTERVAL_MS, config.selfMaintainer.intervalMs)
                : config.selfMaintainer.intervalMs,
            failureWindowMs: isWebOnlyProcess()
                ? parseIntegerEnv(env.SELF_MAINTAINER_FAILURE_WINDOW_MS, config.selfMaintainer.failureWindowMs)
                : config.selfMaintainer.failureWindowMs,
            minFailures: isWebOnlyProcess()
                ? parseIntegerEnv(env.SELF_MAINTAINER_MIN_FAILURES, config.selfMaintainer.minFailures)
                : config.selfMaintainer.minFailures,
            cooldownMs: isWebOnlyProcess()
                ? parseIntegerEnv(env.SELF_MAINTAINER_COOLDOWN_MS, config.selfMaintainer.cooldownMs)
                : config.selfMaintainer.cooldownMs,
            maxToolsPerRun: isWebOnlyProcess()
                ? parseIntegerEnv(env.SELF_MAINTAINER_MAX_TOOLS_PER_RUN, config.selfMaintainer.maxToolsPerRun)
                : config.selfMaintainer.maxToolsPerRun,
            allowedTools: isWebOnlyProcess()
                ? parseStringArrayEnv(env.SELF_MAINTAINER_ALLOWED_TOOLS, config.selfMaintainer.allowedTools)
                : config.selfMaintainer.allowedTools,
            blockedTools: isWebOnlyProcess()
                ? parseStringArrayEnv(env.SELF_MAINTAINER_BLOCKED_TOOLS, config.selfMaintainer.blockedTools)
                : config.selfMaintainer.blockedTools,
        },
    };
}

async function buildRuntimeConfigResponse() {
    const runtimeHealth = await Promise.all([
        getGenesisAgentProcessStatus(),
        getAdapterProcessStatus(),
    ]);

    return {
        ...getRuntimeConfig(),
        runtimeHealth: {
            agent: runtimeHealth[0],
            adapter: runtimeHealth[1],
        },
    };
}

interface RuntimeSettingsUpdatePayload {
    napcatWsUrl?: unknown;
    adapterMode?: unknown;
    adapterNapcatWsUrl?: unknown;
    adapterAccessToken?: unknown;
    adapterClearAccessToken?: unknown;
    adapterOwnerQq?: unknown;
    adapterOwnerNotifyText?: unknown;
    adapterReverseHost?: unknown;
    adapterReversePort?: unknown;
    adapterReversePath?: unknown;
    adapterEnableStream?: unknown;
    adapterStreamHost?: unknown;
    adapterStreamPort?: unknown;
    debounceDelayMs?: unknown;
    memoryWindowSize?: unknown;
    llmStrictIsolation?: unknown;
    showReasoningChain?: unknown;
    autoMemeEnabled?: unknown;
    autoMemeProbability?: unknown;
    autoMemePerSessionCooldownMs?: unknown;
    autoMemePerUserCooldownMs?: unknown;
    autoMemeDisableInPrivate?: unknown;
    autoMemeDisableWhenToolSentMedia?: unknown;
    autoMemeMaxRecentPerSession?: unknown;
    autoMemeMaxRecentPerPackPerSession?: unknown;
    selfMaintainerEnabled?: unknown;
    selfMaintainerIntervalMs?: unknown;
    selfMaintainerFailureWindowMs?: unknown;
    selfMaintainerMinFailures?: unknown;
    selfMaintainerCooldownMs?: unknown;
    selfMaintainerMaxToolsPerRun?: unknown;
    selfMaintainerAllowedTools?: unknown;
    selfMaintainerBlockedTools?: unknown;
}

interface RuntimeSettingsUpdate {
    napcatWsUrl?: string;
    adapterMode?: 'forward' | 'reverse';
    adapterNapcatWsUrl?: string;
    adapterAccessToken?: string;
    adapterClearAccessToken?: boolean;
    adapterOwnerQq?: string;
    adapterOwnerNotifyText?: string;
    adapterReverseHost?: string;
    adapterReversePort?: number;
    adapterReversePath?: string;
    adapterEnableStream?: boolean;
    adapterStreamHost?: string;
    adapterStreamPort?: number;
    debounceDelayMs?: number;
    memoryWindowSize?: number;
    llmStrictIsolation?: boolean;
    showReasoningChain?: boolean;
    autoMemeEnabled?: boolean;
    autoMemeProbability?: number;
    autoMemePerSessionCooldownMs?: number;
    autoMemePerUserCooldownMs?: number;
    autoMemeDisableInPrivate?: boolean;
    autoMemeDisableWhenToolSentMedia?: boolean;
    autoMemeMaxRecentPerSession?: number;
    autoMemeMaxRecentPerPackPerSession?: number;
    selfMaintainerEnabled?: boolean;
    selfMaintainerIntervalMs?: number;
    selfMaintainerFailureWindowMs?: number;
    selfMaintainerMinFailures?: number;
    selfMaintainerCooldownMs?: number;
    selfMaintainerMaxToolsPerRun?: number;
    selfMaintainerAllowedTools?: string[];
    selfMaintainerBlockedTools?: string[];
}

type RuntimeConfigSnapshot = ReturnType<typeof getRuntimeConfig>;

type RuntimeProcessScope = 'agent' | 'adapter';

type RuntimeScopeMutationState = {
    changed: boolean;
    savedKeys: string[];
    unsavedKeys: string[];
};

type RuntimeSettingsApplyResult = {
    savedKeys: string[];
    unsavedKeys: string[];
    scopes: Record<RuntimeProcessScope, RuntimeScopeMutationState>;
};

type RuntimeScopeSyncPlan = {
    requested: boolean;
    shouldSync: boolean;
    reason?: string;
};

type RuntimeSettingsSyncSummary = {
    agent: ProcessSyncResult;
    adapter: ProcessSyncResult;
};

function createRuntimeScopeMutationState(): RuntimeScopeMutationState {
    return {
        changed: false,
        savedKeys: [],
        unsavedKeys: [],
    };
}

function createRuntimeSettingsApplyResult(): RuntimeSettingsApplyResult {
    return {
        savedKeys: [],
        unsavedKeys: [],
        scopes: {
            agent: createRuntimeScopeMutationState(),
            adapter: createRuntimeScopeMutationState(),
        },
    };
}

function markRuntimeScopeChanged(result: RuntimeSettingsApplyResult, scope: RuntimeProcessScope): void {
    result.scopes[scope].changed = true;
}

function recordRuntimePersistResult(
    result: RuntimeSettingsApplyResult,
    scope: RuntimeProcessScope,
    key: string,
    saved: boolean,
): void {
    const target = saved ? result.savedKeys : result.unsavedKeys;
    const scopedTarget = saved ? result.scopes[scope].savedKeys : result.scopes[scope].unsavedKeys;
    target.push(key);
    scopedTarget.push(key);
}

function buildRuntimeSyncPlan(result: RuntimeSettingsApplyResult): Record<RuntimeProcessScope, RuntimeScopeSyncPlan> {
    const buildScopePlan = (scope: RuntimeProcessScope, label: string): RuntimeScopeSyncPlan => {
        const mutation = result.scopes[scope];
        if (!mutation.changed) {
            return { requested: false, shouldSync: false };
        }
        if (mutation.unsavedKeys.length > 0) {
            return {
                requested: true,
                shouldSync: false,
                reason: `${label}配置存在未保存字段，已跳过同步`,
            };
        }
        return { requested: true, shouldSync: true };
    };

    return {
        agent: buildScopePlan('agent', 'genesis-agent'),
        adapter: buildScopePlan('adapter', 'NapCat 适配器'),
    };
}

function buildRuntimeSettingsMessage(saved: boolean, sync: RuntimeSettingsSyncSummary): string {
    if (!saved) {
        return '运行时配置已在当前 Web 进程更新，但部分字段保存失败，相关进程未完全同步';
    }

    if (!sync.agent.requested && !sync.adapter.requested) {
        return '未检测到配置变更';
    }

    const appliedParts: string[] = [];
    const pendingParts: string[] = [];

    const collect = (
        label: string,
        result: ProcessSyncResult,
        hotAppliedText?: string,
    ): void => {
        if (!result.requested) return;
        if (result.applied) {
            if (result.mode === 'hot' && hotAppliedText) {
                appliedParts.push(hotAppliedText);
            } else {
                appliedParts.push(`${label} 已重启并生效`);
            }
            return;
        }

        pendingParts.push(result.skippedReason || result.error || `${label}同步失败`);
    };

    collect('genesis-agent', sync.agent, '当前 agent 已即时生效');
    collect('NapCat 适配器', sync.adapter);

    if (pendingParts.length > 0) {
        const appliedText = appliedParts.length > 0 ? `${appliedParts.join('，')}；` : '';
        return `运行时配置已保存，${appliedText}${pendingParts.join('；')}`;
    }

    if (appliedParts.length === 0) {
        return '运行时配置已保存并即时生效';
    }

    return `运行时配置已保存，${appliedParts.join('，')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseIntegerSetting(
    value: unknown,
    fieldName: string,
    minimum: number,
    maximum?: number,
): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;

    if (!Number.isInteger(parsed)) {
        throw new Error(`${fieldName} 必须是整数`);
    }

    if (parsed < minimum || (maximum !== undefined && parsed > maximum)) {
        const rangeText = maximum === undefined ? `>= ${minimum}` : `${minimum} ~ ${maximum}`;
        throw new Error(`${fieldName} 必须在 ${rangeText} 范围内`);
    }

    return parsed;
}

function parseFloatSetting(
    value: unknown,
    fieldName: string,
    minimum: number,
    maximum: number,
): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;

    if (!Number.isFinite(parsed)) {
        throw new Error(`${fieldName} 必须是数字`);
    }

    if (parsed < minimum || parsed > maximum) {
        throw new Error(`${fieldName} 必须在 ${minimum} ~ ${maximum} 范围内`);
    }

    return Number(parsed.toFixed(4));
}

function parseStringSetting(value: unknown, fieldName: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new Error(`${fieldName} 必须是字符串`);
    }

    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${fieldName} 不能为空`);
    }

    return trimmed;
}

function parseOptionalStringSetting(value: unknown, fieldName: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new Error(`${fieldName} 必须是字符串`);
    }

    return value.trim();
}

function parseAdapterModeSetting(value: unknown): 'forward' | 'reverse' | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new Error('适配器连接模式必须是字符串');
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'forward' || normalized === 'reverse') {
        return normalized;
    }

    throw new Error('适配器连接模式必须是 forward 或 reverse');
}

function parseBooleanSetting(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') {
            return true;
        }
        if (normalized === 'false' || normalized === '0') {
            return false;
        }
    }

    throw new Error(`${fieldName} 必须是布尔值`);
}

function parseToolListSetting(value: unknown, fieldName: string): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    let rawItems: string[];
    if (typeof value === 'string') {
        rawItems = value.split(/[\n,，]+/);
    } else if (Array.isArray(value)) {
        rawItems = value.map(item => {
            if (typeof item !== 'string') {
                throw new Error(`${fieldName} 里的每一项都必须是字符串`);
            }
            return item;
        });
    } else {
        throw new Error(`${fieldName} 必须是字符串或字符串数组`);
    }

    return Array.from(new Set(
        rawItems
            .map(item => item.trim().toLowerCase())
            .filter(Boolean)
    ));
}

function parseRuntimeSettingsUpdate(body: unknown): RuntimeSettingsUpdate {
    if (!isRecord(body)) {
        throw new Error('请求体必须是对象');
    }

    const parsed: RuntimeSettingsUpdate = {
        napcatWsUrl: parseStringSetting(body.napcatWsUrl, 'NapCat 地址'),
        adapterMode: parseAdapterModeSetting(body.adapterMode),
        adapterNapcatWsUrl: parseOptionalStringSetting(body.adapterNapcatWsUrl, '适配器 NapCat 地址'),
        adapterAccessToken: parseOptionalStringSetting(body.adapterAccessToken, '适配器访问令牌'),
        adapterClearAccessToken: parseBooleanSetting(body.adapterClearAccessToken, '适配器清空访问令牌开关'),
        adapterOwnerQq: parseOptionalStringSetting(body.adapterOwnerQq, '适配器主人 QQ'),
        adapterOwnerNotifyText: parseOptionalStringSetting(body.adapterOwnerNotifyText, '适配器通知文本'),
        adapterReverseHost: parseOptionalStringSetting(body.adapterReverseHost, '适配器反向监听地址'),
        adapterReversePort: parseIntegerSetting(body.adapterReversePort, '适配器反向监听端口', 1, 65535),
        adapterReversePath: parseOptionalStringSetting(body.adapterReversePath, '适配器反向路径'),
        adapterEnableStream: parseBooleanSetting(body.adapterEnableStream, '适配器消息流开关'),
        adapterStreamHost: parseOptionalStringSetting(body.adapterStreamHost, '适配器消息流监听地址'),
        adapterStreamPort: parseIntegerSetting(body.adapterStreamPort, '适配器消息流端口', 1, 65535),
        debounceDelayMs: parseIntegerSetting(body.debounceDelayMs, '防抖延迟', 100, 60000),
        memoryWindowSize: parseIntegerSetting(body.memoryWindowSize, '记忆窗口大小', 1, 200),
        llmStrictIsolation: parseBooleanSetting(body.llmStrictIsolation, 'LLM 严格隔离开关'),
        showReasoningChain: parseBooleanSetting(body.showReasoningChain, '思考链显示开关'),
        autoMemeEnabled: parseBooleanSetting(body.autoMemeEnabled, '自动表情包开关'),
        autoMemeProbability: parseFloatSetting(body.autoMemeProbability, '自动表情包概率', 0, 1),
        autoMemePerSessionCooldownMs: parseIntegerSetting(body.autoMemePerSessionCooldownMs, '自动表情包会话冷却', 0, 3600000),
        autoMemePerUserCooldownMs: parseIntegerSetting(body.autoMemePerUserCooldownMs, '自动表情包用户冷却', 0, 3600000),
        autoMemeDisableInPrivate: parseBooleanSetting(body.autoMemeDisableInPrivate, '私聊禁用自动表情'),
        autoMemeDisableWhenToolSentMedia: parseBooleanSetting(body.autoMemeDisableWhenToolSentMedia, '已有媒体时跳过自动表情'),
        autoMemeMaxRecentPerSession: parseIntegerSetting(body.autoMemeMaxRecentPerSession, '会话去重窗口', 1, 50),
        autoMemeMaxRecentPerPackPerSession: parseIntegerSetting(body.autoMemeMaxRecentPerPackPerSession, '单分组去重窗口', 1, 50),
        selfMaintainerEnabled: parseBooleanSetting(body.selfMaintainerEnabled, '工具自维护开关'),
        selfMaintainerIntervalMs: parseIntegerSetting(body.selfMaintainerIntervalMs, '自维护巡检间隔', 60000, 86400000),
        selfMaintainerFailureWindowMs: parseIntegerSetting(body.selfMaintainerFailureWindowMs, '失败统计窗口', 60000, 86400000),
        selfMaintainerMinFailures: parseIntegerSetting(body.selfMaintainerMinFailures, '最少失败次数', 1, 20),
        selfMaintainerCooldownMs: parseIntegerSetting(body.selfMaintainerCooldownMs, '自维护冷却时间', 60000, 604800000),
        selfMaintainerMaxToolsPerRun: parseIntegerSetting(body.selfMaintainerMaxToolsPerRun, '单轮最多维护工具数', 1, 20),
        selfMaintainerAllowedTools: parseToolListSetting(body.selfMaintainerAllowedTools, '允许维护工具名单'),
        selfMaintainerBlockedTools: parseToolListSetting(body.selfMaintainerBlockedTools, '禁止维护工具名单'),
    };

    if (parsed.adapterAccessToken !== undefined && parsed.adapterClearAccessToken) {
        throw new Error('不能同时设置新的适配器访问令牌并勾选清空令牌');
    }

    validateRuntimeSettingsUpdate(parsed, getRuntimeConfig());

    return parsed;
}

function validateRuntimeSettingsUpdate(update: RuntimeSettingsUpdate, currentConfig: RuntimeConfigSnapshot): void {
    const targetAdapterMode = update.adapterMode ?? currentConfig.adapter.mode;
    const targetStreamEnabled = update.adapterEnableStream ?? currentConfig.adapter.enableStream;

    if (targetAdapterMode === 'forward') {
        const upstreamUrl = update.adapterNapcatWsUrl ?? currentConfig.adapter.napcatWsUrl;
        if (!String(upstreamUrl || '').trim()) {
            throw new Error('forward 模式下，上游 NapCat 地址不能为空');
        }
    } else {
        const reverseHost = update.adapterReverseHost ?? currentConfig.adapter.reverseHost;
        const reversePath = update.adapterReversePath ?? currentConfig.adapter.reversePath;
        if (!String(reverseHost || '').trim()) {
            throw new Error('reverse 模式下，适配器反向监听地址不能为空');
        }
        if (!String(reversePath || '').trim()) {
            throw new Error('reverse 模式下，适配器反向路径不能为空');
        }
    }

    if (targetStreamEnabled) {
        const streamHost = update.adapterStreamHost ?? currentConfig.adapter.streamHost;
        if (!String(streamHost || '').trim()) {
            throw new Error('启用消息流服务时，适配器消息流监听地址不能为空');
        }
    }
}

function persistRuntimeEnv(key: string, value: string): boolean {
    if (!isWebOnlyProcess()) {
        process.env[key] = value;
    }
    return updateEnvVariable(key, value);
}

function normalizeToolNamesForCompare(values: string[]): string[] {
    return Array.from(new Set(
        values
            .map(item => item.trim().toLowerCase())
            .filter(Boolean)
    )).sort();
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
    const normalizedLeft = normalizeToolNamesForCompare(left);
    const normalizedRight = normalizeToolNamesForCompare(right);
    return normalizedLeft.length === normalizedRight.length
        && normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

async function applyRuntimeSettings(update: RuntimeSettingsUpdate): Promise<RuntimeSettingsApplyResult> {
    const result = createRuntimeSettingsApplyResult();
    let selfMaintainerChanged = false;
    const webOnly = isWebOnlyProcess();
    const currentConfig = getRuntimeConfig();
    const currentAdapterEnv = parseEnvFileSync(getAdapterEnvPath());
    const persist = (key: string, value: string, scope: RuntimeProcessScope): void => {
        recordRuntimePersistResult(result, scope, key, persistRuntimeEnv(key, value));
    };

    const persistAdapter = (key: string, value: string, sensitive = false): void => {
        recordRuntimePersistResult(
            result,
            'adapter',
            `adapter:${key}`,
            updateEnvVariable(key, value, { envPath: getAdapterEnvPath(), sensitive }),
        );
    };

    if (update.napcatWsUrl !== undefined) {
        if (update.napcatWsUrl !== currentConfig.napcatWsUrl) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.napcatWsUrl = update.napcatWsUrl;
                await connector.updateUrl(update.napcatWsUrl, connector.connected);
            }
            persist('NAPCAT_WS_URL', update.napcatWsUrl, 'agent');
        }
    }

    if (update.adapterMode !== undefined) {
        if (update.adapterMode !== currentConfig.adapter.mode) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('MODE', update.adapterMode);
        }
    }

    if (update.adapterNapcatWsUrl !== undefined) {
        if (update.adapterNapcatWsUrl !== currentConfig.adapter.napcatWsUrl) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('NAPCAT_WS_URL', serializeEnvValue(update.adapterNapcatWsUrl));
        }
    }

    const currentAdapterAccessToken = currentAdapterEnv.NAPCAT_ACCESS_TOKEN || '';
    if (update.adapterAccessToken !== undefined) {
        if (update.adapterAccessToken !== currentAdapterAccessToken) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('NAPCAT_ACCESS_TOKEN', serializeEnvValue(update.adapterAccessToken), true);
        }
    } else if (update.adapterClearAccessToken && currentAdapterAccessToken) {
        markRuntimeScopeChanged(result, 'adapter');
        persistAdapter('NAPCAT_ACCESS_TOKEN', '');
    }

    if (update.adapterOwnerQq !== undefined) {
        if (update.adapterOwnerQq !== currentConfig.adapter.ownerQq) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('OWNER_QQ', serializeEnvValue(update.adapterOwnerQq));
        }
    }

    if (update.adapterOwnerNotifyText !== undefined) {
        if (update.adapterOwnerNotifyText !== currentConfig.adapter.ownerNotifyText) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('OWNER_NOTIFY_TEXT', serializeEnvValue(update.adapterOwnerNotifyText));
        }
    }

    if (update.adapterReverseHost !== undefined) {
        if (update.adapterReverseHost !== currentConfig.adapter.reverseHost) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('REVERSE_HOST', serializeEnvValue(update.adapterReverseHost));
        }
    }

    if (update.adapterReversePort !== undefined) {
        if (update.adapterReversePort !== currentConfig.adapter.reversePort) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('REVERSE_PORT', String(update.adapterReversePort));
        }
    }

    if (update.adapterReversePath !== undefined) {
        if (update.adapterReversePath !== currentConfig.adapter.reversePath) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('REVERSE_PATH', serializeEnvValue(update.adapterReversePath));
        }
    }

    if (update.adapterEnableStream !== undefined) {
        if (update.adapterEnableStream !== currentConfig.adapter.enableStream) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('ENABLE_STREAM', String(update.adapterEnableStream));
        }
    }

    if (update.adapterStreamHost !== undefined) {
        if (update.adapterStreamHost !== currentConfig.adapter.streamHost) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('STREAM_HOST', serializeEnvValue(update.adapterStreamHost));
        }
    }

    if (update.adapterStreamPort !== undefined) {
        if (update.adapterStreamPort !== currentConfig.adapter.streamPort) {
            markRuntimeScopeChanged(result, 'adapter');
            persistAdapter('STREAM_PORT', String(update.adapterStreamPort));
        }
    }

    if (update.debounceDelayMs !== undefined) {
        if (update.debounceDelayMs !== currentConfig.settings.debounceDelayMs) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.debounceDelayMs = update.debounceDelayMs;
                debouncer.updateDelay(update.debounceDelayMs);
            }
            persist('DEBOUNCE_DELAY_MS', String(update.debounceDelayMs), 'agent');
        }
    }

    if (update.memoryWindowSize !== undefined) {
        if (update.memoryWindowSize !== currentConfig.settings.memoryWindowSize) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.memoryWindowSize = update.memoryWindowSize;
                memory.updateMaxSize(update.memoryWindowSize);
            }
            persist('MEMORY_WINDOW_SIZE', String(update.memoryWindowSize), 'agent');
        }
    }

    if (update.llmStrictIsolation !== undefined) {
        if (update.llmStrictIsolation !== currentConfig.settings.llmStrictIsolation) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.llmStrictIsolation = update.llmStrictIsolation;
            }
            persist('LLM_STRICT_ISOLATION', String(update.llmStrictIsolation), 'agent');
            if (!webOnly) {
                syncRuntimeLlmProviders();
            }
        }
    }

    if (update.showReasoningChain !== undefined) {
        if (update.showReasoningChain !== currentConfig.settings.showReasoningChain) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.showReasoningChain = update.showReasoningChain;
            }
            persist('SHOW_REASONING_CHAIN', String(update.showReasoningChain), 'agent');
        }
    }

    if (update.autoMemeEnabled !== undefined) {
        if (update.autoMemeEnabled !== currentConfig.autoMeme.enabled) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.enabled = update.autoMemeEnabled;
            }
            persist('AUTO_MEME_ENABLED', String(update.autoMemeEnabled), 'agent');
        }
    }

    if (update.autoMemeProbability !== undefined) {
        if (update.autoMemeProbability !== currentConfig.autoMeme.probability) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.probability = update.autoMemeProbability;
            }
            persist('AUTO_MEME_PROBABILITY', String(update.autoMemeProbability), 'agent');
        }
    }

    if (update.autoMemePerSessionCooldownMs !== undefined) {
        if (update.autoMemePerSessionCooldownMs !== currentConfig.autoMeme.perSessionCooldownMs) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.perSessionCooldownMs = update.autoMemePerSessionCooldownMs;
            }
            persist('AUTO_MEME_PER_SESSION_COOLDOWN_MS', String(update.autoMemePerSessionCooldownMs), 'agent');
        }
    }

    if (update.autoMemePerUserCooldownMs !== undefined) {
        if (update.autoMemePerUserCooldownMs !== currentConfig.autoMeme.perUserCooldownMs) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.perUserCooldownMs = update.autoMemePerUserCooldownMs;
            }
            persist('AUTO_MEME_PER_USER_COOLDOWN_MS', String(update.autoMemePerUserCooldownMs), 'agent');
        }
    }

    if (update.autoMemeDisableInPrivate !== undefined) {
        if (update.autoMemeDisableInPrivate !== currentConfig.autoMeme.disableInPrivate) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.disableInPrivate = update.autoMemeDisableInPrivate;
            }
            persist('AUTO_MEME_DISABLE_IN_PRIVATE', String(update.autoMemeDisableInPrivate), 'agent');
        }
    }

    if (update.autoMemeDisableWhenToolSentMedia !== undefined) {
        if (update.autoMemeDisableWhenToolSentMedia !== currentConfig.autoMeme.disableWhenToolSentMedia) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.disableWhenToolSentMedia = update.autoMemeDisableWhenToolSentMedia;
            }
            persist('AUTO_MEME_DISABLE_WHEN_TOOL_SENT_MEDIA', String(update.autoMemeDisableWhenToolSentMedia), 'agent');
        }
    }

    if (update.autoMemeMaxRecentPerSession !== undefined) {
        if (update.autoMemeMaxRecentPerSession !== currentConfig.autoMeme.maxRecentPerSession) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.maxRecentPerSession = update.autoMemeMaxRecentPerSession;
            }
            persist('AUTO_MEME_MAX_RECENT_PER_SESSION', String(update.autoMemeMaxRecentPerSession), 'agent');
        }
    }

    if (update.autoMemeMaxRecentPerPackPerSession !== undefined) {
        if (update.autoMemeMaxRecentPerPackPerSession !== currentConfig.autoMeme.maxRecentPerPackPerSession) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.autoMeme.maxRecentPerPackPerSession = update.autoMemeMaxRecentPerPackPerSession;
            }
            persist('AUTO_MEME_MAX_RECENT_PER_PACK_PER_SESSION', String(update.autoMemeMaxRecentPerPackPerSession), 'agent');
        }
    }

    if (update.selfMaintainerEnabled !== undefined) {
        if (update.selfMaintainerEnabled !== currentConfig.settings.selfMaintainerEnabled) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.enabled = update.selfMaintainerEnabled;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_ENABLED', String(update.selfMaintainerEnabled), 'agent');
        }
    }

    if (update.selfMaintainerIntervalMs !== undefined) {
        if (update.selfMaintainerIntervalMs !== currentConfig.selfMaintainer.intervalMs) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.intervalMs = update.selfMaintainerIntervalMs;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_INTERVAL_MS', String(update.selfMaintainerIntervalMs), 'agent');
        }
    }

    if (update.selfMaintainerFailureWindowMs !== undefined) {
        if (update.selfMaintainerFailureWindowMs !== currentConfig.selfMaintainer.failureWindowMs) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.failureWindowMs = update.selfMaintainerFailureWindowMs;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_FAILURE_WINDOW_MS', String(update.selfMaintainerFailureWindowMs), 'agent');
        }
    }

    if (update.selfMaintainerMinFailures !== undefined) {
        if (update.selfMaintainerMinFailures !== currentConfig.selfMaintainer.minFailures) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.minFailures = update.selfMaintainerMinFailures;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_MIN_FAILURES', String(update.selfMaintainerMinFailures), 'agent');
        }
    }

    if (update.selfMaintainerCooldownMs !== undefined) {
        if (update.selfMaintainerCooldownMs !== currentConfig.selfMaintainer.cooldownMs) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.cooldownMs = update.selfMaintainerCooldownMs;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_COOLDOWN_MS', String(update.selfMaintainerCooldownMs), 'agent');
        }
    }

    if (update.selfMaintainerMaxToolsPerRun !== undefined) {
        if (update.selfMaintainerMaxToolsPerRun !== currentConfig.selfMaintainer.maxToolsPerRun) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.maxToolsPerRun = update.selfMaintainerMaxToolsPerRun;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_MAX_TOOLS_PER_RUN', String(update.selfMaintainerMaxToolsPerRun), 'agent');
        }
    }

    if (update.selfMaintainerAllowedTools !== undefined) {
        if (!areStringArraysEqual(update.selfMaintainerAllowedTools, currentConfig.selfMaintainer.allowedTools)) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.allowedTools = update.selfMaintainerAllowedTools;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_ALLOWED_TOOLS', update.selfMaintainerAllowedTools.join(','), 'agent');
        }
    }

    if (update.selfMaintainerBlockedTools !== undefined) {
        if (!areStringArraysEqual(update.selfMaintainerBlockedTools, currentConfig.selfMaintainer.blockedTools)) {
            markRuntimeScopeChanged(result, 'agent');
            if (!webOnly) {
                config.selfMaintainer.blockedTools = update.selfMaintainerBlockedTools;
            }
            selfMaintainerChanged = true;
            persist('SELF_MAINTAINER_BLOCKED_TOOLS', update.selfMaintainerBlockedTools.join(','), 'agent');
        }
    }

    if (selfMaintainerChanged && !webOnly) {
        toolSelfMaintainer.syncWithConfig();
    }

    return result;
}

// Bot 信息缓存
let botInfoCache: { nickname: string; userId: number; avatar: string } | null = null;
let botInfoLastFetch = 0;

export const systemRouter: Router = express.Router();

systemRouter.get('/system/logs', (req: Request, res: Response) => {
    const rawLimit = Number.parseInt(String(req.query.limit || '200'), 10);
    const rawSince = Number.parseInt(String(req.query.since || ''), 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
    const since = Number.isFinite(rawSince) ? rawSince : undefined;

    res.json({
        success: true,
        logs: log.getRecent(limit, since),
    });
});

systemRouter.get('/system', (req, res) => {
    void (async () => {
        const [agentProcess, adapterProcess] = await Promise.all([
            getGenesisAgentProcessStatus(),
            getAdapterProcessStatus(),
        ]);
        res.json({
            ...getSystemInfo(),
            managedProcesses: {
                agent: agentProcess,
                adapter: adapterProcess,
            },
        });
    })().catch((error) => {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    });
});

systemRouter.get('/processes/adapter', async (req, res) => {
    try {
        const processInfo = await getAdapterProcessStatus();
        res.json({
            success: true,
            process: processInfo,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.post('/processes/adapter/:action', async (req, res) => {
    const action = String(req.params.action || '') as ManagedProcessAction;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({
            success: false,
            error: '仅支持 start / stop / restart',
        });
    }

    try {
        const result = await controlAdapterProcess(action);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.get('/processes/agent', async (req, res) => {
    try {
        const processInfo = await getGenesisAgentProcessStatus();
        res.json({
            success: true,
            process: processInfo,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.post('/processes/agent/:action', async (req, res) => {
    const action = String(req.params.action || '') as ManagedProcessAction;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({
            success: false,
            error: '仅支持 start / stop / restart',
        });
    }

    try {
        const result = await controlGenesisAgentProcess(action);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.get('/config', (req, res) => {
    void (async () => {
        res.json(await buildRuntimeConfigResponse());
    })().catch((error) => {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    });
});

systemRouter.put(
    '/config/runtime',
    async (
        req: Request<unknown, unknown, RuntimeSettingsUpdatePayload>,
        res: Response,
    ) => {
        try {
            const update = parseRuntimeSettingsUpdate(req.body);
            const result = await applyRuntimeSettings(update);
            const syncPlan = buildRuntimeSyncPlan(result);
            const saved = result.unsavedKeys.length === 0;
            const agentSync = syncPlan.agent.shouldSync
                ? await syncGenesisAgentProcess()
                : syncPlan.agent.requested
                    ? createSkippedProcessSyncResult(syncPlan.agent.reason || 'genesis-agent 已跳过同步')
                    : createNoProcessSyncResult();
            const adapterSync = syncPlan.adapter.shouldSync
                ? await syncAdapterProcess()
                : syncPlan.adapter.requested
                    ? createSkippedProcessSyncResult(syncPlan.adapter.reason || 'NapCat 适配器已跳过同步')
                    : createNoProcessSyncResult();
            const applied = saved && agentSync.applied && adapterSync.applied;

            res.json({
                success: true,
                saved,
                applied,
                savedKeys: result.savedKeys,
                unsavedKeys: result.unsavedKeys,
                agentSync,
                adapterSync,
                config: await buildRuntimeConfigResponse(),
                message: buildRuntimeSettingsMessage(saved, { agent: agentSync, adapter: adapterSync }),
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
);

systemRouter.post(
    '/config/llm/providers',
    async (
        req: Request<unknown, unknown, { name?: string; baseUrl?: string; apiKey?: string }>,
        res: Response
    ) => {
        try {
            const result = createProvider(req.body);
            const sync = result.saved
                ? await syncGenesisAgentProcess()
                : createSkippedProcessSyncResult('供应商配置未写入 .env，已跳过 genesis-agent 同步');
            res.json({
                success: true,
                saved: result.saved,
                applied: result.saved && sync.applied,
                provider: result.provider,
                restarted: sync.restarted,
                restartError: sync.error,
                syncMode: sync.mode,
                message: result.saved
                    ? (
                        sync.applied
                            ? (sync.mode === 'hot' ? '供应商已保存，当前 agent 已即时生效' : '供应商已保存，agent 已重启并生效')
                            : '供应商已保存，但 agent 同步失败'
                    )
                    : '供应商即时生效但保存失败',
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
);

systemRouter.put(
    '/config/llm/providers/:providerId',
    async (
        req: Request<{ providerId: string }, unknown, { name?: string; baseUrl?: string; apiKey?: string }>,
        res: Response
    ) => {
        try {
            const result = updateProvider(req.params.providerId, req.body);
            const sync = result.saved
                ? await syncGenesisAgentProcess()
                : createSkippedProcessSyncResult('供应商配置未写入 .env，已跳过 genesis-agent 同步');
            res.json({
                success: true,
                saved: result.saved,
                applied: result.saved && sync.applied,
                provider: result.provider,
                restarted: sync.restarted,
                restartError: sync.error,
                syncMode: sync.mode,
                message: result.saved
                    ? (
                        sync.applied
                            ? (sync.mode === 'hot' ? '供应商已更新，当前 agent 已即时生效' : '供应商已更新，agent 已重启并生效')
                            : '供应商已更新，但 agent 同步失败'
                    )
                    : '供应商即时生效但保存失败',
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
);

systemRouter.delete('/config/llm/providers/:providerId', async (req, res) => {
    try {
        const result = deleteProvider(req.params.providerId);
        const sync = result.saved
            ? await syncGenesisAgentProcess()
            : createSkippedProcessSyncResult('供应商配置未写入 .env，已跳过 genesis-agent 同步');
        res.json({
            success: true,
            saved: result.saved,
            applied: result.saved && sync.applied,
            restarted: sync.restarted,
            restartError: sync.error,
            syncMode: sync.mode,
            message: result.saved
                ? (
                    sync.applied
                        ? (sync.mode === 'hot' ? '供应商已删除，当前 agent 已即时生效' : '供应商已删除，agent 已重启并生效')
                        : '供应商已删除，但 agent 同步失败'
                )
                : '供应商已删除，但保存到 .env 失败',
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.get('/config/llm/providers/:providerId/models', (req, res) => {
    try {
        const query = typeof req.query.query === 'string' ? req.query.query : '';
        const result = fetchProviderModels(req.params.providerId, query);
        res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.post('/config/llm/providers/:providerId/models/refresh', async (req, res) => {
    try {
        const result = await refreshProviderModels(req.params.providerId);
        res.json({
            success: true,
            ...result,
            message: result.saved ? '模型已刷新并保存' : '模型已刷新，但保存到 .env 失败',
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

systemRouter.post(
    '/config/llm/providers/:providerId/test',
    async (
        req: Request<{ providerId: string }, unknown, { model?: string }>,
        res: Response
    ) => {
        try {
            const result = await testProviderModel(req.params.providerId, String(req.body.model || ''));
            res.json(result);
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
);

systemRouter.put(
    '/config/llm/modules/:moduleId',
    async (
        req: Request<{ moduleId: string }, unknown, { providerId?: string; model?: string }>,
        res: Response
    ) => {
        try {
            const result = saveModuleBinding(req.params.moduleId as LlmModuleId, req.body);
            const sync = result.saved
                ? await syncGenesisAgentProcess()
                : createSkippedProcessSyncResult('模块配置未写入 .env，已跳过 genesis-agent 同步');
            res.json({
                success: true,
                saved: result.saved,
                applied: result.saved && sync.applied,
                module: result.module,
                restarted: sync.restarted,
                restartError: sync.error,
                syncMode: sync.mode,
                message: result.saved
                    ? (
                        sync.applied
                            ? (sync.mode === 'hot' ? '模块配置已保存，当前 agent 已即时生效' : '模块配置已保存，agent 已重启并生效')
                            : '模块配置已保存，但 agent 同步失败'
                    )
                    : '模块即时生效但保存失败',
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
);

systemRouter.post(
    '/config/llm/modules/:moduleId/test',
    async (
        req: Request<{ moduleId: string }, unknown, { providerId?: string; model?: string }>,
        res: Response
    ) => {
        try {
            const providerId = String(req.body.providerId || '');
            const model = String(req.body.model || '');
            const result = await testProviderModel(providerId, model);
            res.json({
                moduleId: req.params.moduleId,
                ...result,
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
);

systemRouter.get('/config/llm/state', (_req, res) => {
    res.json({
        success: true,
        ...getLlmDashboardState(),
    });
});

// 获取 Bot 登录信息（需要从 connector 动态获取）
systemRouter.get('/bot', async (req, res) => {
    try {
        // 使用缓存（5分钟内有效）
        const now = Date.now();
        if (botInfoCache && now - botInfoLastFetch < 300000) {
            return res.json(botInfoCache);
        }

        // 动态导入 connector（避免循环依赖）
        const { connector } = await import('../../connector.js');

        if (!connector.connected) {
            // 未连接时返回配置中的 botQQ
            const fallback = {
                nickname: config.botQQ ? `${config.botQQ}` : 'Bot',
                userId: config.botQQ || 0,
                avatar: getBotAvatarUrl(),
            };
            return res.json(fallback);
        }

        // 调用 OneBot API 获取登录信息
        const info = await connector.callData<{ user_id: number; nickname: string }>('get_login_info', {});

        botInfoCache = {
            nickname: info.nickname || 'Bot',
            userId: info.user_id,
            avatar: getUserAvatarUrl(info.user_id),
        };
        botInfoLastFetch = now;

        res.json(botInfoCache);
    } catch {
        // 出错时返回配置中的信息
        res.json({
            nickname: config.botQQ ? `${config.botQQ}` : 'Bot',
            userId: config.botQQ || 0,
            avatar: getBotAvatarUrl(),
        });
    }
});

// ================== 任务管理 API ==================

// 获取任务统计
systemRouter.get('/tasks/stats', async (_req, res) => {
    const role = getGenesisProcessRole();
    const allTasks = role === 'web' ? await listTasksFromDisk(100) : taskManager.getAllTasks(100);
    const stats = role === 'web' ? await getTaskStatsFromDisk(100) : taskManager.getStats();
    const completedTasks = allTasks.filter(t => t.status === 'success' || t.status === 'failed');
    const totalDuration = completedTasks.reduce((sum, t) => {
        if (t.finishedAt && t.startedAt) {
            return sum + (t.finishedAt - t.startedAt);
        }
        return sum;
    }, 0);
    const avgDuration = completedTasks.length > 0 ? totalDuration / completedTasks.length : 0;

    res.json({
        ...stats,
        avgDuration,
    });
});

// 获取任务列表（直接返回数组）
systemRouter.get('/tasks', async (req, res) => {
    const userId = parseInt(req.query.userId as string) || 0;
    const limit = parseInt(req.query.limit as string) || 50;
    const role = getGenesisProcessRole();

    if (userId) {
        const tasks = role === 'web'
            ? await listTasksFromDisk(limit, userId)
            : taskManager.getUserTasks(userId, limit);
        res.json(tasks);
    } else {
        const tasks = role === 'web'
            ? await listTasksFromDisk(limit)
            : taskManager.getAllTasks(limit);
        res.json(tasks);
    }
});

// 获取单个任务详情
systemRouter.get('/tasks/:taskId', async (req, res) => {
    const task = getGenesisProcessRole() === 'web'
        ? await getTaskFromDisk(req.params.taskId)
        : taskManager.getTask(req.params.taskId);
    if (task) {
        res.json(task);
    } else {
        res.status(404).json({ error: '任务不存在' });
    }
});

// 取消任务
systemRouter.post('/tasks/:taskId/cancel', (req, res) => {
    if (getGenesisProcessRole() === 'web') {
        return res.status(409).json({
            success: false,
            error: 'web-only 模式暂不支持直接取消 agent 中任务，请在 agent 进程内操作',
        });
    }

    const success = taskManager.cancelTask(req.params.taskId);
    if (success) {
        res.json({ success: true, message: '任务已取消' });
    } else {
        res.status(400).json({ success: false, error: '无法取消任务（可能已在执行中）' });
    }
});

export const __testables = {
    buildRuntimeSyncPlan,
    buildRuntimeSettingsMessage,
    parseRuntimeSettingsUpdate,
    validateRuntimeSettingsUpdate,
    getRuntimeConfig,
    applyRuntimeSettings,
};
