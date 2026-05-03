/**
 * 模块执行引擎
 * 
 * 功能：
 * - 权限检查
 * - 冷却管理
 * - 调用模块的 execute() 方法
 * - 错误处理
 */

import { log } from '../logger.js';
import { getModuleByName } from './loader.js';
import type {
    ModuleMeta,
    ModuleContext,
    ModuleResult,
    CooldownTracker,
    ModuleErrorHandler,
} from './types.js';

// ==================== 冷却追踪 ====================

const cooldownTracker: CooldownTracker = {
    perUser: new Map(),
    global: new Map(),
};

// ==================== 公共 API ====================

/**
 * 执行模块
 * 
 * @param moduleName 模块名称
 * @param params 执行参数
 * @param ctx 执行上下文
 */
export async function executeModule(
    moduleName: string,
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    const startTime = Date.now();

    // 1. 获取模块
    const loaded = getModuleByName(moduleName);
    if (!loaded) {
        return { success: false, text: `找不到模块: ${moduleName}` };
    }

    const { module: mod, meta } = loaded;

    // 2. 检查是否启用
    if (!mod.enabled()) {
        return { success: false, text: `模块 ${moduleName} 已禁用` };
    }

    // 3. 权限检查
    const permError = checkPermissions(meta, ctx);
    if (permError) {
        return { success: false, text: permError };
    }

    // 4. 冷却检查
    const cooldownError = checkCooldown(meta, ctx.senderId);
    if (cooldownError) {
        return { success: false, text: cooldownError };
    }

    try {
        // 5. 执行模块
        const result = await mod.execute(params, ctx);

        // 6. 检查 success=false 的情况，触发 onError
        if (!result.success && meta.onError) {
            const errorResponse = handleError(meta.onError, new Error(result.text || '执行失败'));
            if (errorResponse) {
                return { success: false, text: errorResponse };
            }
        }

        // 7. 设置冷却
        if (result.success) {
            setCooldown(meta, ctx.senderId);
        }

        log.debug(`✅ 模块执行完成: ${moduleName} (${Date.now() - startTime}ms)`);
        return result;

    } catch (err) {
        log.error(`❌ 模块执行失败: ${moduleName}`, err);

        // 8. 错误处理
        if (meta.onError) {
            const errorResponse = handleError(meta.onError, err);
            if (errorResponse) {
                return { success: false, text: errorResponse };
            }
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, text: `模块 ${moduleName} 执行出错: ${errMsg}` };
    }
}

/**
 * 检查用户是否在冷却中
 */
export function isInCooldown(moduleName: string, userId: number): boolean {
    const userKey = `${moduleName}:${userId}`;
    const now = Date.now();

    // 检查用户冷却
    const userExpires = cooldownTracker.perUser.get(userKey);
    if (userExpires && now < userExpires) {
        return true;
    }

    // 检查全局冷却
    const globalExpires = cooldownTracker.global.get(moduleName);
    if (globalExpires && now < globalExpires) {
        return true;
    }

    return false;
}

/**
 * 获取剩余冷却时间（秒）
 */
export function getRemainingCooldown(moduleName: string, userId: number): number {
    const userKey = `${moduleName}:${userId}`;
    const now = Date.now();

    const userExpires = cooldownTracker.perUser.get(userKey) || 0;
    const globalExpires = cooldownTracker.global.get(moduleName) || 0;

    const maxExpires = Math.max(userExpires, globalExpires);
    if (now >= maxExpires) return 0;

    return Math.ceil((maxExpires - now) / 1000);
}

// ==================== 内部实现 ====================

/**
 * 权限检查
 */
function checkPermissions(meta: ModuleMeta, ctx: ModuleContext): string | null {
    const perms = meta.permissions;
    if (!perms) return null;

    // 检查是否允许私聊
    if (!ctx.groupId && perms.allowPrivate === false) {
        return '这个功能只能在群里使用哦~';
    }

    // 检查群权限
    if (ctx.groupId && perms.allowGroups !== 'all') {
        const allowed = perms.allowGroups || [];
        if (!allowed.includes(ctx.groupId)) {
            return '这个群没有开启这个功能~';
        }
    }

    // 检查角色权限
    if (perms.requiredRole && ctx.groupId) {
        const roleHierarchy: Record<string, number> = { owner: 3, admin: 2, member: 1 };
        const required = roleHierarchy[perms.requiredRole] || 1;
        const actual = roleHierarchy[ctx.senderRole || 'member'] || 1;

        if (actual < required) {
            const roleNames: Record<string, string> = { owner: '群主', admin: '管理员', member: '成员' };
            return `这个功能需要${roleNames[perms.requiredRole]}权限哦~`;
        }
    }

    return null;
}

/**
 * 冷却检查
 */
function checkCooldown(meta: ModuleMeta, userId: number): string | null {
    const cd = meta.cooldown;
    if (!cd) return null;

    const now = Date.now();

    // 检查用户冷却
    if (cd.perUser && cd.perUser > 0) {
        const userKey = `${meta.name}:${userId}`;
        const expires = cooldownTracker.perUser.get(userKey);
        if (expires && now < expires) {
            const remaining = Math.ceil((expires - now) / 1000);
            return `这个功能冷却中，还需等待 ${remaining} 秒~`;
        }
    }

    // 检查全局冷却
    if (cd.global && cd.global > 0) {
        const expires = cooldownTracker.global.get(meta.name);
        if (expires && now < expires) {
            const remaining = Math.ceil((expires - now) / 1000);
            return `这个功能全局冷却中，还需等待 ${remaining} 秒~`;
        }
    }

    return null;
}

/**
 * 设置冷却
 */
function setCooldown(meta: ModuleMeta, userId: number): void {
    const cd = meta.cooldown;
    if (!cd) return;

    const now = Date.now();

    if (cd.perUser && cd.perUser > 0) {
        const userKey = `${meta.name}:${userId}`;
        cooldownTracker.perUser.set(userKey, now + cd.perUser * 1000);
    }

    if (cd.global && cd.global > 0) {
        cooldownTracker.global.set(meta.name, now + cd.global * 1000);
    }
}

/**
 * 处理错误
 */
function handleError(handlers: ModuleErrorHandler[], err: unknown): string | null {
    const errorObj = {
        message: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string }).code,
    };

    for (const handler of handlers) {
        if (matchesErrorCondition(handler.condition, errorObj)) {
            return handler.response;
        }
    }

    return null;
}

function matchesErrorCondition(
    condition: string,
    error: { message: string; code?: string },
): boolean {
    const includesMatch = condition.match(/^error\.(message|code)\.includes\((['"])(.*)\2\)$/);
    if (includesMatch) {
        const [, field, , expected] = includesMatch;
        const actual = field === 'message' ? error.message : error.code;
        return typeof actual === 'string' && actual.includes(expected);
    }

    const equalsMatch = condition.match(/^error\.(message|code)\s*(===|==|!==|!=)\s*(['"])(.*)\3$/);
    if (equalsMatch) {
        const [, field, operator, , expected] = equalsMatch;
        const actual = field === 'message' ? error.message : error.code;
        const value = actual || '';

        if (operator === '===' || operator === '==') {
            return value === expected;
        }
        return value !== expected;
    }

    log.warn(`⚠️ 无法解析 onError 条件: ${condition}`);
    return false;
}
