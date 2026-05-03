/**
 * Blog Article 模块
 *
 * 博客文章管理（发布、列表、详情、搜索、删除、状态管理、图片上传）
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { log } from '../../logger.js';
import { getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
import { requestBlogApi, type BlogApiResponse } from '../../utils/blogApi.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

function getMimeType(fileName: string): string {
    const ext = extname(fileName).toLowerCase();
    const map: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp'
    };
    return map[ext] || 'application/octet-stream';
}

// ==================== 类型定义 ====================

interface ArticleListItem {
    id: number;
    articleTitle: string;
    categoryName: string;
    tagsName: string[];
    articleCover: string;
    isTop: number;
    status: number;
    visitCount: number;
    createTime: string;
}

interface ArticleDetail {
    id: number;
    articleTitle: string;
    articleContent: string;
    categoryName: string;
    categoryId: number;
    tags: { id: number; tagName: string }[];
    articleCover: string;
    articleType: number;
    isTop: number;
    visitCount: number;
    commentCount: number;
    likeCount: number;
    favoriteCount: number;
    createTime: string;
    updateTime: string;
}

interface ArticlePageResult {
    page: ArticleCardVO[];
    total: number;
}

interface ArticleCardVO {
    id: number;
    categoryName: string;
    tags: string[];
    articleCover: string;
    articleTitle: string;
    articleContent: string;
    articleType: number;
    visitCount: number;
    commentCount: number;
    likeCount: number;
    favoriteCount: number;
    createTime: string;
}

type ArticleEchoPayload = Record<string, unknown> & {
    articleCover?: string;
};

// ==================== 模块元数据 ====================

export const name = 'blog_article';
export const description = '博客文章管理';
export const keywords = ['发布文章', '写文章', '文章列表', '文章管理', '删除文章', '置顶文章', '博客', '上传封面', '上传图片'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>,
    requiredAuth = true,
): Promise<BlogApiResponse<T>> {
    return await requestBlogApi<T>(config, {
        method,
        path,
        body,
        queryParams,
        requiredAuth,
    });
}

/** 发布文章 */
async function publishArticle(params: Record<string, unknown>): Promise<ToolResult> {
    const title = (params.title ?? params.articleTitle) as string | undefined;
    const content = (params.content ?? params.articleContent) as string | undefined;
    const categoryId = (params.category_id ?? params.categoryId) as number | undefined;
    const tagIds = (params.tag_ids ?? params.tagIds ?? params.tags) as number[] | undefined;

    if (!title || !content) {
        return { success: false, text: '发布文章需要标题(title)和内容(content)' };
    }
    if (!categoryId) {
        return { success: false, text: '发布文章需要指定分类ID(category_id)，可以先用 blog_category 工具查看分类列表' };
    }
    if (!tagIds || tagIds.length === 0) {
        return { success: false, text: '发布文章需要至少一个标签ID(tag_ids)，可以先用 blog_tag 工具查看标签列表' };
    }

    const articleDTO = {
        id: params.id as number | undefined,
        articleTitle: title,
        articleContent: content,
        categoryId,
        tagId: tagIds,
        articleCover: (params.cover ?? params.articleCover ?? '') as string,
        articleType: (params.article_type ?? params.articleType ?? 1) as number,
        status: (params.status ?? 1) as number,
        isTop: (params.is_top ?? params.isTop ?? 0) as number,
    };

    const res = await apiRequest<void>('POST', '/article/publish', articleDTO);
    if (res.code === 200) {
        return { success: true, text: `文章「${title}」发布成功！` };
    }
    return { success: false, text: `发布文章失败: ${res.msg}` };
}

/** 获取文章列表 */
async function listArticles(params: Record<string, unknown>): Promise<ToolResult> {
    const page = (params.page ?? params.pageNum ?? 1) as number;
    const pageSize = (params.page_size ?? params.pageSize ?? 10) as number;

    const res = await apiRequest<ArticlePageResult>('GET', '/article/list', undefined, {
        pageNum: String(page),
        pageSize: String(pageSize),
    }, false);

    if (res.code === 200 && res.data) {
        const articles = res.data.page || [];
        const total = res.data.total || 0;
        if (articles.length === 0) {
            return { success: true, text: '暂无文章' };
        }

        const lines = [`📝 文章列表（共${total}篇，第${page}页）`, ''];
        for (const a of articles) {
            const tags = a.tags?.length > 0 ? ` [${a.tags.join(', ')}]` : '';
            lines.push(`#${a.id} ${a.articleTitle}`);
            lines.push(`  分类: ${a.categoryName}${tags} | 浏览: ${a.visitCount} | 评论: ${a.commentCount}`);
            lines.push(`  发布: ${a.createTime?.slice(0, 10) ?? '未知'}`);
            lines.push('');
        }
        return { success: true, text: lines.join('\n'), data: { articles, total, page } };
    }
    return { success: false, text: `获取文章列表失败: ${res.msg}` };
}

