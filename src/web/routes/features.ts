/**
 * 工具功能开关 Web API
 * 使用 getEnabledTools() 动态获取工具状态
 */

import express from 'express';
import type { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { profiler } from '../../agents/profiler.js';
import {
    getAllModules,
    getModuleByName,
    reloadModule,
} from '../../tools/index.js';
import { toolSelfMaintainer } from '../../services/tool_self_maintainer.js';
import {
    enqueueToolTestRequest,
    getToolTestRequest,
} from '../../services/tool_test_request_store.js';
import {
    executePreparedToolTest,
    prepareToolTestPayload,
    recordToolTestLog,
} from '../../services/tool_test_runner.js';
import { parseEnvFileSync, updateEnvVariable } from '../../utils/env.js';
import { toolStats } from '../store/tool_stats.js';
import { llmStats } from '../store/llm_stats.js';
import { getGenesisProcessRole, syncGenesisAgentProcess, type ProcessSyncResult } from '../services/process_control.js';

export const featuresRouter: Router = express.Router();

// 工具图标映射
const toolIcons: Record<string, string> = {
    like: '👍', profile: '👤', poke: '👆', vision: '🖼️',
    weather: '🌤️', draw: '🎨', banana_draw: '🍌', read_file: '📄', read_audio: '🔊', read_video: '🎬',
    chrome_screenshot: '📸',
};

// 工具名称映射
const toolNames: Record<string, string> = {
    like: '点赞', profile: '查询资料', poke: '戳一戳', vision: '识图',
    weather: '天气', draw: '绘图', banana_draw: 'Banana 绘图', read_file: '读文件', read_audio: '听音频', read_video: '看视频',
    chrome_screenshot: 'Chrome 网页截图',
};

type AgentToggleState = {
    enabled: boolean;
    name: string;
    icon: string;
};

const AGENT_TOGGLE_DEFINITIONS = {
    useTrueReAct: {
        envKey: 'AGENT_USE_TRUE_REACT',
        name: 'True ReAct',
        icon: '🧠',
        getFallback: () => config.agents.useTrueReAct,
    },
    sentry: {
        envKey: 'AGENT_SENTRY_ENABLED',
        name: '哨兵',
        icon: '🛡️',
        getFallback: () => config.agents.sentryEnabled,
    },
    routerLlm: {
        envKey: 'AGENT_ROUTER_LLM_ENABLED',
        name: 'Router LLM',
        icon: '🧭',
        getFallback: () => config.agents.routerLlmEnabled,
    },
    routerRuleMatch: {
        envKey: 'AGENT_ROUTER_RULE_MATCH_ENABLED',
        name: 'Router 规则',
        icon: '📐',
        getFallback: () => config.agents.routerRuleMatchEnabled,
    },
    profiler: {
        envKey: 'AGENT_PROFILER_ENABLED',
        name: '用户画像',
        icon: '📊',
        getFallback: () => config.agents.profilerEnabled,
    },
    vectordb: {
        envKey: 'AGENT_VECTORDB_ENABLED',
        name: '记忆存储',
        icon: '🧠',
        getFallback: () => config.agents.vectordbEnabled,
    },
    emotion: {
        envKey: 'AGENT_EMOTION_ENABLED',
        name: '情感分析',
        icon: '💭',
        getFallback: () => config.agents.emotionEnabled,
    },
    toolEnhance: {
        envKey: 'TOOL_ENHANCE_RESPONSE',
        name: '工具结果润色',
        icon: '✨',
        getFallback: () => config.toolEnhanceResponse,
    },
    techFallback: {
        envKey: 'TECH_FALLBACK_TO_PERSONA',
        name: 'Tech 回退 Persona',
        icon: '🎭',
        getFallback: () => config.techFallbackToPersona,
    },
    selfMaintainer: {
        envKey: 'SELF_MAINTAINER_ENABLED',
        name: '工具自维护',
        icon: '🩺',
        getFallback: () => config.selfMaintainer.enabled,
    },
} as const satisfies Record<string, {
    envKey: string;
    name: string;
    icon: string;
    getFallback: () => boolean;
}>;

type AgentToggleKey = keyof typeof AGENT_TOGGLE_DEFINITIONS;
const TOOL_TEST_REQUEST_POLL_MS = 300;
const TOOL_TEST_REQUEST_WAIT_TIMEOUT_MS = 30000;
const SENSITIVE_LOG_KEY_PATTERN = /(token|secret|password|passwd|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|session)/i;

function isWebOnlyProcess(): boolean {
    return getGenesisProcessRole() === 'web';
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeToolTestLogValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(item => sanitizeToolTestLogValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
                key,
                SENSITIVE_LOG_KEY_PATTERN.test(key)
                    ? '[REDACTED]'
                    : sanitizeToolTestLogValue(entryValue),
            ]),
        );
    }
    return value;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
}

