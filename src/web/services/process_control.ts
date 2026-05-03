import { execFile } from 'child_process';
import { promisify } from 'util';

export const ADAPTER_PM2_NAME = 'll-genesis-napcat-adapter';
export const GENESIS_AGENT_PM2_NAME = 'genesis-agent';

const execFileAsync = promisify(execFile);

export type ProcessRestartResult = {
    restarted: boolean;
    error?: string;
};

export type ProcessSyncResult = {
    requested: boolean;
    applied: boolean;
    restarted: boolean;
    mode: 'none' | 'hot' | 'restart';
    error?: string;
    skippedReason?: string;
};

export type ManagedProcessStatus = {
    name: string;
    status: string;
    pid: number | null;
    uptimeText: string;
    restarts: number | null;
};

export type ManagedProcessAction = 'start' | 'stop' | 'restart';

const PM2_STATUS_PATTERN = /│\s*status\s*│\s*(.+?)\s*│/u;
const PM2_PID_PATTERN = /│\s*(?:pid|pid path)\s*│\s*(.+?)\s*│/u;
const PM2_UPTIME_PATTERN = /│\s*uptime\s*│\s*(.+?)\s*│/u;
const PM2_RESTARTS_PATTERN = /│\s*restarts\s*│\s*(.+?)\s*│/u;

