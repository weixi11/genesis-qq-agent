import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'read_audio',
    description: '听取并分析音频/语音内容。可用 audioIndex 指定第几个语音。',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '音频文件路径（可不填，自动从历史获取）' },
            question: { type: 'string', description: '关于音频的问题' },
            audioIndex: { type: 'integer', description: '指定第几个语音（1=最近）' },
        },
        required: [],
    },
};