function readFeatureEnvSnapshot(): Record<string, string> {
    return parseEnvFileSync(path.resolve(process.cwd(), '.env'));
}

function readAgentToggleEnabled(key: AgentToggleKey, env: Record<string, string>): boolean {
    const definition = AGENT_TOGGLE_DEFINITIONS[key];
    return parseBooleanEnv(env[definition.envKey]) ?? definition.getFallback();
}

function readToolEnabled(name: string, env: Record<string, string>, fallback?: boolean): boolean {
    const envKey = `MODULE_${name.toUpperCase()}_ENABLED`;
    const fromEnv = parseBooleanEnv(env[envKey]);
    if (fromEnv !== undefined) {
        return fromEnv;
    }
    if (typeof fallback === 'boolean') {
        return fallback;
    }
    return getModuleByName(name)?.module.enabled() ?? false;
}

export const __featureToggleTestUtils = {
    readFeatureEnvSnapshot,
    readToolEnabled,
    readAgentToggleEnabled,
    getAgentToggles,
    applyAgentToggle,
};

function getAgentToggles(): Record<string, AgentToggleState> {
    const env = readFeatureEnvSnapshot();
    return Object.fromEntries(
        Object.entries(AGENT_TOGGLE_DEFINITIONS).map(([key, definition]) => [
            key,
            {
                enabled: readAgentToggleEnabled(key as AgentToggleKey, env),
                name: definition.name,
                icon: definition.icon,
            },
        ]),
    );
}

function setBooleanEnv(envKey: string, enabled: boolean): boolean {
    if (!isWebOnlyProcess()) {
        process.env[envKey] = String(enabled);
    }
    return updateEnvVariable(envKey, String(enabled));
}

function getFeatureToggleMessage(options: {
    saved: boolean;
    sync: ProcessSyncResult;
    actualEnabled: boolean;
    requestedEnabled: boolean;
    mismatchMessage: string;
    targetLabel: string;
}): string {
    const { saved, sync, actualEnabled, requestedEnabled, mismatchMessage, targetLabel } = options;
    if (!saved) {
        return `${targetLabel}配置写入 .env 失败，genesis-agent 未同步`;
    }
    if (!sync.applied) {
        return sync.mode === 'restart'
            ? `${targetLabel}配置已保存，但 genesis-agent 重启失败`
            : `${targetLabel}配置已保存，但 genesis-agent 未同步`;
    }
    if (actualEnabled !== requestedEnabled) {
        return mismatchMessage;
    }
    if (sync.mode === 'hot') {
        return `${targetLabel}配置已保存，当前 agent 已即时生效`;
    }
    return `${targetLabel}配置已保存，genesis-agent 已重启并生效`;
}

async function restartAgentAfterPersist(saved: boolean): Promise<ProcessSyncResult> {
    if (!saved) {
        return {
            requested: false,
            applied: false,
            restarted: false,
            mode: 'none',
            skippedReason: '配置未写入 .env，已跳过 genesis-agent 同步',
        };
    }
    return syncGenesisAgentProcess();
}

async function waitForToolTestRequest(requestId: string, timeoutMs: number = TOOL_TEST_REQUEST_WAIT_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const request = await getToolTestRequest(requestId);
        if (!request) {
            return undefined;
        }
        if (request.status === 'success' || request.status === 'failed') {
            return request;
        }
        await sleep(TOOL_TEST_REQUEST_POLL_MS);
    }

    return getToolTestRequest(requestId);
}

