import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { FunctionCallResult, ChatMessage } from '../../src/llm.ts';
import type { FormattedMessage } from '../../src/types.ts';

const originalCwd = process.cwd();
let tempCwd = '';
let closeGenesisDb: (() => void) | undefined;
let stopModuleLoader: (() => void) | undefined;
let closeProfilesDb: (() => void) | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-react-'));
    process.chdir(tempCwd);
    process.env.CRON_SCHEDULER_ALLOWED_TOOLS = 'blog_article';

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;

    const dbModule = await import('../../src/storage/genesis-db.ts');
    await dbModule.initGenesisDb();
    closeGenesisDb = dbModule.closeGenesisDb;

    const toolsModule = await import('../../src/tools/index.ts');
    await toolsModule.initModuleLoader(false);
    stopModuleLoader = toolsModule.stopModuleLoader;
});

after(() => {
    stopModuleLoader?.();
    closeGenesisDb?.();
    closeProfilesDb?.();
    delete process.env.CRON_SCHEDULER_ALLOWED_TOOLS;
    process.chdir(originalCwd);
});

function createMessage(overrides: Partial<FormattedMessage>): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        type: 'group',
        sender_id: 2148941548,
        sender_name: '踟蹰',
        sender_role: 'owner',
        group_id: 1042574135,
        text: '',
        images: [],
        videos: [],
        records: [],
        files: [],
        cards: [],
        mface_urls: [],
        at_users: [],
        at_all: false,
        ...overrides,
    };
}

test('ReAct retries scheduling requests instead of claiming success without cron_scheduler', async () => {
    const reactModule = await import('../../src/agents/react.ts');
    const llmModule = await import('../../src/llm.ts');
    const schedulerStore = await import('../../src/tools/cron_scheduler/store.ts');

    const { reactAgent } = reactModule;
    const { reactLlm } = llmModule;
    const { getAllTasks } = schedulerStore;

    const recordedMessages: ChatMessage[][] = [];
    const originalChatWithTools = reactLlm.chatWithTools.bind(reactLlm);
    const futureRunAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    let callCount = 0;

    const patchedClient = reactLlm as unknown as {
        chatWithTools: typeof reactLlm.chatWithTools;
    };

    patchedClient.chatWithTools = async (messages): Promise<FunctionCallResult> => {
        recordedMessages.push(messages.map((item) => ({ ...item })));
        callCount += 1;

        if (callCount === 1) {
            return {
                type: 'text',
                content: '收到，我这就给你设一个5分钟后自动发布博客的定时任务。',
                message: {
                    role: 'assistant',
                    content: '收到，我这就给你设一个5分钟后自动发布博客的定时任务。',
                },
            };
        }

        if (callCount === 2) {
            assert.ok(
                messages.some((item) =>
                    item.role === 'system'
                    && typeof item.content === 'string'
                    && item.content.includes('当前请求属于“定时/稍后执行”的真实操作'),
                ),
                'second ReAct attempt should include the scheduler guard prompt',
            );

            return {
                type: 'tool_calls',
                toolCalls: [{
                    id: 'call_cron_scheduler_1',
                    name: 'cron_scheduler',
                    arguments: {
                        action: 'create',
                        name: 'auto-blog-post',
                        schedule_type: 'once',
                        run_at: futureRunAt,
                        timezone: 'Asia/Shanghai',
                        tool_name: 'blog_article',
                        tool_params: {
                            action: 'publish',
                            title: '当AI开始“看懂”二次元：从工具到创作伙伴',
                            content: '这是一篇由测试构造的定时发布文章。',
                            category_id: 1,
                            tag_ids: [1],
                        },
                    },
                }],
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_cron_scheduler_1',
                        type: 'function',
                        function: {
                            name: 'cron_scheduler',
                            arguments: JSON.stringify({
                                action: 'create',
                                name: 'auto-blog-post',
                                schedule_type: 'once',
                                run_at: futureRunAt,
                                timezone: 'Asia/Shanghai',
                                tool_name: 'blog_article',
                                tool_params: {
                                    action: 'publish',
                                    title: '当AI开始“看懂”二次元：从工具到创作伙伴',
                                    content: '这是一篇由测试构造的定时发布文章。',
                                    category_id: 1,
                                    tag_ids: [1],
                                },
                            }),
                        },
                    }],
                },
            };
        }

        return {
            type: 'text',
            content: '意图：已创建一个五分钟后自动发布博客的定时任务。',
            message: {
                role: 'assistant',
                content: '意图：已创建一个五分钟后自动发布博客的定时任务。',
            },
        };
    };

    try {
        const currentMessage = createMessage({
            message_id: 2,
            text: '落落你自己看着来发',
        });
        const history = [
            createMessage({
                message_id: 1,
                text: '落落五分钟后发一篇博客',
            }),
        ];

        const result = await reactAgent.handle(currentMessage, history, null);

        assert.equal(callCount, 3);
        assert.deepEqual(result.toolNames, ['cron_scheduler']);
        assert.equal(result.tool, 'cron_scheduler');
        assert.equal(result.text, '意图：已创建一个五分钟后自动发布博客的定时任务。');

        const tasks = getAllTasks();
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.toolName, 'blog_article');
        assert.equal(tasks[0]?.scheduleType, 'once');
        assert.equal(tasks[0]?.name, 'auto-blog-post');
        assert.ok(recordedMessages.length >= 2);
    } finally {
        patchedClient.chatWithTools = originalChatWithTools;
    }
});

