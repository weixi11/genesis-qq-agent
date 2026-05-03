export const FAVORABILITY_CONFIG = {
    MIN: 0,
    MAX: 100,
    BASELINE: 35,
    DECAY_PER_DAY: 0.35,
    LEVELS: {
        ACQUAINTANCE: 55,
        GOOD_FRIEND: 70,
        OLD_FRIEND: 85,
    },
    MAX_EVENT_COUNT: 20,
} as const;

export type FavorabilityRelationLevel = '老朋友' | '好朋友' | '熟人' | '新朋友';

export function clampFavorability(value: number): number {
    return Math.max(FAVORABILITY_CONFIG.MIN, Math.min(FAVORABILITY_CONFIG.MAX, value));
}

export function getFavorabilityRelationLevel(favorability: number): FavorabilityRelationLevel {
    if (favorability >= FAVORABILITY_CONFIG.LEVELS.OLD_FRIEND) {
        return '老朋友';
    }
    if (favorability >= FAVORABILITY_CONFIG.LEVELS.GOOD_FRIEND) {
        return '好朋友';
    }
    if (favorability >= FAVORABILITY_CONFIG.LEVELS.ACQUAINTANCE) {
        return '熟人';
    }
    return '新朋友';
}
