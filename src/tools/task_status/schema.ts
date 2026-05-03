import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'task_status',
    description: '查询用户的任务执行状态，可以查询绘图、识图等任务的进度',
    parameters: {
        type: 'object',
        properties: {
            toolName: {
                type: 'string',
                description: '要查询的工具名称（可选，如 draw, weather, vision）',
            },
        },
        required: [],
    },
};
