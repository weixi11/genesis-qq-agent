/**
 * Mute Status 模块 Schema
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'mute_status',
    description: '查询群里所有被禁言的成员列表。当用户询问谁被禁言了、群里有多少人被禁言时调用。',
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