async function restartPm2Process(name: string, timeout: number): Promise<ProcessRestartResult> {
    try {
        await execFileAsync('pm2', ['restart', name], {
            encoding: 'utf8',
            timeout,
            maxBuffer: 1024 * 1024,
        });
        return { restarted: true };
    } catch (error) {
        return {
            restarted: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function parseIntegerField(rawValue: string | undefined): number | null {
    if (!rawValue) return null;
    const normalized = rawValue.trim();
    if (!normalized || normalized === 'N/A') return null;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractPm2Field(output: string, pattern: RegExp): string {
    const match = output.match(pattern);
    return match?.[1]?.trim() || '';
}

export function parsePm2DescribeOutput(name: string, output: string): ManagedProcessStatus {
    const status = extractPm2Field(output, PM2_STATUS_PATTERN) || 'unknown';
    const pidRaw = extractPm2Field(output, PM2_PID_PATTERN);
    const uptimeText = extractPm2Field(output, PM2_UPTIME_PATTERN) || '-';
    const restartsRaw = extractPm2Field(output, PM2_RESTARTS_PATTERN);

    return {
        name,
        status,
        pid: parseIntegerField(pidRaw),
        uptimeText,
        restarts: parseIntegerField(restartsRaw),
    };
}

async function describePm2Process(name: string): Promise<ManagedProcessStatus> {
    try {
        const { stdout } = await execFileAsync('pm2', ['describe', name], {
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1024 * 1024,
        });
        const parsed = parsePm2DescribeOutput(name, stdout);
        const pid = await getPm2ProcessPid(name);
        return {
            ...parsed,
            pid,
        };
    } catch (error) {
        return {
            name,
            status: 'missing',
            pid: null,
            uptimeText: '-',
            restarts: null,
        };
    }
}

async function getPm2ProcessPid(name: string): Promise<number | null> {
    try {
        const { stdout } = await execFileAsync('pm2', ['pid', name], {
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1024 * 1024,
        });
        const match = stdout.match(/(\d+)\s*$/u);
        return match ? parseIntegerField(match[1]) : null;
    } catch {
        return null;
    }
}

async function runPm2Action(name: string, action: ManagedProcessAction): Promise<void> {
    await execFileAsync('pm2', [action, name], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type ProcessControlDriver = {
    restartPm2Process: (name: string, timeout: number) => Promise<ProcessRestartResult>;
    describePm2Process: (name: string) => Promise<ManagedProcessStatus>;
    runPm2Action: (name: string, action: ManagedProcessAction) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
};

const defaultProcessControlDriver: ProcessControlDriver = {
    restartPm2Process,
    describePm2Process,
    runPm2Action,
    sleep,
};

let processControlDriver: ProcessControlDriver = defaultProcessControlDriver;

export function isManagedProcessActionApplied(action: ManagedProcessAction, status: string): boolean {
    if (action === 'stop') {
        return status === 'stopped' || status === 'missing';
    }
    return status === 'online';
}

function getManagedProcessActionMessage(action: ManagedProcessAction, status: string): string {
    if (isManagedProcessActionApplied(action, status)) {
        return action === 'start'
            ? 'genesis-agent 已启动'
            : action === 'stop'
                ? 'genesis-agent 已停止'
                : 'genesis-agent 已重启';
    }

    return action === 'stop'
        ? `genesis-agent 停止命令已发送，但当前状态仍为 ${status || 'unknown'}`
        : `genesis-agent ${action === 'start' ? '启动' : '重启'}后未进入运行状态，当前状态为 ${status || 'unknown'}`;
}

function getManagedProcessActionMessageForLabel(
    label: string,
    action: ManagedProcessAction,
    status: string,
): string {
    if (isManagedProcessActionApplied(action, status)) {
        return action === 'start'
            ? `${label} 已启动`
            : action === 'stop'
                ? `${label} 已停止`
                : `${label} 已重启`;
    }

    return action === 'stop'
        ? `${label} 停止命令已发送，但当前状态仍为 ${status || 'unknown'}`
        : `${label} ${action === 'start' ? '启动' : '重启'}后未进入运行状态，当前状态为 ${status || 'unknown'}`;
}

async function syncManagedProcessByRestart(name: string, timeout: number): Promise<ProcessSyncResult> {
    const restart = await processControlDriver.restartPm2Process(name, timeout);
    if (!restart.restarted) {
        return {
            requested: true,
            applied: false,
            restarted: false,
            mode: 'restart',
            error: restart.error,
        };
    }

    const after = await processControlDriver.describePm2Process(name);
    const applied = after.status === 'online';
    return {
        requested: true,
        applied,
        restarted: true,
        mode: 'restart',
        error: applied ? undefined : `${name} 重启后状态为 ${after.status || 'unknown'}`,
    };
}

export const __processControlTestUtils = {
    setDriverForTests(overrides: Partial<ProcessControlDriver>) {
        processControlDriver = {
            ...defaultProcessControlDriver,
            ...overrides,
        };
    },
    resetDriverForTests() {
        processControlDriver = defaultProcessControlDriver;
    },
};

export function restartAdapterProcess(): Promise<ProcessRestartResult> {
    return processControlDriver.restartPm2Process(ADAPTER_PM2_NAME, 15000);
}

export function restartGenesisAgentProcess(): Promise<ProcessRestartResult> {
    return processControlDriver.restartPm2Process(GENESIS_AGENT_PM2_NAME, 20000);
}

export function getAdapterProcessStatus(): Promise<ManagedProcessStatus> {
    return processControlDriver.describePm2Process(ADAPTER_PM2_NAME);
}

export function getGenesisAgentProcessStatus(): Promise<ManagedProcessStatus> {
    return processControlDriver.describePm2Process(GENESIS_AGENT_PM2_NAME);
}

async function controlManagedProcess(
    name: string,
    label: string,
    action: ManagedProcessAction,
): Promise<{
    success: boolean;
    message: string;
    process: ManagedProcessStatus;
    action: ManagedProcessAction;
}> {
    const before = await processControlDriver.describePm2Process(name);

    if (action === 'start' && before.status === 'online') {
        return {
            success: true,
            message: `${label} 已在运行`,
            process: before,
            action,
        };
    }

    if (action === 'stop' && before.status !== 'online') {
        return {
            success: true,
            message: `${label} 当前未运行`,
            process: before,
            action,
        };
    }

    await processControlDriver.runPm2Action(name, action);
    await processControlDriver.sleep(600);
    const after = await processControlDriver.describePm2Process(name);
    const success = isManagedProcessActionApplied(action, after.status);
    const message = getManagedProcessActionMessageForLabel(label, action, after.status);

    return {
        success,
        message,
        process: after,
        action,
    };
}

export async function controlGenesisAgentProcess(action: ManagedProcessAction): Promise<{
    success: boolean;
    message: string;
    process: ManagedProcessStatus;
    action: ManagedProcessAction;
}> {
    return controlManagedProcess(GENESIS_AGENT_PM2_NAME, 'genesis-agent', action);
}

export async function controlAdapterProcess(action: ManagedProcessAction): Promise<{
    success: boolean;
    message: string;
    process: ManagedProcessStatus;
    action: ManagedProcessAction;
}> {
    return controlManagedProcess(ADAPTER_PM2_NAME, 'NapCat 适配器', action);
}

export function getGenesisProcessRole(): 'agent' | 'web' {
    const role = (process.env.GENESIS_PROCESS_ROLE || '').trim().toLowerCase();
    return role === 'web' ? 'web' : 'agent';
}

export function createNoProcessSyncResult(reason?: string): ProcessSyncResult {
    return {
        requested: false,
        applied: true,
        restarted: false,
        mode: 'none',
        skippedReason: reason,
    };
}

export function createSkippedProcessSyncResult(reason: string): ProcessSyncResult {
    return {
        requested: true,
        applied: false,
        restarted: false,
        mode: 'none',
        skippedReason: reason,
    };
}

export async function syncGenesisAgentProcess(): Promise<ProcessSyncResult> {
    if (getGenesisProcessRole() === 'agent') {
        return {
            requested: true,
            applied: true,
            restarted: false,
            mode: 'hot',
        };
    }

    return syncManagedProcessByRestart(GENESIS_AGENT_PM2_NAME, 20000);
}

export async function syncAdapterProcess(): Promise<ProcessSyncResult> {
    return syncManagedProcessByRestart(ADAPTER_PM2_NAME, 15000);
}
