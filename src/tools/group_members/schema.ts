/**
 * Group Members 模块 Schema
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'group_members',
    description: '查询本群的全部群成员列表，包括群昵称和QQ号。当用户询问群里有多少人、群成员列表、群里都有谁时调用。',
    parameters: {
        type: 'object',
        properties: {
            groupId: {
                type: 'integer',
                description: '群号（在群聊中调用时可省略）',
            },
        },
        required: [],
    },
};
