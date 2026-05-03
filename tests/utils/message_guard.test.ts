import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ERROR_REPLY_COOLDOWN_MS,
    getConversationKey,
    isBotSelfMessage,
    isCooldownActive,
} from '../../src/utils/message_guard.ts';

test('Bot self messages are identified by sender id and bot id', () => {
    const botMessage = {
        type: 'group',
        group_id: 626015875,
        sender_id: 2086702098,
    } as const;

    assert.equal(isBotSelfMessage(botMessage, 2086702098), true);
    assert.equal(isBotSelfMessage(botMessage, 0), false);
    assert.equal(isBotSelfMessage(botMessage, 114514), false);
});

test('Conversation keys are stable across group and private sessions', () => {
    assert.equal(
        getConversationKey({ type: 'group', group_id: 626015875, sender_id: 123 }),
        'group:626015875',
    );
    assert.equal(
        getConversationKey({ type: 'private', sender_id: 456 }),
        'private:456',
    );
});

test('Error fallback cooldown blocks repeated triggers inside the window', () => {
    const now = Date.now();

    assert.equal(isCooldownActive(undefined, now, ERROR_REPLY_COOLDOWN_MS), false);
    assert.equal(isCooldownActive(now - 1000, now, ERROR_REPLY_COOLDOWN_MS), true);
    assert.equal(
        isCooldownActive(now - ERROR_REPLY_COOLDOWN_MS, now, ERROR_REPLY_COOLDOWN_MS),
        false,
    );
});
