import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'profile',
    description: '查询用户资料。当用户询问某人是谁或查资料时调用。',
    parameters: {
        type: 'object',
        properties: {
            targetId: { type: 'string', description: '目标用户的QQ号' },
        },
        required: ['targetId'],
    },
};
