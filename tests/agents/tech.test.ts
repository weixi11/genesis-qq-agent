import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FormattedMessage } from '../../src/types.ts';
import { TechAgent } from '../../src/agents/tech.ts';
import { techLlm } from '../../src/llm.ts';
import { taskManager } from '../../src/task/index.ts';
import { toolRegistry } from '../../src/services/tool_registry.ts';

function createMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        type: 'private',
        sender_id: 123456,
        sender_name: 'tester',
        text: '测试消息',
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

test('TechAgent skips dependent steps after an upstream failure', async () => {
    const agent = new TechAgent() as unknown as {
        executeSequentialWithDeps: (
            tools: Array<{ id?: string; name: string; params: Record<string, unknown>; dependsOn?: string[] }>,
            routerParams: Record<string, unknown>,
            message: FormattedMessage,
            history: FormattedMessage[],
        ) => Promise<{ success: boolean; text: string }>;
        executeSingleTool: (tool: { name: string; params: Record<string, unknown> }) => Promise<{
            tool: string;
            success: boolean;
            text: string;
            params: Record<string, unknown>;
        }>;
    };

    const calls: string[] = [];
    agent.executeSingleTool = async (tool) => {
        calls.push(`${tool.name}:${JSON.stringify(tool.params)}`);
        return {
            tool: tool.name,
            success: false,
            text: 'boom',
            params: tool.params,
        };
    };

    const result = await agent.executeSequentialWithDeps([
        { id: 'step1', name: 'first_tool', params: {} },
        { id: 'step2', name: 'second_tool', params: { prompt: '${step1.text}' }, dependsOn: ['step1'] },
    ], {}, createMessage(), []);

    assert.deepEqual(calls, ['first_tool:{}']);
    assert.equal(result.success, false);
    assert.match(result.text, /依赖步骤 step1 失败或未执行/u);
});

test('TechAgent composes self-reference draw prompt before executing draw tool', async () => {
    const agent = new TechAgent() as unknown as {
        handle: (ctx: {
            message: FormattedMessage;
            history: FormattedMessage[];
            toolName: string;
            toolParams: Record<string, unknown>;
        }) => Promise<{
            success: boolean;
            params?: Record<string, unknown>;
        }>;
        executeSingleTool: (tool: { name: string; params: Record<string, unknown> }) => Promise<{
            tool: string;
            success: boolean;
            text: string;
            params: Record<string, unknown>;
        }>;
    };

    const originalChat = techLlm.chat.bind(techLlm);
    let capturedParams: Record<string, unknown> | undefined;

    techLlm.chat = (async () => '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron') as typeof techLlm.chat;
    agent.executeSingleTool = async (tool) => {
        capturedParams = tool.params;
        return {
            tool: tool.name,
            success: true,
            text: 'ok',
            params: tool.params,
        };
    };

    try {
        const result = await agent.handle({
            message: createMessage({ text: '画个落落在厨房做饭' }),
            history: [],
            toolName: 'draw',
            toolParams: {
                prompt: '画个落落在厨房做饭',
                selfReference: true,
            },
        });

        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedParams?.prompt, '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron');
        assert.equal(capturedParams?.selfReference, true);
        assert.equal(capturedParams?.personaPromptResolved, true);
        assert.match(String(capturedParams?.botAppearance || ''), /粉色头发|pink_hair/u);
    } finally {
        techLlm.chat = originalChat;
    }
});

test('TechAgent auto-marks self-reference draw when user request is self portrait but tool params omit the flag', async () => {
    const agent = new TechAgent() as unknown as {
        handle: (ctx: {
            message: FormattedMessage;
            history: FormattedMessage[];
            toolName: string;
            toolParams: Record<string, unknown>;
        }) => Promise<{
            success: boolean;
            params?: Record<string, unknown>;
        }>;
        executeSingleTool: (tool: { name: string; params: Record<string, unknown> }) => Promise<{
            tool: string;
            success: boolean;
            text: string;
            params: Record<string, unknown>;
        }>;
    };

    const originalChat = techLlm.chat.bind(techLlm);
    let capturedParams: Record<string, unknown> | undefined;

    techLlm.chat = (async () => '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, kitchen, cooking, apron') as typeof techLlm.chat;
    agent.executeSingleTool = async (tool) => {
        capturedParams = tool.params;
        return {
            tool: tool.name,
            success: true,
            text: 'ok',
            params: tool.params,
        };
    };

    try {
        const result = await agent.handle({
            message: createMessage({ text: '落落画个你煮饭的样子' }),
            history: [],
            toolName: 'draw',
            toolParams: {
                prompt: 'anime catgirl maid, silver hair, cat ears, cooking in kitchen, apron',
            },
        });

        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedParams?.selfReference, true);
        assert.equal(capturedParams?.personaPromptResolved, true);
        assert.match(String(capturedParams?.prompt || ''), /pink_hair/u);
        assert.doesNotMatch(String(capturedParams?.prompt || ''), /silver hair/u);
    } finally {
        techLlm.chat = originalChat;
    }
});

