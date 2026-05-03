/**
 * LLM 客户端 (OpenAI 兼容格式)
 */

import { config } from './config.js';
import { log } from './logger.js';
import { isRecord, safeParseJson } from './utils/json.js';
import { llmStats } from './web/store/llm_stats.js';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: Array<{
        id: string;
        type?: 'function';
        function?: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
}

export interface ChatCompletionOptions {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
}

/** 工具定义（用于 Function Calling） */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

/** 工具调用结果 */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** Function Calling 返回结果 */
export type FunctionCallResult =
    | { type: 'tool_calls'; toolCalls: ToolCall[]; message: ChatMessage }
    | { type: 'text'; content: string; message: ChatMessage };

/** OpenAI 响应接口 */
interface OpenAIChatCompletion {
    choices: Array<{
        message: {
            content: string | Array<Record<string, unknown> | string> | null;
            reasoning_content?: string | Array<Record<string, unknown> | string> | null;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
        finish_reason?: string | null;
        native_finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

function parseToolArguments(rawArguments: string | undefined, toolName: string): Record<string, unknown> {
    if (!rawArguments) {
        return {};
    }

    const parsed = safeParseJson(rawArguments);
    if (!parsed) {
        log.warn(`工具参数解析失败，已回退为空对象: ${toolName}`);
        return {};
    }
    if (!isRecord(parsed)) {
        log.warn(`工具参数不是对象，已回退为空对象: ${toolName}`);
        return {};
    }
    return parsed;
}

function extractTextContent(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (!Array.isArray(value)) {
        return '';
    }

    return value
        .map((part) => {
            if (typeof part === 'string') {
                return part;
            }
            if (!part || typeof part !== 'object') {
                return '';
            }

            const record = part as Record<string, unknown>;
            if (typeof record.text === 'string') {
                return record.text;
            }
            if (typeof record.content === 'string') {
                return record.content;
            }
            if (typeof record.reasoning_content === 'string') {
                return record.reasoning_content;
            }
            return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function buildEmptyAssistantMessageError(
    model: string,
    message: OpenAIChatCompletion['choices'][number]['message'] | undefined,
    finishReason: string | null | undefined,
): Error {
    const messageKeys = message ? Object.keys(message).join(',') : 'none';
    const hasToolCalls = !!message?.tool_calls?.length;
    return new Error(
        `LLM 返回空 assistant message: model=${model}, finish_reason=${finishReason || 'unknown'}, message_keys=${messageKeys}, tool_calls=${hasToolCalls}`,
    );
}

export class LLMClient {
    private baseUrl!: string;
    private apiKey!: string;
    private defaultModel!: string;

    constructor(
        baseUrl: string = config.llm.baseUrl,
        apiKey: string = config.llm.apiKey,
        defaultModel: string = config.llm.model
    ) {
        this.setConfig(baseUrl, apiKey, defaultModel);
    }

    /** 运行时更新配置（用于 Web 热更新） */
    setConfig(baseUrl: string, apiKey: string, defaultModel: string): void {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;
        this.defaultModel = defaultModel;
    }

    /** 发送聊天请求 */
    async chat(
        messages: ChatMessage[],
        options: ChatCompletionOptions = {},
        caller: string = 'unknown'
    ): Promise<string> {
        const model = options.model || this.defaultModel;
        const url = `${this.baseUrl}/chat/completions`;
        const startTime = Date.now();
        const temperature = options.temperature ?? 0.7;
        const max_tokens = options.max_tokens ?? 2048;

        log.debug(`LLM 请求: model=${model}, messages=${messages.length}`);

        const requestPayload = {
            model,
            messages: messages as Array<{ role: string; content: unknown }>,
            temperature,
            max_tokens,
            stream: false,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(requestPayload),
            });

            if (!response.ok) {
                const text = await response.text();
                const error = `LLM API error: ${response.status} ${text}`;
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: { content: '' },
                    duration: Date.now() - startTime,
                    success: false,
                    error,
                });
                throw new Error(error);
            }

            const data = await response.json() as unknown as OpenAIChatCompletion;
            const choice = data.choices?.[0];
            const message = choice?.message;
            const content = extractTextContent(message?.content);
            const thinking = extractTextContent(message?.reasoning_content);
            const responseText = content || thinking;

            if (!content && !thinking && !message?.tool_calls?.length) {
                throw buildEmptyAssistantMessageError(model, message, choice?.finish_reason);
            }

            // 记录到 llmStats
            llmStats.add({
                time: Date.now(),
                caller,
                model,
                request: requestPayload,
                response: {
                    content,
                    thinking: thinking || undefined,
                    input_tokens: data.usage?.prompt_tokens,
                    output_tokens: data.usage?.completion_tokens,
                },
                duration: Date.now() - startTime,
                success: true,
            });

            log.debug(`LLM 响应: ${responseText.slice(0, 100)}...`);
            return responseText;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (!errorMsg.startsWith('LLM API error:')) {
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: { content: '' },
                    duration: Date.now() - startTime,
                    success: false,
                    error: errorMsg,
                });
            }
            log.error('LLM 请求失败:', err);
            throw err;
        }
    }

