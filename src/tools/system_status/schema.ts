import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'system_status',
    description: '查询系统运行状态，包括系统资源、机器人连接状态、任务统计和工具状态',
    parameters: {
        type: 'object',
        properties: {
            section: {
                type: 'string',
                description: '要查询的具体部分（可选，不传则返回全部）',
                enum: ['system', 'disk', 'network', 'bot', 'tasks', 'tools'],
            },
        },
        required: [],
    },
};
