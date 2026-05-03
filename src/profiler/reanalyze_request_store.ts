import { randomUUID } from 'node:crypto';
import type { AnalysisMessage } from '../types.js';
import { mutateGenesisDbSnapshot, readGenesisDbSnapshot } from '../storage/genesis-db.js';
import { isRecord, safeParseJson } from '../utils/json.js';

export interface ProfilerReanalyzeRequest {
    requestId: string;
    userId: number;
    messages: AnalysisMessage[];
    status: 'pending' | 'running' | 'success' | 'failed';
    requestedAt: number;
    startedAt?: number;
    finishedAt?: number;
    analyzedCount?: number;
    errorMessage?: string;
}

function parseAnalysisContext(raw: unknown): Array<{ sender: string; text: string }> | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }

    const context = raw
        .filter(isRecord)
        .map((item) => ({
            sender: typeof item.sender === 'string' ? item.sender : '',
            text: typeof item.text === 'string' ? item.text : '',
        }))
        .filter((item) => item.sender && item.text);

    return context.length > 0 ? context : undefined;
}

function parseAnalysisMessage(raw: unknown): AnalysisMessage | null {
    if (!isRecord(raw)) {
        return null;
    }
    if (
        typeof raw.userId !== 'number'
        || typeof raw.nickname !== 'string'
        || typeof raw.text !== 'string'
        || typeof raw.timestamp !== 'number'
    ) {
        return null;
    }

    return {
        userId: raw.userId,
        nickname: raw.nickname,
        groupId: typeof raw.groupId === 'number' ? raw.groupId : undefined,
        text: raw.text,
        timestamp: raw.timestamp,
        emotion: isRecord(raw.emotion)
            && typeof raw.emotion.valence === 'number'
            && typeof raw.emotion.arousal === 'number'
            ? { valence: raw.emotion.valence, arousal: raw.emotion.arousal }
            : undefined,
        context: parseAnalysisContext(raw.context),
    };
}

function parseMessagesJson(raw: unknown): AnalysisMessage[] {
    if (typeof raw !== 'string') {
        return [];
    }

    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed
        .map((item) => parseAnalysisMessage(item))
        .filter((item): item is AnalysisMessage => item !== null);
}

function deserializeRequest(row: Record<string, unknown>): ProfilerReanalyzeRequest {
    return {
        requestId: String(row.request_id),
        userId: Number(row.user_id) || 0,
        messages: parseMessagesJson(row.messages_json),
        status: row.status as ProfilerReanalyzeRequest['status'],
        requestedAt: Number(row.requested_at) || 0,
        startedAt: row.started_at == null ? undefined : Number(row.started_at),
        finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
        analyzedCount: row.analyzed_count == null ? undefined : Number(row.analyzed_count),
        errorMessage: row.error_message == null ? undefined : String(row.error_message),
    };
}

export async function enqueueProfilerReanalyzeRequest(
    userId: number,
    messages: AnalysisMessage[],
): Promise<ProfilerReanalyzeRequest> {
    const request: ProfilerReanalyzeRequest = {
        requestId: `prof_req_${Date.now()}_${randomUUID().slice(0, 8)}`,
        userId,
        messages,
        status: 'pending',
        requestedAt: Date.now(),
    };

    await mutateGenesisDbSnapshot((db) => {
        db.run(
            `INSERT INTO profiler_reanalyze_requests (
                request_id, user_id, messages_json, status, requested_at, started_at, finished_at, analyzed_count, error_message
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
            [
                request.requestId,
                request.userId,
                JSON.stringify(request.messages),
                request.status,
                request.requestedAt,
            ],
        );
    });

    return request;
}

export async function claimPendingProfilerReanalyzeRequest(): Promise<ProfilerReanalyzeRequest | undefined> {
    return mutateGenesisDbSnapshot((db) => {
        const stmt = db.prepare(
            "SELECT * FROM profiler_reanalyze_requests WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 1",
        );

        let request: ProfilerReanalyzeRequest | undefined;
        if (stmt.step()) {
            request = deserializeRequest(stmt.getAsObject());
        }
        stmt.free();

        if (!request) {
            return undefined;
        }

        const startedAt = Date.now();
        db.run(
            `UPDATE profiler_reanalyze_requests
             SET status = 'running', started_at = ?, finished_at = NULL, analyzed_count = NULL, error_message = NULL
             WHERE request_id = ?`,
            [startedAt, request.requestId],
        );

        return {
            ...request,
            status: 'running',
            startedAt,
            finishedAt: undefined,
            analyzedCount: undefined,
            errorMessage: undefined,
        };
    });
}

export async function completeProfilerReanalyzeRequest(
    requestId: string,
    result: {
        status: 'success' | 'failed';
        analyzedCount?: number;
        errorMessage?: string;
    },
): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run(
            `UPDATE profiler_reanalyze_requests
             SET status = ?, finished_at = ?, analyzed_count = ?, error_message = ?
             WHERE request_id = ?`,
            [
                result.status,
                Date.now(),
                result.analyzedCount ?? null,
                result.errorMessage || null,
                requestId,
            ],
        );
    });
}

export async function getProfilerReanalyzeRequest(
    requestId: string,
): Promise<ProfilerReanalyzeRequest | undefined> {
    return readGenesisDbSnapshot((db) => {
        const stmt = db.prepare('SELECT * FROM profiler_reanalyze_requests WHERE request_id = ? LIMIT 1');
        stmt.bind([requestId]);

        let request: ProfilerReanalyzeRequest | undefined;
        if (stmt.step()) {
            request = deserializeRequest(stmt.getAsObject());
        }
        stmt.free();
        return request;
    });
}
