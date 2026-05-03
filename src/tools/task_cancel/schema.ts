import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'task_cancel',
    description: '取消用户正在等待的任务',
    parameters: {
        type: 'object',
        properties: {
            toolName: {
                type: 'string',
                description: '要取消的工具名称（可选，如 draw, weather）。不指定则取消最近的等待任务',
            },
        },
        required: [],
    },
};