    /** 简单对话（单轮） */
    async ask(prompt: string, systemPrompt?: string, caller: string = 'unknown'): Promise<string> {
        const messages: ChatMessage[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        return this.chat(messages, {}, caller);
    }

    /** 
     * 带工具的对话（Function Calling）
     * 返回工具调用列表或文本响应
     */
    async chatWithTools(
        messages: ChatMessage[],
        tools: ToolDefinition[],
        options: ChatCompletionOptions = {},
        caller: string = 'unknown'
    ): Promise<FunctionCallResult> {
        const model = options.model || this.defaultModel;
        const url = `${this.baseUrl}/chat/completions`;
        const startTime = Date.now();
        const temperature = options.temperature ?? 0.3;
        const max_tokens = options.max_tokens ?? 2048;

        log.debug(`LLM Function Calling: model=${model}, tools=${tools.length}, caller=${caller}`);

        const toolsPayload = tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            }
        }));

        const requestPayload = {
            model,
            messages: messages as Array<{ role: string; content: unknown }>,
            temperature,
            max_tokens,
            tools: toolsPayload,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    ...requestPayload,
                    tool_choice: 'auto',
                }),
            });

            if (!response.ok) {
                const text = await response.text();
                const error = `LLM API error: ${response.status} ${text}`;
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: { content: '' },
                    duration: Date.now() - startTime,
                    success: false,
                    error,
                });
                throw new Error(error);
            }

            const data = await response.json() as unknown as OpenAIChatCompletion;
            const choice = data.choices?.[0];
            const message = choice?.message;
            const content = extractTextContent(message?.content);
            const thinking = extractTextContent(message?.reasoning_content);
            const responseText = content || thinking;

            // 检查是否有工具调用
            if (message?.tool_calls && message.tool_calls.length > 0) {
                const toolCalls = message.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
                    id: tc.id,
                    name: tc.function?.name || '',
                    arguments: parseToolArguments(tc.function?.arguments, tc.function?.name || 'unknown'),
                }));

                // 记录到 llmStats
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: {
                        content,
                        thinking: thinking || undefined,
                        input_tokens: data.usage?.prompt_tokens,
                        output_tokens: data.usage?.completion_tokens,
                        tool_calls: toolCalls,
                    },
                    duration: Date.now() - startTime,
                    success: true,
                });

                log.debug(`LLM 返回工具调用: ${toolCalls.map((t) => t.name).join(', ')}`);
                return {
                    type: 'tool_calls',
                    toolCalls,
                    message: {
                        role: 'assistant',
                        content: content || null,
                        tool_calls: message.tool_calls
                    }
                };
            }

            // 普通文本响应
            if (!content && !thinking) {
                throw buildEmptyAssistantMessageError(model, message, choice?.finish_reason);
            }

            llmStats.add({
                time: Date.now(),
                caller,
                model,
                request: requestPayload,
                response: {
                    content,
                    thinking: thinking || undefined,
                    input_tokens: data.usage?.prompt_tokens,
                    output_tokens: data.usage?.completion_tokens,
                },
                duration: Date.now() - startTime,
                success: true,
            });

            log.debug(`LLM 返回文本: ${responseText.slice(0, 100)}...`);
            return {
                type: 'text',
                content: responseText,
                message: {
                    role: 'assistant',
                    content: responseText
                }
            };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (!errorMsg.startsWith('LLM API error:')) {
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: { content: '' },
                    duration: Date.now() - startTime,
                    success: false,
                    error: errorMsg,
                });
            }
            log.error('LLM Function Calling 失败:', err);
            throw err;
        }
    }

    /** 多模态识图对话（支持多张图片） */
    async chatWithImages(imageSources: string[], prompt: string, systemPrompt?: string, caller: string = 'unknown'): Promise<string> {
        const model = this.defaultModel;
        const url = `${this.baseUrl}/chat/completions`;
        const startTime = Date.now();

        log.debug(`LLM 识图请求: model=${model}, 图片数量=${imageSources.length}`);

        // 处理所有图片：本地路径需要转换为 base64 data URI
        const processImage = async (imageSource: string): Promise<string> => {
            if (!imageSource || imageSource.startsWith('http') || imageSource.startsWith('data:')) {
                return imageSource;
            }
            try {
                const fs = await import('fs');
                const path = await import('path');

                if (fs.existsSync(imageSource)) {
                    const imageData = fs.readFileSync(imageSource);
                    const ext = path.extname(imageSource).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png'
                        : ext === '.gif' ? 'image/gif'
                            : ext === '.webp' ? 'image/webp'
                                : 'image/jpeg';
                    log.debug(`图片已转换为 base64 (${Math.round(imageData.length / 1024)}KB)`);
                    return `data:${mimeType};base64,${imageData.toString('base64')}`;
                }
            } catch (err) {
                log.warn('无法读取本地图片:', err);
            }
            return imageSource;
        };

        const imageUrls = await Promise.all(imageSources.map(processImage));

        const messages: Array<{ role: string; content: unknown }> = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        // 构建包含多张图片的消息（为 log 记录简化，不包含完整 base64）
        const contentForLog: Array<{ type: string; text?: string; image_url?: string }> = [{ type: 'text', text: prompt }];
        for (let i = 0; i < imageUrls.length; i++) {
            if (imageUrls[i]) {
                contentForLog.push({ type: 'image_url', image_url: imageUrls[i].startsWith('data:') ? `[base64 image ${i + 1}]` : imageUrls[i] });
            }
        }

        // 构建实际请求的 content
        const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
        for (const imageUrl of imageUrls) {
            if (imageUrl) {
                content.push({ type: 'image_url', image_url: { url: imageUrl } });
            }
        }
        messages.push({ role: 'user', content });

        const requestPayload = {
            model,
            messages: messages.map((m, idx) => idx === messages.length - 1 ? { role: m.role, content: contentForLog } : m),
            max_tokens: 4096,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages,
                    max_tokens: 4096, // 多图需要更多 token
                }),
            });

            if (!response.ok) {
                const text = await response.text();
                const error = `LLM Vision API error: ${response.status} ${text}`;
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: { content: '' },
                    duration: Date.now() - startTime,
                    success: false,
                    error,
                });
                throw new Error(error);
            }

            const data = await response.json() as unknown as OpenAIChatCompletion;
            const choice = data.choices?.[0];
            const responseContent = extractTextContent(choice?.message?.content);
            const thinking = extractTextContent(choice?.message?.reasoning_content);
            const responseText = responseContent || thinking;

            if (!responseText) {
                throw buildEmptyAssistantMessageError(model, choice?.message, choice?.finish_reason);
            }

            // 记录到 llmStats
            llmStats.add({
                time: Date.now(),
                caller,
                model,
                request: requestPayload,
                response: {
                    content: responseContent,
                    thinking: thinking || undefined,
                    input_tokens: data.usage?.prompt_tokens,
                    output_tokens: data.usage?.completion_tokens,
                },
                duration: Date.now() - startTime,
                success: true,
            });

            log.debug(`LLM 识图响应: ${responseText.slice(0, 100)}...`);
            return responseText;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (!errorMsg.startsWith('LLM Vision API error:')) {
                llmStats.add({
                    time: Date.now(),
                    caller,
                    model,
                    request: requestPayload,
                    response: { content: '' },
                    duration: Date.now() - startTime,
                    success: false,
                    error: errorMsg,
                });
            }
            log.error('LLM 识图请求失败:', err);
            throw err;
        }
    }

    /** 单图识图（兼容旧接口） */
    async chatWithImage(imageSource: string, prompt: string, systemPrompt?: string, caller: string = 'unknown'): Promise<string> {
        return this.chatWithImages([imageSource], prompt, systemPrompt, caller);
    }
}

