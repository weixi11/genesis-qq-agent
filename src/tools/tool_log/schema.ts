import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'tool_log',
    description: '查看最近工具执行日志、失败记录和按工具聚合摘要。适合排查某个工具为什么报错、最近谁调用过、成功率如何。仅主人可用。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['recent', 'failures', 'summary'],
                description: '查询类型：recent=最近日志, failures=最近失败日志, summary=按工具聚合摘要',
            },
            toolName: {
                type: 'string',
                description: '可选，按工具名称过滤，如 music / draw / weather',
            },
            limit: {
                type: 'integer',
                description: '最多返回多少条日志，默认 5，最大 20',
            },
            userId: {
                type: 'integer',
                description: '可选，按调用用户 ID 过滤',
            },
            taskId: {
                type: 'string',
                description: '可选，按任务 ID 过滤',
            },
            includeParams: {
                type: 'boolean',
                description: '是否在文本中附带参数摘要，默认 true',
            },
            includeResult: {
                type: 'boolean',
                description: '是否在文本中附带结果摘要，默认 true',
            },
        },
        required: ['action'],
    },
};
