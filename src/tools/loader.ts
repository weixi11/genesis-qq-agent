/**
 * 工具加载器
 * 
 * 功能：
 * - 自动扫描 src/tools/ 下的子目录
 * - 加载每个工具的 index.ts 和 *.skills.yaml
 * - 支持热重载（文件变化时自动重新加载）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml } from 'yaml';
import { log } from '../logger.js';
import type { Module, ModuleMeta, LoadedModule, ModuleSchema } from './types.js';

// ESM 目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 工具目录
const TOOLS_DIR = __dirname;

// ==================== 工具存储 ====================

/** 已加载的工具 Map<name, LoadedModule> */
const loadedTools = new Map<string, LoadedModule>();

/** 是否已初始化 */
let initialized = false;

/** 文件监听器 */
let watcher: fs.FSWatcher | null = null;

// ==================== 排除的目录 ====================

/** 非工具的目录/文件（框架自身） */
const EXCLUDED_NAMES = new Set([
    'index.ts',
    'index.js',
    'types.ts',
    'types.js',
    'loader.ts',
    'loader.js',
    'executor.ts',
    'executor.js',
]);

// ==================== 公共 API ====================

/**
 * 初始化工具加载器
 * @param hotReload 是否启用热重载
 */
export async function initModuleLoader(hotReload = true): Promise<void> {
    if (initialized) {
        log.warn('⚠️ 工具加载器已初始化');
        return;
    }

    log.info(`📦 正在加载工具... (${TOOLS_DIR})`);

    // 加载所有工具
    await loadAllTools();

    // 启用热重载
    if (hotReload) {
        enableHotReload();
    }

    initialized = true;
    log.info(`✅ 已加载 ${loadedTools.size} 个工具`);
}

/**
 * 获取所有已加载的工具
 */
export function getAllModules(): LoadedModule[] {
    return Array.from(loadedTools.values());
}

/**
 * 获取所有已启用的工具
 */
export function getEnabledModules(): LoadedModule[] {
    return Array.from(loadedTools.values()).filter(m => m.module.enabled());
}

/**
 * 根据名称获取工具
 */
export function getModuleByName(name: string): LoadedModule | undefined {
    return loadedTools.get(name);
}

/**
 * 获取所有已启用模块的 Function Calling Schemas
 */
export function getModuleSchemas(): ModuleSchema[] {
    return getEnabledModules().map(m => m.module.schema);
}

/**
 * 模块简介（用于两阶段 Function Calling 的第一阶段）
 */
export interface ModuleBrief {
    name: string;
    description: string;
}

/**
 * 获取所有已启用模块的简介（名称+描述）
 * 用于两阶段 Function Calling 的工具选择阶段，大幅减少 token 消耗
 */
export function getModuleBriefs(): ModuleBrief[] {
    return getEnabledModules().map(m => ({
        name: m.module.name,
        description: m.module.description,
    }));
}

/**
 * 根据名称获取单个模块的 Schema
 * 用于两阶段 Function Calling 的参数提取阶段
 */
export function getModuleSchemaByName(name: string): ModuleSchema | undefined {
    const mod = getModuleByName(name);
    return mod?.module.schema;
}

/**
 * 根据名称列表获取多个模块的 Schemas
 */
export function getModuleSchemasByNames(names: string[]): ModuleSchema[] {
    return names
        .map(name => getModuleSchemaByName(name))
        .filter((schema): schema is ModuleSchema => schema !== undefined);
}

/**
 * 获取模块定义文本（用于 Prompt Engineering）
 */
export function getModuleDefinitions(): string {
    const enabledModules = getEnabledModules();
    if (enabledModules.length === 0) return '(无可用工具)';

    const lines = ['可用工具列表：', ''];
    enabledModules.forEach((loaded, idx) => {
        const mod = loaded.module;
        lines.push(`${idx + 1}. ${mod.name} - ${mod.description}`);
        if (mod.schema) {
            const params = mod.schema.parameters;
            const props = Object.entries(params.properties || {});
            if (props.length > 0) {
                const paramStr = props
                    .map(([key, val]) => `"${key}": ${(val as { description?: string }).description || key}`)
                    .join(', ');
                lines.push(`   参数: { ${paramStr} }`);
            }
        }
        lines.push('');
    });
    lines.push(`${enabledModules.length + 1}. none - 不需要调用工具（闲聊或无法识别）`);
    return lines.join('\n');
}

/**
 * 根据关键词匹配工具
 */
export function matchModuleByKeyword(text: string): LoadedModule | undefined {
    for (const loaded of getEnabledModules()) {
        const keywords = loaded.module.keywords || loaded.meta.triggers.keywords || [];
        for (const keyword of keywords) {
            try {
                const regex = new RegExp(keyword, 'i');
                if (regex.test(text)) {
                    return loaded;
                }
            } catch {
                // 无效正则，跳过
            }
        }
    }
    return undefined;
}

/**
 * 停止工具加载器（清理资源）
 */
export function stopModuleLoader(): void {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    loadedTools.clear();
    initialized = false;
    log.info('📦 工具加载器已停止');
}

/**
 * 重新加载指定工具
 */
export async function reloadModule(moduleName: string): Promise<boolean> {
    const loaded = loadedTools.get(moduleName);
    if (!loaded) {
        log.warn(`⚠️ 工具 ${moduleName} 不存在，无法重载`);
        return false;
    }
    return loadToolDir(loaded.dirPath);
}

