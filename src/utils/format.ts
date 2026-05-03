/**
 * 展示层格式化工具
 */

interface StringifyOptions {
    maxLen?: number;
    fallback?: string;
}

function createSafeJsonReplacer(): (key: string, value: unknown) => unknown {
    const seen = new WeakSet<object>();

    return (_key: string, value: unknown): unknown => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (typeof value === 'symbol') {
            return value.toString();
        }
        if (typeof value === 'function') {
            return `[Function ${value.name || 'anonymous'}]`;
        }
        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack,
            };
        }
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);
        }
        return value;
    };
}

export function truncateText(text: string, maxLen: number): string {
    if (maxLen <= 0 || text.length <= maxLen) {
        return text;
    }
    if (maxLen <= 3) {
        return text.slice(0, maxLen);
    }
    return `${text.slice(0, maxLen - 3)}...`;
}

export function safeJsonStringify(value: unknown, space = 0): string | null {
    try {
        return JSON.stringify(value, createSafeJsonReplacer(), space) ?? null;
    } catch {
        return null;
    }
}

export function stringifyForDisplay(value: unknown, options: StringifyOptions = {}): string {
    const { maxLen, fallback } = options;

    const finish = (text: string): string => {
        if (typeof maxLen === 'number') {
            return truncateText(text, maxLen);
        }
        return text;
    };

    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return finish(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return finish(String(value));
    }
    if (typeof value === 'symbol') return finish(value.toString());
    if (typeof value === 'function') return finish(`[Function ${value.name || 'anonymous'}]`);
    if (value instanceof Error) return finish(value.message || value.name);

    const json = safeJsonStringify(value);
    if (json) {
        return finish(json);
    }

    return finish(fallback || Object.prototype.toString.call(value));
}

export function getStringParam(
    params: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = params[key];
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function parseInteger(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Math.trunc(value) : undefined;
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

export function resolveOptionalGroupId(
    value: unknown,
    fallback?: number,
): number | undefined {
    const parsed = parseInteger(value);
    if (parsed !== undefined && parsed > 0) {
        return parsed;
    }
    return fallback;
}