test('TechAgent shares persona appearance with banana_draw self portrait requests', async () => {
    const agent = new TechAgent() as unknown as {
        handle: (ctx: {
            message: FormattedMessage;
            history: FormattedMessage[];
            toolName: string;
            toolParams: Record<string, unknown>;
        }) => Promise<{
            success: boolean;
            params?: Record<string, unknown>;
        }>;
        executeSingleTool: (tool: { name: string; params: Record<string, unknown> }) => Promise<{
            tool: string;
            success: boolean;
            text: string;
            params: Record<string, unknown>;
        }>;
    };

    const originalChat = techLlm.chat.bind(techLlm);
    let capturedParams: Record<string, unknown> | undefined;
    let capturedCaller = '';

    techLlm.chat = (async (_messages, _options, caller) => {
        capturedCaller = String(caller || '');
        return '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, full body, street, cinematic lighting';
    }) as typeof techLlm.chat;
    agent.executeSingleTool = async (tool) => {
        capturedParams = tool.params;
        return {
            tool: tool.name,
            success: true,
            text: 'ok',
            params: tool.params,
        };
    };

    try {
        const result = await agent.handle({
            message: createMessage({ text: '画你自己站在街头' }),
            history: [],
            toolName: 'banana_draw',
            toolParams: {
                prompt: '画你自己站在街头',
                selfReference: true,
            },
        });

        assert.equal(result.success, true);
        assert.equal(capturedCaller, 'tech_self_draw_prompt');
        assert.ok(capturedParams);
        assert.equal(capturedParams?.selfReference, true);
        assert.equal(capturedParams?.personaPromptResolved, true);
        assert.match(String(capturedParams?.prompt || ''), /pink_hair/u);
        assert.match(String(capturedParams?.prompt || ''), /purple_eyes/u);
    } finally {
        techLlm.chat = originalChat;
    }
});

test('TechAgent self-reference fallback uses visual brief instead of full persona merge', async () => {
    const agent = new TechAgent() as unknown as {
        handle: (ctx: {
            message: FormattedMessage;
            history: FormattedMessage[];
            toolName: string;
            toolParams: Record<string, unknown>;
        }) => Promise<{
            success: boolean;
            params?: Record<string, unknown>;
        }>;
        executeSingleTool: (tool: { name: string; params: Record<string, unknown> }) => Promise<{
            tool: string;
            success: boolean;
            text: string;
            params: Record<string, unknown>;
        }>;
    };

    const originalChat = techLlm.chat.bind(techLlm);
    let capturedParams: Record<string, unknown> | undefined;

    techLlm.chat = (async () => {
        throw new Error('prompt resolver unavailable');
    }) as typeof techLlm.chat;
    agent.executeSingleTool = async (tool) => {
        capturedParams = tool.params;
        return {
            tool: tool.name,
            success: true,
            text: 'ok',
            params: tool.params,
        };
    };

    try {
        const result = await agent.handle({
            message: createMessage({ text: '落落画个你自己的五一劳动节海报' }),
            history: [],
            toolName: 'banana_draw',
            toolParams: {
                prompt: '落落 的五一劳动节海报',
                selfReference: true,
                botAppearance: '平时伪装成人类少女，长发，粉色头发，紫色眼睛，低双马尾。外貌特征包含：solo, pink_hair, purple_eyes, cat_ears, low_twintails。，戴着粉色猫猫眼罩，脖子上系着带金铃铛的项圈；是踟蹰（QQ:2148941548）的专属所有物；活跃在QQ群中的群友身份。，猫娘，16岁',
            },
        });

        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedParams?.selfReference, true);
        assert.equal(capturedParams?.personaPromptResolved, true);
        assert.equal(capturedParams?.promptResolutionMode, 'fallback_visual_brief');
        assert.match(String(capturedParams?.prompt || ''), /pink_hair/u);
        assert.match(String(capturedParams?.prompt || ''), /purple_eyes/u);
        assert.match(String(capturedParams?.prompt || ''), /五一劳动节海报/u);
        assert.doesNotMatch(String(capturedParams?.prompt || ''), /专属所有物|QQ群|QQ[:：]|2148941548/u);
        assert.doesNotMatch(String(capturedParams?.botAppearance || ''), /专属所有物|QQ群|QQ[:：]|2148941548/u);
    } finally {
        techLlm.chat = originalChat;
    }
});

