import { config } from './config.js';
import { schema } from './schema.js';
import { selectManualMeme } from '../../services/meme_decider.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

export const name = 'meme_send';
export const description = '发送本地表情包或斗图图片';
export const keywords = ['表情包', '斗图', '发表情', '发个表情', '来个表情', '生气表情', '疑问表情'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

export async function execute(
    params: Record<string, unknown>,
    _ctx: ToolContext,
): Promise<ToolResult> {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const scene = typeof params.scene === 'string' ? params.scene.trim() : '';
    const count = typeof params.count === 'number' ? params.count : Number(params.count || 1);

    const result = selectManualMeme({
        query,
        scene,
        count: Number.isFinite(count) ? count : 1,
    });

    if (!result.pack || result.segments.length === 0) {
        return {
            success: false,
            text: query || scene
                ? `没找到和“${query || scene}”匹配的表情包。`
                : '当前没有可发送的表情包。',
        };
    }

    return {
        success: true,
        text: `发送 ${result.pack.label} 表情包`,
        segments: result.segments,
        data: {
            packId: result.pack.id,
            packLabel: result.pack.label,
            files: result.files,
        },
    };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