/** 获取文章详情 */
async function getArticleDetail(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.articleId) as number | undefined;
    if (!id) {
        return { success: false, text: '查看文章详情需要提供文章ID(id)' };
    }

    const res = await apiRequest<ArticleDetail>('GET', `/article/detail/${id}`, undefined, undefined, false);
    if (res.code === 200 && res.data) {
        const a = res.data;
        const tags = a.tags?.map(t => t.tagName).join(', ') || '无';
        const typeMap: Record<number, string> = { 1: '原创', 2: '转载', 3: '翻译' };
        const statusText = a.isTop ? '📌 置顶' : '';

        const lines = [
            `📄 ${a.articleTitle} ${statusText}`,
            ...(a.articleCover ? [`![文章封面](${a.articleCover})`] : []),
            '',
            `分类: ${a.categoryName} | 标签: ${tags}`,
            `类型: ${typeMap[a.articleType] || '未知'} | 浏览: ${a.visitCount}`,
            `评论: ${a.commentCount} | 点赞: ${a.likeCount} | 收藏: ${a.favoriteCount}`,
            `发布: ${a.createTime?.slice(0, 10)} | 更新: ${a.updateTime?.slice(0, 10)}`,
            '',
            '--- 文章内容 ---',
            a.articleContent || '(无内容)',
        ];
        return { success: true, text: lines.join('\n'), data: { article: a } };
    }
    return { success: false, text: `获取文章详情失败: ${res.msg}` };
}

/** 搜索文章 */
async function searchArticles(params: Record<string, unknown>): Promise<ToolResult> {
    const searchDTO: Record<string, unknown> = {};
    if (params.title ?? params.articleTitle) {
        searchDTO.articleTitle = params.title ?? params.articleTitle;
    }
    if (params.category_id ?? params.categoryId) {
        searchDTO.categoryId = params.category_id ?? params.categoryId;
    }
    if (params.status !== undefined) {
        searchDTO.status = params.status;
    }
    if (params.is_top ?? params.isTop) {
        searchDTO.isTop = params.is_top ?? params.isTop;
    }

    const res = await apiRequest<ArticleListItem[]>('POST', '/article/back/search', searchDTO);
    if (res.code === 200 && res.data) {
        const articles = res.data;
        if (articles.length === 0) {
            return { success: true, text: '没有找到匹配的文章' };
        }

        const statusMap: Record<number, string> = { 1: '已发布', 2: '私密', 3: '草稿' };
        const lines = [`🔍 搜索结果（${articles.length}篇）`, ''];
        for (const a of articles) {
            const topIcon = a.isTop ? '📌' : '';
            const tags = a.tagsName?.length > 0 ? ` [${a.tagsName.join(', ')}]` : '';
            lines.push(`#${a.id} ${topIcon}${a.articleTitle}`);
            lines.push(`  分类: ${a.categoryName}${tags} | 状态: ${statusMap[a.status] || '未知'} | 浏览: ${a.visitCount}`);
            lines.push('');
        }
        return { success: true, text: lines.join('\n'), data: { articles } };
    }
    return { success: false, text: `搜索文章失败: ${res.msg}` };
}

/** 删除文章 */
async function deleteArticle(params: Record<string, unknown>): Promise<ToolResult> {
    const rawId = params.id ?? params.articleId;
    if (rawId === undefined) {
        return { success: false, text: '删除文章需要提供文章ID(id)' };
    }
    const ids = Array.isArray(rawId) ? rawId : [rawId];

    const res = await apiRequest<void>('DELETE', '/article/back/delete', ids, { id: String(ids[0]) });
    if (res.code === 200) {
        return { success: true, text: `已成功删除 ${ids.length} 篇文章` };
    }
    return { success: false, text: `删除文章失败: ${res.msg}` };
}

