/**
 * 统一工具类型定义
 * 
 * 工具 = 热插拔能力单元
 * 每个工具包含：执行逻辑(index.ts) + Schema(schema.ts) + 元数据(*.skills.yaml) + 配置(config.ts)
 */

// ==================== 工具元数据（从 YAML 解析） ====================

/** 触发条件 */
export interface ToolTriggers {
    /** 关键词列表（正则匹配） */
    keywords?: string[];
    /** 意图标识列表 */
    intents?: string[];
}

/** 权限设置 */
export interface ToolPermissions {
    /** 允许的群（'all' 或群号列表） */
    allowGroups?: 'all' | number[];
    /** 是否允许私聊 */
    allowPrivate?: boolean;
    /** 需要的角色（owner/admin/member） */
    requiredRole?: 'owner' | 'admin' | 'member';
}

/** 冷却设置 */
export interface ToolCooldown {
    /** 单用户冷却（秒） */
    perUser?: number;
    /** 全局冷却（秒） */
    global?: number;
}

/** 错误处理器 */
export interface ToolErrorHandler {
    /** 匹配条件（JS 表达式） */
    condition: string;
    /** 响应文本 */
    response: string;
}

/** 工具元数据（从 *.skills.yaml 解析） */
export interface ToolMeta {
    /** 工具唯一标识 */
    name: string;
    /** 显示名称 */
    displayName: string;
    /** 版本号 */
    version: string;
    /** 工具描述 */
    description?: string;
    /** 触发条件 */
    triggers: ToolTriggers;
    /** 权限设置 */
    permissions?: ToolPermissions;
    /** 冷却设置 */
    cooldown?: ToolCooldown;
    /** 错误处理 */
    onError?: ToolErrorHandler[];
}

// ==================== 工具 Schema（用于 Function Calling） ====================

/** Schema 属性定义 */
export interface ToolSchemaProperty {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    description?: string;
    enum?: string[];
    default?: unknown;
    items?: ToolSchemaProperty;
}

/** 工具 Schema（用于 LLM Function Calling） */
export interface ToolSchema {
    /** 工具名称 */
    name: string;
    /** 工具描述（LLM 可见） */
    description: string;
    /** 参数定义 */
    parameters: {
        type: 'object';
        properties: Record<string, ToolSchemaProperty>;
        required?: string[];
    };
}

// ==================== 工具执行 ====================

/** 工具执行上下文 */
export interface ToolContext {
    /** 发送者 ID */
    senderId: number;
    /** 群 ID（私聊时为 undefined） */
    groupId?: number;
    /** 图片 URL 列表 */
    imageUrls?: string[];
    /** 被 @ 的用户 ID 列表 */
    atUsers?: number[];
    /** 视频路径列表 */
    videoPaths?: string[];
    /** 音频路径列表 */
    audioPaths?: string[];
    /** 文件路径列表 */
    filePaths?: string[];
    /** 发送者角色 */
    senderRole?: 'owner' | 'admin' | 'member';
    /** 目标用户 ID（从 @ 或文本解析） */
    targetUser?: number;
}

/** 重新导出 MessageSegment 类型供工具使用 */
export type { MessageSegment } from '../utils/message.js';
export type { FileAttachment } from '../utils/file_attachment.js';

/** 工具执行结果 */
export interface ToolResult {
    /** 是否成功 */
    success: boolean;
    /** 响应文本 (用于润色或直接发送) */
    text: string;
    /** 统一消息段数组 (替代 data.segments / data.imageUrl 等) */
    segments?: import('../utils/message.js').MessageSegment[];
    /** 需要通过 QQ 文件接口发送的本地文件 */
    files?: import('../utils/file_attachment.js').FileAttachment[];
    /** 附加数据 (用于额外信息透传，如歌曲列表、prompt等) */
    data?: Record<string, unknown>;
}

/** 工具执行函数类型 */
export type ToolExecuteFn = (
    params: Record<string, unknown>,
    ctx: ToolContext
) => Promise<ToolResult>;

// ==================== 工具任务配置 ====================

/** 工具任务配置（用于 TaskManager 和 TaskQueue） */
export interface ToolTaskConfig {
    /** 超时时间（毫秒），默认 30000 */
    timeoutMs: number;
    /** 最大并发数，默认 5 */
    concurrency: number;
}

// ==================== 工具接口 ====================

/** 工具接口（每个工具的 index.ts 必须导出） */
export interface Tool {
    /** 工具名称 */
    name: string;
    /** 工具描述 */
    description: string;
    /** 关键词（正则匹配，用于快速检测） */
    keywords: string[];
    /** 是否启用 */
    enabled: () => boolean;
    /** Function Calling Schema */
    schema: ToolSchema;
    /** 执行函数 */
    execute: ToolExecuteFn;
    /** 获取任务配置（可选，用于 TaskManager/TaskQueue） */
    getTaskConfig?: () => ToolTaskConfig;
}

/** 已加载的工具（包含运行时信息） */
export interface LoadedTool {
    /** 工具实现（向后兼容：保持 module 属性名） */
    module: Tool;
    /** 工具元数据（从 YAML 解析） */
    meta: ToolMeta;
    /** 工具目录路径 */
    dirPath: string;
    /** 加载时间 */
    loadedAt: Date;
}

// ==================== 冷却状态追踪 ====================

/** 冷却状态追踪器 */
export interface CooldownTracker {
    /** 用户冷却 Map<toolName:userId, expiresAt> */
    perUser: Map<string, number>;
    /** 全局冷却 Map<toolName, expiresAt> */
    global: Map<string, number>;
}

// ==================== 向后兼容别名（过渡期使用，后续移除） ====================

/** @deprecated 请使用 ToolTriggers */
export type ModuleTriggers = ToolTriggers;
/** @deprecated 请使用 ToolPermissions */
export type ModulePermissions = ToolPermissions;
/** @deprecated 请使用 ToolCooldown */
export type ModuleCooldown = ToolCooldown;
/** @deprecated 请使用 ToolErrorHandler */
export type ModuleErrorHandler = ToolErrorHandler;
/** @deprecated 请使用 ToolMeta */
export type ModuleMeta = ToolMeta;
/** @deprecated 请使用 ToolSchemaProperty */
export type ModuleSchemaProperty = ToolSchemaProperty;
/** @deprecated 请使用 ToolSchema */
export type ModuleSchema = ToolSchema;
/** @deprecated 请使用 ToolContext */
export type ModuleContext = ToolContext;
/** @deprecated 请使用 ToolResult */
export type ModuleResult = ToolResult;
/** @deprecated 请使用 ToolExecuteFn */
export type ModuleExecuteFn = ToolExecuteFn;
/** @deprecated 请使用 Tool */
export type Module = Tool;
/** @deprecated 请使用 LoadedTool */
export type LoadedModule = LoadedTool;
