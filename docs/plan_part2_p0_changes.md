# 架构优化实施方案 — Part 2: P0 条件润色 + 两阶段 FC

## P0-A: 条件润色（修改 `index.ts`）

### 改动位置: `index.ts` 第 574-621 行 (ReAct 路径)

### 新增辅助函数

```typescript
// index.ts 顶部新增
const DATA_TOOLS = new Set(['weather', 'group_members', 'mute_status', 'profile', 'read_file']);

function needsPolish(text: string, toolName: string): boolean {
    // 1. 纯数据工具的输出需要润色
    if (DATA_TOOLS.has(toolName)) return true;
    // 2. 空输出或极短输出不润色
    if (!text || text.length < 10) return false;
    // 3. ReAct 已输出括号文学（动作描述），说明已经拟人化了
    if (/\([^)]+\)/.test(text)) return false;
    // 4. 默认不润色（信任 ReAct）
    return false;
}
```

### 修改 ReAct 处理流程

```typescript
// 替换 index.ts 第 593-610 行
let response = reactResult.text;

// 只对"冰冷数据"类工具结果做润色，信任 ReAct 的自然语言输出
if (config.toolEnhanceResponse && response
    && needsPolish(response, reactResult.tool)) {
    const enhanceResult = await responseEnhancer.enhance({
        message: first,
        history,
        result: {
            toolName: reactResult.tool,
            toolNames: reactResult.toolNames,
            rawText: response,
            params: reactResult.params,
            data: reactResult.data,
            success: reactResult.success,
        },
        emotion,
        taskPlan: { goal: '执行用户请求', needsTool: true, steps: [], confidence: 1 },
    });
    response = enhanceResult.text || response;
}
```

**效果**: 省掉 ~70% 的 Persona 润色调用（大部分情况 ReAct 已经输出了高质量自然语言）。

---

## P0-B: 两阶段 Function Calling

### 步骤 1: 新建 `src/agents/tool_selector.ts`

```typescript
/**
 * 工具选择器（两阶段 FC 的阶段 1）
 *
 * 用极少 token 让 LLM 从工具简介列表中选出相关工具
 * 然后只加载选中工具的完整 Schema 给 ReAct
 */
import { log } from '../logger.js';
import { toolSelectorLlm } from '../llm.js';
import { toolRegistry } from '../services/tool_registry.js';
import { safeParseLLMJson } from '../utils/json.js';
import type { FormattedMessage } from '../types.js';
import type { ToolDefinition } from '../llm.js';

/** 选择结果 */
interface ToolSelectionResult {
    selectedTools: string[];
    schemas: ToolDefinition[];
    isChat: boolean;  // true = 纯闲聊，不需要工具
}

/** 构建工具菜单（极精简，~15 tokens/工具） */
function buildToolMenu(): string {
    const briefs = toolRegistry.getBriefs();
    const lines = briefs.map(b => `- ${b.name}: ${b.description}`);
    lines.push('- none: 不需要工具，纯聊天/闲聊');
    return lines.join('\n');
}

/** 构建选择 Prompt */
function buildSelectionPrompt(msg: FormattedMessage, hasMedia: boolean): string {
    let prompt = `从以下工具中选出处理本次请求需要的（最多3个）。\n`;
    prompt += `只输出 JSON 数组，如 ["vision","draw"] 或 ["none"]。\n\n`;
    prompt += `可用工具:\n${buildToolMenu()}\n\n`;
    prompt += `用户消息: "${msg.text || '(无文本)'}"\n`;
    if (hasMedia) {
        const mediaTags: string[] = [];
        if (msg.images?.length > 0) mediaTags.push(`[含${msg.images.length}张图片]`);
        if (msg.videos?.length > 0) mediaTags.push('[含视频]');
        if (msg.records?.length > 0) mediaTags.push('[含语音]');
        if (msg.files?.length > 0) mediaTags.push('[含文件]');
        prompt += `附件: ${mediaTags.join(' ')}\n`;
    }
    return prompt;
}

/** 执行工具选择 */
export async function selectTools(msg: FormattedMessage): Promise<ToolSelectionResult> {
    const hasMedia = (msg.images?.length > 0) || (msg.videos?.length > 0)
        || (msg.records?.length > 0) || (msg.files?.length > 0);

    const prompt = buildSelectionPrompt(msg, hasMedia);

    try {
        const response = await toolSelectorLlm.ask(
            prompt,
            '你是工具选择器。只输出JSON数组，不要解释。',
            'toolSelector'
        );

        const parsed = safeParseLLMJson<string[]>(response);
        if (!parsed || !Array.isArray(parsed)) {
            log.warn('工具选择器解析失败，回退全量加载');
            return fallbackFullLoad();
        }

        // none = 纯闲聊
        if (parsed.length === 1 && parsed[0] === 'none') {
            return { selectedTools: [], schemas: [], isChat: true };
        }

        // 过滤无效工具名
        const validNames = parsed.filter(n => toolRegistry.isToolEnabled(n));
        if (validNames.length === 0) {
            return { selectedTools: [], schemas: [], isChat: true };
        }

        const schemas = toolRegistry.getSchemasByNames(validNames);
        log.info(`🎯 工具选择: [${validNames.join(', ')}] (${schemas.length} schemas)`);

        return { selectedTools: validNames, schemas, isChat: false };
    } catch (err) {
        log.error('工具选择器异常，回退全量:', err);
        return fallbackFullLoad();
    }
}

/** 回退：加载全部工具 */
function fallbackFullLoad(): ToolSelectionResult {
    return {
        selectedTools: toolRegistry.getEnabledToolNames(),
        schemas: toolRegistry.getSchemas(),
        isChat: false,
    };
}
```

### 步骤 2: `config.ts` 添加配置

```typescript
// Config 接口中添加
toolSelectorLlm: LlmConfig;

// 配置实现
toolSelectorLlm: {
    baseUrl: process.env.TOOL_SELECTOR_LLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.TOOL_SELECTOR_LLM_API_KEY || process.env.LLM_API_KEY || '',
    model: process.env.TOOL_SELECTOR_LLM_MODEL || 'gemini-2.0-flash-lite',  // 用最便宜的模型
},
```

### 步骤 3: `llm.ts` 添加客户端

```typescript
export const toolSelectorLlm = createLlm(config.toolSelectorLlm);
```

### 步骤 4: 修改 `react.ts`

`handle()` 方法签名增加可选的 `schemas` 参数:

```typescript
async handle(
    message: FormattedMessage,
    history: FormattedMessage[],
    emotion: EmotionResult | null,
    filteredSchemas?: ToolDefinition[]  // 新增：预筛选的工具 Schema
): Promise<ToolResult> {
    // ...
    // 第 27 行改为：
    const schemas = filteredSchemas || toolRegistry.getSchemas();
    // 其余逻辑不变
}
```

### 步骤 5: 修改 `index.ts` ReAct 路径

```typescript
// 替换 index.ts 第 575-577 行
if (config.agents.useTrueReAct) {
    log.info(`🧠 [True ReAct] 引擎接管请求`);

    // 阶段 1: 轻量工具选择
    const { selectedTools, schemas, isChat } = await selectTools(first);

    // 纯闲聊 → 直接走 Persona
    if (isChat) {
        const response = await handlePersonaRouter(first, history, emotion);
        await finalizeResponse(first, response, 'Persona(Chat)', decision.priority);
        return;
    }

    // 阶段 2: 只用选中的工具 Schema 调用 ReAct
    const reactResult = await reactAgent.handle(first, history, emotion, schemas);
    // ... 后续逻辑不变
}
```
