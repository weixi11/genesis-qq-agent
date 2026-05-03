import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripReasoningChain } from '../../src/utils/reasoning.ts';

test('stripReasoningChain removes tagged reasoning blocks', () => {
    const raw = '<think>先思考</think>\n最终回答：你好';

    assert.equal(stripReasoningChain(raw), '你好');
});

test('stripReasoningChain removes Grok quoted reasoning artifacts from content', () => {
    const raw = `
> 🔍 **Thinking about your request**
> 🔍 **Comparing numbers**
> ***- 9.11 is larger than 9.9 because it has a smaller decimal part.***

> ***- 9.9 is actually larger than 9.11, as 9.9 equals 9.90.***

9.9 比 9.11 大。

**简短说明**：
把 9.9 补成 9.90 后比较
> ***- 9.9 exceeds 9.11 since 9.9 equals 9.90, making it numerically greater.***
，小数点后第一位 9 > 1，因此 9.90 > 9.11（即 9.
> ***- 9.9 is larger than 9.11 because 9.9 equals 9.90, which is greater than 9.11.***
9 > 9.11）。
`;

    assert.equal(
        stripReasoningChain(raw),
        '9.9 比 9.11 大。\n\n**简短说明**：\n把 9.9 补成 9.90 后比较，小数点后第一位 9 > 1，因此 9.90 > 9.11（即 9.9 > 9.11）。',
    );
});

test('stripReasoningChain keeps normal quoted reply content when no reasoning markers exist', () => {
    const raw = '> 这是引用\n这是正常回答';

    assert.equal(stripReasoningChain(raw), '> 这是引用\n这是正常回答');
});
