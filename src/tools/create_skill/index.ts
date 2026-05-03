/**
 * Create Skill 模块 - Bot 自己给自己写新技能
 *
 * 功能：
 * - 接收工具名称和功能描述
 * - 使用 LLM 生成 schema.ts、config.ts、index.ts 三个文件
 * - 写入 src/tools/<name>/ 目录
 * - 热重载系统自动加载新工具
 *
 * 权限：仅主人可用
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LLMClient } from '../../llm.js';
import { log } from '../../logger.js';
import { isMaster } from '../../utils/identity.js';
import { safeParseRecord } from '../../utils/json.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'create_skill';
export const description = '创建新的技能工具（仅主人可用）';
export const keywords = ['创建工具', '写技能', '新技能', '添加工具', '写个工具', '造工具'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 常量 ====================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 工具根目录 (src/tools/) */
const TOOLS_DIR = path.resolve(__dirname, '..');

/** 工具名称正则：仅允许小写字母、数字、下划线 */
const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{1,30}$/;

/** 禁止创建的名称（框架保留） */
const RESERVED_NAMES = new Set([
    'index', 'types', 'loader', 'executor',
    'create_skill', 'manage_skill', 'tool_log', 'task_status', 'task_cancel', 'task_detail',
]);

// ==================== LLM 客户端 ====================

let codeLlm: LLMClient | null = null;
let codeLlmSignature = '';

function getCodeLlm(): LLMClient {
    const nextSignature = `${config.baseUrl}\n${config.apiKey}\n${config.model}`;
    if (!codeLlm || codeLlmSignature !== nextSignature) {
        codeLlm = new LLMClient(config.baseUrl, config.apiKey, config.model);
        codeLlmSignature = nextSignature;
    }
    return codeLlm;
}

// ==================== Prompt ====================

function buildCodeGenPrompt(toolName: string, description: string): string {
    return `你是一个 TypeScript 工具代码生成器。你需要为一个 QQ 机器人框架（Genesis）生成一个新的工具模块。

## 框架规范

每个工具包含 3 个文件，放在 src/tools/${toolName}/ 目录下：

### 1. schema.ts - Function Calling Schema
\`\`\`typescript
import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: '${toolName}',
    description: '工具描述（LLM 可见，决定何时调用此工具）',
    parameters: {
        type: 'object',
        properties: {
            // 参数定义
            param1: { type: 'string', description: '参数说明' },
        },
        required: ['param1'], // 必填参数
    },
};
\`\`\`

### 2. config.ts - 配置
\`\`\`typescript
export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_${toolName.toUpperCase()}_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_${toolName.toUpperCase()}_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),
    timeoutMs: parseInt(process.env.${toolName.toUpperCase()}_TIMEOUT_MS || '30000', 10),
    concurrency: parseInt(process.env.${toolName.toUpperCase()}_CONCURRENCY || '5', 10),
};
\`\`\`

如果工具需要调用外部 API，添加独立的 API 配置（API Key、Base URL 等），从环境变量读取。
如果工具需要调用 LLM，添加独立的 LLM 配置（baseUrl、apiKey、model），可回退到主 LLM 配置：
\`\`\`typescript
baseUrl: process.env.${toolName.toUpperCase()}_LLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
apiKey: process.env.${toolName.toUpperCase()}_LLM_API_KEY || process.env.LLM_API_KEY || '',
model: process.env.${toolName.toUpperCase()}_LLM_MODEL || 'gemini-2.5-flash-preview',
\`\`\`

### 3. index.ts - 主入口
\`\`\`typescript
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

export const name = '${toolName}';
export const description = '工具描述';
export const keywords = ['关键词1', '关键词2'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 工具逻辑
    return { success: true, text: '执行结果' };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
\`\`\`

## ToolContext 可用字段
- ctx.senderId: number - 发送者 QQ
- ctx.groupId?: number - 群 ID（私聊时 undefined）
- ctx.imageUrls?: string[] - 图片 URL 列表
- ctx.videoPaths?: string[] - 视频路径列表
- ctx.audioPaths?: string[] - 音频路径列表
- ctx.filePaths?: string[] - 文件路径列表
- ctx.atUsers?: number[] - @的用户 ID
- ctx.targetUser?: number - 目标用户 ID
- ctx.senderRole?: 'owner' | 'admin' | 'member'

## ToolResult 返回格式
- success: boolean - 是否成功
- text: string - 响应文本
- segments?: MessageSegment[] - 富媒体消息段（可选）
- files?: Array<{ path: string; name?: string }> - 需要通过 QQ 文件接口上传的本地文件（可选）
- data?: Record<string, unknown> - 附加数据（可选）

## 重要规则
1. 不要使用未约束的顶层类型
2. 所有硬编码值放到 config.ts
3. 外部 API 调用要有 try-catch 错误处理
4. 参数要通过 params 获取，支持多种命名（如 params.xxx ?? params.yyy）
5. 如果需要调用 LLM，在工具内部创建独立的 LLMClient：
   \`\`\`typescript
   import { LLMClient } from '../../llm.js';
   const toolLlm = new LLMClient(config.baseUrl, config.apiKey, config.model);
   \`\`\`
6. 如果需要权限控制，导入 identity 工具：
   \`\`\`typescript
   import { isMaster, getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
   \`\`\`
7. 如果需要日志，导入 logger：
   \`\`\`typescript
   import { log } from '../../logger.js';
   \`\`\`
8. 如果工具需要发送本地图片/音频/视频，先保存到本地，再通过 \`resolveFileForSend()\` 生成可发送路径：
   \`\`\`typescript
   import { resolveFileForSend } from '../../utils/file.js';
   \`\`\`
9. 如果工具生成 docx/html/js/txt/md/xlsx/py 等普通文件，返回 \`files: [{ path: localPath, name: fileName }]\`，不要把文件内容塞进长文本。
10. 默认继承全局 \`FILE_SEND_MODE\`，只有确实需要时才增加工具级发送模式覆盖。
11. 如果新工具和现有工具能力重叠，\`schema.description\` 必须明确边界，避免 LLM 误选；必要时还要同步更新规则路由。

## 你的任务

请为以下工具生成代码：

**工具名称**: ${toolName}
**功能描述**: ${description}

请严格按照以下 JSON 格式输出，不要包含其他内容：

\`\`\`json
{
  "schema": "schema.ts 的完整代码内容",
  "config": "config.ts 的完整代码内容",
  "index": "index.ts 的完整代码内容"
}
\`\`\``;
}