test('ReAct resolves self-reference draw prompt before executing draw tool', async () => {
    const reactModule = await import('../../src/agents/react.ts');
    const llmModule = await import('../../src/llm.ts');

    const { reactAgent } = reactModule as unknown as {
        reactAgent: {
            handle: (message: FormattedMessage, history: FormattedMessage[], emotion: null) => Promise<{
                tool: string;
                success: boolean;
                toolNames?: string[];
                toolParams?: Array<{ name: string; params: Record<string, unknown> }>;
            }>;
            executeToolLocally: (toolName: string, params: Record<string, unknown>, message: FormattedMessage) => Promise<{
                success: boolean;
                text: string;
                data?: unknown;
            }>;
        };
    };
    const { reactLlm } = llmModule;

    const originalChatWithTools = reactLlm.chatWithTools.bind(reactLlm);
    const originalChat = reactLlm.chat.bind(reactLlm);
    const agent = reactAgent as unknown as {
        executeToolLocally: typeof reactAgent.executeToolLocally;
        handle: typeof reactAgent.handle;
    };
    const originalExecuteToolLocally = agent.executeToolLocally;
    let capturedParams: Record<string, unknown> | undefined;

    const patchedClient = reactLlm as unknown as {
        chatWithTools: typeof reactLlm.chatWithTools;
        chat: typeof reactLlm.chat;
    };
    let reactTurn = 0;

    patchedClient.chatWithTools = async (_messages): Promise<FunctionCallResult> => {
        reactTurn += 1;

        if (reactTurn === 1) {
            return {
                type: 'tool_calls',
                toolCalls: [{
                    id: 'call_draw_1',
                    name: 'draw',
                    arguments: {
                        prompt: '画个落落在厨房做饭',
                        selfReference: true,
                    },
                }],
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_draw_1',
                        type: 'function',
                        function: {
                            name: 'draw',
                            arguments: JSON.stringify({
                                prompt: '画个落落在厨房做饭',
                                selfReference: true,
                            }),
                        },
                    }],
                },
            };
        }

        return {
            type: 'text',
            content: '意图：已生成落落在厨房做饭的图片。',
            message: {
                role: 'assistant',
                content: '意图：已生成落落在厨房做饭的图片。',
            },
        };
    };
    patchedClient.chat = async () => '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron';
    agent.executeToolLocally = async (_toolName, params) => {
        capturedParams = params;
        return {
            success: true,
            text: '画好了',
            data: {
                prompt: params.prompt,
            },
        };
    };

    try {
        const result = await agent.handle(
            createMessage({
                message_id: 3,
                text: '画个落落在厨房做饭',
            }),
            [],
            null,
        );

        assert.equal(result.tool, 'draw');
        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedParams?.prompt, '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron');
        assert.equal(capturedParams?.selfReference, true);
        assert.equal(capturedParams?.personaPromptResolved, true);
        assert.ok(result.toolParams?.some((item) => item.name === 'draw' && item.params.personaPromptResolved === true));
    } finally {
        patchedClient.chatWithTools = originalChatWithTools;
        patchedClient.chat = originalChat;
        agent.executeToolLocally = originalExecuteToolLocally;
    }
});