// 全局单例
/** 主 LLM 客户端（用于生成回复） */
/**
 * 创建 LLM 客户端的工厂函数
 */
function createLlm(cfg: typeof config.llm): LLMClient {
    return new LLMClient(cfg.baseUrl, cfg.apiKey, cfg.model);
}

function syncLlmClient(client: LLMClient, cfg: typeof config.llm): void {
    client.setConfig(cfg.baseUrl, cfg.apiKey, cfg.model);
}

/** 主 LLM 客户端（用于生成回复） */
export const llm = createLlm(config.llm);

/** 哨兵 LLM 客户端（用于是否响应判断） */
export const sentryLlm = createLlm(config.sentryLlm);

/** Router LLM 客户端（用于意图识别） */
export const routerLlm = createLlm(config.routerLlm);

/** Profiler LLM 客户端（用于用户画像分析） */
export const profilerLlm = createLlm(config.profilerLlm);

/** Persona LLM 客户端（用于闲聊对话） */
export const personaLlm = createLlm(config.personaLlm);

/** Tech LLM 客户端（用于工具调用） */
export const techLlm = createLlm(config.techLlm);

/** ReAct LLM 客户端（用于多轮思考与工具调用） */
export const reactLlm = createLlm(config.reactLlm);

/** Auto Meme LLM 客户端（用于自动表情包决策） */
export const autoMemeLlm = createLlm(config.autoMemeLlm);

/** 运行时刷新全局 LLM 客户端 */
export function refreshRuntimeLlmClients(): void {
    syncLlmClient(llm, config.llm);
    syncLlmClient(sentryLlm, config.sentryLlm);
    syncLlmClient(routerLlm, config.routerLlm);
    syncLlmClient(profilerLlm, config.profilerLlm);
    syncLlmClient(personaLlm, config.personaLlm);
    syncLlmClient(techLlm, config.techLlm);
    syncLlmClient(reactLlm, config.reactLlm);
    syncLlmClient(autoMemeLlm, config.autoMemeLlm);
}

// 兼容别名
export const agentLlm = sentryLlm;

// ============ 工具专用 LLM 已迁移到各工具内部 ============
// visionLlm -> vision.ts 内部
// audioLlm -> read_audio.ts 内部
// videoLlm -> read_video.ts 内部
// fileLlm -> read_file.ts 内部
// drawLlm -> draw.ts 内部
