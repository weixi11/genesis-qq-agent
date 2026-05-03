/**
 * Mute 模块 Schema
 *
 * 用于 LLM Function Calling
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'mute',
    description: '禁言群成员。当用户要求禁言、解除禁言、禁止发言时调用。主人/群主/管理员可以禁言他人，普通群员只能禁言自己或给自己解禁。',
    parameters: {
        type: 'object',
        properties: {
            targetId: {
                type: 'integer',
                description: '要禁言的用户 QQ 号',
            },
            groupId: {
                type: 'integer',
                description: '群号（在群聊中调用时可省略，自动使用当前群）',
            },
            duration: {
                type: 'integer',
                description: '禁言时长（分钟），0 表示解除禁言，不填默认 10 分钟',
            },
        },
        required: ['targetId'],
    },
};