test('ReAct auto-marks self-reference draw when tool call omits the flag', async () => {
    const reactModule = await import('../../src/agents/react.ts');
    const llmModule = await import('../../src/llm.ts');

    const { reactAgent } = reactModule as unknown as {
        reactAgent: {
            handle: (message: FormattedMessage, history: FormattedMessage[], emotion: null) => Promise<{
                tool: string;
                success: boolean;
                toolNames?: string[];
                toolParams?: Array<{ name: string; params: Record<string, unknown> }>;
            }>;
            executeToolLocally: (toolName: string, params: Record<string, unknown>, message: FormattedMessage) => Promise<{
                success: boolean;
                text: string;
                data?: unknown;
            }>;
        };
    };
    const { reactLlm } = llmModule;

    const originalChatWithTools = reactLlm.chatWithTools.bind(reactLlm);
    const originalChat = reactLlm.chat.bind(reactLlm);
    const agent = reactAgent as unknown as {
        executeToolLocally: typeof reactAgent.executeToolLocally;
        handle: typeof reactAgent.handle;
    };
    const originalExecuteToolLocally = agent.executeToolLocally;
    let capturedParams: Record<string, unknown> | undefined;

    const patchedClient = reactLlm as unknown as {
        chatWithTools: typeof reactLlm.chatWithTools;
        chat: typeof reactLlm.chat;
    };
    let reactTurn = 0;

    patchedClient.chatWithTools = async (): Promise<FunctionCallResult> => {
        reactTurn += 1;

        if (reactTurn === 1) {
            return {
                type: 'tool_calls',
                toolCalls: [{
                    id: 'call_draw_2',
                    name: 'draw',
                    arguments: {
                        prompt: 'anime catgirl maid, silver hair, cat ears, cooking in kitchen, apron',
                        seed: 'react_log_case_1',
                    },
                }],
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_draw_2',
                        type: 'function',
                        function: {
                            name: 'draw',
                            arguments: JSON.stringify({
                                prompt: 'anime catgirl maid, silver hair, cat ears, cooking in kitchen, apron',
                                seed: 'react_log_case_1',
                            }),
                        },
                    }],
                },
            };
        }

        return {
            type: 'text',
            content: '意图：已生成落落在厨房做饭的图片。',
            message: {
                role: 'assistant',
                content: '意图：已生成落落在厨房做饭的图片。',
            },
        };
    };
    patchedClient.chat = async () => '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron';
    agent.executeToolLocally = async (_toolName, params) => {
        capturedParams = params;
        return {
            success: true,
            text: '画好了',
            data: {
                prompt: params.prompt,
            },
        };
    };

    try {
        const result = await agent.handle(
            createMessage({
                message_id: 4,
                text: '落落画个你煮饭的样子',
            }),
            [],
            null,
        );

        assert.equal(result.tool, 'draw');
        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedParams?.selfReference, true);
        assert.equal(capturedParams?.detectedSelfReference, true);
        assert.equal(capturedParams?.selfReferenceSource, 'user_text');
        assert.equal(capturedParams?.personaPromptResolved, true);
        assert.match(String(capturedParams?.promptResolutionMode || ''), /llm_/u);
        assert.match(String(capturedParams?.prompt || ''), /pink_hair/u);
        assert.doesNotMatch(String(capturedParams?.prompt || ''), /silver hair/u);
        assert.ok(result.toolParams?.some((item) => item.name === 'draw' && item.params.selfReference === true));
    } finally {
        patchedClient.chatWithTools = originalChatWithTools;
        patchedClient.chat = originalChat;
        agent.executeToolLocally = originalExecuteToolLocally;
    }
});

test('ReAct keeps persona-inspired draw out of strict self-reference params', async () => {
    const reactModule = await import('../../src/agents/react.ts');
    const llmModule = await import('../../src/llm.ts');

    const { reactAgent } = reactModule as unknown as {
        reactAgent: {
            handle: (message: FormattedMessage, history: FormattedMessage[], emotion: null) => Promise<{
                tool: string;
                success: boolean;
            }>;
            executeToolLocally: (toolName: string, params: Record<string, unknown>, message: FormattedMessage) => Promise<{
                success: boolean;
                text: string;
                data?: unknown;
            }>;
        };
    };
    const { reactLlm } = llmModule;

    const originalChatWithTools = reactLlm.chatWithTools.bind(reactLlm);
    const agent = reactAgent as unknown as {
        executeToolLocally: typeof reactAgent.executeToolLocally;
        handle: typeof reactAgent.handle;
    };
    const originalExecuteToolLocally = agent.executeToolLocally;
    let capturedParams: Record<string, unknown> | undefined;

    const patchedClient = reactLlm as unknown as {
        chatWithTools: typeof reactLlm.chatWithTools;
    };
    let reactTurn = 0;
    patchedClient.chatWithTools = async (): Promise<FunctionCallResult> => {
        reactTurn += 1;
        if (reactTurn === 1) {
            return {
                type: 'tool_calls',
                toolCalls: [{
                    id: 'call_draw_log_2',
                    name: 'draw',
                    arguments: {
                        prompt: '画一个像落落一样的猫娘在街头',
                        seed: 'react_log_case_2',
                    },
                }],
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_draw_log_2',
                        type: 'function',
                        function: {
                            name: 'draw',
                            arguments: JSON.stringify({
                                prompt: '画一个像落落一样的猫娘在街头',
                                seed: 'react_log_case_2',
                            }),
                        },
                    }],
                },
            };
        }

        return {
            type: 'text',
            content: '意图：已生成一张参考落落风格的猫娘图片。',
            message: {
                role: 'assistant',
                content: '意图：已生成一张参考落落风格的猫娘图片。',
            },
        };
    };
    agent.executeToolLocally = async (_toolName, params) => {
        capturedParams = params;
        return {
            success: true,
            text: '画好了',
            data: {
                prompt: params.prompt,
            },
        };
    };

    try {
        const result = await reactAgent.handle(
            createMessage({
                message_id: 6,
                text: '画一个像落落一样的猫娘在街头',
            }),
            [],
            null,
        );

        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedParams?.selfReference, undefined);
        assert.equal(capturedParams?.detectedSelfReference, undefined);
        assert.equal(capturedParams?.selfReferenceSource, undefined);
    } finally {
        patchedClient.chatWithTools = originalChatWithTools;
        agent.executeToolLocally = originalExecuteToolLocally;
    }
});
