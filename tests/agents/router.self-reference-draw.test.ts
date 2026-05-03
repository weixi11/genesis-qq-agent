import assert from 'node:assert/strict';
import { test } from 'node:test';

import { router } from '../../src/agents/router.ts';
import { config } from '../../src/config.ts';
import { routerLlm } from '../../src/llm.ts';
import { toolRegistry } from '../../src/services/tool_registry.ts';
import { config as bananaDrawConfig } from '../../src/tools/banana_draw/config.ts';
import type { FormattedMessage } from '../../src/types.ts';

function createMessage(text: string, overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleTimeString('zh-CN'),
        type: 'group',
        self_id: 424242,
        summary: '',
        sender_id: 10001,
        sender_name: '测试',
        sender_role: 'member',
        group_id: 20001,
        group_name: '测试群',
        text,
        images: [],
        videos: [],
        records: [],
        at_users: [424242],
        at_all: false,
        files: [],
        cards: [],
        mface_urls: [],
        ...overrides,
    };
}

test('router rule-based draw plan marks selfReference for self portrait requests', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'draw' || originalIsToolEnabled(toolName)) as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('画你自己，站在街头'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'draw');
        assert.equal(result.plan.steps[0]?.params?.selfReference, true);
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router rule-based draw plan does not mark selfReference for persona-inspired requests', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'draw' || originalIsToolEnabled(toolName)) as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('画一个像落落一样的猫娘在街头'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'draw');
        assert.equal(result.plan.steps[0]?.params?.selfReference, undefined);
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router high-confidence rule plan short-circuits router llm', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    const originalAsk = routerLlm.ask.bind(routerLlm);

    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = true;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'weather' || originalIsToolEnabled(toolName)) as typeof toolRegistry.isToolEnabled;

    let askCalled = false;
    routerLlm.ask = (async () => {
        askCalled = true;
        throw new Error('router llm should be skipped for high-confidence rule plan');
    }) as typeof routerLlm.ask;

    try {
        const result = await router.plan({
            message: createMessage('查一下北京天气'),
            history: [],
            emotion: null,
        });

        assert.equal(askCalled, false);
        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'weather');
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
        routerLlm.ask = originalAsk;
    }
});

test('router rule-based banana plan routes figurine requests to banana_draw', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'banana_draw' || originalIsToolEnabled(toolName)) as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('把这张图手办化'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'banana_draw');
        assert.equal(result.plan.steps[0]?.params?.mode, 'figurine');
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router routes explicit banana text-to-image requests to banana_draw', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'banana_draw' || originalIsToolEnabled(toolName)) as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('用banana画一只站在月球上的猫'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'banana_draw');
        assert.equal(result.plan.steps[0]?.params?.mode, undefined);
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router can prefer banana_draw for normal text-to-image when configured', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    bananaDrawConfig.preferForTextToImage = true;
    toolRegistry.isToolEnabled = ((toolName: string) => (toolName === 'banana_draw' || toolName === 'draw') || originalIsToolEnabled(toolName)) as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('画一只站在月球上的猫'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'banana_draw');
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        bananaDrawConfig.preferForTextToImage = previousPrefer;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router falls back to banana_draw for normal draw requests when draw is disabled', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    bananaDrawConfig.preferForTextToImage = false;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'banana_draw') as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('画一只站在月球上的猫'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'banana_draw');
        assert.equal(result.plan.reasoning, '规则匹配: draw 已关闭，使用 Banana 绘图兜底');
        assert.equal(result.plan.steps[0]?.params?.promptResolutionMode, 'llm_image_prompt');
        assert.equal(result.plan.executionMode, 'fast');
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        bananaDrawConfig.preferForTextToImage = previousPrefer;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router marks banana_draw fallback as selfReference for self portrait requests', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = false;
    bananaDrawConfig.preferForTextToImage = false;
    toolRegistry.isToolEnabled = ((toolName: string) => toolName === 'banana_draw') as typeof toolRegistry.isToolEnabled;

    try {
        const result = await router.plan({
            message: createMessage('画你自己站在街头'),
            history: [],
            emotion: null,
        });

        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps[0]?.tool, 'banana_draw');
        assert.equal(result.plan.steps[0]?.params?.selfReference, true);
        assert.equal(result.plan.steps[0]?.params?.prompt, '画你自己站在街头');
        assert.match(result.plan.reasoning, /自引用绘图请求/u);
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        bananaDrawConfig.preferForTextToImage = previousPrefer;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
    }
});

test('router uses mentioned user avatar as banana_draw reference after vision check', async () => {
    const previousRule = config.agents.routerRuleMatchEnabled;
    const previousLlm = config.agents.routerLlmEnabled;
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    const originalIsToolEnabled = toolRegistry.isToolEnabled.bind(toolRegistry);
    const originalAsk = routerLlm.ask.bind(routerLlm);

    config.agents.routerRuleMatchEnabled = true;
    config.agents.routerLlmEnabled = true;
    bananaDrawConfig.preferForTextToImage = false;
    toolRegistry.isToolEnabled = ((toolName: string) => (
        toolName === 'banana_draw'
        || toolName === 'avatar'
        || toolName === 'vision'
    )) as typeof toolRegistry.isToolEnabled;

    let askCalled = false;
    routerLlm.ask = (async () => {
        askCalled = true;
        throw new Error('router llm should be skipped for mentioned avatar draw plan');
    }) as typeof routerLlm.ask;

    try {
        const result = await router.plan({
            message: createMessage('画一下 @小明 在海边看日落', {
                at_users: [424242, 30001],
            }),
            history: [],
            emotion: null,
        });

        assert.equal(askCalled, false);
        assert.equal(result.target, 'tech');
        assert.equal(result.plan.steps.length, 3);
        assert.equal(result.plan.steps[0]?.tool, 'avatar');
        assert.deepEqual(result.plan.steps[0]?.params, { targetId: '30001', action: 'describe' });
        assert.equal(result.plan.steps[1]?.tool, 'vision');
        assert.equal(result.plan.steps[1]?.params?.imageUrl, '${step1.data.avatarUrl}');
        assert.deepEqual(result.plan.steps[1]?.dependsOn, ['step1']);
        assert.equal(result.plan.steps[2]?.tool, 'banana_draw');
        assert.equal(result.plan.steps[2]?.params?.imageUrl, '${step1.data.avatarUrl}');
        assert.equal(result.plan.steps[2]?.params?.preserveIdentity, false);
        assert.match(String(result.plan.steps[2]?.params?.prompt || ''), /do not invent it as the user's face/u);
        assert.deepEqual(result.plan.steps[2]?.dependsOn, ['step1', 'step2']);
        assert.equal(result.plan.steps[2]?.params?.promptResolutionMode, 'llm_image_prompt');
        assert.equal(result.plan.executionMode, 'fast');
        assert.match(result.plan.reasoning || '', /头像参考绘图/u);
    } finally {
        config.agents.routerRuleMatchEnabled = previousRule;
        config.agents.routerLlmEnabled = previousLlm;
        bananaDrawConfig.preferForTextToImage = previousPrefer;
        toolRegistry.isToolEnabled = originalIsToolEnabled;
        routerLlm.ask = originalAsk;
    }
});