/** 修改文章状态 */
async function updateArticleStatus(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.articleId) as number | undefined;
    const status = params.status as number | undefined;
    if (!id || status === undefined) {
        return { success: false, text: '修改状态需要提供文章ID(id)和状态(status: 1=已发布, 2=私密, 3=草稿)' };
    }

    const res = await apiRequest<void>('POST', '/article/back/update/status', undefined, {
        id: String(id),
        status: String(status),
    });
    const statusMap: Record<number, string> = { 1: '已发布', 2: '私密', 3: '草稿' };
    if (res.code === 200) {
        return { success: true, text: `文章 #${id} 状态已更新为「${statusMap[status] || status}」` };
    }
    return { success: false, text: `修改文章状态失败: ${res.msg}` };
}

/** 置顶/取消置顶 */
async function toggleArticleTop(params: Record<string, unknown>): Promise<ToolResult> {
    const id = (params.id ?? params.articleId) as number | undefined;
    const isTop = (params.is_top ?? params.isTop) as number | undefined;
    if (!id || isTop === undefined) {
        return { success: false, text: '置顶操作需要提供文章ID(id)和是否置顶(is_top: 0=取消, 1=置顶)' };
    }

    const res = await apiRequest<void>('POST', '/article/back/update/isTop', undefined, {
        id: String(id),
        isTop: String(isTop),
    });
    if (res.code === 200) {
        return { success: true, text: `文章 #${id} 已${isTop ? '置顶' : '取消置顶'}` };
    }
    return { success: false, text: `置顶操作失败: ${res.msg}` };
}

// ==================== 图片上传相关 ====================

/** 从本地路径或URL获取文件数据，构建 FormData */
async function buildFileFormData(
    fieldName: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
): Promise<{ formData: FormData; fileName: string } | ToolResult> {
    const filePath = (params.file_path ?? params.filePath ?? params.path) as string | undefined;
    const imageUrl = (params.image_url ?? params.imageUrl ?? params.url) as string | undefined;

    // 优先使用参数中的路径，其次使用上下文中的文件/图片
    const localPath = filePath ?? ctx.filePaths?.[0];
    const remoteUrl = imageUrl ?? ctx.imageUrls?.[0];

    if (localPath) {
        try {
            const fileBuffer = await readFile(localPath);
            const fileName = basename(localPath);
            const blob = new Blob([fileBuffer], { type: getMimeType(fileName) });
            const formData = new FormData();
            formData.append(fieldName, blob, fileName);
            return { formData, fileName };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : '未知错误';
            return { success: false, text: `读取本地文件失败: ${errMsg}` };
        }
    }

    if (remoteUrl) {
        try {
            const response = await fetch(remoteUrl);
            if (!response.ok) {
                return { success: false, text: `下载图片失败: HTTP ${response.status}` };
            }
            const arrayBuffer = await response.arrayBuffer();
            // 从URL中提取文件名
            const urlPath = new URL(remoteUrl).pathname;
            const fileName = basename(urlPath) || 'image.jpg';
            const contentType = response.headers.get('content-type') || getMimeType(fileName);
            const blob = new Blob([arrayBuffer], { type: contentType });
            const formData = new FormData();
            formData.append(fieldName, blob, fileName);
            return { formData, fileName };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : '未知错误';
            return { success: false, text: `下载远程图片失败: ${errMsg}` };
        }
    }

    return { success: false, text: `上传需要提供本地文件路径(file_path)或图片URL(image_url)，也可以直接在消息中发送图片/文件` };
}

/** multipart 上传请求 */
async function uploadRequest(
    path: string,
    formData: FormData,
    queryParams?: Record<string, string>,
): Promise<BlogApiResponse<string>> {
    return await requestBlogApi<string>(config, {
        method: 'POST',
        path,
        body: formData,
        queryParams,
        requiredAuth: true,
    });
}

/** 上传文章封面 */
async function uploadCover(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const articleId = (params.id ?? params.articleId ?? params.article_id) as number | undefined;

    const result = await buildFileFormData('articleCover', params, ctx);
    if ('success' in result) return result; // 返回的是错误 ToolResult

    const { formData, fileName } = result;
    const res = await uploadRequest('/article/upload/articleCover', formData);

    if (res.code === 200 && res.data) {
        const coverUrl = res.data;

        if (articleId) {
            log.info(`[blog_article] 正在获取文章 ${articleId} 的原始数据...`);
            const echoRes = await apiRequest<ArticleEchoPayload>('GET', `/article/back/echo/${articleId}`);

            if (echoRes.code === 200 && echoRes.data) {
                const articleData = echoRes.data;
                articleData.articleCover = coverUrl;

                log.info(`[blog_article] 正在更新文章 ${articleId} 的封面...`);
                // 发起发布请求
                const publishRes = await apiRequest<void>('POST', '/article/publish', articleData);

                if (publishRes.code === 200) {
                    return {
                        success: true,
                        text: `封面图「${fileName}」上传成功，并且文章 #${articleId} 的封面已更新！\n图片地址: ${coverUrl}`,
                        data: { url: coverUrl, articleId },
                    };
                } else {
                    return {
                        success: false,
                        text: `上传封面图成功，但更新文章封面失败: ${publishRes.msg}\n图片地址: ${coverUrl}`,
                        data: { url: coverUrl, articleId },
                    };
                }
            } else {
                return {
                    success: false,
                    text: `上传封面图成功，但获取文章原数据失败无法更新: ${echoRes.msg}\n图片地址: ${coverUrl}`,
                    data: { url: coverUrl, articleId },
                };
            }
        }

        return {
            success: true,
            text: `封面图「${fileName}」上传成功！\n图片地址: ${coverUrl}`,
            data: { url: coverUrl },
        };
    }
    return { success: false, text: `上传封面失败: ${res.msg}` };
}

