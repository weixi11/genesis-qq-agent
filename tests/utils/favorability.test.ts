import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getFavorabilityRelationLevel } from '../../src/utils/favorability.ts';

test('Favorability relation levels stay boundary-consistent', () => {
    assert.equal(getFavorabilityRelationLevel(35), '新朋友');
    assert.equal(getFavorabilityRelationLevel(50), '新朋友');
    assert.equal(getFavorabilityRelationLevel(55), '熟人');
    assert.equal(getFavorabilityRelationLevel(70), '好朋友');
    assert.equal(getFavorabilityRelationLevel(85), '老朋友');
});
