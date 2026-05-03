import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'poke',
    description: '戳一戳用户。当用户请求戳某人时调用。',
    parameters: {
        type: 'object',
        properties: {
            targetId: { type: 'string', description: '目标用户的QQ号' },
            times: { type: 'number', description: '戳的次数，默认为1次，最多不超过10次' },
        },
        required: ['targetId'],
    },
};
