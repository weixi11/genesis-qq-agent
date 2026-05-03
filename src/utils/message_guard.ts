import type { FormattedMessage } from '../types.js';

export const ERROR_REPLY_COOLDOWN_MS = 15 * 1000;

export function isBotSelfMessage(msg: FormattedMessage, botId: number): boolean {
    return botId > 0 && msg.sender_id === botId;
}

export function getConversationKey(msg: Pick<FormattedMessage, 'type' | 'group_id' | 'sender_id'>): string {
    if (msg.type === 'group' && msg.group_id) {
        return `group:${msg.group_id}`;
    }

    return `private:${msg.sender_id}`;
}

export function isCooldownActive(
    lastTriggeredAt: number | undefined,
    now: number,
    cooldownMs: number,
): boolean {
    if (typeof lastTriggeredAt !== 'number') {
        return false;
    }

    return now - lastTriggeredAt < cooldownMs;
}