/** 上传文章内图片 */
async function uploadImage(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const articleId = (params.id ?? params.articleId ?? params.article_id) as number | undefined;
    if (!articleId) {
        return { success: false, text: '上传文章图片需要提供文章ID(id)' };
    }

    const result = await buildFileFormData('articleImage', params, ctx);
    if ('success' in result) return result;

    const { formData, fileName } = result;
    const res = await uploadRequest('/article/upload/articleImage', formData, {
        articleId: String(articleId),
    });

    if (res.code === 200 && res.data) {
        return {
            success: true,
            text: `文章图片「${fileName}」上传成功！\n图片地址: ${res.data}\nMarkdown引用: ![${fileName}](${res.data})`,
            data: { url: res.data },
        };
    }
    return { success: false, text: `上传文章图片失败: ${res.msg}` };
}

/** 删除文章封面 */
async function deleteCover(params: Record<string, unknown>): Promise<ToolResult> {
    const coverUrl = (params.cover_url ?? params.coverUrl ?? params.articleCoverUrl ?? params.url) as string | undefined;
    if (!coverUrl) {
        return { success: false, text: '删除封面需要提供封面图URL(cover_url)' };
    }

    const res = await apiRequest<void>('GET', '/article/delete/articleCover', undefined, {
        articleCoverUrl: coverUrl,
    });

    if (res.code === 200) {
        return { success: true, text: '封面图已删除' };
    }
    return { success: false, text: `删除封面失败: ${res.msg}` };
}

// ==================== 权限常量 ====================

/** 需要管理员权限的写操作 */
const WRITE_ACTIONS = new Set([
    'publish', 'create', 'write',
    'delete', 'remove',
    'update_status', 'status',
    'toggle_top', 'pin', 'top',
    'upload_cover', 'upload_image', 'delete_cover',
]);

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    const action = (params.action ?? params.type ?? params.operation) as string | undefined;

    if (!action) {
        return { success: false, text: '请指定操作类型(action): publish/list/detail/search/delete/update_status/toggle_top/upload_cover/upload_image/delete_cover' };
    }

    // 写操作需要管理员及以上权限
    if (WRITE_ACTIONS.has(action)) {
        const reqLevel = getUserLevel(ctx.senderId, ctx.senderRole);
        if (reqLevel < ROLE_LEVEL.admin) {
            return { success: false, text: `操作失败：请求者(${ctx.senderId})权限不足，需要管理员及以上权限才能执行${action}操作` };
        }
    }

    try {
        log.info(`🔧 模块: blog_article ${action}`);

        switch (action) {
            case 'publish':
            case 'create':
            case 'write':
                return await publishArticle(params);

            case 'list':
            case 'all':
                return await listArticles(params);

            case 'detail':
            case 'get':
            case 'view':
                return await getArticleDetail(params);

            case 'search':
            case 'find':
                return await searchArticles(params);

            case 'delete':
            case 'remove':
                return await deleteArticle(params);

            case 'update_status':
            case 'status':
                return await updateArticleStatus(params);

            case 'toggle_top':
            case 'pin':
            case 'top':
                return await toggleArticleTop(params);

            case 'upload_cover':
                return await uploadCover(params, ctx);

            case 'upload_image':
                return await uploadImage(params, ctx);

            case 'delete_cover':
                return await deleteCover(params);

            default:
                return { success: false, text: `未知操作: ${action}，支持的操作: publish/list/detail/search/delete/update_status/toggle_top/upload_cover/upload_image/delete_cover` };
        }
    } catch (err) {
        log.error('blog_article 执行失败:', err);
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
