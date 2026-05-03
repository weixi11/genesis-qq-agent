/**
 * 管理员指令处理
 * 
 * 支持的指令：
 * - #管理菜单 - 查看管理员命令菜单
 * - #查看记忆 - 列出所有会话
 * - #查看本记忆 - 查看当前群/私聊的记忆
 * - #查看记忆+群号/QQ号 - 查看指定会话的记忆
 * - #清除所有记忆 - 清除所有会话记忆
 * - #清除本记忆 - 清除当前群/私聊的记忆
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { memory } from './memory.js';
import { memeCatalog } from './services/meme_catalog.js';
import { selectManualMeme } from './services/meme_decider.js';
import type { FormattedMessage } from './types.js';
import { resolveTestFile } from './utils/file.js';
import { isRecord, safeParseJson } from './utils/json.js';

/** 指令处理结果 */
export interface CommandResult {
    handled: boolean;
    response?: string;
    /** 异步处理器（用于知识库等需要异步操作的命令） */
    asyncHandler?: () => Promise<string>;
}

interface MemePackManifestItem {
    id?: string;
    label?: string;
    description?: string;
    aliases?: string[];
    scenes?: string[];
    files?: string[];
}

interface MemeManifestData {
    sourceDir?: string;
    packs?: MemePackManifestItem[];
}

function getEmptyMemeManifestSummary(manifestPath: string) {
    return {
        manifestPath,
        sourceDir: '',
        packs: [] as MemePackManifestItem[],
        actualFiles: [] as Array<{ absolute: string; relative: string }>,
        orphanFiles: [] as Array<{ absolute: string; relative: string }>,
    };
}

const SUPPORTED_MEME_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function resolveMemeManifestPath(): string {
    const manifestPath = config.autoMeme.manifestPath;
    return path.isAbsolute(manifestPath) ? manifestPath : path.join(process.cwd(), manifestPath);
}

function resolveMemeSourceDir(manifestPath: string, manifest: MemeManifestData): string {
    if (manifest.sourceDir) {
        return path.isAbsolute(manifest.sourceDir)
            ? manifest.sourceDir
            : path.join(path.dirname(manifestPath), manifest.sourceDir);
    }

    return path.isAbsolute(config.autoMeme.sourceDir)
        ? config.autoMeme.sourceDir
        : path.join(process.cwd(), config.autoMeme.sourceDir);
}

function normalizeRelativeFile(file: string): string {
    return file.replace(/\\/g, '/').replace(/^\/+/, '');
}

function scanSupportedMemeFiles(dir: string): Array<{ absolute: string; relative: string }> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return [];
    }

    const results: Array<{ absolute: string; relative: string }> = [];
    const stack = [''];

    while (stack.length > 0) {
        const currentRelative = stack.pop() || '';
        const currentDir = path.join(dir, currentRelative);
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const nextRelative = currentRelative
                ? path.posix.join(currentRelative.replace(/\\/g, '/'), entry.name)
                : entry.name;
            const absolute = path.join(dir, nextRelative);
            if (entry.isDirectory()) {
                stack.push(nextRelative);
                continue;
            }
            if (SUPPORTED_MEME_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                results.push({ absolute, relative: normalizeRelativeFile(nextRelative) });
            }
        }
    }

    return results.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN'));
}

function getMemeManifestSummary() {
    const manifestPath = resolveMemeManifestPath();
    if (!fs.existsSync(manifestPath)) {
        return getEmptyMemeManifestSummary(manifestPath);
    }

    let manifest: MemeManifestData;
    try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = safeParseJson(raw);
        if (!isRecord(parsed)) {
            throw new Error('manifest 不是 JSON 对象');
        }
        manifest = parsed as MemeManifestData;
    } catch (err) {
        log.warn('🎭 解析表情包 manifest 失败，按空配置处理:', err);
        return getEmptyMemeManifestSummary(manifestPath);
    }

    const sourceDir = resolveMemeSourceDir(manifestPath, manifest);
    const packs = Array.isArray(manifest.packs) ? manifest.packs : [];
    const referencedFiles = new Set(
        packs.flatMap(pack => Array.isArray(pack.files) ? pack.files : []).map(normalizeRelativeFile)
    );
    const actualFiles = scanSupportedMemeFiles(sourceDir);
    const orphanFiles = actualFiles.filter(file => !referencedFiles.has(file.relative));

    return { manifestPath, sourceDir, packs, actualFiles, orphanFiles };
}

