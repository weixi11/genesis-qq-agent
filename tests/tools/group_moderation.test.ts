import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { config as globalConfig } from '../../src/config.ts';
import { connector } from '../../src/connector.ts';
import { execute as executeKick } from '../../src/tools/group_kick/index.ts';
import { execute as executeSetAdmin } from '../../src/tools/group_set_admin/index.ts';
import { execute as executeSetCard } from '../../src/tools/group_set_card/index.ts';
import { execute as executeSetName } from '../../src/tools/group_set_name/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const originalCallData = connector.callData.bind(connector);
const originalBotQQ = globalConfig.botQQ;

afterEach(() => {
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = originalCallData;
    globalConfig.botQQ = originalBotQQ;
});

test('group_kick low-permission rejection includes requester name', async () => {
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        if (action === 'get_group_member_info' && params.user_id === 30001) {
            return {
                user_id: 30001,
                role: 'member',
                nickname: '团子',
            };
        }
        return undefined;
    };

    const result = await executeKick({ user_id: 30002 }, {
        senderId: 30001,
        senderRole: 'member',
        groupId: 123456,
    });

    assert.equal(result.success, false);
    assert.equal(result.text, '团子，你又不是管理员/群主/主人，凭什么命令我踢别人出群');
});

test('group_kick higher-role rejection includes target name', async () => {
    globalConfig.botQQ = 99999;

    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        if (action === 'get_group_member_info') {
            if (params.user_id === 30002) {
                return {
                    user_id: 30002,
                    role: 'admin',
                    card: '老王',
                };
            }
            if (params.user_id === 99999) {
                return {
                    user_id: 99999,
                    role: 'admin',
                    nickname: 'Genesis',
                };
            }
        }
        return undefined;
    };

    const ctx: ToolContext = {
        senderId: 30001,
        senderRole: 'admin',
        groupId: 123456,
    };
    const result = await executeKick({ user_id: 30002 }, ctx);

    assert.equal(result.success, false);
    assert.equal(result.text, '老王(30002) 可不是你能移出群的，人家可是管理员');
});

test('group_set_card success includes target member name', async () => {
    globalConfig.botQQ = 99999;

    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        if (action === 'get_group_member_info') {
            if (params.user_id === 99999) {
                return {
                    user_id: 99999,
                    role: 'admin',
                    nickname: 'Genesis',
                };
            }
            if (params.user_id === 30002) {
                return {
                    user_id: 30002,
                    role: 'member',
                    nickname: '泡泡',
                };
            }
        }
        return undefined;
    };

    const result = await executeSetCard({
        user_id: 30002,
        card: '新名片',
    }, {
        senderId: 30001,
        senderRole: 'admin',
        groupId: 123456,
    });

    assert.equal(result.success, true);
    assert.equal(result.text, '已将 泡泡(30002) 的群昵称修改为：新名片 ✨');
});

test('group_set_name low-permission rejection includes requester name', async () => {
    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        if (action === 'get_group_member_info' && params.user_id === 30001) {
            return {
                user_id: 30001,
                role: 'member',
                card: '小夏',
            };
        }
        return undefined;
    };

    const result = await executeSetName({ name: '新群名' }, {
        senderId: 30001,
        senderRole: 'member',
        groupId: 123456,
    });

    assert.equal(result.success, false);
    assert.equal(result.text, '小夏，你又不是管理员/群主/主人，凭什么命令我改群名');
});

test('group_set_admin success includes target member name', async () => {
    globalConfig.botQQ = 99999;

    const patchedConnector = connector as unknown as {
        callData: typeof connector.callData;
    };
    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        if (action === 'get_group_member_info') {
            if (params.user_id === 99999) {
                return {
                    user_id: 99999,
                    role: 'owner',
                    nickname: 'Genesis',
                };
            }
            if (params.user_id === 30002) {
                return {
                    user_id: 30002,
                    role: 'member',
                    card: '小夜',
                };
            }
        }
        return undefined;
    };

    const result = await executeSetAdmin({
        user_id: 30002,
        enable: true,
    }, {
        senderId: 30001,
        senderRole: 'owner',
        groupId: 123456,
    });

    assert.equal(result.success, true);
    assert.equal(result.text, '已将 小夜(30002) 晋升为管理员 ✨');
});
