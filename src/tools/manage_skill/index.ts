/**
 * Manage Skill 模块 - Bot 自己管理/修改已有技能
 *
 * 功能：
 * - list: 列出所有已安装的技能
 * - inspect: 查看指定技能的代码（schema.ts, config.ts, index.ts）
 * - modify: 修改指定技能的代码从而增加新功能
 * - fix: 修复指定技能的 bug
 *
 * 修改和修复功能使用指定的 LLM 进行代码重写。
 * 权限：仅主人可用
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LLMClient } from '../../llm.js';
import { log } from '../../logger.js';
import { isMaster } from '../../utils/identity.js';
import { config } from './config.js';
import { schema } from './schema.js';
import { getAllModules, getModuleByName, reloadModule } from '../../tools/loader.js';
import { toolStats, type ToolUsageParams } from '../../web/store/tool_stats.js';
import { getStringParam, safeJsonStringify, stringifyForDisplay, truncateText } from '../../utils/format.js';
import { safeParseRecord } from '../../utils/json.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'manage_skill';
export const description = '管理已有技能工具：查看代码、结合日志诊断、修改、修复、维护（仅主人可用）';
export const keywords = ['管理工具', '修改工具', '修复工具', '维护工具', '看看代码', '列出工具', '所有技能', '查看工具日志'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 常量 ====================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 工具根目录 (src/tools/) */
const TOOLS_DIR = path.resolve(__dirname, '..');

/** 禁止修改的核心框架文件/基础工具 */
const PROTECTED_TOOLS = new Set([
    'create_skill', 'manage_skill', 'tool_log', 'task_status', 'task_cancel', 'task_detail'
]);

const INSPECT_LOG_LIMIT = 8;
const MAINTAIN_LOG_LIMIT = 12;
const MAX_LOG_RESULT_LENGTH = 220;
const MAX_LOG_PARAMS_LENGTH = 160;

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

// ==================== 辅助函数 ====================

interface ToolFiles {
    schema: string;
    config: string;
    index: string;
}

type ManageAction = 'list' | 'inspect' | 'modify' | 'fix' | 'maintain';

function readToolFiles(toolName: string): ToolFiles | null {
    const dir = path.join(TOOLS_DIR, toolName);
    if (!fs.existsSync(dir)) return null;

    try {
        const schema = fs.readFileSync(path.join(dir, 'schema.ts'), 'utf-8');
        const config = fs.readFileSync(path.join(dir, 'config.ts'), 'utf-8');
        const index = fs.readFileSync(path.join(dir, 'index.ts'), 'utf-8');
        return { schema, config, index };
    } catch {
        return null; // 可能缺少某个文件
    }
}

function writeToolFiles(toolName: string, files: ToolFiles): void {
    const dir = path.join(TOOLS_DIR, toolName);
    fs.writeFileSync(path.join(dir, 'schema.ts'), files.schema, 'utf-8');
    fs.writeFileSync(path.join(dir, 'config.ts'), files.config, 'utf-8');
    fs.writeFileSync(path.join(dir, 'index.ts'), files.index, 'utf-8');
}

