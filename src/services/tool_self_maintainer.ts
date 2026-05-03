import { config } from '../config.js';
import { log } from '../logger.js';
import { toolStats, type ToolUsageParams } from '../web/store/tool_stats.js';
import { execute as manageSkillExecute } from '../tools/manage_skill/index.js';
import { stringifyForDisplay, truncateText } from '../utils/format.js';
import type { ToolResult } from '../tools/types.js';

const DEFAULT_BLOCKED_TOOLS = [
    'create_skill',
    'manage_skill',
    'tool_log',
    'cron_scheduler',
    'task_status',
    'task_cancel',
    'task_detail',
    'system_status',
] as const;

const FAILURE_SAMPLE_LIMIT = 4;
const DESCRIPTION_RESULT_LIMIT = 180;
const DESCRIPTION_PARAM_LIMIT = 120;

export interface MaintenanceCandidate {
    toolName: string;
    failures: ToolUsageParams[];
    latestFailureTime: number;
}

export interface SelfMaintainerState {
    lastAttemptAt: Map<string, number>;
    lastHandledFailureTime: Map<string, number>;
}

export interface SelfMaintainerDeps {
    getLogs: () => ToolUsageParams[];
    maintainTool: (toolName: string, description: string) => Promise<ToolResult>;
    recordMaintenance: (toolName: string, description: string, result: ToolResult, duration: number) => void;
    now: () => number;
}

function getBlockedTools(): Set<string> {
    return new Set([
        ...DEFAULT_BLOCKED_TOOLS,
        ...config.selfMaintainer.blockedTools,
    ]);
}

function isAllowedTool(toolName: string, blockedTools: Set<string>): boolean {
    if (blockedTools.has(toolName)) {
        return false;
    }

    const { allowedTools } = config.selfMaintainer;
    if (allowedTools.length === 0) {
        return true;
    }

    return allowedTools.includes(toolName);
}

export function collectMaintenanceCandidates(
    logs: ToolUsageParams[],
    now: number,
    state: SelfMaintainerState,
): MaintenanceCandidate[] {
    const { failureWindowMs, minFailures, cooldownMs, maxToolsPerRun } = config.selfMaintainer;
    const blockedTools = getBlockedTools();
    const grouped = new Map<string, ToolUsageParams[]>();

    for (const logItem of logs) {
        const isRecentFailure = !logItem.success && now - logItem.time <= failureWindowMs;
        if (!isRecentFailure || !isAllowedTool(logItem.name, blockedTools)) {
            continue;
        }

        const failures = grouped.get(logItem.name) ?? [];
        failures.push(logItem);
        grouped.set(logItem.name, failures);
    }

    return Array.from(grouped.entries())
        .map(([toolName, failures]) => {
            const latestFailureTime = Math.max(...failures.map(item => item.time));
            return { toolName, failures, latestFailureTime };
        })
        .filter(candidate => candidate.failures.length >= minFailures)
        .filter(candidate => {
            const lastAttemptAt = state.lastAttemptAt.get(candidate.toolName) ?? 0;
            if (now - lastAttemptAt < cooldownMs) {
                return false;
            }

            const lastHandledFailureTime = state.lastHandledFailureTime.get(candidate.toolName) ?? 0;
            return candidate.latestFailureTime > lastHandledFailureTime;
        })
        .sort((left, right) => {
            if (right.failures.length !== left.failures.length) {
                return right.failures.length - left.failures.length;
            }
            return right.latestFailureTime - left.latestFailureTime;
        })
        .slice(0, maxToolsPerRun);
}

