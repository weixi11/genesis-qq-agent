import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'recent_draw_image',
    description: '重发之前由 draw 或 banana_draw 生成并保存在本机的图片。适合“把刚才/上次/之前画的图再发一下”“发一下最近画的图片”等请求。',
    parameters: {
        type: 'object',
        properties: {
            count: {
                type: 'integer',
                description: '要发送的图片数量，默认 1，最大 5。',
                default: 1,
            },
            offset: {
                type: 'integer',
                description: '跳过最近的几张图。0 表示最近一张，1 表示上一张之前的那张。',
                default: 0,
            },
            source: {
                type: 'string',
                enum: ['all', 'draw', 'banana_draw'],
                description: '图片来源。all 表示普通 draw 和 banana_draw 都查；draw 只查普通绘图；banana_draw 只查 Banana 绘图。',
                default: 'all',
            },
        },
        required: [],
    },
};