// ==================== 解析 LLM 输出 ====================

interface GeneratedCode {
    schema: string;
    config: string;
    index: string;
}

function parseGeneratedCode(raw: string): GeneratedCode | null {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const data = safeParseRecord(jsonStr);

    if (!data) {
        log.warn('🔧 解析生成代码失败: 输出不是合法 JSON 对象');
        return null;
    }
    if (typeof data.schema !== 'string' || !data.schema) return null;
    if (typeof data.config !== 'string' || !data.config) return null;
    if (typeof data.index !== 'string' || !data.index) return null;

    return {
        schema: data.schema,
        config: data.config,
        index: data.index,
    };
}

// ==================== 文件写入 ====================

function writeToolFiles(toolName: string, code: GeneratedCode): string {
    const toolDir = path.join(TOOLS_DIR, toolName);

    // 创建目录
    if (!fs.existsSync(toolDir)) {
        fs.mkdirSync(toolDir, { recursive: true });
    }

    // 写入文件
    fs.writeFileSync(path.join(toolDir, 'schema.ts'), code.schema, 'utf-8');
    fs.writeFileSync(path.join(toolDir, 'config.ts'), code.config, 'utf-8');
    fs.writeFileSync(path.join(toolDir, 'index.ts'), code.index, 'utf-8');

    return toolDir;
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 1. 权限检查：仅主人可用
    if (!isMaster(ctx.senderId)) {
        return {
            success: false,
            text: '操作失败：只有主人才能创建新技能哦~',
        };
    }

    // 2. 参数提取
    const toolName = (params.name ?? params.toolName ?? params.tool_name) as string | undefined;
    const description = (params.description ?? params.desc ?? params.功能描述) as string | undefined;

    if (!toolName) {
        return { success: false, text: '请提供工具名称（英文小写+下划线，如 dice_roll）' };
    }

    if (!description) {
        return { success: false, text: '请提供工具的功能描述，越详细越好~' };
    }

    // 3. 名称校验
    if (!TOOL_NAME_REGEX.test(toolName)) {
        return {
            success: false,
            text: `工具名称 "${toolName}" 不合法！要求：小写字母开头，仅包含小写字母、数字、下划线，长度 2-31`,
        };
    }

    if (RESERVED_NAMES.has(toolName)) {
        return {
            success: false,
            text: `工具名称 "${toolName}" 是保留名称，不能使用`,
        };
    }

    // 4. 检查是否已存在
    const targetDir = path.join(TOOLS_DIR, toolName);
    if (fs.existsSync(targetDir)) {
        return {
            success: false,
            text: `工具 "${toolName}" 已存在！如需覆盖请先删除旧工具目录`,
        };
    }

    // 5. 使用 LLM 生成代码
    log.info(`🔧 正在为 Bot 生成新技能: ${toolName}`);

    const prompt = buildCodeGenPrompt(toolName, description);

    let rawOutput: string;
    try {
        rawOutput = await getCodeLlm().ask(prompt, undefined, 'create_skill');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`🔧 LLM 代码生成失败: ${errMsg}`);
        return {
            success: false,
            text: `代码生成失败: ${errMsg}`,
        };
    }

    // 6. 解析生成的代码
    const code = parseGeneratedCode(rawOutput);
    if (!code) {
        return {
            success: false,
            text: '代码生成结果解析失败，LLM 返回的格式不正确。请尝试重新描述功能。',
        };
    }

    // 7. 基础校验：确保生成的代码包含必要的导出
    if (!code.index.includes('export const name') || !code.index.includes('export async function execute')) {
        return {
            success: false,
            text: '生成的代码缺少必要的导出（name/execute），请重试。',
        };
    }

    // 8. 写入文件
    try {
        const dir = writeToolFiles(toolName, code);
        log.info(`🔧 新技能已创建: ${toolName} -> ${dir}`);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`🔧 文件写入失败: ${errMsg}`);
        return {
            success: false,
            text: `文件写入失败: ${errMsg}`,
        };
    }

    // 9. 返回成功
    return {
        success: true,
        text: [
            `✅ 新技能 "${toolName}" 已创建成功！`,
            '',
            `📁 路径: src/tools/${toolName}/`,
            `📝 文件: schema.ts, config.ts, index.ts`,
            `🔄 热重载将自动加载新技能`,
            '',
            `💡 功能描述: ${description}`,
        ].join('\n'),
        data: {
            toolName,
            path: `src/tools/${toolName}/`,
        },
    };
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
