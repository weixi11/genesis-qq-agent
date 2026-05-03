
import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'group_kick',
    description: '移出群成员（踢人）。主人/群主/管理员可以操作，普通群员不能踢人。',
    parameters: {
        type: 'object',
        properties: {
            user_id: {
                type: 'integer',
                description: '目标用户QQ号',
            },
            reject_add_request: {
                type: 'boolean',
                description: '是否拒绝此人再次加群（默认false）',
            },
        },
        required: ['user_id'],
    },
};