export function buildMaintenanceDescription(candidate: MaintenanceCandidate): string {
    const summary = candidate.failures
        .slice(0, FAILURE_SAMPLE_LIMIT)
        .map((failure, index) => {
            const timeText = new Date(failure.time).toLocaleString('zh-CN', { hour12: false });
            const paramsText = stringifyForDisplay(failure.params, { maxLen: DESCRIPTION_PARAM_LIMIT });
            const resultText = truncateText(failure.result || '(空结果)', DESCRIPTION_RESULT_LIMIT);
            return `${index + 1}. ${timeText} | params=${paramsText} | result=${resultText}`;
        })
        .join('\n');

    return [
        `自动维护触发：工具 [${candidate.toolName}] 在最近窗口内连续失败 ${candidate.failures.length} 次。`,
        '请优先修复导致这些失败的根因，保持原有功能兼容，并避免影响其他工具。',
        '最近失败摘要：',
        summary,
    ].join('\n');
}

async function defaultMaintainTool(toolName: string, description: string): Promise<ToolResult> {
    return manageSkillExecute({
        action: 'maintain',
        toolName,
        description,
    }, {
        senderId: config.masterQQ,
    });
}

function defaultRecordMaintenance(
    toolName: string,
    description: string,
    result: ToolResult,
    duration: number,
): void {
    toolStats.add({
        name: 'manage_skill',
        params: {
            action: 'maintain',
            toolName,
            source: 'self_maintainer',
            description,
        },
        result: result.text,
        success: result.success,
        duration,
        time: Date.now(),
        user: {
            id: config.masterQQ,
            name: 'self_maintainer',
        },
    });
}

export class ToolSelfMaintainer {
    private timer: NodeJS.Timeout | null = null;

    private state: SelfMaintainerState = {
        lastAttemptAt: new Map(),
        lastHandledFailureTime: new Map(),
    };

    constructor(private readonly deps: SelfMaintainerDeps = {
        getLogs: () => toolStats.getLogs(),
        maintainTool: defaultMaintainTool,
        recordMaintenance: defaultRecordMaintenance,
        now: () => Date.now(),
    }) {}

    start(): void {
        if (!config.selfMaintainer.enabled) {
            log.info('🩺 工具自维护服务已禁用');
            return;
        }

        if (!config.masterQQ || config.masterQQ <= 0) {
            log.warn('🩺 工具自维护服务启动失败：MASTER_QQ 未正确配置');
            return;
        }

        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => {
            void this.runOnce();
        }, config.selfMaintainer.intervalMs);
        this.timer.unref?.();

        log.info(`🩺 工具自维护服务已启动，巡检间隔 ${Math.round(config.selfMaintainer.intervalMs / 60000)} 分钟`);
    }

    stop(): void {
        if (!this.timer) {
            return;
        }

        clearInterval(this.timer);
        this.timer = null;
        log.info('🩺 工具自维护服务已停止');
    }

    syncWithConfig(): void {
        this.stop();
        if (config.selfMaintainer.enabled) {
            this.start();
        }
    }

    async runOnce(): Promise<void> {
        if (!config.selfMaintainer.enabled || !config.masterQQ || config.masterQQ <= 0) {
            return;
        }

        const now = this.deps.now();
        const candidates = collectMaintenanceCandidates(this.deps.getLogs(), now, this.state);
        if (candidates.length === 0) {
            return;
        }

        for (const candidate of candidates) {
            await this.maintainCandidate(candidate, now);
        }
    }

    private async maintainCandidate(candidate: MaintenanceCandidate, now: number): Promise<void> {
        const description = buildMaintenanceDescription(candidate);
        this.state.lastAttemptAt.set(candidate.toolName, now);

        log.warn(`🩺 自动维护触发: ${candidate.toolName} 最近失败 ${candidate.failures.length} 次，开始调用 manage_skill`);

        const startedAt = this.deps.now();
        const result = await this.deps.maintainTool(candidate.toolName, description);
        const duration = Math.max(0, this.deps.now() - startedAt);

        this.deps.recordMaintenance(candidate.toolName, description, result, duration);

        if (result.success) {
            this.state.lastHandledFailureTime.set(candidate.toolName, candidate.latestFailureTime);
            log.info(`🩺 自动维护成功: ${candidate.toolName}`);
            return;
        }

        log.warn(`🩺 自动维护失败: ${candidate.toolName} -> ${result.text}`);
    }
}

export const toolSelfMaintainer = new ToolSelfMaintainer();
