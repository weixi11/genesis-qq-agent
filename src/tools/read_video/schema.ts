import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'read_video',
    description: '观看并描述视频内容。可用 videoIndex 指定第几个视频。',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '视频文件路径（可不填，自动从历史获取）' },
            question: { type: 'string', description: '关于视频的问题' },
            videoIndex: { type: 'integer', description: '指定第几个视频（1=最近）' },
        },
        required: [],
    },
};
