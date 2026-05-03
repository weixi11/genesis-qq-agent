import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'task_detail',
    description: '查询任务的详细信息，包括参数、执行结果、错误信息、耗时等完整详情。当用户问"任务详情"、"任务结果是什么"、"看看任务参数"时调用。',
    parameters: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: '任务ID（可选，支持短ID如前8位）',
            },
            toolName: {
                type: 'string',
                description: '要查询的工具名称（可选，如 draw, weather, vision, blog_article）',
            },
        },
        required: [],
    },
};
