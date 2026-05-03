/**
 * Avatar 模块 Schema
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'avatar',
    description: '获取QQ用户头像或群头像。当用户想知道头像是什么样的（描述头像内容），使用 action=describe；当用户要求发送/获取头像图片时，使用 action=send。',
    parameters: {
        type: 'object',
        properties: {
            targetId: {
                type: 'string',
                description: '目标用户的QQ号（不填则使用@的用户或发送者自身）',
            },
            type: {
                type: 'string',
                description: '头像类型：user=用户头像，group=群头像',
                enum: ['user', 'group'],
            },
            action: {
                type: 'string',
                description: '操作类型：send=直接发送头像图片（默认，如"把头像发给我"），describe=获取头像URL供识图描述（如"他头像是什么"、"他头像长什么样"）',
                enum: ['describe', 'send'],
            },
        },
        required: [],
    },
};
