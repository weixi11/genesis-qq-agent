import { randomUUID } from 'node:crypto';
import type { PreparedToolTestPayload, ToolTestExecutionResponse } from './tool_test_runner.js';
import { mutateGenesisDbSnapshot, readGenesisDbSnapshot } from '../storage/genesis-db.js';
import { isRecord, safeParseJson } from '../utils/json.js';

export interface ToolTestRequestRecord {
    requestId: string;
    toolName: string;
    payload: PreparedToolTestPayload;
    status: 'pending' | 'running' | 'success' | 'failed';
    requestedAt: number;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
    response?: ToolTestExecutionResponse;
    errorMessage?: string;
}

function isToolTestExecutionContext(value: unknown): value is PreparedToolTestPayload['context'] {
    return isRecord(value)
        && typeof value.senderId === 'number'
        && (value.groupId === undefined || typeof value.groupId === 'number')
        && Array.isArray(value.atUsers)
        && value.atUsers.every((item) => typeof item === 'number')
        && Array.isArray(value.imageUrls)
        && value.imageUrls.every((item) => typeof item === 'string')
        && Array.isArray(value.audioPaths)
        && value.audioPaths.every((item) => typeof item === 'string')
        && Array.isArray(value.videoPaths)
        && value.videoPaths.every((item) => typeof item === 'string');
}

function parseToolTestPayload(raw: unknown, fallbackToolName: string): PreparedToolTestPayload {
    const fallback: PreparedToolTestPayload = {
        toolName: fallbackToolName,
        requestParams: {},
        toolParams: {},
        context: {
            senderId: 0,
            atUsers: [],
            imageUrls: [],
            audioPaths: [],
            videoPaths: [],
        },
    };

    if (typeof raw !== 'string') {
        return fallback;
    }
    const parsed = safeParseJson(raw);
    if (!isRecord(parsed)) {
        return fallback;
    }

    return {
        toolName: typeof parsed.toolName === 'string' && parsed.toolName.trim() ? parsed.toolName : fallbackToolName,
        requestParams: isRecord(parsed.requestParams) ? parsed.requestParams : {},
        toolParams: isRecord(parsed.toolParams) ? parsed.toolParams : {},
        context: isToolTestExecutionContext(parsed.context) ? parsed.context : fallback.context,
    };
}

function parseToolTestContext(raw: unknown, fallback: PreparedToolTestPayload['context']): PreparedToolTestPayload['context'] {
    if (typeof raw !== 'string') {
        return fallback;
    }
    const parsed = safeParseJson(raw);
    return isToolTestExecutionContext(parsed) ? parsed : fallback;
}

function parseToolTestResponse(raw: unknown): ToolTestExecutionResponse | undefined {
    if (typeof raw !== 'string') {
        return undefined;
    }
    const parsed = safeParseJson(raw);
    if (!isRecord(parsed) || typeof parsed.success !== 'boolean') {
        return undefined;
    }
    return {
        success: parsed.success,
        text: typeof parsed.text === 'string' ? parsed.text : undefined,
        data: parsed.data,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
}

function deserializeRecord(row: Record<string, unknown>): ToolTestRequestRecord {
    const toolName = String(row.tool_name || '');
    const payload = parseToolTestPayload(String(row.params_json || ''), toolName);
    const parsedContext = parseToolTestContext(String(row.context_json || ''), payload.context);
    const parsedResponse = parseToolTestResponse(row.response_json);

    return {
        requestId: String(row.request_id),
        toolName,
        payload: {
            ...payload,
            toolName,
            context: parsedContext || payload.context,
        },
        status: row.status as ToolTestRequestRecord['status'],
        requestedAt: Number(row.requested_at) || 0,
        startedAt: row.started_at == null ? undefined : Number(row.started_at),
        finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
        durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
        response: parsedResponse,
        errorMessage: row.error_message == null ? undefined : String(row.error_message),
    };
}

export async function enqueueToolTestRequest(
    payload: PreparedToolTestPayload,
): Promise<ToolTestRequestRecord> {
    const request: ToolTestRequestRecord = {
        requestId: `tool_test_${Date.now()}_${randomUUID().slice(0, 8)}`,
        toolName: payload.toolName,
        payload,
        status: 'pending',
        requestedAt: Date.now(),
    };

    await mutateGenesisDbSnapshot((db) => {
        db.run(
            `INSERT INTO tool_test_requests (
                request_id, tool_name, params_json, context_json, status, requested_at,
                started_at, finished_at, duration_ms, response_json, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
            [
                request.requestId,
                request.toolName,
                JSON.stringify({
                    toolName: payload.toolName,
                    requestParams: payload.requestParams,
                    toolParams: payload.toolParams,
                }),
                JSON.stringify(payload.context),
                request.status,
                request.requestedAt,
            ],
        );
    });

    return request;
}

export async function claimPendingToolTestRequest(): Promise<ToolTestRequestRecord | undefined> {
    return mutateGenesisDbSnapshot((db) => {
        const stmt = db.prepare(
            "SELECT * FROM tool_test_requests WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 1",
        );

        let record: ToolTestRequestRecord | undefined;
        if (stmt.step()) {
            record = deserializeRecord(stmt.getAsObject());
        }
        stmt.free();

        if (!record) {
            return undefined;
        }

        const startedAt = Date.now();
        db.run(
            `UPDATE tool_test_requests
             SET status = 'running', started_at = ?, finished_at = NULL, duration_ms = NULL, response_json = NULL, error_message = NULL
             WHERE request_id = ?`,
            [startedAt, record.requestId],
        );

        return {
            ...record,
            status: 'running',
            startedAt,
            finishedAt: undefined,
            durationMs: undefined,
            response: undefined,
            errorMessage: undefined,
        };
    });
}

export async function completeToolTestRequest(
    requestId: string,
    result: {
        status: 'success' | 'failed';
        durationMs: number;
        response?: ToolTestExecutionResponse;
        errorMessage?: string;
    },
): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run(
            `UPDATE tool_test_requests
             SET status = ?, finished_at = ?, duration_ms = ?, response_json = ?, error_message = ?
             WHERE request_id = ?`,
            [
                result.status,
                Date.now(),
                result.durationMs,
                result.response ? JSON.stringify(result.response) : null,
                result.errorMessage || null,
                requestId,
            ],
        );
    });
}

export async function getToolTestRequest(
    requestId: string,
): Promise<ToolTestRequestRecord | undefined> {
    return readGenesisDbSnapshot((db) => {
        const stmt = db.prepare('SELECT * FROM tool_test_requests WHERE request_id = ? LIMIT 1');
        stmt.bind([requestId]);

        let request: ToolTestRequestRecord | undefined;
        if (stmt.step()) {
            request = deserializeRecord(stmt.getAsObject());
        }
        stmt.free();
        return request;
    });
}
