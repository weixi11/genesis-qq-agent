import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'manage_skill',
    description: '管理Bot的已有技能工具：查看代码、查看最近日志、修改功能、修复bug、做日常维护。当主人说"看看xxx工具的代码"、"看看xxx工具最近日志"、"修复xxx工具"、"维护xxx工具"、"列出所有工具"时调用。仅主人可用。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'inspect', 'modify', 'fix', 'maintain'],
                description: '操作类型：list=列出所有工具, inspect=查看代码+最近日志, modify=修改功能, fix=修复bug, maintain=结合最近日志做维护',
            },
            toolName: {
                type: 'string',
                description: '要操作的工具名称（list 时不需要）',
            },
            description: {
                type: 'string',
                description: '修改描述、bug 描述或维护目标（modify/fix 时建议必填；maintain 可留空让系统参考最近日志主动维护）',
            },
        },
        required: ['action'],
    },
};
