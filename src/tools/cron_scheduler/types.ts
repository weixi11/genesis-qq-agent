export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ScheduleType = 'once' | 'cron';
export type LastStatus = 'never' | 'running' | 'success' | 'failed';
export type TriggerSource = 'scheduler' | 'run_now';

export class TaskExecutionError extends Error {
    code: string;
    detail?: Record<string, unknown>;

    constructor(code: string, message: string, detail?: Record<string, unknown>) {
        super(message);
        this.name = 'TaskExecutionError';
        this.code = code;
        this.detail = detail;
    }
}

export interface SchedulerTask {
    taskId: string;
    name: string;
    scheduleType: ScheduleType;
    runAt?: string;
    cron?: string;
    timezone: string;
    toolName: string;
    toolParams: Record<string, JsonValue>;
    enabled: boolean;
    retries: number;
    timeoutSec: number;
    maxConcurrency: number;
    notifyOnFail: boolean;
    createdBy: number;
    createdAt: string;
    updatedBy: number;
    updatedAt: string;
    nextRunTime?: string;
    lastRunTime?: string;
    lastStatus: LastStatus;
    lastError?: string;
    runCount: number;
    runningCount: number;
    groupId?: number;
}

export interface TaskLog {
    taskId: string;
    time: string;
    timeMs: number;
    status: 'success' | 'failed';
    message: string;
    durationMs: number;
    triggerSource: TriggerSource;
    triggeredBy: number;
    attempts: number;
    errorCode?: string;
    errorMessage?: string;
}

export interface ListFilters {
    status?: string;
    toolName?: string;
    createdBy?: number;
    enabled?: boolean;
}