function formatAdminMenu(): string {
    return `📋 管理员菜单
记忆管理：
• #查看记忆
• #查看本记忆
• #查看记忆 <群号/QQ号>
• #清除所有记忆
• #清除本记忆

表情包管理：
• #表情 菜单
• #表情 列表
• #表情 统计
• #表情 重载
• #表情 孤儿
• #表情 清理孤儿
• #表情 发送 <关键词>

其他管理：
• #知识 搜索 <关键词>
• #知识 统计
• #画像 查询 <QQ号>
• #画像 列表
• #画像 统计
• #模块 列表
• #模块 统计
• #模块 重载
• #测试消息`;
}

function formatMemeMenu(): string {
    return `🎭 表情包管理菜单
• #表情 列表 - 查看当前表情分组
• #表情 统计 - 查看分组数、图片数、孤儿数
• #表情 重载 - 重新加载 manifest 缓存
• #表情 孤儿 - 查看未被引用的图片
• #表情 清理孤儿 - 删除未被引用的图片
• #表情 发送 <关键词> - 手动发送匹配表情

提示：
• 关键词可用分组名、别名、场景词
• 不带关键词时会随机发送一张`;
}

/**
 * 检查是否是管理员
 */
export function isAdmin(userId: number): boolean {
    return config.adminQQ.includes(userId) || config.masterQQ === userId;
}

/**
 * 处理管理员指令
 */
