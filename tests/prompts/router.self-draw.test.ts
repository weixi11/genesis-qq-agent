import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRouterUserPrompt } from '../../src/prompts/router.ts';

test('buildRouterUserPrompt includes self draw persona context when provided', () => {
    const prompt = buildRouterUserPrompt({
        messageText: '画个落落在厨房做饭',
        senderId: 10001,
        senderName: '阿祈',
        atIds: [],
        selfDrawContext: {
            botName: '落落',
            appearance: '平时伪装成人类少女，粉色头发，紫色眼睛，低双马尾，cat_ears, pink_hair, purple_eyes',
        },
    });

    assert.match(prompt, /机器人自画像参考/);
    assert.match(prompt, /角色名: 落落/);
    assert.match(prompt, /pink_hair/);
    assert.match(prompt, /personaPromptResolved: true/);
    assert.match(prompt, /最终英文绘图提示词/);
});
