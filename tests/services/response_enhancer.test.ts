import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toEnhanceableResult } from '../../src/services/response_enhancer.ts';
import type { ToolResult } from '../../src/agents/tech.ts';

test('toEnhanceableResult preserves tool success state', () => {
    const toolResult: ToolResult = {
        tool: 'search_web',
        success: false,
        text: '工具调用失败',
        params: { query: 'Genesis' },
    };

    const enhanced = toEnhanceableResult(toolResult);

    assert.equal(enhanced.success, false);
    assert.equal(enhanced.rawText, '工具调用失败');
});

test('toEnhanceableResult marks media segments for tool replies', () => {
    const toolResult: ToolResult = {
        tool: 'draw',
        success: true,
        text: '🎨 画好啦喵~',
        params: { prompt: 'cat girl' },
        segments: [{ type: 'image', file: '/tmp/draw.png' }],
    };

    const enhanced = toEnhanceableResult(toolResult);

    assert.equal(enhanced.hasSegments, true);
});