export function handleAdminCommand(msg: FormattedMessage): CommandResult {
    const text = msg.text?.trim() || '';

    // 检查是否是指令格式
    if (!text.startsWith('#')) {
        return { handled: false };
    }

    // 检查是否是管理员
    if (!isAdmin(msg.sender_id)) {
        log.debug(`非管理员 ${msg.sender_id} 尝试使用指令: ${text}`);
        return { handled: false };
    }

    log.info(`📋 管理员指令: ${text}`);

    // 解析指令
    const command = text.toLowerCase();

    // #管理菜单 / #管理员菜单
    if (
        command === '#管理菜单'
        || command === '#管理员菜单'
        || command === '#管理 菜单'
        || command === '#管理 帮助'
    ) {
        return { handled: true, response: formatAdminMenu() };
    }

    // === 表情包管理命令 ===

    // #表情 菜单 / #表情 帮助
    if (
        command === '#表情 菜单'
        || command === '#表情菜单'
        || command === '#表情 帮助'
        || command === '#表情帮助'
    ) {
        return { handled: true, response: formatMemeMenu() };
    }

    // #表情 列表
    if (command === '#表情 列表' || command === '#表情列表') {
        return {
            handled: true,
            response: '🎭 查询中...',
            asyncHandler: async () => {
                const packs = memeCatalog.listPacks();
                if (packs.length === 0) {
                    return '📭 当前没有可用表情包';
                }

                const lines = ['🎭 当前表情包列表:'];
                for (const pack of packs) {
                    const description = pack.description?.trim() || '暂无描述';
                    lines.push(`• ${pack.label} [${pack.id}]`);
                    lines.push(`  图片: ${pack.resolvedFiles.length} 张 | 场景: ${pack.scenes.join(', ') || '(无)'}`);
                    lines.push(`  描述: ${description}`);
                }
                lines.push(`\n总计: ${packs.length} 组`);
                return lines.join('\n');
            }
        };
    }

    // #表情 统计
    if (command === '#表情 统计' || command === '#表情统计') {
        return {
            handled: true,
            response: '📊 统计中...',
            asyncHandler: async () => {
                const summary = getMemeManifestSummary();
                const totalReferenced = summary.packs
                    .reduce((sum, pack) => sum + (Array.isArray(pack.files) ? pack.files.length : 0), 0);
                const orphanCount = summary.orphanFiles.length;
                return `🎭 表情包统计:
  分组: ${summary.packs.length} 组
  manifest 引用图片: ${totalReferenced} 张
  素材目录图片: ${summary.actualFiles.length} 张
  孤儿图片: ${orphanCount} 张
  素材目录: ${summary.sourceDir || '(未配置)'}`;
            }
        };
    }

    // #表情 重载
    if (command === '#表情 重载' || command === '#表情重载') {
        memeCatalog.invalidate();
        return { handled: true, response: '✅ 表情包缓存已重载' };
    }

    // #表情 孤儿
    if (command === '#表情 孤儿' || command === '#表情孤儿') {
        return {
            handled: true,
            response: '🧹 扫描中...',
            asyncHandler: async () => {
                const summary = getMemeManifestSummary();
                if (summary.orphanFiles.length === 0) {
                    return '✅ 没有发现孤儿表情图片';
                }

                const preview = summary.orphanFiles
                    .slice(0, 20)
                    .map(file => `• ${file.relative}`);
                const remain = summary.orphanFiles.length - preview.length;
                if (remain > 0) {
                    preview.push(`• 其余 ${remain} 张未展开`);
                }
                return `🧹 发现 ${summary.orphanFiles.length} 张孤儿图片:\n${preview.join('\n')}`;
            }
        };
    }

    // #表情 清理孤儿
    if (command === '#表情 清理孤儿' || command === '#表情清理孤儿') {
        return {
            handled: true,
            response: '🧹 清理中...',
            asyncHandler: async () => {
                const summary = getMemeManifestSummary();
                if (summary.orphanFiles.length === 0) {
                    return '✅ 没有可清理的孤儿图片';
                }

                let removed = 0;
                for (const file of summary.orphanFiles) {
                    if (fs.existsSync(file.absolute)) {
                        fs.unlinkSync(file.absolute);
                        removed++;
                    }
                }
                memeCatalog.invalidate();
                return `✅ 已清理孤儿图片 ${removed} 张`;
            }
        };
    }

    // #表情 发送 <关键词>
    const sendMemeMatch = text.match(/^#表情\s*发送(?:\s+(.+))?$/s);
    if (sendMemeMatch) {
        const query = sendMemeMatch[1]?.trim();
        return {
            handled: true,
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const result = selectManualMeme({ query, count: 1 });
                if (!result.pack || result.segments.length === 0) {
                    return query
                        ? `📭 没找到和“${query}”匹配的表情包`
                        : '📭 当前没有可发送的表情包';
                }

                await connector.send(msg, result.segments);
                return `✅ 已发送表情: ${result.pack.label} [${result.pack.id}]`;
            }
        };
    }

    // #查看记忆 - 列出所有会话
    if (command === '#查看记忆') {
        const sessions = memory.getAllSessions();
        if (sessions.length === 0) {
            return { handled: true, response: '📭 当前没有任何记忆' };
        }

        const lines = ['📋 记忆会话列表:'];
        let groupCount = 0;
        let privateCount = 0;

        for (const session of sessions) {
            const [type, id] = session.key.split(':');
            if (type === 'group') {
                groupCount++;
                lines.push(`  群 ${id}: ${session.count} 条消息`);
            } else {
                privateCount++;
                lines.push(`  私聊 ${id}: ${session.count} 条消息`);
            }
        }

        lines.push(`\n总计: ${groupCount} 个群, ${privateCount} 个私聊`);
        return { handled: true, response: lines.join('\n') };
    }

    // #查看本记忆 - 查看当前会话
    if (command === '#查看本记忆') {
        const key = msg.type === 'group' && msg.group_id
            ? `group:${msg.group_id}`
            : `private:${msg.sender_id}`;

        const messages = memory.getSessionByKey(key);
        if (!messages || messages.length === 0) {
            return { handled: true, response: '📭 当前会话没有记忆' };
        }

        const header = msg.type === 'group'
            ? `📋 群 ${msg.group_id} 的记忆 (${messages.length} 条):`
            : `📋 私聊 ${msg.sender_id} 的记忆 (${messages.length} 条):`;

        return {
            handled: true,
            response: `${header}\n${memory.formatMessages(messages)}`
        };
    }

    // #查看记忆+群号/QQ号
    const viewMatch = text.match(/^#查看记忆\s*(\d+)$/);
    if (viewMatch) {
        const id = parseInt(viewMatch[1], 10);

        // 先尝试作为群号查询
        let messages = memory.getGroupSession(id);
        let sessionType = '群';

        // 如果群没有，尝试作为私聊查询
        if (!messages || messages.length === 0) {
            messages = memory.getPrivateSession(id);
            sessionType = '私聊';
        }

        if (!messages || messages.length === 0) {
            return { handled: true, response: `📭 没有找到 ${id} 的记忆` };
        }

        return {
            handled: true,
            response: `📋 ${sessionType} ${id} 的记忆 (${messages.length} 条):\n${memory.formatMessages(messages)}`
        };
    }

    // #清除所有记忆
    if (command === '#清除所有记忆') {
        const count = memory.sessionCount;
        memory.clearAll();
        return { handled: true, response: `🗑️ 已清除所有记忆 (共 ${count} 个会话)` };
    }

    // #清除本记忆
    if (command === '#清除本记忆') {
        if (msg.type === 'group' && msg.group_id) {
            const success = memory.clearGroup(msg.group_id);
            return {
                handled: true,
                response: success ? `🗑️ 已清除群 ${msg.group_id} 的记忆` : '📭 当前群没有记忆'
            };
        } else {
            const success = memory.clearPrivate(msg.sender_id);
            return {
                handled: true,
                response: success ? `🗑️ 已清除私聊记忆` : '📭 当前私聊没有记忆'
            };
        }
    }

    // === 知识库管理命令 ===

    // #知识 添加 <内容>
    const addKnowledgeMatch = text.match(/^#知识\s*添加\s+(.+)$/s);
    if (addKnowledgeMatch) {
        const content = addKnowledgeMatch[1].trim();
        if (content.length < 10) {
            return { handled: true, response: '❌ 内容太短，至少需要 10 个字符' };
        }

        // 异步添加
        (async () => {
            const { addKnowledge } = await import('./vectordb/knowledge.js');
            const count = await addKnowledge(content, '手动添加');
            log.info(`📚 知识库添加成功: ${count} 条片段`);
        })().catch(err => log.error('添加知识失败:', err));

        return { handled: true, response: `📚 正在添加知识... (文本长度: ${content.length})` };
    }

    // #知识 列表
    if (command === '#知识 列表' || command === '#知识列表') {
        // 异步返回需要重构，这里简化处理
        return { handled: true, response: '📚 请使用 #知识 搜索 <关键词> 来测试知识库' };
    }

    // #知识 搜索 <关键词>
    const searchKnowledgeMatch = text.match(/^#知识\s*搜索\s+(.+)$/);
    if (searchKnowledgeMatch) {
        const query = searchKnowledgeMatch[1].trim();

        // 返回 Promise 需要异步处理，这里用同步标记
        return {
            handled: true,
            response: `🔍 搜索中... (${query})`,
            asyncHandler: async () => {
                const { searchKnowledge } = await import('./vectordb/knowledge.js');
                const results = await searchKnowledge(query, 3);
                if (results.length === 0) {
                    return '📭 未找到相关知识（相似度 < 0.7）';
                }
                const lines = ['📚 相关知识:'];
                for (const r of results) {
                    lines.push(`  [${(r.score * 100).toFixed(0)}%] ${r.text.slice(0, 100)}...`);
                }
                return lines.join('\n');
            }
        };
    }

    // #知识 统计
    if (command === '#知识 统计' || command === '#知识统计') {
        return {
            handled: true,
            response: '📊 统计中...',
            asyncHandler: async () => {
                const { getKnowledgeStats } = await import('./vectordb/knowledge.js');
                const stats = await getKnowledgeStats();
                return `📚 知识库统计:\n  总计: ${stats.total} 条知识`;
            }
        };
    }

    // #知识 删除 <id>
    const deleteKnowledgeMatch = text.match(/^#知识\s*删除\s+(k_\S+)$/);
    if (deleteKnowledgeMatch) {
        const id = deleteKnowledgeMatch[1];
        return {
            handled: true,
            response: '🗑️ 删除中...',
            asyncHandler: async () => {
                const { deleteKnowledge } = await import('./vectordb/knowledge.js');
                const success = await deleteKnowledge(id);
                return success ? `✅ 已删除知识: ${id}` : `❌ 删除失败: ${id}`;
            }
        };
    }

    // === 用户画像管理命令 ===

    // #画像 查询 <QQ号>
    const profileQueryMatch = text.match(/^#画像\s*查询\s+(\d+)$/);
    if (profileQueryMatch) {
        const userId = parseInt(profileQueryMatch[1], 10);
        return {
            handled: true,
            response: '📋 查询中...',
            asyncHandler: async () => {
                const { getProfileFromSqlite } = await import('./storage/profiles-sqlite.js');
                const profile = getProfileFromSqlite(userId);
                if (!profile || profile.userId === 0) {
                    return `❌ 未找到用户 ${userId} 的画像`;
                }
                const lines = [
                    `📋 用户画像 [${profile.nickname}] (${profile.userId})`,
                    `  好感度: ${profile.favorability.toFixed(1)}`,
                    `  性格: ${profile.traits.length > 0 ? profile.traits.join(', ') : '(无)'}`,
                    `  兴趣: ${profile.interests.length > 0 ? profile.interests.join(', ') : '(无)'}`,
                    `  情绪: ${profile.mood}`,
                    `  互动次数: ${profile.messageCount}`,
                    `  最后活跃: ${new Date(profile.lastSeen).toLocaleString('zh-CN')}`,
                ];
                if (profile.notes) {
                    lines.push(`  备注: ${profile.notes}`);
                }
                return lines.join('\n');
            }
        };
    }

    // #画像 列表
    if (command === '#画像 列表' || command === '#画像列表') {
        return {
            handled: true,
            response: '📋 查询中...',
            asyncHandler: async () => {
                const { listAllProfilesFromSqlite } = await import('./storage/profiles-sqlite.js');
                const profiles = listAllProfilesFromSqlite(20);
                if (profiles.length === 0) {
                    return '📭 暂无用户画像';
                }
                const lines = ['📋 用户画像列表:'];
                for (const p of profiles) {
                    lines.push(`  [${p.nickname}] (${p.userId}) 好感:${p.favorability.toFixed(0)} 互动:${p.messageCount}`);
                }
                lines.push(`\n总计: ${profiles.length} 个用户`);
                return lines.join('\n');
            }
        };
    }

    // #画像 统计
    if (command === '#画像 统计' || command === '#画像统计') {
        return {
            handled: true,
            response: '📊 统计中...',
            asyncHandler: async () => {
                const { getProfileStatsFromSqlite } = await import('./storage/profiles-sqlite.js');
                const stats = getProfileStatsFromSqlite();
                return `📋 画像统计:\n  总用户: ${stats.total}\n  平均好感度: ${stats.avgFavorability.toFixed(1)}`;
            }
        };
    }

    // #画像 删除 <QQ号>
    const profileDeleteMatch = text.match(/^#画像\s*删除\s+(\d+)$/);
    if (profileDeleteMatch) {
        const userId = parseInt(profileDeleteMatch[1], 10);
        return {
            handled: true,
            response: '🗑️ 删除中...',
            asyncHandler: async () => {
                const { deleteProfileFromSqlite } = await import('./storage/profiles-sqlite.js');
                const success = deleteProfileFromSqlite(userId);
                return success ? `✅ 已删除用户 ${userId} 的画像` : `❌ 删除失败`;
            }
        };
    }

    // === 模块管理命令 ===

    // #模块 列表 / #技能 列表 (兼容)
    if (command === '#模块 列表' || command === '#模块列表' || command === '#技能 列表' || command === '#技能列表') {
        return {
            handled: true,
            response: '📦 查询中...',
            asyncHandler: async () => {
                const { getEnabledModules } = await import('./tools/index.js');
                const modules = getEnabledModules();
                if (modules.length === 0) {
                    return '📭 暂无已加载的模块';
                }
                const lines = ['📦 已加载模块:'];
                for (const m of modules) {
                    const mod = m.module;
                    lines.push(`  • ${mod.name} - ${mod.description}`);
                }
                lines.push(`\n总计: ${modules.length} 个模块`);
                return lines.join('\n');
            }
        };
    }

    // #模块 统计 / #技能 统计 (兼容)
    if (command === '#模块 统计' || command === '#模块统计' || command === '#技能 统计' || command === '#技能统计') {
        return {
            handled: true,
            response: '📊 统计中...',
            asyncHandler: async () => {
                const { getAllModules, getEnabledModules } = await import('./tools/index.js');
                const all = getAllModules();
                const enabled = getEnabledModules();
                return `📦 模块统计:\n  已加载: ${all.length} 个\n  已启用: ${enabled.length} 个`;
            }
        };
    }

    // #模块 重载 / #技能 重载 (兼容)
    if (command === '#模块 重载' || command === '#模块重载' || command === '#技能 重载' || command === '#技能重载') {
        return {
            handled: true,
            response: '🔄 重载中...',
            asyncHandler: async () => {
                const { stopModuleLoader, initModuleLoader, getEnabledModules } = await import('./tools/index.js');
                stopModuleLoader();
                await initModuleLoader(true);
                const modules = getEnabledModules();
                return `✅ 模块已重载，当前 ${modules.length} 个模块`;
            }
        };
    }

    // === 消息发送测试命令 ===

    // #测试消息 - 显示可用的测试类型
    if (command === '#测试消息' || command === '#测试消息 帮助') {
        return {
            handled: true,
            response: `📨 消息发送测试命令:
• #测试消息 文本 - 发送普通文本
• #测试消息 多段 - 发送多段文本（分段发送）
• #测试消息 图片 - 发送图片
• #测试消息 音乐 - 发送音乐卡片
• #测试消息 语音 - 发送语音消息
• #测试消息 视频 - 发送视频
• #测试消息 引用 - 发送引用回复
• #测试消息 艾特 - 发送 @消息
• #测试消息 表情 - 发送 QQ 表情
• #测试消息 图文 - 发送文字+图片组合
• #测试消息 全部 - 依次测试所有类型`
        };
    }

    // #测试消息 文本
    if (command === '#测试消息 文本') {
        return {
            handled: true,
            response: '📨 [测试] 这是一条普通文本消息~落落正在测试消息发送功能喵！'
        };
    }

    // #测试消息 多段
    if (command === '#测试消息 多段') {
        return {
            handled: true,
            response: '📨 测试中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const segments = [
                    '🔔 第一段消息：Hello~',
                    '📝 第二段消息：这是分段发送测试',
                    '✅ 第三段消息：发送完成喵！'
                ];
                for (let i = 0; i < segments.length; i++) {
                    if (i > 0) await new Promise(r => setTimeout(r, 500));
                    if (msg.type === 'group' && msg.group_id) {
                        await connector.sendGroup(msg.group_id, segments[i]);
                    } else {
                        await connector.sendPrivate(msg.sender_id, segments[i]);
                    }
                }
                return '✅ 多段文本发送完成！';
            }
        };
    }

    // #测试消息 图片
    if (command === '#测试消息 图片') {
        return {
            handled: true,
            response: '📨 发送图片中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const testImagePath = resolveTestFile('draw_1768126112708_ogj6oo.webp');
                await connector.sendImage(msg, testImagePath);
                return '✅ 图片发送完成！';
            }
        };
    }

    // #测试消息 音乐
    if (command === '#测试消息 音乐') {
        return {
            handled: true,
            response: '📨 发送音乐卡片中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                await connector.sendMusic(msg, '163', '430053202');  // 网易云音乐测试
                return '✅ 音乐卡片发送完成！(网易云 - 四重罪孽)';
            }
        };
    }

    // #测试消息 语音
    if (command === '#测试消息 语音') {
        return {
            handled: true,
            response: '📨 发送语音中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const testAudioPath = resolveTestFile('6a81bcd044425bed111c8ad530419f86.amr.mp3');
                await connector.send(msg, [{ type: 'record', data: { file: testAudioPath } }]);
                return '✅ 语音发送完成！';
            }
        };
    }

    // #测试消息 视频
    if (command === '#测试消息 视频') {
        return {
            handled: true,
            response: '📨 发送视频中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const testVideoPath = resolveTestFile('0ea911a5ad2763b9.mp4');
                await connector.send(msg, [{ type: 'video', data: { file: testVideoPath } }]);
                return '✅ 视频发送完成！';
            }
        };
    }

    // #测试消息 引用
    if (command === '#测试消息 引用') {
        return {
            handled: true,
            response: '📨 发送引用回复中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                await connector.send(msg, [
                    { type: 'reply', data: { id: String(msg.message_id) } },
                    { type: 'text', data: { text: '📨 [测试] 这是一条引用回复消息~' } }
                ]);
                return '✅ 引用回复发送完成！';
            }
        };
    }

    // #测试消息 艾特
    if (command === '#测试消息 艾特') {
        return {
            handled: true,
            response: '📨 发送 @消息中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                await connector.send(msg, [
                    { type: 'at', data: { qq: String(msg.sender_id) } },
                    { type: 'text', data: { text: ' 📨 [测试] 这是一条 @你 的消息~' } }
                ]);
                return '✅ @消息发送完成！';
            }
        };
    }

    // #测试消息 表情
    if (command === '#测试消息 表情') {
        return {
            handled: true,
            response: '📨 发送表情中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                // 发送多个 QQ 表情
                await connector.send(msg, [
                    { type: 'text', data: { text: '📨 [测试] 表情测试: ' } },
                    { type: 'face', data: { id: '178' } },  // 喵喵
                    { type: 'face', data: { id: '179' } },  // 汪汪
                    { type: 'face', data: { id: '66' } },   // 爱心
                    { type: 'face', data: { id: '12' } },   // 调皮
                ]);
                return '✅ 表情发送完成！';
            }
        };
    }

    // #测试消息 图文
    if (command === '#测试消息 图文') {
        return {
            handled: true,
            response: '📨 发送图文消息中...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const testImagePath = resolveTestFile('draw_1768126112708_ogj6oo.webp');
                await connector.send(msg, [
                    { type: 'text', data: { text: '📨 [测试] 这是一条图文混合消息~\n下面是图片：' } },
                    { type: 'image', data: { file: testImagePath } }
                ]);
                return '✅ 图文消息发送完成！';
            }
        };
    }

    // #测试消息 全部
    if (command === '#测试消息 全部') {
        return {
            handled: true,
            response: '📨 开始全部测试...',
            asyncHandler: async () => {
                const { connector } = await import('./connector.js');
                const results: string[] = [];
                const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

                try {
                    // 1. 文本
                    if (msg.type === 'group' && msg.group_id) {
                        await connector.sendGroup(msg.group_id, '📨 [1/7] 文本测试');
                    } else {
                        await connector.sendPrivate(msg.sender_id, '📨 [1/7] 文本测试');
                    }
                    results.push('✅ 文本');
                    await delay(1000);

                    // 2. 图片
                    await connector.sendImage(msg, resolveTestFile('draw_1768126112708_ogj6oo.webp'));
                    results.push('✅ 图片');
                    await delay(1000);

                    // 3. 音乐卡片
                    await connector.sendMusic(msg, '163', '430053202');
                    results.push('✅ 音乐卡片');
                    await delay(1000);

                    // 4. @消息
                    await connector.send(msg, [
                        { type: 'at', data: { qq: String(msg.sender_id) } },
                        { type: 'text', data: { text: ' [4/7] @消息测试' } }
                    ]);
                    results.push('✅ @消息');
                    await delay(1000);

                    // 5. 表情
                    await connector.send(msg, [
                        { type: 'text', data: { text: '[5/7] 表情测试: ' } },
                        { type: 'face', data: { id: '178' } },
                        { type: 'face', data: { id: '66' } }
                    ]);
                    results.push('✅ 表情');
                    await delay(1000);

                    // 6. 引用
                    await connector.send(msg, [
                        { type: 'reply', data: { id: String(msg.message_id) } },
                        { type: 'text', data: { text: '[6/7] 引用测试' } }
                    ]);
                    results.push('✅ 引用');
                    await delay(1000);

                    // 7. 图文
                    await connector.send(msg, [
                        { type: 'text', data: { text: '[7/7] 图文测试:\n' } },
                        { type: 'image', data: { file: resolveTestFile('draw_1768126112708_ogj6oo.webp') } }
                    ]);
                    results.push('✅ 图文');

                } catch (err) {
                    results.push(`❌ 错误: ${err instanceof Error ? err.message : String(err)}`);
                }

                return `📊 测试结果:\n${results.join('\n')}`;
            }
        };
    }

    // 未识别的 # 开头指令，不处理
    return { handled: false };
}