function parseGeneratedCode(raw: string): ToolFiles | null {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();
    const data = safeParseRecord(jsonStr);

    if (!data) {
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

function parseAction(params: Record<string, unknown>): ManageAction | null {
    const action = getStringParam(params, 'action');
    if (!action) return null;

    if (action === 'list' || action === 'inspect' || action === 'modify' || action === 'fix' || action === 'maintain') {
        return action;
    }

    return null;
}

function parseToolName(params: Record<string, unknown>): string | undefined {
    return getStringParam(params, 'toolName')
        ?? getStringParam(params, 'tool_name')
        ?? getStringParam(params, 'name');
}

function formatLogRecord(logItem: ToolUsageParams): string {
    const status = logItem.success ? '✅成功' : '❌失败';
    const paramsText = stringifyForDisplay(logItem.params, { maxLen: MAX_LOG_PARAMS_LENGTH });
    const resultText = truncateText(logItem.result || '(空结果)', MAX_LOG_RESULT_LENGTH);
    const timeText = new Date(logItem.time).toLocaleString('zh-CN', { hour12: false });

    return [
        `- ${timeText} | ${status} | ${logItem.duration}ms | ${logItem.user.name || '未知用户'}(${logItem.user.id})`,
        `  params: ${paramsText}`,
        `  result: ${resultText}`,
        logItem.taskId ? `  taskId: ${logItem.taskId}` : undefined,
    ].filter(Boolean).join('\n');
}

function getRecentToolLogs(toolName: string, limit: number): ToolUsageParams[] {
    return toolStats.getLogs()
        .filter(logItem => logItem.name === toolName)
        .slice(0, limit);
}

function listInstalledTools(): ToolResult {
    const modules = getAllModules().sort((left, right) => left.module.name.localeCompare(right.module.name));
    const msg = [
        '🛠️ **已安装技能列表**',
        ...modules.map(m => `- ${m.module.name}: ${m.module.description}`),
        '',
        `共 ${modules.length} 个工具。`,
    ].join('\n');

    return { success: true, text: msg };
}

function inspectTool(toolName: string): ToolResult {
    const files = readToolFiles(toolName);
    if (!files) {
        return { success: false, text: `无法读取 "${toolName}" 的代码文件。` };
    }

    const recentLogs = getRecentToolLogs(toolName, INSPECT_LOG_LIMIT);
    const failedCount = recentLogs.filter(logItem => !logItem.success).length;
    const logSummary = recentLogs.length > 0
        ? recentLogs.map(formatLogRecord).join('\n')
        : '最近没有找到相关工具调用日志。';

    return {
        success: true,
        text: [
            `已读取技能 [${toolName}] 的代码，共 3 个文件（schema, config, index）。`,
            `最近日志: ${recentLogs.length} 条，失败 ${failedCount} 条。`,
            '',
            '📒 最近日志摘要：',
            logSummary,
        ].join('\n'),
        data: {
            files,
            schemaLength: files.schema.length,
            configLength: files.config.length,
            indexLength: files.index.length,
            recentLogs,
        },
    };
}

function buildLogPromptSection(recentLogs: ToolUsageParams[]): string {
    if (recentLogs.length === 0) {
        return '暂无最近工具日志可用。';
    }

    return recentLogs
        .map((logItem, index) => [
            `### 日志 ${index + 1}`,
            `- 时间: ${new Date(logItem.time).toISOString()}`,
            `- 状态: ${logItem.success ? 'success' : 'failed'}`,
            `- 耗时: ${logItem.duration}ms`,
            `- 用户: ${logItem.user.name || '未知用户'} (${logItem.user.id})`,
            `- taskId: ${logItem.taskId || '无'}`,
            `- params: ${safeJsonStringify(logItem.params, 2) || stringifyForDisplay(logItem.params)}`,
            `- result: ${logItem.result || '(空结果)'}`,
        ].join('\n'))
        .join('\n\n');
}

function validateGeneratedFiles(files: ToolFiles): string | null {
    if (!files.index.includes('export const name') || !files.index.includes('export async function execute')) {
        return '生成的代码似乎不完整，缺少必要的导出定义，已取消写入。';
    }
    return null;
}

async function applyToolChanges(
    action: Exclude<ManageAction, 'list' | 'inspect'>,
    toolName: string,
    description: string | undefined,
): Promise<ToolResult> {
    const currentFiles = readToolFiles(toolName);
    if (!currentFiles) {
        return { success: false, text: `无法读取 "${toolName}" 的原始代码，不能修改。` };
    }

    const recentLogs = getRecentToolLogs(toolName, MAINTAIN_LOG_LIMIT);
    const needsDescription = action === 'modify' || action === 'fix';
    if (needsDescription && !description) {
        return { success: false, text: '必须提供修改需求或 bug 描述 (description)！' };
    }

    if (action === 'maintain' && !description && recentLogs.length === 0) {
        return { success: false, text: `工具 [${toolName}] 最近没有可用日志，请至少提供维护目标描述。` };
    }

    log.info(`🔧 正在使用 LLM ${action === 'modify' ? '修改' : '维护'} 工具 [${toolName}]...`);

    let rawOutput: string;
    try {
        const prompt = buildModifyPrompt(toolName, currentFiles, description, action, recentLogs);
        rawOutput = await getCodeLlm().ask(prompt, undefined, `manage_skill_${action}`);
    } catch (err) {
        return { success: false, text: `代码生成报错: ${String(err)}` };
    }

    const newFiles = parseGeneratedCode(rawOutput);
    if (!newFiles) {
        return { success: false, text: '代码解析失败，LLM 输出格式不符合要求。' };
    }

    const validationError = validateGeneratedFiles(newFiles);
    if (validationError) {
        return { success: false, text: validationError };
    }

    try {
        writeToolFiles(toolName, newFiles);
        await reloadModule(toolName);
        log.info(`🔧 工具 [${toolName}] 已完成 ${action} 并尝试热重载。`);
    } catch (err) {
        return { success: false, text: `修改后的代码写入文件系统失败: ${String(err)}` };
    }

    const actionLabel = action === 'modify' ? '修改' : action === 'fix' ? '修复' : '维护';
    return {
        success: true,
        text: [
            `✅ 工具 [${toolName}] 已成功${actionLabel}并保存！`,
            `🔄 已尝试立即热重载生效。`,
            `📒 本次参考日志: ${recentLogs.length} 条。`,
            description ? `📝 需求: ${description}` : '📝 需求: 未提供额外描述，按最近日志做了主动维护。',
        ].join('\n'),
        data: {
            newFiles,
            recentLogs,
        },
    };
}

// ==================== Prompt 构建 ====================

function buildModifyPrompt(
    toolName: string,
    currentFiles: ToolFiles,
    description: string | undefined,
    action: Exclude<ManageAction, 'list' | 'inspect'>,
    recentLogs: ToolUsageParams[],
): string {
    const actionDesc = action === 'modify'
        ? '修改功能'
        : action === 'fix'
            ? '修复 Bug'
            : '维护并修复最近暴露的问题';
    const requestText = description || '未提供额外说明，请根据最近日志主动定位并修复最明显的问题，同时保持工具行为稳定。';

    return `你是一个高级 TypeScript 工程师，需要帮助修改/修复一个现有的 QQ 机器人工具（框架名为 Genesis）。

**当前工具名称**: ${toolName}
**目标操作**: ${actionDesc}
**修改/修复需求**: ${requestText}

### 当前现有代码

#### 1. schema.ts
\`\`\`typescript
${currentFiles.schema}
\`\`\`

#### 2. config.ts
\`\`\`typescript
${currentFiles.config}
\`\`\`

#### 3. index.ts
\`\`\`typescript
${currentFiles.index}
\`\`\`

### 最近工具日志（用于定位问题）
${buildLogPromptSection(recentLogs)}

### 你的任务

请根据修改需求，提供修改后的完整代码。
**要求**：
1. 请提供 3 个文件的完整代码（哪怕某个文件没有改动，也要原样输出完整的）。
2. 不要引入未约束的顶层类型。
3. 如果修改了参数列表，请同步更新 schema.ts。
4. 优先修复日志里暴露出来的问题，避免只做表面改字。
5. 保持代码结构清晰，严格按照要求输出格式。

请输出一个标准的 JSON，格式如下（只输出 JSON，不用废话）：
\`\`\`json
{
  "schema": "schema.ts 的完整代码内容",
  "config": "config.ts 的完整代码内容",
  "index": "index.ts 的完整代码内容"
}
\`\`\``;
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    if (!isMaster(ctx.senderId)) {
        return { success: false, text: '权限不足：只有主人才能管理技能~' };
    }

    const action = parseAction(params);
    if (!action) {
        return { success: false, text: '未知的操作类型，请使用 list / inspect / modify / fix / maintain。' };
    }

    if (action === 'list') {
        return listInstalledTools();
    }

    const toolName = parseToolName(params);
    if (!toolName) {
        return { success: false, text: '执行 inspect / modify / fix / maintain 必须提供工具名称 (toolName)。' };
    }

    const targetTool = getModuleByName(toolName);
    if (!targetTool && !fs.existsSync(path.join(TOOLS_DIR, toolName))) {
        return { success: false, text: `找不到名为 "${toolName}" 的工具！` };
    }

    if (action === 'inspect') {
        return inspectTool(toolName);
    }

    if (PROTECTED_TOOLS.has(toolName)) {
        return { success: false, text: `⚠️ 出于安全原因，不允许通过此工具修改核心工具 [${toolName}]。` };
    }

    if (action === 'modify' || action === 'fix' || action === 'maintain') {
        const description = getStringParam(params, 'description') ?? getStringParam(params, 'desc');
        return applyToolChanges(action, toolName, description);
    }

    return { success: false, text: '未知的操作类型。' };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
