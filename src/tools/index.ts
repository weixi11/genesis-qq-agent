/**
 * 统一工具系统入口
 * 
 * 提供工具注册、查询、执行的公共 API
 */

// ==================== 新类型导出（推荐使用） ====================
export type {
    Tool,
    ToolMeta,
    ToolSchema,
    ToolSchemaProperty,
    ToolContext,
    ToolResult,
    ToolTriggers,
    ToolPermissions,
    ToolCooldown,
    ToolErrorHandler,
    ToolExecuteFn,
    LoadedTool,
    CooldownTracker,
} from './types.js';

// ==================== 旧类型导出（向后兼容，已弃用） ====================
export type {
    Module,
    ModuleMeta,
    ModuleSchema,
    ModuleSchemaProperty,
    ModuleContext,
    ModuleResult,
    ModuleTriggers,
    ModulePermissions,
    ModuleCooldown,
    ModuleErrorHandler,
    ModuleExecuteFn,
    LoadedModule,
} from './types.js';

// 加载器导出
export {
    initModuleLoader,
    getAllModules,
    getEnabledModules,
    getModuleByName,
    getModuleSchemas,
    getModuleDefinitions,
    matchModuleByKeyword,
    stopModuleLoader,
    reloadModule,
    // 两阶段 Function Calling 支持
    getModuleBriefs,
    getModuleSchemaByName,
    getModuleSchemasByNames,
} from './loader.js';

export type { ModuleBrief } from './loader.js';

// 执行器导出
export {
    executeModule,
    isInCooldown,
    getRemainingCooldown,
} from './executor.js';

// ==================== 工具上下文构建 ====================

import { config } from '../config.js';
import type { ToolContext } from './types.js';

/**
 * 构建工具上下文
 */
export function buildToolContext(options: {
    groupId?: number;
    senderId?: number;
    imageUrls?: string[];
    atUsers?: number[];
    videoPaths?: string[];
    audioPaths?: string[];
    filePaths?: string[];
    senderRole?: 'owner' | 'admin' | 'member';
}): ToolContext {
    const { groupId, senderId, imageUrls, atUsers, videoPaths, audioPaths, filePaths, senderRole } = options;

    // 计算目标用户（排除 bot 自己）
    let targetUser: number | undefined;
    const botQQ = config.botQQ;
    const validAtUsers = atUsers?.filter(id => id !== botQQ) || [];
    if (validAtUsers.length > 0) {
        targetUser = validAtUsers[0];
    }

    return {
        groupId,
        senderId: senderId || 0,
        targetUser,
        imageUrls,
        atUsers,
        videoPaths,
        audioPaths,
        filePaths,
        senderRole,
    };
}

/** @deprecated 请使用 buildToolContext */
export const buildModuleContext = buildToolContext;

/**
 * 从被@用户和发送者中获取目标用户
 */
export function getTargetUser(ctx: ToolContext): number | null {
    const botQQ = config.botQQ;
    const atUsers = ctx.atUsers?.filter(id => id !== botQQ) || [];
    if (atUsers.length > 0) return atUsers[0];
    return ctx.senderId || null;
}
