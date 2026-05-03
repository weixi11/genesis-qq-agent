/**
 * 工具注册中心
 * 
 * 提供工具信息的统一访问接口，支持缓存
 * 解决分散调用 getEnabledModules()、getAllModules() 等问题
 */

import {
    getEnabledModules,
    getAllModules,
    getModuleBriefs,
    getModuleSchemas,
    getModuleSchemasByNames,
    getModuleDefinitions,
    type ModuleBrief,
} from '../tools/index.js';
import type { LoadedTool } from '../tools/types.js';
import type { ToolDefinition } from '../llm.js';

/** 工具信息缓存 */
interface ToolInfo {
    enabled: LoadedTool[];
    all: LoadedTool[];
    disabledNames: string[];
    briefs: ModuleBrief[];
}

/**
 * 工具注册中心
 */
class ToolRegistry {
    private cache: ToolInfo | null = null;
    private cacheTime = 0;
    private readonly CACHE_TTL = 5000; // 5 秒缓存

    /**
     * 确保缓存有效
     */
    private ensureCache(): ToolInfo {
        const now = Date.now();
        if (!this.cache || now - this.cacheTime > this.CACHE_TTL) {
            const enabled = getEnabledModules();
            const all = getAllModules();
            this.cache = {
                enabled,
                all,
                disabledNames: all
                    .filter(m => !enabled.some(e => e.module.name === m.module.name))
                    .map(m => m.module.name),
                briefs: getModuleBriefs(),
            };
            this.cacheTime = now;
        }
        return this.cache;
    }

    /**
     * 获取已启用的工具列表
     */
    getEnabledModules(): LoadedTool[] {
        return this.ensureCache().enabled;
    }

    /**
     * 获取所有工具列表（包括禁用的）
     */
    getAllModules(): LoadedTool[] {
        return this.ensureCache().all;
    }

    /**
     * 获取已禁用工具的名称列表
     */
    getDisabledNames(): string[] {
        return this.ensureCache().disabledNames;
    }

    /**
     * 获取工具简介列表（用于两阶段 Function Calling）
     */
    getBriefs(): ModuleBrief[] {
        return this.ensureCache().briefs;
    }

    /**
     * 获取工具定义文本（用于 Prompt Engineering）
     */
    getDefinitions(): string {
        return getModuleDefinitions();
    }

    /**
     * 获取所有工具的 Schema（用于 Function Calling）
     */
    getSchemas(): ToolDefinition[] {
        return getModuleSchemas() as ToolDefinition[];
    }

    /**
     * 根据工具名获取 Schema
     */
    getSchemasByNames(names: string[]): ToolDefinition[] {
        return getModuleSchemasByNames(names) as ToolDefinition[];
    }

    /**
     * 获取已启用工具的名称列表
     */
    getEnabledToolNames(): string[] {
        return this.ensureCache().enabled.map(m => m.module.name);
    }

    /**
     * 检查工具是否存在且已启用
     */
    isToolEnabled(name: string): boolean {
        return this.ensureCache().enabled.some(m => m.module.name === name);
    }

    /**
     * 根据名称查找工具
     */
    findByName(name: string): LoadedTool | undefined {
        return this.ensureCache().enabled.find(m => m.module.name === name);
    }

    /**
     * 使缓存失效（用于热重载）
     */
    invalidate(): void {
        this.cache = null;
    }
}

// 全局单例
export const toolRegistry = new ToolRegistry();
