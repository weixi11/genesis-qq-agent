import { getEnabledModules } from '../loader.js';

const parseEnabled = (): boolean => {
    const envEnabled = process.env.MODULE_CRON_SCHEDULER_ENABLED?.toLowerCase();
    return envEnabled !== 'false' && envEnabled !== '0';
};

const parseList = (value: string | undefined, fallback: string[]): string[] => {
    if (!value) return fallback;
    return value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
};

function resolveAllowedTools(): string[] {
    const configured = process.env.CRON_SCHEDULER_ALLOWED_TOOLS;
    if (configured && configured.trim()) {
        return parseList(configured, []);
    }

    return getEnabledModules()
        .map((item) => item.module.name)
        .sort((left, right) => left.localeCompare(right));
}

function resolveAllowedToolsSource(): 'env' | 'enabled_modules' {
    const configured = process.env.CRON_SCHEDULER_ALLOWED_TOOLS;
    return configured && configured.trim() ? 'env' : 'enabled_modules';
}

export const config = {
    enabled: parseEnabled(),
    timeoutMs: parseInt(process.env.CRON_SCHEDULER_TIMEOUT_MS || '30000', 10),
    concurrency: parseInt(process.env.CRON_SCHEDULER_CONCURRENCY || '5', 10),

    defaultTimezone: process.env.CRON_SCHEDULER_DEFAULT_TIMEZONE || 'Asia/Shanghai',
    tickMs: parseInt(process.env.CRON_SCHEDULER_TICK_MS || '15000', 10),
    maxPageSize: parseInt(process.env.CRON_SCHEDULER_MAX_PAGE_SIZE || '100', 10),
    logsLimitPerTask: parseInt(process.env.CRON_SCHEDULER_LOGS_LIMIT || '50', 10),

    defaultRetries: parseInt(process.env.CRON_SCHEDULER_DEFAULT_RETRIES || '0', 10),
    defaultTimeoutSec: parseInt(process.env.CRON_SCHEDULER_DEFAULT_TIMEOUT_SEC || '60', 10),
    defaultMaxConcurrency: parseInt(process.env.CRON_SCHEDULER_DEFAULT_MAX_CONCURRENCY || '1', 10),
    defaultNotifyOnFail: (() => {
        const raw = process.env.CRON_SCHEDULER_DEFAULT_NOTIFY_ON_FAIL?.toLowerCase();
        return raw === 'true' || raw === '1';
    })(),
    get allowedToolsSource(): 'env' | 'enabled_modules' {
        return resolveAllowedToolsSource();
    },
    get allowedTools(): string[] {
        return resolveAllowedTools();
    },
};
