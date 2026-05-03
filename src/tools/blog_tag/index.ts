/**
 * Blog Tag 模块
 *
 * 博客标签管理（列表、创建、修改、删除、搜索）
 */

import { log } from '../../logger.js';
import { getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
import { requestBlogApi, type BlogApiResponse } from '../../utils/blogApi.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== 类型定义 ====================

interface TagVO {
    id: number;
    tagName: string;
    articleCount: number;
    createTime: string;
    updateTime: string;
}

// ==================== 模块元数据 ====================

export const name = 'blog_tag';
export const description = '博客标签管理';
export const keywords = ['标签', '标签列表', '创建标签', '删除标签', '添加标签', 'tag'];

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

/** 获取标签列表 */
async function listTags(): Promise<ToolResult> {
    const res = await apiRequest<TagVO[]>('GET', '/tag/list', undefined, false);
    if (res.code === 200 && res.data) {
        const tags = res.data;
        if (tags.length === 0) {
            return { success: true, text: '暂无标签' };
        }
        const lines = [`🏷️ 标签列表（共${tags.length}个）`, ''];
        for (const t of tags) {
            lines.push(`#${t.id} ${t.tagName}（${t.articleCount}篇文章）`);
        }
        return { success: true, text: lines.join('\n'), data: { tags } };
    }
    return { success: false, text: `获取标签列表失败: ${res.msg}` };
}

/** 根据ID查询标签 */
async function getTagById(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.tagId) as number | undefined;
    if (!id) {
        return { success: false, text: '查询标签需要提供标签ID(id)' };
    }
    const res = await apiRequest<TagVO>('GET', `/tag/back/get/${id}`);
    if (res.code === 200 && res.data) {
        const t = res.data;
        return {
            success: true,
            text: `🏷️ 标签详情\nID: ${t.id}\n名称: ${t.tagName}\n文章数: ${t.articleCount}\n创建时间: ${t.createTime?.slice(0, 10)}`,
            data: { tag: t },
        };
    }
    return { success: false, text: `查询标签失败: ${res.msg}` };
}

/** 创建标签 */
async function createTag(params: Record<string, unknown>): Promise<ToolResult> {
    const tagName = (params.tag_name ?? params.tagName ?? params.name) as string | undefined;
    if (!tagName) {
        return { success: false, text: '创建标签需要提供标签名称(tag_name)' };
    }
    const res = await apiRequest<void>('PUT', '/tag/back/add', { tagName });
    if (res.code === 200) {
        return { success: true, text: `标签「${tagName}」创建成功！` };
    }
    return { success: false, text: `创建标签失败: ${res.msg}` };
}

/** 修改标签 */
async function updateTag(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.tagId) as number | undefined;
    const tagName = (params.tag_name ?? params.tagName ?? params.name) as string | undefined;
    if (!id || !tagName) {
        return { success: false, text: '修改标签需要提供标签ID(id)和新名称(tag_name)' };
    }
    const res = await apiRequest<void>('POST', '/tag/back/update', { id, tagName });
    if (res.code === 200) {
        return { success: true, text: `标签 #${id} 已更新为「${tagName}」` };
    }
    return { success: false, text: `修改标签失败: ${res.msg}` };
}

/** 删除标签 */
async function deleteTag(params: Record<string, unknown>): Promise<ToolResult> {
    const rawId = params.id ?? params.tagId;
    if (rawId === undefined) {
        return { success: false, text: '删除标签需要提供标签ID(id)' };
    }
    const ids = Array.isArray(rawId) ? rawId : [rawId];
    const res = await apiRequest<void>('DELETE', '/tag/back/delete', ids);
    if (res.code === 200) {
        return { success: true, text: `已成功删除 ${ids.length} 个标签` };
    }
    return { success: false, text: `删除标签失败: ${res.msg}` };
}

/** 搜索标签 */
async function searchTags(params: Record<string, unknown>): Promise<ToolResult> {
    const searchDTO: Record<string, unknown> = {};
    const tagName = params.tag_name ?? params.tagName ?? params.name;
    if (tagName) {
        searchDTO.tagName = tagName;
    }
    const res = await apiRequest<TagVO[]>('POST', '/tag/back/search', searchDTO);
    if (res.code === 200 && res.data) {
        const tags = res.data;
        if (tags.length === 0) {
            return { success: true, text: '没有找到匹配的标签' };
        }
        const lines = [`🔍 标签搜索结果（${tags.length}个）`, ''];
        for (const t of tags) {
            lines.push(`#${t.id} ${t.tagName}（${t.articleCount}篇文章）`);
        }
        return { success: true, text: lines.join('\n'), data: { tags } };
    }
    return { success: false, text: `搜索标签失败: ${res.msg}` };
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
        log.info(`🔧 模块: blog_tag ${action}`);

        switch (action) {
            case 'list':
            case 'all':
                return await listTags();

            case 'get':
            case 'detail':
                return await getTagById(params);

            case 'create':
            case 'add':
                return await createTag(params);

            case 'update':
            case 'edit':
            case 'modify':
                return await updateTag(params);

            case 'delete':
            case 'remove':
                return await deleteTag(params);

            case 'search':
            case 'find':
                return await searchTags(params);

            default:
                return { success: false, text: `未知操作: ${action}，支持的操作: list/create/update/delete/search/get` };
        }
    } catch (err) {
        log.error('blog_tag 执行失败:', err);
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
