import type { JsonValue } from './types.js';

export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

export function getZonedParts(date: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
    });
    const parts = dtf.formatToParts(date);
    const map = new Map<string, string>();
    for (const p of parts) {
        if (p.type !== 'literal') map.set(p.type, p.value);
    }
    const weekdayRaw = map.get('weekday') || 'Sun';
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: Number(map.get('year') || '1970'),
        month: Number(map.get('month') || '1'),
        day: Number(map.get('day') || '1'),
        hour: Number(map.get('hour') || '0'),
        minute: Number(map.get('minute') || '0'),
        weekday: weekdayMap[weekdayRaw] ?? 0,
    };
}

export function formatToday(date: Date, tz: string): string {
    const p = getZonedParts(date, tz);
    return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function formatNow(date: Date, tz: string): string {
    const p = getZonedParts(date, tz);
    return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00`;
}

export function renderTemplates(value: JsonValue, tz: string, now: Date): JsonValue {
    if (typeof value === 'string') {
        return value.replaceAll('{{now}}', formatNow(now, tz)).replaceAll('{{today}}', formatToday(now, tz));
    }
    if (Array.isArray(value)) {
        return value.map((v) => renderTemplates(v, tz, now));
    }
    if (value && typeof value === 'object') {
        const out: { [k: string]: JsonValue } = {};
        for (const [k, v] of Object.entries(value)) out[k] = renderTemplates(v, tz, now);
        return out;
    }
    return value;
}

function isIntegerText(text: string): boolean {
    if (text.length === 0) return false;
    for (const ch of text) {
        if (ch < '0' || ch > '9') return false;
    }
    return true;
}

function parseNumberText(text: string): number | null {
    if (!isIntegerText(text)) return null;
    const n = Number(text);
    return Number.isInteger(n) ? n : null;
}

interface CronFieldMatch {
    values: Set<number>;
    isWildcard: boolean;
}

export function parseCronField(field: string, min: number, max: number, isWeekday = false): { ok: true; field: CronFieldMatch } | { ok: false; error: string } {
    const set = new Set<number>();
    const normalizedField = field.trim();
    const parts = normalizedField.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) return { ok: false, error: `空字段: ${field}` };

    const addValue = (v: number): boolean => {
        const value = isWeekday && v === 7 ? 0 : v;
        if (value < min || value > max) return false;
        set.add(value);
        return true;
    };

    const addRange = (start: number, end: number, step: number): boolean => {
        if (start > end || step <= 0) return false;
        for (let i = start; i <= end; i += step) {
            if (!addValue(i)) return false;
        }
        return true;
    };

    for (const part of parts) {
        const slashIndex = part.indexOf('/');
        let base = part;
        let step = 1;
        if (slashIndex >= 0) {
            base = part.slice(0, slashIndex);
            const parsedStep = parseNumberText(part.slice(slashIndex + 1));
            if (parsedStep === null || parsedStep <= 0) return { ok: false, error: `非法 step: ${part}` };
            step = parsedStep;
        }

        if (base === '*') {
            if (!addRange(min, max, step)) return { ok: false, error: `非法通配范围: ${part}` };
            continue;
        }

        const dashIndex = base.indexOf('-');
        if (dashIndex >= 0) {
            const s = parseNumberText(base.slice(0, dashIndex));
            const e = parseNumberText(base.slice(dashIndex + 1));
            if (s === null || e === null) return { ok: false, error: `非法范围: ${part}` };
            if (!addRange(s, e, step)) return { ok: false, error: `范围越界: ${part}` };
            continue;
        }

        const single = parseNumberText(base);
        if (single === null) return { ok: false, error: `非法值: ${part}` };
        if (step !== 1) return { ok: false, error: `单值不支持 step: ${part}` };
        if (!addValue(single)) return { ok: false, error: `值越界: ${part}` };
    }

    return {
        ok: true,
        field: {
            values: set,
            isWildcard: normalizedField === '*',
        },
    };
}

export function parseCron(expr: string): { ok: true; match: (date: Date, tz: string) => boolean } | { ok: false; error: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return { ok: false, error: 'cron 必须是 5 段：分 时 日 月 周' };

    const minute = parseCronField(fields[0], 0, 59);
    if (!minute.ok) return { ok: false, error: minute.error };
    const hour = parseCronField(fields[1], 0, 23);
    if (!hour.ok) return { ok: false, error: hour.error };
    const day = parseCronField(fields[2], 1, 31);
    if (!day.ok) return { ok: false, error: day.error };
    const month = parseCronField(fields[3], 1, 12);
    if (!month.ok) return { ok: false, error: month.error };
    const weekday = parseCronField(fields[4], 0, 6, true);
    if (!weekday.ok) return { ok: false, error: weekday.error };

    return {
        ok: true,
        match: (date: Date, tz: string) => {
            const p = getZonedParts(date, tz);
            const dayMatches = day.field.values.has(p.day);
            const weekdayMatches = weekday.field.values.has(p.weekday);
            const dateMatches = day.field.isWildcard && weekday.field.isWildcard
                ? true
                : day.field.isWildcard
                    ? weekdayMatches
                    : weekday.field.isWildcard
                        ? dayMatches
                        : (dayMatches || weekdayMatches);

            return minute.field.values.has(p.minute)
                && hour.field.values.has(p.hour)
                && month.field.values.has(p.month)
                && dateMatches;
        },
    };
}

export function computeNextCronRun(cronExpr: string, tz: string, fromDate: Date): Date | null {
    const cron = parseCron(cronExpr);
    if (!cron.ok) return null;
    const base = new Date(Math.floor(fromDate.getTime() / 60000) * 60000 + 60000);
    // Limit to 1 year search
    for (let i = 0; i < 525600; i++) {
        const candidate = new Date(base.getTime() + i * 60000);
        if (cron.match(candidate, tz)) return candidate;
    }
    return null;
}
