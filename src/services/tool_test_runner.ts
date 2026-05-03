import { buildModuleContext, executeModule } from '../tools/index.js';
import { toolStats } from '../web/store/tool_stats.js';
import { getStringParam } from '../utils/format.js';

export interface ToolTestExecutionContext {
    senderId: number;
    groupId?: number;
    atUsers: number[];
    imageUrls: string[];
    audioPaths: string[];
    videoPaths: string[];
}

export interface PreparedToolTestPayload {
    toolName: string;
    requestParams: Record<string, unknown>;
    toolParams: Record<string, unknown>;
    context: ToolTestExecutionContext;
}

export interface ToolTestExecutionResponse {
    success: boolean;
    text?: string;
    data?: unknown;
    error?: string;
}

export interface ToolTestExecutionResult {
    response: ToolTestExecutionResponse;
    duration: number;
}

export function prepareToolTestPayload(
    toolName: string,
    requestParams: Record<string, unknown>,
): PreparedToolTestPayload {
    const toolParams = { ...requestParams };
    const imageUrls: string[] = [];
    const audioPaths: string[] = [];
    const videoPaths: string[] = [];
    const atUsers: number[] = [];

    const imagePath = getStringParam(toolParams, 'imagePath');
    if ((toolName === 'vision' || toolName === 'banana_draw') && imagePath) {
        if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
            imageUrls.push(imagePath);
            delete toolParams.imagePath;
        }
    }

    const audioPath = getStringParam(toolParams, 'audioPath');
    if (toolName === 'read_audio' && audioPath) {
        audioPaths.push(audioPath);
    }

    const videoPath = getStringParam(toolParams, 'videoPath');
    if (toolName === 'read_video' && videoPath) {
        videoPaths.push(videoPath);
    }

    if (['like', 'profile', 'poke'].includes(toolName) && toolParams.targetId !== undefined) {
        const targetNum = Number(toolParams.targetId);
        if (!Number.isNaN(targetNum)) {
            atUsers.push(targetNum);
        }
    }

    return {
        toolName,
        requestParams,
        toolParams,
        context: {
            senderId: 0,
            atUsers,
            imageUrls,
            audioPaths,
            videoPaths,
        },
    };
}

export async function executePreparedToolTest(
    payload: PreparedToolTestPayload,
): Promise<ToolTestExecutionResult> {
    const startedAt = Date.now();

    try {
        const ctx = buildModuleContext({
            senderId: payload.context.senderId,
            groupId: payload.context.groupId,
            atUsers: payload.context.atUsers,
            imageUrls: payload.context.imageUrls,
            audioPaths: payload.context.audioPaths,
            videoPaths: payload.context.videoPaths,
        });
        const result = await executeModule(payload.toolName, payload.toolParams, ctx);
        const duration = Date.now() - startedAt;

        return {
            response: {
                success: result.success,
                text: result.text,
                data: result.data,
            },
            duration,
        };
    } catch (error) {
        return {
            response: {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            },
            duration: Date.now() - startedAt,
        };
    }
}

export function recordToolTestLog(
    toolName: string,
    requestParams: Record<string, unknown>,
    result: ToolTestExecutionResult,
): void {
    toolStats.add({
        name: toolName,
        params: requestParams,
        result: result.response.text || result.response.error || '',
        success: result.response.success,
        duration: result.duration,
        time: Date.now(),
        user: { id: 0, name: 'Web测试' },
    });
}
