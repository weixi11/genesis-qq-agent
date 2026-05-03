/**
 * Like 模块 Schema
 * 
 * 用于 LLM Function Calling
 */

import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'like',
    description: '给用户点赞。当用户请求点赞时调用。',
    parameters: {
        type: 'object',
        properties: {
            targetId: {
                type: 'string',
                description: '目标用户的QQ号（可选，不填则给@的用户或发送者点赞）',
            },
            times: {
                type: 'integer',
                description: '点赞次数，默认10次',
                default: 10,
            },
        },
        required: [],
    },
};
