/**
 * Blog Category 模块
 *
 * 博客分类管理（列表、创建、修改、删除、搜索）
 */

import { log } from '../../logger.js';
import { getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
import { requestBlogApi, type BlogApiResponse } from '../../utils/blogApi.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== 类型定义 ====================

interface CategoryVO {
    id: number;
    categoryName: string;
    articleCount: number;
    createTime: string;
    updateTime: string;
}

// ==================== 模块元数据 ====================

export const name = 'blog_category';
export const description = '博客分类管理';
export const keywords = ['分类', '分类列表', '创建分类', '删除分类', '添加分类', 'category'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    requiredAuth = true,
): Promise<BlogApiResponse<T>> {
    return await requestBlogApi<T>(config, {
        method,
        path,
        body,
        requiredAuth,
    });
}

/** 获取分类列表 */
async function listCategories(): Promise<ToolResult> {
    const res = await apiRequest<CategoryVO[]>('GET', '/category/list', undefined, false);
    if (res.code === 200 && res.data) {
        const categories = res.data;
        if (categories.length === 0) {
            return { success: true, text: '暂无分类' };
        }
        const lines = [`📂 分类列表（共${categories.length}个）`, ''];
        for (const c of categories) {
            lines.push(`#${c.id} ${c.categoryName}（${c.articleCount}篇文章）`);
        }
        return { success: true, text: lines.join('\n'), data: { categories } };
    }
    return { success: false, text: `获取分类列表失败: ${res.msg}` };
}

/** 根据ID查询分类 */
async function getCategoryById(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.categoryId) as number | undefined;
    if (!id) {
        return { success: false, text: '查询分类需要提供分类ID(id)' };
    }
    const res = await apiRequest<CategoryVO>('GET', `/category/back/get/${id}`);
    if (res.code === 200 && res.data) {
        const c = res.data;
        return {
            success: true,
            text: `📂 分类详情\nID: ${c.id}\n名称: ${c.categoryName}\n文章数: ${c.articleCount}\n创建时间: ${c.createTime?.slice(0, 10)}`,
            data: { category: c },
        };
    }
    return { success: false, text: `查询分类失败: ${res.msg}` };
}

/** 创建分类 */
async function createCategory(params: Record<string, unknown>): Promise<ToolResult> {
    const categoryName = (params.category_name ?? params.categoryName ?? params.name) as string | undefined;
    if (!categoryName) {
        return { success: false, text: '创建分类需要提供分类名称(category_name)' };
    }
    const res = await apiRequest<void>('PUT', '/category/back/add', { categoryName });
    if (res.code === 200) {
        return { success: true, text: `分类「${categoryName}」创建成功！` };
    }
    return { success: false, text: `创建分类失败: ${res.msg}` };
}

/** 修改分类 */
async function updateCategory(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.categoryId) as number | undefined;
    const categoryName = (params.category_name ?? params.categoryName ?? params.name) as string | undefined;
    if (!id || !categoryName) {
        return { success: false, text: '修改分类需要提供分类ID(id)和新名称(category_name)' };
    }
    const res = await apiRequest<void>('POST', '/category/back/update', { id, categoryName });
    if (res.code === 200) {
        return { success: true, text: `分类 #${id} 已更新为「${categoryName}」` };
    }
    return { success: false, text: `修改分类失败: ${res.msg}` };
}

/** 删除分类 */
async function deleteCategory(params: Record<string, unknown>): Promise<ToolResult> {
    const rawId = params.id ?? params.categoryId;
    if (rawId === undefined) {
        return { success: false, text: '删除分类需要提供分类ID(id)' };
    }
    const ids = Array.isArray(rawId) ? rawId : [rawId];
    const res = await apiRequest<void>('DELETE', '/category/back/delete', ids);
    if (res.code === 200) {
        return { success: true, text: `已成功删除 ${ids.length} 个分类` };
    }
    return { success: false, text: `删除分类失败: ${res.msg}` };
}

/** 搜索分类 */
async function searchCategories(params: Record<string, unknown>): Promise<ToolResult> {
    const searchDTO: Record<string, unknown> = {};
    const categoryName = params.category_name ?? params.categoryName ?? params.name;
    if (categoryName) {
        searchDTO.categoryName = categoryName;
    }
    const res = await apiRequest<CategoryVO[]>('POST', '/category/back/search', searchDTO);
    if (res.code === 200 && res.data) {
        const categories = res.data;
        if (categories.length === 0) {
            return { success: true, text: '没有找到匹配的分类' };
        }
        const lines = [`🔍 分类搜索结果（${categories.length}个）`, ''];
        for (const c of categories) {
            lines.push(`#${c.id} ${c.categoryName}（${c.articleCount}篇文章）`);
        }
        return { success: true, text: lines.join('\n'), data: { categories } };
    }
    return { success: false, text: `搜索分类失败: ${res.msg}` };
}

// ==================== 权限常量 ====================

/** 需要管理员权限的写操作 */
const WRITE_ACTIONS = new Set(['create', 'add', 'update', 'edit', 'modify', 'delete', 'remove']);

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    const action = (params.action ?? params.type ?? params.operation) as string | undefined;

    if (!action) {
        return { success: false, text: '请指定操作类型(action): list/create/update/delete/search/get' };
    }

    // 写操作需要管理员及以上权限
    if (WRITE_ACTIONS.has(action)) {
        const reqLevel = getUserLevel(ctx.senderId, ctx.senderRole);
        if (reqLevel < ROLE_LEVEL.admin) {
            return { success: false, text: `操作失败：请求者(${ctx.senderId})权限不足，需要管理员及以上权限才能执行${action}操作` };
        }
    }

    try {
        log.info(`🔧 模块: blog_category ${action}`);

        switch (action) {
            case 'list':
            case 'all':
                return await listCategories();

            case 'get':
            case 'detail':
                return await getCategoryById(params);

            case 'create':
            case 'add':
                return await createCategory(params);

            case 'update':
            case 'edit':
            case 'modify':
                return await updateCategory(params);

            case 'delete':
            case 'remove':
                return await deleteCategory(params);

            case 'search':
            case 'find':
                return await searchCategories(params);

            default:
                return { success: false, text: `未知操作: ${action}，支持的操作: list/create/update/delete/search/get` };
        }
    } catch (err) {
        log.error('blog_category 执行失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `操作失败: ${errMsg}` };
    }
}

// ==================== 默认导出 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
