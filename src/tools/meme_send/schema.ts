import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'meme_send',
    description: '发送本地表情包/斗图图片。适合用户明确要求“发表情包”“来个生气表情”“斗图回他”时使用。',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '表情包关键词或分类，例如“生气”“疑问”“主人”“安慰”',
            },
            scene: {
                type: 'string',
                description: '按场景选图，可选 angry/question/comfort/owner/daily',
                enum: ['angry', 'question', 'comfort', 'owner', 'daily'],
            },
            count: {
                type: 'integer',
                description: '发送数量，默认 1，最大 5',
                default: 1,
            },
        },
        required: [],
    },
};
