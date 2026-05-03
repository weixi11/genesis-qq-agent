/**
 * Weather 模块 Schema
 * 
 * 用于 LLM Function Calling
 */

import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'weather',
    description: '查询天气预报。当用户询问某个城市的天气时调用。',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: '城市名称，如"北京"、"上海"',
            },
            date: {
                type: 'string',
                enum: ['today', 'tomorrow', '3days'],
                description: '查询日期',
            },
        },
        required: ['location'],
    },
};
