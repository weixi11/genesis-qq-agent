import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'music',
    description: '搜索并分享网易云音乐。当用户想要听歌、点歌时调用。',
    parameters: {
        type: 'object',
        properties: {
            keyword: { type: 'string', description: '歌曲关键词，如"稻香 周杰伦"' },
            index: { type: 'number', description: '选择第几首（默认第1首）' },
        },
        required: ['keyword'],
    },
};