function applyAgentToggle(name: string, enabled: boolean): { actualEnabled: boolean; saved: boolean } | null {
    switch (name) {
        case 'useTrueReAct': {
            const saved = setBooleanEnv('AGENT_USE_TRUE_REACT', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.useTrueReAct = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('useTrueReAct', readFeatureEnvSnapshot()), saved };
        }
        case 'sentry': {
            const saved = setBooleanEnv('AGENT_SENTRY_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.sentryEnabled = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('sentry', readFeatureEnvSnapshot()), saved };
        }
        case 'routerLlm': {
            const saved = setBooleanEnv('AGENT_ROUTER_LLM_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.routerLlmEnabled = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('routerLlm', readFeatureEnvSnapshot()), saved };
        }
        case 'routerRuleMatch': {
            const saved = setBooleanEnv('AGENT_ROUTER_RULE_MATCH_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.routerRuleMatchEnabled = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('routerRuleMatch', readFeatureEnvSnapshot()), saved };
        }
        case 'profiler': {
            const saved = setBooleanEnv('AGENT_PROFILER_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.profilerEnabled = enabled;
                if (enabled) {
                    profiler.start();
                } else {
                    profiler.stop();
                }
            }
            return { actualEnabled: readAgentToggleEnabled('profiler', readFeatureEnvSnapshot()), saved };
        }
        case 'vectordb': {
            const saved = setBooleanEnv('AGENT_VECTORDB_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.vectordbEnabled = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('vectordb', readFeatureEnvSnapshot()), saved };
        }
        case 'emotion': {
            const saved = setBooleanEnv('AGENT_EMOTION_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.agents.emotionEnabled = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('emotion', readFeatureEnvSnapshot()), saved };
        }
        case 'toolEnhance': {
            const saved = setBooleanEnv('TOOL_ENHANCE_RESPONSE', enabled);
            if (!isWebOnlyProcess()) {
                config.toolEnhanceResponse = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('toolEnhance', readFeatureEnvSnapshot()), saved };
        }
        case 'techFallback': {
            const saved = setBooleanEnv('TECH_FALLBACK_TO_PERSONA', enabled);
            if (!isWebOnlyProcess()) {
                config.techFallbackToPersona = enabled;
            }
            return { actualEnabled: readAgentToggleEnabled('techFallback', readFeatureEnvSnapshot()), saved };
        }
        case 'selfMaintainer': {
            const saved = setBooleanEnv('SELF_MAINTAINER_ENABLED', enabled);
            if (!isWebOnlyProcess()) {
                config.selfMaintainer.enabled = enabled;
                if (enabled) {
                    toolSelfMaintainer.start();
                } else {
                    toolSelfMaintainer.stop();
                }
            }
            return { actualEnabled: readAgentToggleEnabled('selfMaintainer', readFeatureEnvSnapshot()), saved };
        }
        default:
            return null;
    }
}

// Tools - 动态从工具模块获取状态
featuresRouter.get('/tools', (req: Request, res: Response) => {
    const registered = getAllModules();
    const env = readFeatureEnvSnapshot();

    const result: Record<string, { enabled: boolean; name: string; icon: string }> = {};
    for (const mod of registered) {
        const name = mod.module.name;
        result[name] = {
            enabled: readToolEnabled(name, env, mod.module.enabled()),
            name: toolNames[name] || mod.module.description,
            icon: toolIcons[name] || '🔧',
        };
    }
    res.json(result);
});

// 工具开关 - 支持运行时热切换并持久化
featuresRouter.put('/tools/:name', async (req: Request<{ name: string }, unknown, { enabled: boolean }>, res: Response) => {
    const { name } = req.params;
    const { enabled } = req.body;
    const target = getModuleByName(name);
    if (!target) {
        return res.status(404).json({ success: false, error: '工具不存在' });
    }

    const envKey = `MODULE_${name.toUpperCase()}_ENABLED`;
    const saved = updateEnvVariable(envKey, String(enabled));
    const reloaded = isWebOnlyProcess() ? false : await reloadModule(name);
    const actualEnabled = readToolEnabled(name, readFeatureEnvSnapshot(), target.module.enabled());
    const restart = await restartAgentAfterPersist(saved);

    log.info(`🔧 工具 ${name} 请求${enabled ? '启用' : '禁用'} -> 实际${actualEnabled ? '启用' : '禁用'} (Reload ${reloaded ? 'OK' : 'Fail'}, Save ${saved ? 'OK' : 'Fail'})`);

    res.json({
        success: true,
        [name]: actualEnabled,
        requested: enabled,
        reloaded,
        saved,
        restarted: restart.restarted,
        restartError: restart.error,
        syncMode: restart.mode,
        applied: saved && restart.applied && actualEnabled === enabled,
        message: getFeatureToggleMessage({
            saved,
            sync: restart,
            actualEnabled,
            requestedEnabled: enabled,
            mismatchMessage: restart.mode === 'hot'
                ? '配置已保存，当前 agent 已即时生效，但工具当前状态受额外条件限制（如缺少 API Key）'
                : '配置已保存，genesis-agent 已重启，但工具当前状态受额外条件限制（如缺少 API Key）',
            targetLabel: `工具 ${name}`,
        }),
    });
});

// Agents
featuresRouter.get('/agents', (req: Request, res: Response) => {
    res.json(getAgentToggles());
});

featuresRouter.put('/agents/:name', async (req: Request<{ name: string }, unknown, { enabled: boolean }>, res: Response) => {
    const { name } = req.params;
    const enabled = Boolean(req.body.enabled);
    const result = applyAgentToggle(name, enabled);
    if (!result) return res.status(404).json({ error: 'Agent 不存在' });
    const restart = await restartAgentAfterPersist(result.saved);

    log.info(`🤖 开关 ${name} 请求${enabled ? '启用' : '禁用'} -> 实际${result.actualEnabled ? '启用' : '禁用'}`);
    res.json({
        success: true,
        [name]: result.actualEnabled,
        requested: enabled,
        saved: result.saved,
        restarted: restart.restarted,
        restartError: restart.error,
        syncMode: restart.mode,
        applied: result.saved && restart.applied && result.actualEnabled === enabled,
        message: getFeatureToggleMessage({
            saved: result.saved,
            sync: restart,
            actualEnabled: result.actualEnabled,
            requestedEnabled: enabled,
            mismatchMessage: restart.mode === 'hot'
                ? `Agent ${name} 配置已保存，当前 agent 已即时生效，但当前状态仍未匹配请求值`
                : `Agent ${name} 配置已保存，genesis-agent 已重启，但当前状态仍未匹配请求值`,
            targetLabel: `Agent ${name}`,
        }),
    });
});

// Modules - 获取已加载的模块列表 (兼容旧 /skills 路径)
featuresRouter.get('/skills', (req: Request, res: Response) => {
    const all = getAllModules();
    const env = readFeatureEnvSnapshot();
    const enabledCount = all.filter((m) => readToolEnabled(m.module.name, env, m.module.enabled())).length;

    const result = all.map(m => ({
        name: m.module.name,
        displayName: m.module.name,
        version: '1.0.0',
        description: m.module.description,
        enabled: readToolEnabled(m.module.name, env, m.module.enabled()),
        triggers: { keywords: m.module.keywords },
        cooldown: {},
        loadedAt: new Date().toISOString(),
    }));

    res.json({
        total: all.length,
        enabled: enabledCount,
        modules: result,
        skills: result,  // 兼容旧字段
    });
});

// Modules - 新路径
featuresRouter.get('/modules', (req: Request, res: Response) => {
    const all = getAllModules();
    const env = readFeatureEnvSnapshot();
    const enabledCount = all.filter((m) => readToolEnabled(m.module.name, env, m.module.enabled())).length;

    const result = all.map(m => ({
        name: m.module.name,
        description: m.module.description,
        keywords: m.module.keywords,
        enabled: readToolEnabled(m.module.name, env, m.module.enabled()),
    }));

    res.json({
        total: all.length,
        enabled: enabledCount,
        modules: result,
    });
});

// 获取工具调用日志
featuresRouter.get('/tools/logs', async (req: Request, res: Response) => {
    await toolStats.reloadFromDisk();
    res.json(toolStats.getLogs());
});

// 获取工具参数 Schema
featuresRouter.get('/tools/:name/schema', (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const mod = getAllModules().find(m => m.module.name === name);
    if (!mod) {
        return res.status(404).json({ error: `工具 ${name} 不存在` });
    }
    res.json({
        name: mod.module.name,
        description: mod.module.description,
        schema: mod.module.schema,
    });
});

featuresRouter.get('/tools/test/:requestId', async (req: Request<{ requestId: string }>, res: Response) => {
    const request = await getToolTestRequest(req.params.requestId);
    if (!request) {
        return res.status(404).json({ success: false, error: '工具测试请求不存在' });
    }

    if (request.status === 'success' && request.response) {
        return res.json({
            success: true,
            queued: true,
            completed: true,
            requestId: request.requestId,
            message: request.response.success
                ? '工具测试已由 genesis-agent 执行完成'
                : '工具测试已由 genesis-agent 执行完成，但结果失败',
            response: request.response,
            duration: request.durationMs || 0,
        });
    }

    if (request.status === 'failed') {
        return res.json({
            success: false,
            queued: true,
            completed: true,
            requestId: request.requestId,
            message: '工具测试请求已到达 genesis-agent，但执行失败',
            response: {
                success: false,
                error: request.errorMessage || 'genesis-agent 执行工具测试失败',
            },
            duration: request.durationMs || 0,
        });
    }

    return res.json({
        success: true,
        queued: true,
        completed: false,
        requestId: request.requestId,
        message: request.status === 'running'
            ? '工具测试请求已被 genesis-agent 接收，正在执行中'
            : '工具测试请求已提交给 genesis-agent，等待执行',
        response: {
            success: false,
            error: request.status === 'running'
                ? '工具测试请求已被 genesis-agent 接收，正在执行中'
                : '工具测试请求已提交给 genesis-agent，等待执行',
        },
        duration: request.durationMs || 0,
    });
});

// 工具测试 - 执行工具并返回原始请求/响应
featuresRouter.post('/tools/test', async (req: Request<unknown, unknown, { toolName: string; params: Record<string, unknown> }>, res: Response) => {
    const { toolName } = req.body;
    const requestParams = req.body.params || {};

    if (!toolName) {
        return res.status(400).json({ error: '缺少工具名称' });
    }

    const mod = getAllModules().find(m => m.module.name === toolName);
    if (!mod) {
        return res.status(404).json({ error: `工具 ${toolName} 不存在` });
    }

    const startTime = Date.now();
    const requestData = {
        toolName,
        params: requestParams,
        timestamp: new Date().toISOString(),
    };

    log.info(`🧪 Web 工具测试: ${toolName} 参数:`, JSON.stringify(sanitizeToolTestLogValue(requestParams)));

    try {
        const payload = prepareToolTestPayload(toolName, requestParams);

        if (isWebOnlyProcess()) {
            const queued = await enqueueToolTestRequest(payload);
            const settled = await waitForToolTestRequest(queued.requestId);
            const elapsed = Date.now() - startTime;

            if (settled?.status === 'success' && settled.response) {
                log.info(`🧪 Web 工具测试已由 agent 完成: ${toolName} [${settled.response.success ? 'SUCCESS' : 'FAIL'}] ${settled.durationMs || elapsed}ms`);
                return res.json({
                    success: true,
                    queued: true,
                    completed: true,
                    requestId: queued.requestId,
                    message: settled.response.success
                        ? '工具测试已由 genesis-agent 执行完成'
                        : '工具测试已由 genesis-agent 执行完成，但结果失败',
                    request: requestData,
                    response: settled.response,
                    duration: settled.durationMs || elapsed,
                });
            }

            if (settled?.status === 'failed') {
                return res.json({
                    success: false,
                    queued: true,
                    completed: true,
                    requestId: queued.requestId,
                    message: '工具测试请求已到达 genesis-agent，但执行失败',
                    request: requestData,
                    response: {
                        success: false,
                        error: settled.errorMessage || 'genesis-agent 执行工具测试失败',
                    },
                    duration: settled.durationMs || elapsed,
                });
            }

            return res.json({
                success: true,
                queued: true,
                completed: false,
                requestId: queued.requestId,
                message: '工具测试请求已提交给 genesis-agent，仍在执行中',
                request: requestData,
                response: {
                    success: false,
                    error: '工具测试请求已提交给 genesis-agent，仍在执行中',
                },
                duration: elapsed,
            });
        }

        const result = await executePreparedToolTest(payload);
        recordToolTestLog(toolName, requestParams, result);

        log.info(`🧪 工具测试完成: ${toolName} [${result.response.success ? 'SUCCESS' : 'FAIL'}] ${result.duration}ms`);

        res.json({
            success: true,
            request: requestData,
            response: result.response,
            duration: result.duration,
        });
    } catch (err) {
        const duration = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`🧪 工具测试失败: ${toolName}`, err);

        res.json({
            success: false,
            request: requestData,
            response: {
                success: false,
                error: errorMessage,
            },
            duration,
        });
    }
});

// ==================== LLM 调用日志 API ====================

// 获取 LLM 调用日志
featuresRouter.get('/llm/logs', async (req: Request, res: Response) => {
    await llmStats.reloadFromDisk();
    const logs = llmStats.getLogs();
    const stats = llmStats.getStats();
    res.json({ logs, stats });
});

// 获取单条 LLM 日志详情
featuresRouter.get('/llm/logs/:id', async (req: Request<{ id: string }>, res: Response) => {
    await llmStats.reloadFromDisk();
    const { id } = req.params;
    const record = llmStats.getById(id);
    if (!record) {
        return res.status(404).json({ error: '日志不存在' });
    }
    res.json(record);
});

// 清空 LLM 日志
featuresRouter.delete('/llm/logs', (req: Request, res: Response) => {
    llmStats.clear();
    log.info('🧹 LLM 调用日志已清空');
    res.json({ success: true });
});
