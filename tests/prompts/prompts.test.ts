import assert from 'node:assert/strict';
import test from 'node:test';

import { promptSnapshotCases } from './cases.ts';
import { normalizeSnapshot, readSnapshot } from './snapshot-utils.ts';

test('prompt builders match committed snapshots', async (t) => {
    for (const promptCase of promptSnapshotCases) {
        await t.test(promptCase.name, async () => {
            const actual = normalizeSnapshot(promptCase.render());
            const expected = await readSnapshot(promptCase.fileName);

            assert.strictEqual(
                actual,
                expected,
                `快照不一致: ${promptCase.fileName}。请先运行 npm run test:prompts:update 更新快照。`,
            );
        });
    }
});
