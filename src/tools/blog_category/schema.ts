/**
 * Blog Category 模块 Schema
 *
 * 用于 LLM Function Calling
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'blog_category',
    description: '博客分类管理工具。可以查看分类列表、创建分类、修改分类、删除分类。发布文章前需要先获取或创建分类。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'create', 'update', 'delete', 'search', 'get'],
                description: '操作类型：list=分类列表, create=创建分类, update=修改分类, delete=删除分类, search=搜索分类, get=根据ID查询分类',
            },
            id: {
                type: 'integer',
                description: '分类ID（get/update/delete 时需要）',
            },
            category_name: {
                type: 'string',
                description: '分类名称（create/update/search 时使用）',
            },
        },
        required: ['action'],
    },
};