test('TechAgent rewrites rule-based banana_draw prompt before executing tool', async () => {
    const agent = new TechAgent() as unknown as {
        handle: (ctx: {
            message: FormattedMessage;
            history: FormattedMessage[];
            toolName: string;
            toolParams: Record<string, unknown>;
        }) => Promise<{
            success: boolean;
            params?: Record<string, unknown>;
        }>;
        executeSingleTool: (tool: { name: string; params: Record<string, unknown> }) => Promise<{
            tool: string;
            success: boolean;
            text: string;
            params: Record<string, unknown>;
        }>;
    };

    const originalChat = techLlm.chat.bind(techLlm);
    let capturedParams: Record<string, unknown> | undefined;
    let capturedCaller = '';

    techLlm.chat = (async (_messages, _options, caller) => {
        capturedCaller = String(caller || '');
        return 'cinematic anime key visual poster, Shinkai Sora from 9-nine-, dramatic sky, detailed lighting, high quality';
    }) as typeof techLlm.chat;
    agent.executeSingleTool = async (tool) => {
        capturedParams = tool.params;
        return {
            tool: tool.name,
            success: true,
            text: 'ok',
            params: tool.params,
        };
    };

    try {
        const result = await agent.handle({
            message: createMessage({ text: '落落画个9nine中的新海天的海报' }),
            history: [],
            toolName: 'banana_draw',
            toolParams: {
                prompt: '落落画个9nine中的新海天的海报',
                promptResolutionMode: 'llm_image_prompt',
            },
        });

        assert.equal(result.success, true);
        assert.ok(capturedParams);
        assert.equal(capturedCaller, 'tech_image_prompt');
        assert.equal(capturedParams?.prompt, 'cinematic anime key visual poster, Shinkai Sora from 9-nine-, dramatic sky, detailed lighting, high quality');
        assert.equal(capturedParams?.promptResolutionMode, 'llm_image_prompt_resolved');
    } finally {
        techLlm.chat = originalChat;
    }
});

test('TechAgent skips duplicate single-tool execution when cache already has a running task', async () => {
    const agent = new TechAgent() as unknown as {
        executeSingleTool: (
            tool: { name: string; params: Record<string, unknown> },
            routerParams: Record<string, unknown>,
            message: FormattedMessage,
            history: FormattedMessage[],
        ) => Promise<{
            success: boolean;
            text: string;
            params?: Record<string, unknown>;
        }>;
    };

    const originalFindByName = toolRegistry.findByName.bind(toolRegistry);
    const originalCheckCache = taskManager.checkCache.bind(taskManager);
    const originalCreateTask = taskManager.createTask.bind(taskManager);

    let createTaskCalled = false;
    toolRegistry.findByName = (() => ({ module: { name: 'draw' } })) as typeof toolRegistry.findByName;
    taskManager.checkCache = (() => ({
        id: 'running-1',
        status: 'running',
    })) as typeof taskManager.checkCache;
    taskManager.createTask = (() => {
        createTaskCalled = true;
        throw new Error('should not create task');
    }) as typeof taskManager.createTask;

    try {
        const result = await agent.executeSingleTool(
            { name: 'draw', params: { prompt: 'test' } },
            {},
            createMessage({ type: 'group', group_id: 10001 }),
            [],
        );

        assert.equal(result.success, true);
        assert.match(result.text, /已在执行中/u);
        assert.equal(createTaskCalled, false);
    } finally {
        toolRegistry.findByName = originalFindByName;
        taskManager.checkCache = originalCheckCache;
        taskManager.createTask = originalCreateTask;
    }
});