// ==================== 内部实现 ====================

/**
 * 加载所有工具
 */
async function loadAllTools(): Promise<void> {
    const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
        // 只处理目录
        if (!entry.isDirectory()) continue;

        // 排除框架文件
        if (EXCLUDED_NAMES.has(entry.name)) continue;

        const dirPath = path.join(TOOLS_DIR, entry.name);
        await loadToolDir(dirPath);
    }
}

/**
 * 加载单个工具目录
 */
async function loadToolDir(dirPath: string): Promise<boolean> {
    const dirName = path.basename(dirPath);

    try {
        // 1. 检查目录是否存在
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
            return false;
        }

        // 2. 查找工具入口文件
        const indexFile = findToolIndex(dirPath);
        if (!indexFile) {
            log.warn(`⚠️ 工具 ${dirName} 缺少 index.ts/index.js`);
            return false;
        }

        // 3. 查找元数据文件
        const metaFile = findToolMeta(dirPath);
        let meta: ModuleMeta | null = null;

        if (metaFile) {
            meta = loadToolMeta(metaFile);
        }

        // 4. 动态导入工具
        const moduleUrl = pathToFileURL(indexFile).href;

        // 添加时间戳强制重新加载（热重载用）
        const moduleUrlWithTimestamp = `${moduleUrl}?t=${Date.now()}`;
        const mod = await import(moduleUrlWithTimestamp) as Module;

        // 5. 校验工具接口
        if (!validateTool(mod, dirName)) {
            return false;
        }

        // 6. 如果没有 YAML 元数据，从工具代码生成默认元数据
        if (!meta) {
            meta = {
                name: mod.name,
                displayName: mod.name,
                version: '1.0.0',
                description: mod.description,
                triggers: {
                    keywords: mod.keywords || [],
                },
            };
        }

        // 7. 存储已加载的工具
        const loaded: LoadedModule = {
            module: mod,
            meta,
            dirPath,
            loadedAt: new Date(),
        };

        loadedTools.set(mod.name, loaded);
        log.debug(`📄 已加载工具: ${mod.name} (${dirName}/)`);

        return true;
    } catch (err) {
        log.error(`❌ 加载工具失败: ${dirName}`, err);
        return false;
    }
}

/**
 * 查找工具入口文件
 */
function findToolIndex(dirPath: string): string | null {
    const candidates = ['index.js', 'index.ts'];
    for (const name of candidates) {
        const filePath = path.join(dirPath, name);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }
    return null;
}

/**
 * 查找工具元数据文件
 */
function findToolMeta(dirPath: string): string | null {
    const files = fs.readdirSync(dirPath);
    const metaFile = files.find(f => f.endsWith('.skills.yaml') || f.endsWith('.skills.yml'));
    return metaFile ? path.join(dirPath, metaFile) : null;
}

/**
 * 加载工具元数据
 */
function loadToolMeta(filePath: string): ModuleMeta | null {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const meta = parseYaml(content) as ModuleMeta;

        // 验证必要字段
        if (!meta.name) {
            log.warn(`⚠️ 工具元数据缺少 name: ${filePath}`);
            return null;
        }

        return meta;
    } catch (err) {
        log.error(`❌ 解析工具元数据失败: ${filePath}`, err);
        return null;
    }
}

/**
 * 校验工具接口
 */
function validateTool(mod: Module, dirName: string): boolean {
    const errors: string[] = [];

    if (!mod.name) errors.push('缺少 name');
    if (typeof mod.enabled !== 'function') errors.push('缺少 enabled()');
    if (typeof mod.execute !== 'function') errors.push('缺少 execute()');
    if (!mod.schema) errors.push('缺少 schema');

    if (errors.length > 0) {
        log.warn(`⚠️ 工具 ${dirName} 接口不完整: ${errors.join(', ')}`);
        return false;
    }

    return true;
}

/**
 * 启用热重载
 */
function enableHotReload(): void {
    try {
        watcher = fs.watch(TOOLS_DIR, { recursive: true }, (eventType, filename) => {
            if (!filename) return;

            // 解析文件路径
            const parts = filename.split(path.sep);
            if (parts.length < 1) return;

            const toolDirName = parts[0];

            // 排除框架文件
            if (EXCLUDED_NAMES.has(toolDirName)) return;

            const toolDirPath = path.join(TOOLS_DIR, toolDirName);

            // 检查是否是目录级别的变化
            if (eventType === 'rename') {
                if (fs.existsSync(toolDirPath) && fs.statSync(toolDirPath).isDirectory()) {
                    log.info(`🔄 检测到新工具: ${toolDirName}`);
                    void loadToolDir(toolDirPath);
                } else {
                    // 工具目录被删除
                    for (const [name, loaded] of loadedTools) {
                        if (loaded.dirPath === toolDirPath) {
                            loadedTools.delete(name);
                            log.info(`🗑️ 已卸载工具: ${name}`);
                            break;
                        }
                    }
                }
            } else if (eventType === 'change') {
                // 文件变化，重载工具
                if (fs.existsSync(toolDirPath) && fs.statSync(toolDirPath).isDirectory()) {
                    log.info(`🔄 工具文件变更: ${filename}`);
                    void loadToolDir(toolDirPath);
                }
            }
        });

        log.info('👁️ 工具热重载已启用');
    } catch (err) {
        log.warn('⚠️ 无法启用工具热重载:', err);
    }
}
