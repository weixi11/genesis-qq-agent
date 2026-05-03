import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { connector } from '../../src/connector.ts';
import { config as globalConfig } from '../../src/config.ts';
import { config as muteConfig } from '../../src/tools/mute/config.ts';
import { execute } from '../../src/tools/mute/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const originalCallData = connector.callData.bind(connector);
const originalMuteConfig = {
    masterQQ: muteConfig.masterQQ,
    botQQ: muteConfig.botQQ,
    defaultDuration: muteConfig.defaultDuration,
    maxDuration: muteConfig.maxDuration,
};
const originalAdminQQ = [...globalConfig.adminQQ];

afterEach(() => {
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = originalCallData;

    muteConfig.masterQQ = originalMuteConfig.masterQQ;
    muteConfig.botQQ = originalMuteConfig.botQQ;
    muteConfig.defaultDuration = originalMuteConfig.defaultDuration;
    muteConfig.maxDuration = originalMuteConfig.maxDuration;
    globalConfig.adminQQ = [...originalAdminQQ];
});

test('member muting others is rejected with clearer permission text', async () => {
    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        if (action === 'get_group_member_info' && params.user_id === 10001) {
            return {
                user_id: 10001,
                role: 'member',
                card: '阿白',
            };
        }
        return undefined;
    };

    const ctx: ToolContext = {
        senderId: 10001,
        senderRole: 'member',
        groupId: 123456,
    };

    const result = await execute({ targetId: 10002, duration: 5 }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.text, '阿白，你又不是管理员/群主/主人，凭什么命令我去禁言别人');
    assert.deepEqual(requests, [{
        action: 'get_group_member_info',
        params: {
            group_id: 123456,
            user_id: 10001,
            no_cache: true,
        },
    }]);
});

test('member can mute self', async () => {
    muteConfig.botQQ = 99999;

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        if (action === 'get_group_member_info') {
            const userId = params.user_id;
            if (userId === 10001) {
                return {
                    user_id: 10001,
                    role: 'member',
                    card: '小明',
                };
            }
            if (userId === muteConfig.botQQ) {
                return {
                    user_id: muteConfig.botQQ,
                    role: 'admin',
                    nickname: 'Genesis',
                };
            }
        }
        return undefined;
    };

    const ctx: ToolContext = {
        senderId: 10001,
        senderRole: 'member',
        groupId: 123456,
    };

    const result = await execute({ targetId: 10001, duration: 5 }, ctx);

    assert.equal(result.success, true);
    assert.equal(result.text, '已禁言 小明(10001) 5分钟 🔇');
    assert.deepEqual(requests, [
        {
            action: 'get_group_member_info',
            params: {
                group_id: 123456,
                user_id: 10001,
                no_cache: true,
            },
        },
        {
            action: 'get_group_member_info',
            params: {
                group_id: 123456,
                user_id: 99999,
                no_cache: true,
            },
        },
        {
            action: 'set_group_ban',
            params: {
                group_id: 123456,
                user_id: 10001,
                duration: 300,
            },
        },
    ]);
});

test('mute falls back to context group when tool params carry groupId zero', async () => {
    muteConfig.botQQ = 99999;

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        if (action === 'get_group_member_info') {
            const userId = params.user_id;
            if (userId === 10002) {
                return {
                    user_id: 10002,
                    role: 'member',
                    nickname: '宝贝',
                };
            }
            if (userId === muteConfig.botQQ) {
                return {
                    user_id: muteConfig.botQQ,
                    role: 'admin',
                    nickname: 'Genesis',
                };
            }
        }
        return undefined;
    };

    const result = await execute({ targetId: 10002, duration: 5, groupId: 0 }, {
        senderId: 10001,
        senderRole: 'admin',
        groupId: 123456,
    });

    assert.equal(result.success, true);
    assert.equal(result.text, '已禁言 宝贝(10002) 5分钟 🔇');
    assert.equal(requests[0]?.params.group_id, 123456);
    assert.equal(requests.at(-1)?.params.group_id, 123456);
});

test('global admin is treated as privileged for mute permission', async () => {
    muteConfig.masterQQ = 424242;
    muteConfig.botQQ = 99999;
    globalConfig.adminQQ = [20001];

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        if (action === 'get_group_member_info') {
            const userId = params.user_id;
            if (userId === 20002) {
                return {
                    user_id: 20002,
                    role: 'member',
                    nickname: '路人甲',
                };
            }
            if (userId === muteConfig.botQQ) {
                return {
                    user_id: muteConfig.botQQ,
                    role: 'admin',
                    nickname: 'Genesis',
                };
            }
        }
        return undefined;
    };

    const ctx: ToolContext = {
        senderId: 20001,
        senderRole: 'member',
        groupId: 654321,
    };

    const result = await execute({ targetId: 20002, duration: 1 }, ctx);

    assert.equal(result.success, true);
    assert.equal(result.text, '已禁言 路人甲(20002) 1分钟 🔇');
    assert.equal(requests.at(-1)?.action, 'set_group_ban');
});
