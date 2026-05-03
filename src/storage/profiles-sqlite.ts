/**
 * SQLite 用户画像存储（使用 sql.js）
 * 纯 JavaScript 实现，无需编译原生模块
 */

import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { log } from '../logger.js';
import type {
    UserProfile,
    ProfileTagEvidence,
    ProfileEvidenceSource,
    ProfileMemoryEntry,
    ProfileMemoryInput,
    ProfileMemorySentiment,
    ProfileConflictStatus,
    FavorabilityEvent,
    FavorabilityEventReason,
    FavorabilityEventSource,
} from '../types.js';
import { createDefaultProfile } from '../types.js';
import {
    FAVORABILITY_CONFIG,
    clampFavorability,
    getFavorabilityRelationLevel,
} from '../utils/favorability.js';
import { safeParseJson } from '../utils/json.js';

/** 数据库行结构 */
interface ProfileRow {
    userId: number;
    nickname: string;
    gender: string | null;
    ageRange: string | null;
    traits: string; // JSON
    traitEvidence: string | null; // JSON
    interests: string; // JSON
    interestEvidence: string | null; // JSON
    identityFacts: string; // JSON
    identityEvidence: string | null; // JSON
    likes: string; // JSON
    likeEvidence: string | null; // JSON
    dislikes: string; // JSON
    dislikeEvidence: string | null; // JSON
    redLines: string; // JSON
    redLineEvidence: string | null; // JSON
    emotionPatterns: string; // JSON
    emotionPatternEvidence: string | null; // JSON
    emotionalTriggers: string; // JSON
    emotionalTriggerEvidence: string | null; // JSON
    calmingSignals: string; // JSON
    calmingSignalEvidence: string | null; // JSON
    relationshipNotes: string; // JSON
    relationshipNoteEvidence: string | null; // JSON
    boundaryNotes: string; // JSON
    boundaryNoteEvidence: string | null; // JSON
    importantMemories: string | null; // JSON
    conflictRecords: string | null; // JSON
    favorability: number;
    favorabilityUpdatedAt: number | null;
    favorabilityEvents: string | null; // JSON
    mood: string;
    messageCount: number;
    lastSeen: number;
    lastAnalyzed: number;
    notes: string;
}

type ProfileListField =
    | 'traits'
    | 'interests'
    | 'identityFacts'
    | 'likes'
    | 'dislikes'
    | 'redLines'
    | 'emotionPatterns'
    | 'emotionalTriggers'
    | 'calmingSignals'
    | 'relationshipNotes'
    | 'boundaryNotes';

type ProfileEvidenceField =
    | 'traitEvidence'
    | 'interestEvidence'
    | 'identityEvidence'
    | 'likeEvidence'
    | 'dislikeEvidence'
    | 'redLineEvidence'
    | 'emotionPatternEvidence'
    | 'emotionalTriggerEvidence'
    | 'calmingSignalEvidence'
    | 'relationshipNoteEvidence'
    | 'boundaryNoteEvidence';

type ProfileMemoryField = 'importantMemories' | 'conflictRecords';

interface ProfileEvidenceFieldConfig {
    valuesKey: ProfileListField;
    evidenceKey: ProfileEvidenceField;
}

// 数据库文件路径
const DB_PATH = path.resolve(process.cwd(), 'data', 'profiles.db');

// 数据库实例
let db: SqlJsDatabase | null = null;
let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let initialized = false;
let saveTimer: NodeJS.Timeout | null = null;
let hasPendingFileFlush = false;
const FILE_FLUSH_DELAY_MS = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_TAG_COUNT = 20;
const MAX_EVIDENCE_COUNT = 40;
const MAX_MEMORY_COUNT = 12;
const TAG_SCORE_INCREMENT = 1;
const TAG_SCORE_DECAY_PER_DAY = 0.08;
const MIN_TAG_SCORE = 0.15;
const DEFAULT_MEMORY_IMPORTANCE = 3;
const MEMORY_GRACE_DAYS = 14;
const MEMORY_DECAY_PER_DAY = 0.06;
const MEMORY_REPEAT_BONUS = 0.35;
const MEMORY_PRIORITY_MIN = 1.2;
const RESOLVED_CONFLICT_RETENTION_DAYS = 45;

const PROFILE_EVIDENCE_FIELDS: readonly ProfileEvidenceFieldConfig[] = [
    { valuesKey: 'traits', evidenceKey: 'traitEvidence' },
    { valuesKey: 'interests', evidenceKey: 'interestEvidence' },
    { valuesKey: 'identityFacts', evidenceKey: 'identityEvidence' },
    { valuesKey: 'likes', evidenceKey: 'likeEvidence' },
    { valuesKey: 'dislikes', evidenceKey: 'dislikeEvidence' },
    { valuesKey: 'redLines', evidenceKey: 'redLineEvidence' },
    { valuesKey: 'emotionPatterns', evidenceKey: 'emotionPatternEvidence' },
    { valuesKey: 'emotionalTriggers', evidenceKey: 'emotionalTriggerEvidence' },
    { valuesKey: 'calmingSignals', evidenceKey: 'calmingSignalEvidence' },
    { valuesKey: 'relationshipNotes', evidenceKey: 'relationshipNoteEvidence' },
    { valuesKey: 'boundaryNotes', evidenceKey: 'boundaryNoteEvidence' },
] as const;

const PROFILE_MEMORY_FIELDS: readonly ProfileMemoryField[] = [
    'importantMemories',
    'conflictRecords',
] as const;

function isWebOnlyProcess(): boolean {
    return (process.env.GENESIS_PROCESS_ROLE || '').trim().toLowerCase() === 'web';
}

function roundToThree(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function normalizeEvidenceValue(value: string): string {
    return value.trim();
}

function normalizeMemorySummary(value: string): string {
    return value.trim();
}

function isEvidenceSource(value: unknown): value is ProfileEvidenceSource {
    return value === 'llm' || value === 'manual' || value === 'legacy';
}

function isMemorySentiment(value: unknown): value is ProfileMemorySentiment {
    return value === 'positive' || value === 'neutral' || value === 'negative';
}

function isConflictStatus(value: unknown): value is ProfileConflictStatus {
    return value === 'active' || value === 'resolved' || value === 'lingering';
}

function parseStringArray(raw: string | null | undefined): string[] {
    if (!raw) {
        return [];
    }

    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed
        .filter((item): item is string => typeof item === 'string')
        .map(normalizeEvidenceValue)
        .filter(Boolean);
}

function ensureProfilesTableColumns(database: SqlJsDatabase): void {
    const stmt = database.prepare('PRAGMA table_info(profiles)');
    const columns = new Set<string>();

    while (stmt.step()) {
        const row = stmt.getAsObject() as { name?: string };
        if (row.name) {
            columns.add(row.name);
        }
    }
    stmt.free();

    const requiredColumns = [
        ...PROFILE_EVIDENCE_FIELDS.flatMap(({ valuesKey, evidenceKey }) => ([
            { name: valuesKey, statement: `ALTER TABLE profiles ADD COLUMN ${valuesKey} TEXT DEFAULT '[]'` },
            { name: evidenceKey, statement: `ALTER TABLE profiles ADD COLUMN ${evidenceKey} TEXT DEFAULT '[]'` },
        ])),
        ...PROFILE_MEMORY_FIELDS.map((field) => ({
            name: field,
            statement: `ALTER TABLE profiles ADD COLUMN ${field} TEXT DEFAULT '[]'`,
        })),
        { name: 'favorabilityUpdatedAt', statement: `ALTER TABLE profiles ADD COLUMN favorabilityUpdatedAt INTEGER DEFAULT 0` },
        { name: 'favorabilityEvents', statement: `ALTER TABLE profiles ADD COLUMN favorabilityEvents TEXT DEFAULT '[]'` },
    ];

    for (const column of requiredColumns) {
        if (!columns.has(column.name)) {
            database.run(column.statement);
        }
    }
}

function createEvidence(value: string, source: ProfileEvidenceSource, lastSeen: number): ProfileTagEvidence {
    return {
        value,
        score: TAG_SCORE_INCREMENT,
        lastSeen,
        count: 1,
        source,
    };
}

function parseEvidenceItem(raw: unknown, now: number): ProfileTagEvidence | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }

    const item = raw as Record<string, unknown>;
    if (typeof item.value !== 'string') {
        return null;
    }

    const value = normalizeEvidenceValue(item.value);
    if (!value) {
        return null;
    }

    const score = typeof item.score === 'number' && Number.isFinite(item.score)
        ? Math.max(MIN_TAG_SCORE, item.score)
        : TAG_SCORE_INCREMENT;
    const lastSeen = typeof item.lastSeen === 'number' && Number.isFinite(item.lastSeen)
        ? item.lastSeen
        : now;
    const count = typeof item.count === 'number' && Number.isFinite(item.count)
        ? Math.max(1, Math.round(item.count))
        : 1;
    const source = isEvidenceSource(item.source) ? item.source : 'legacy';

    return {
        value,
        score: roundToThree(score),
        lastSeen,
        count,
        source,
    };
}

function decayEvidenceScore(score: number, lastSeen: number, now: number): number {
    const ageDays = Math.max(0, now - lastSeen) / MS_PER_DAY;
    return roundToThree(Math.max(0, score - ageDays * TAG_SCORE_DECAY_PER_DAY));
}

function compareEvidence(left: ProfileTagEvidence, right: ProfileTagEvidence): number {
    if (right.score !== left.score) {
        return right.score - left.score;
    }
    if (right.lastSeen !== left.lastSeen) {
        return right.lastSeen - left.lastSeen;
    }
    return right.count - left.count;
}

function mergeEvidence(items: ProfileTagEvidence[], now: number): ProfileTagEvidence[] {
    const merged = new Map<string, ProfileTagEvidence>();

    for (const item of items) {
        const decayedScore = decayEvidenceScore(item.score, item.lastSeen, now);
        if (decayedScore < MIN_TAG_SCORE) {
            continue;
        }

        const current = merged.get(item.value);
        if (!current) {
            merged.set(item.value, {
                ...item,
                score: decayedScore,
            });
            continue;
        }

        merged.set(item.value, {
            value: item.value,
            score: roundToThree(current.score + decayedScore),
            lastSeen: Math.max(current.lastSeen, item.lastSeen),
            count: current.count + item.count,
            source: current.source === 'manual' ? 'manual' : item.source,
        });
    }

    return Array.from(merged.values())
        .sort(compareEvidence)
        .slice(0, MAX_EVIDENCE_COUNT);
}

function parseEvidence(
    raw: string | null | undefined,
    fallbackValues: string[],
    now: number,
): ProfileTagEvidence[] {
    let evidence: ProfileTagEvidence[] = [];

    if (raw) {
        const parsed = safeParseJson(raw);
        if (Array.isArray(parsed)) {
            evidence = parsed
                .map(item => parseEvidenceItem(item, now))
                .filter((item): item is ProfileTagEvidence => item !== null);
        }
    }

    if (evidence.length === 0 && fallbackValues.length > 0) {
        evidence = fallbackValues.map(value => createEvidence(value, 'legacy', now));
    }

    return mergeEvidence(evidence, now);
}

function buildTopTags(evidence: ProfileTagEvidence[]): string[] {
    return evidence
        .slice(0, MAX_TAG_COUNT)
        .map(item => item.value);
}

function createMemoryEntry(
    input: ProfileMemoryInput,
    source: ProfileEvidenceSource,
    now: number,
): ProfileMemoryEntry | null {
    const summary = normalizeMemorySummary(input.summary);
    if (!summary) {
        return null;
    }

    const importance = typeof input.importance === 'number' && Number.isFinite(input.importance)
        ? Math.max(1, Math.min(5, Math.round(input.importance)))
        : DEFAULT_MEMORY_IMPORTANCE;
    const happenedAt = typeof input.happenedAt === 'number' && Number.isFinite(input.happenedAt)
        ? input.happenedAt
        : now;
    const sentiment = isMemorySentiment(input.sentiment) ? input.sentiment : 'neutral';
    const status = isConflictStatus(input.status) ? input.status : undefined;
    const detail = typeof input.detail === 'string' ? input.detail.trim() : undefined;

    return {
        summary,
        detail: detail || undefined,
        importance,
        sentiment,
        happenedAt,
        lastSeen: now,
        count: 1,
        source,
        status,
    };
}

function parseMemoryItem(raw: unknown, now: number): ProfileMemoryEntry | null {
    if (typeof raw === 'string') {
        return createMemoryEntry({ summary: raw }, 'legacy', now);
    }

    if (typeof raw !== 'object' || raw === null) {
        return null;
    }

    const item = raw as Record<string, unknown>;
    if (typeof item.summary !== 'string') {
        return null;
    }

    const summary = normalizeMemorySummary(item.summary);
    if (!summary) {
        return null;
    }

    const detail = typeof item.detail === 'string' && item.detail.trim().length > 0
        ? item.detail.trim()
        : undefined;
    const importance = typeof item.importance === 'number' && Number.isFinite(item.importance)
        ? Math.max(1, Math.min(5, Math.round(item.importance)))
        : DEFAULT_MEMORY_IMPORTANCE;
    const sentiment = isMemorySentiment(item.sentiment) ? item.sentiment : 'neutral';
    const happenedAt = typeof item.happenedAt === 'number' && Number.isFinite(item.happenedAt)
        ? item.happenedAt
        : now;
    const lastSeen = typeof item.lastSeen === 'number' && Number.isFinite(item.lastSeen)
        ? item.lastSeen
        : happenedAt;
    const count = typeof item.count === 'number' && Number.isFinite(item.count)
        ? Math.max(1, Math.round(item.count))
        : 1;
    const source = isEvidenceSource(item.source) ? item.source : 'legacy';
    const status = isConflictStatus(item.status) ? item.status : undefined;

    return {
        summary,
        detail,
        importance,
        sentiment,
        happenedAt,
        lastSeen,
        count,
        source,
        status,
    };
}

function compareMemoryEntries(left: ProfileMemoryEntry, right: ProfileMemoryEntry): number {
    if (right.importance !== left.importance) {
        return right.importance - left.importance;
    }
    if (right.lastSeen !== left.lastSeen) {
        return right.lastSeen - left.lastSeen;
    }
    return right.count - left.count;
}

function getMemoryPriority(
    entry: ProfileMemoryEntry,
    field: ProfileMemoryField,
    now: number,
): number {
    if (entry.source === 'manual') {
        return 100;
    }

    const ageDays = Math.max(0, now - entry.lastSeen) / MS_PER_DAY;
    const decayDays = Math.max(0, ageDays - MEMORY_GRACE_DAYS);
    const repeatBonus = Math.min(4, Math.max(0, entry.count - 1)) * MEMORY_REPEAT_BONUS;
    const statusBonus = field === 'conflictRecords'
        ? (entry.status === 'active' ? 0.6 : entry.status === 'lingering' ? 0.3 : -0.4)
        : 0;

    return entry.importance + repeatBonus + statusBonus - decayDays * MEMORY_DECAY_PER_DAY;
}

function shouldKeepMemoryEntry(
    entry: ProfileMemoryEntry,
    field: ProfileMemoryField,
    now: number,
): boolean {
    if (entry.source === 'manual') {
        return true;
    }

    const ageDays = Math.max(0, now - entry.lastSeen) / MS_PER_DAY;
    if (field === 'conflictRecords' && entry.status === 'resolved' && ageDays > RESOLVED_CONFLICT_RETENTION_DAYS) {
        return false;
    }

    return getMemoryPriority(entry, field, now) >= MEMORY_PRIORITY_MIN;
}

function mergeMemoryEntries(
    entries: ProfileMemoryEntry[],
    field: ProfileMemoryField,
    now: number = Date.now(),
): ProfileMemoryEntry[] {
    const merged = new Map<string, ProfileMemoryEntry>();

    for (const item of entries) {
        const current = merged.get(item.summary);
        if (!current) {
            merged.set(item.summary, item);
            continue;
        }

        merged.set(item.summary, {
            summary: item.summary,
            detail: item.detail || current.detail,
            importance: Math.max(current.importance, item.importance),
            sentiment: item.sentiment !== 'neutral' ? item.sentiment : current.sentiment,
            happenedAt: Math.min(current.happenedAt, item.happenedAt),
            lastSeen: Math.max(current.lastSeen, item.lastSeen),
            count: current.count + item.count,
            source: current.source === 'manual' ? 'manual' : item.source,
            status: item.status || current.status,
        });
    }

    return Array.from(merged.values())
        .filter((entry) => shouldKeepMemoryEntry(entry, field, now))
        .sort(compareMemoryEntries)
        .slice(0, MAX_MEMORY_COUNT);
}

function parseMemories(
    raw: string | null | undefined,
    field: ProfileMemoryField,
    now: number,
): ProfileMemoryEntry[] {
    if (!raw) {
        return [];
    }

    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) {
        return [];
    }

    return mergeMemoryEntries(
        parsed
            .map((item) => parseMemoryItem(item, now))
            .filter((item): item is ProfileMemoryEntry => item !== null),
        field,
        now,
    );
}

function updateMemoryEntries(
    existing: ProfileMemoryEntry[],
    inputs: ProfileMemoryInput[],
    source: ProfileEvidenceSource,
    field: ProfileMemoryField,
    now: number,
): ProfileMemoryEntry[] {
    const additions = inputs
        .map((item) => createMemoryEntry(item, source, now))
        .filter((item): item is ProfileMemoryEntry => item !== null);

    return mergeMemoryEntries([...existing, ...additions], field, now);
}

function prepareManualMemoryEntries(
    entries: ProfileMemoryEntry[],
    field: ProfileMemoryField,
    now: number,
): ProfileMemoryEntry[] {
    return mergeMemoryEntries(
        entries.map((entry) => ({
            ...entry,
            source: 'manual',
            lastSeen: now,
            count: Math.max(1, entry.count || 1),
        })),
        field,
        now,
    );
}

function parseFavorabilityEvent(item: unknown): FavorabilityEvent | null {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const raw = item as Partial<FavorabilityEvent>;
    if (
        typeof raw.timestamp !== 'number'
        || typeof raw.delta !== 'number'
        || typeof raw.before !== 'number'
        || typeof raw.after !== 'number'
        || !isFavorabilityEventSource(raw.source)
        || !isFavorabilityEventReason(raw.reason)
    ) {
        return null;
    }

    const note = typeof raw.note === 'string' ? raw.note.trim() : '';

    return {
        timestamp: raw.timestamp,
        delta: roundToThree(raw.delta),
        before: roundToThree(raw.before),
        after: roundToThree(raw.after),
        source: raw.source,
        reason: raw.reason,
        ...(note ? { note } : {}),
    };
}

function isFavorabilityEventSource(value: unknown): value is FavorabilityEventSource {
    return value === 'profiler' || value === 'manual' || value === 'system';
}

function isFavorabilityEventReason(value: unknown): value is FavorabilityEventReason {
    return value === 'analysis' || value === 'manual_edit' || value === 'import';
}

function normalizeFavorabilityEvents(entries: FavorabilityEvent[]): FavorabilityEvent[] {
    return entries
        .filter((entry) => Number.isFinite(entry.timestamp))
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, FAVORABILITY_CONFIG.MAX_EVENT_COUNT)
        .map((entry) => {
            const note = entry.note?.trim() || '';
            return {
                ...entry,
                delta: roundToThree(entry.delta),
                before: roundToThree(entry.before),
                after: roundToThree(entry.after),
                ...(note ? { note } : {}),
            };
        });
}

function parseFavorabilityEvents(raw: string | null | undefined): FavorabilityEvent[] {
    if (!raw) {
        return [];
    }

    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) {
        return [];
    }

    return normalizeFavorabilityEvents(
        parsed
            .map((item) => parseFavorabilityEvent(item))
            .filter((item): item is FavorabilityEvent => item !== null),
    );
}

function appendFavorabilityEvent(
    events: FavorabilityEvent[],
    event: FavorabilityEvent,
): FavorabilityEvent[] {
    return normalizeFavorabilityEvents([event, ...events]);
}

function applyFavorabilityDecay(
    favorability: number,
    updatedAt: number,
    now: number,
): { value: number; updatedAt: number } {
    if (updatedAt <= 0) {
        return { value: favorability, updatedAt: now };
    }

    const ageDays = Math.max(0, now - updatedAt) / MS_PER_DAY;
    if (ageDays <= 0) {
        return { value: favorability, updatedAt };
    }

    const decayAmount = ageDays * FAVORABILITY_CONFIG.DECAY_PER_DAY;
    let value = favorability;
    if (favorability > FAVORABILITY_CONFIG.BASELINE) {
        value = Math.max(FAVORABILITY_CONFIG.BASELINE, favorability - decayAmount);
    } else if (favorability < FAVORABILITY_CONFIG.BASELINE) {
        value = Math.min(FAVORABILITY_CONFIG.BASELINE, favorability + decayAmount);
    }

    const roundedValue = roundToThree(value);
    if (roundedValue === favorability) {
        return { value: roundedValue, updatedAt };
    }

    return { value: roundedValue, updatedAt: now };
}

function buildEvidenceFromValues(
    values: string[],
    source: ProfileEvidenceSource,
    now: number,
): ProfileTagEvidence[] {
    return values
        .map(normalizeEvidenceValue)
        .filter(Boolean)
        .map(value => createEvidence(value, source, now));
}

function applyNormalizedEvidenceSections(profile: UserProfile, now: number): void {
    for (const { valuesKey, evidenceKey } of PROFILE_EVIDENCE_FIELDS) {
        const values = profile[valuesKey];
        const evidence = profile[evidenceKey];
        const source = evidence.length > 0
            ? evidence
            : buildEvidenceFromValues(values, 'legacy', now);
        const merged = mergeEvidence(source, now);
        profile[valuesKey] = buildTopTags(merged);
        profile[evidenceKey] = merged;
    }
}

function normalizeProfile(profile: UserProfile, now: number = Date.now()): UserProfile {
    const normalizedProfile: UserProfile = {
        ...profile,
        importantMemories: mergeMemoryEntries(profile.importantMemories, 'importantMemories', now),
        conflictRecords: mergeMemoryEntries(profile.conflictRecords, 'conflictRecords', now),
        favorabilityEvents: normalizeFavorabilityEvents(profile.favorabilityEvents),
    };
    applyNormalizedEvidenceSections(normalizedProfile, now);
    const favorabilityState = applyFavorabilityDecay(
        normalizedProfile.favorability,
        normalizedProfile.favorabilityUpdatedAt || normalizedProfile.lastSeen || now,
        now,
    );

    return {
        ...normalizedProfile,
        favorability: favorabilityState.value,
        favorabilityUpdatedAt: favorabilityState.updatedAt,
    };
}

function updateEvidenceEntries(
    existing: ProfileTagEvidence[],
    values: string[],
    source: ProfileEvidenceSource,
    now: number,
): ProfileTagEvidence[] {
    const merged = new Map(
        mergeEvidence(existing, now).map(item => [item.value, item] as const),
    );

    for (const rawValue of values) {
        const value = normalizeEvidenceValue(rawValue);
        if (!value) {
            continue;
        }

        const current = merged.get(value);
        if (!current) {
            merged.set(value, createEvidence(value, source, now));
            continue;
        }

        merged.set(value, {
            value,
            score: roundToThree(current.score + TAG_SCORE_INCREMENT),
            lastSeen: now,
            count: current.count + 1,
            source: current.source === 'manual' ? 'manual' : source,
        });
    }

    return Array.from(merged.values())
        .sort(compareEvidence)
        .slice(0, MAX_EVIDENCE_COUNT);
}

function hydrateProfile(row: ProfileRow, now: number = Date.now()): UserProfile {
    const hydratedProfile = createDefaultProfile(row.userId, row.nickname);
    hydratedProfile.gender = (row.gender as 'male' | 'female' | 'unknown') || undefined;
    hydratedProfile.ageRange = row.ageRange || undefined;

    for (const { valuesKey, evidenceKey } of PROFILE_EVIDENCE_FIELDS) {
        const values = parseStringArray(row[valuesKey]);
        const evidence = parseEvidence(row[evidenceKey], values, now);
        hydratedProfile[valuesKey] = buildTopTags(evidence);
        hydratedProfile[evidenceKey] = evidence;
    }

    hydratedProfile.importantMemories = parseMemories(row.importantMemories, 'importantMemories', now);
    hydratedProfile.conflictRecords = parseMemories(row.conflictRecords, 'conflictRecords', now);
    hydratedProfile.favorabilityEvents = parseFavorabilityEvents(row.favorabilityEvents);

    const favorabilityState = applyFavorabilityDecay(
        row.favorability,
        row.favorabilityUpdatedAt || row.lastSeen || now,
        now,
    );

    return {
        ...hydratedProfile,
        favorability: favorabilityState.value,
        favorabilityUpdatedAt: favorabilityState.updatedAt,
        mood: row.mood as 'positive' | 'neutral' | 'negative',
        messageCount: row.messageCount,
        lastSeen: row.lastSeen,
        lastAnalyzed: row.lastAnalyzed,
        notes: row.notes || undefined,
    };
}

/**
 * 初始化数据库
 */
async function initDb(): Promise<SqlJsDatabase> {
    if (db && initialized) return db;

    sqlModule ||= await initSqlJs();

    // 确保目录存在
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 加载或创建数据库
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new sqlModule.Database(buffer);
    } else {
        db = new sqlModule.Database();
    }

    initializeProfilesSchema(db);

    initialized = true;
    log.info('📊 SQLite 画像数据库已连接 (sql.js)');
    return db;
}

/**
 * 保存数据库到文件
 */
function saveDbToFile(): void {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    writeProfilesDbFile(buffer);
}

function ensureSqlModuleLoaded(): Awaited<ReturnType<typeof initSqlJs>> {
    if (!sqlModule) {
        throw new Error('Profiles DB not initialized. Call initProfilesDb() first.');
    }
    return sqlModule;
}

function initializeProfilesSchema(database: SqlJsDatabase): void {
    database.run(`
        CREATE TABLE IF NOT EXISTS profiles (
            userId INTEGER PRIMARY KEY,
            nickname TEXT NOT NULL,
            gender TEXT,
            ageRange TEXT,
            traits TEXT DEFAULT '[]',
            traitEvidence TEXT DEFAULT '[]',
            interests TEXT DEFAULT '[]',
            interestEvidence TEXT DEFAULT '[]',
            identityFacts TEXT DEFAULT '[]',
            identityEvidence TEXT DEFAULT '[]',
            likes TEXT DEFAULT '[]',
            likeEvidence TEXT DEFAULT '[]',
            dislikes TEXT DEFAULT '[]',
            dislikeEvidence TEXT DEFAULT '[]',
            redLines TEXT DEFAULT '[]',
            redLineEvidence TEXT DEFAULT '[]',
            emotionPatterns TEXT DEFAULT '[]',
            emotionPatternEvidence TEXT DEFAULT '[]',
            emotionalTriggers TEXT DEFAULT '[]',
            emotionalTriggerEvidence TEXT DEFAULT '[]',
            calmingSignals TEXT DEFAULT '[]',
            calmingSignalEvidence TEXT DEFAULT '[]',
            relationshipNotes TEXT DEFAULT '[]',
            relationshipNoteEvidence TEXT DEFAULT '[]',
            boundaryNotes TEXT DEFAULT '[]',
            boundaryNoteEvidence TEXT DEFAULT '[]',
            importantMemories TEXT DEFAULT '[]',
            conflictRecords TEXT DEFAULT '[]',
            favorability REAL DEFAULT 50,
            favorabilityUpdatedAt INTEGER DEFAULT 0,
            favorabilityEvents TEXT DEFAULT '[]',
            mood TEXT DEFAULT 'neutral',
            messageCount INTEGER DEFAULT 0,
            lastSeen INTEGER DEFAULT 0,
            lastAnalyzed INTEGER DEFAULT 0,
            notes TEXT DEFAULT ''
        )
    `);
    ensureProfilesTableColumns(database);
}

function createProfilesDbSnapshot(): SqlJsDatabase {
    flushPendingDbToFile();

    const SQL = ensureSqlModuleLoaded();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const snapshot = fs.existsSync(DB_PATH)
        ? new SQL.Database(fs.readFileSync(DB_PATH))
        : new SQL.Database();
    initializeProfilesSchema(snapshot);
    return snapshot;
}

function writeProfilesDbFile(buffer: Buffer): void {
    const tempPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, DB_PATH);
}

function readProfilesDbSnapshot<T>(reader: (database: SqlJsDatabase) => T): T {
    const snapshot = createProfilesDbSnapshot();
    try {
        return reader(snapshot);
    } finally {
        snapshot.close();
    }
}

function mutateProfilesDbSnapshot<T>(mutator: (database: SqlJsDatabase) => T): T {
    const snapshot = createProfilesDbSnapshot();
    try {
        const result = mutator(snapshot);
        const buffer = Buffer.from(snapshot.export());
        writeProfilesDbFile(buffer);
        return result;
    } finally {
        snapshot.close();
    }
}

function flushPendingDbToFile(): void {
    if (!db || !hasPendingFileFlush) {
        return;
    }

    saveDbToFile();
    hasPendingFileFlush = false;
}

function scheduleDbFlush(): void {
    hasPendingFileFlush = true;
    if (FILE_FLUSH_DELAY_MS <= 0) {
        flushPendingDbToFile();
        return;
    }
    if (saveTimer) {
        return;
    }

    saveTimer = setTimeout(() => {
        saveTimer = null;
        flushPendingDbToFile();
    }, FILE_FLUSH_DELAY_MS);
    saveTimer.unref?.();
}

/**
 * 确保数据库已初始化（同步包装）
 */
function getDb(): SqlJsDatabase {
    if (!db || !initialized) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return db;
}

function readProfileByUserId(database: SqlJsDatabase, userId: number): UserProfile | undefined {
    const stmt = database.prepare('SELECT * FROM profiles WHERE userId = ?');
    stmt.bind([userId]);

    if (!stmt.step()) {
        stmt.free();
        return undefined;
    }

    const row = stmt.getAsObject() as unknown as ProfileRow;
    stmt.free();

    return hydrateProfile(row);
}

function listProfiles(database: SqlJsDatabase, limit: number): UserProfile[] {
    const stmt = database.prepare('SELECT * FROM profiles ORDER BY lastSeen DESC LIMIT ?');
    stmt.bind([limit]);

    const profiles: UserProfile[] = [];
    while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as ProfileRow;
        profiles.push(hydrateProfile(row));
    }
    stmt.free();
    return profiles;
}

/**
 * 获取用户画像
 */
export function getProfileFromSqlite(userId: number): UserProfile | undefined {
    if (isWebOnlyProcess()) {
        return readProfilesDbSnapshot((database) => readProfileByUserId(database, userId));
    }

    return readProfileByUserId(getDb(), userId);
}

/**
 * 获取或创建用户画像
 */
export function getOrCreateProfileFromSqlite(userId: number, nickname: string): UserProfile {
    const existing = getProfileFromSqlite(userId);
    if (existing) {
        // 更新昵称（可能会变）
        if (existing.nickname !== nickname) {
            updateProfileInSqlite(userId, { nickname });
            existing.nickname = nickname;
        }
        return existing;
    }

    // 创建新画像
    const profile = createDefaultProfile(userId, nickname);
    saveProfileToSqlite(profile);
    log.info(`📊 创建新用户画像: ${nickname} (${userId})`);
    return profile;
}

/**
 * 保存用户画像（upsert）
 */
export function saveProfileToSqlite(profile: UserProfile): void {
    const normalized = normalizeProfile(profile);
    const sql = `
        INSERT OR REPLACE INTO profiles 
        (
            userId, nickname, gender, ageRange,
            traits, traitEvidence, interests, interestEvidence,
            identityFacts, identityEvidence, likes, likeEvidence,
            dislikes, dislikeEvidence, redLines, redLineEvidence,
            emotionPatterns, emotionPatternEvidence,
            emotionalTriggers, emotionalTriggerEvidence,
            calmingSignals, calmingSignalEvidence,
            relationshipNotes, relationshipNoteEvidence,
            boundaryNotes, boundaryNoteEvidence,
            importantMemories, conflictRecords,
            favorability, favorabilityUpdatedAt, favorabilityEvents, mood, messageCount, lastSeen, lastAnalyzed, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [
        normalized.userId,
        normalized.nickname,
        normalized.gender || null,
        normalized.ageRange || null,
        JSON.stringify(normalized.traits),
        JSON.stringify(normalized.traitEvidence),
        JSON.stringify(normalized.interests),
        JSON.stringify(normalized.interestEvidence),
        JSON.stringify(normalized.identityFacts),
        JSON.stringify(normalized.identityEvidence),
        JSON.stringify(normalized.likes),
        JSON.stringify(normalized.likeEvidence),
        JSON.stringify(normalized.dislikes),
        JSON.stringify(normalized.dislikeEvidence),
        JSON.stringify(normalized.redLines),
        JSON.stringify(normalized.redLineEvidence),
        JSON.stringify(normalized.emotionPatterns),
        JSON.stringify(normalized.emotionPatternEvidence),
        JSON.stringify(normalized.emotionalTriggers),
        JSON.stringify(normalized.emotionalTriggerEvidence),
        JSON.stringify(normalized.calmingSignals),
        JSON.stringify(normalized.calmingSignalEvidence),
        JSON.stringify(normalized.relationshipNotes),
        JSON.stringify(normalized.relationshipNoteEvidence),
        JSON.stringify(normalized.boundaryNotes),
        JSON.stringify(normalized.boundaryNoteEvidence),
        JSON.stringify(normalized.importantMemories),
        JSON.stringify(normalized.conflictRecords),
        normalized.favorability,
        normalized.favorabilityUpdatedAt,
        JSON.stringify(normalized.favorabilityEvents),
        normalized.mood,
        normalized.messageCount,
        normalized.lastSeen,
        normalized.lastAnalyzed,
        normalized.notes || ''
    ];

    if (isWebOnlyProcess()) {
        mutateProfilesDbSnapshot((database) => {
            database.run(sql, values);
        });
        return;
    }

    const database = getDb();
    database.run(sql, values);
    scheduleDbFlush();
}

/**
 * 更新用户画像部分字段
 */
export function updateProfileInSqlite(userId: number, updates: Partial<UserProfile>): UserProfile | undefined {
    const existing = getProfileFromSqlite(userId);
    if (!existing) return undefined;

    const now = Date.now();
    const updated: UserProfile = {
        ...existing,
        ...updates,
    };

    for (const { valuesKey, evidenceKey } of PROFILE_EVIDENCE_FIELDS) {
        const nextValues = updates[valuesKey];
        if (Array.isArray(nextValues)) {
            updated[evidenceKey] = buildEvidenceFromValues(nextValues, 'manual', now);
            updated[valuesKey] = buildTopTags(updated[evidenceKey]);
            continue;
        }

        const nextEvidence = updates[evidenceKey];
        if (Array.isArray(nextEvidence)) {
            updated[evidenceKey] = mergeEvidence(nextEvidence, now);
            updated[valuesKey] = buildTopTags(updated[evidenceKey]);
        }
    }

    for (const field of PROFILE_MEMORY_FIELDS) {
        const nextMemories = updates[field];
        if (Array.isArray(nextMemories)) {
            updated[field] = prepareManualMemoryEntries(nextMemories, field, now);
        }
    }

    if (Array.isArray(updates.favorabilityEvents)) {
        updated.favorabilityEvents = normalizeFavorabilityEvents(updates.favorabilityEvents);
    }

    const nextFavorabilityInput = updates.favorability;
    if (typeof nextFavorabilityInput === 'number' && Number.isFinite(nextFavorabilityInput) && nextFavorabilityInput !== existing.favorability) {
        const nextFavorability = roundToThree(clampFavorability(nextFavorabilityInput));
        updated.favorability = nextFavorability;
        updated.favorabilityUpdatedAt = now;

        if (!Array.isArray(updates.favorabilityEvents)) {
            updated.favorabilityEvents = appendFavorabilityEvent(updated.favorabilityEvents, {
                timestamp: now,
                delta: roundToThree(nextFavorability - existing.favorability),
                before: roundToThree(existing.favorability),
                after: nextFavorability,
                source: 'manual',
                reason: 'manual_edit',
                note: '通过画像面板手动调整',
            });
        }
    }

    saveProfileToSqlite(updated);
    return normalizeProfile(updated, now);
}

/**
 * 记录用户活动
 */
export function recordActivityInSqlite(userId: number, nickname: string): void {
    const profile = getOrCreateProfileFromSqlite(userId, nickname);
    updateProfileInSqlite(userId, {
        messageCount: profile.messageCount + 1,
        lastSeen: Date.now(),
    });
}

/**
 * 调整好感度
 */
export function adjustFavorabilityInSqlite(
    userId: number,
    emotionScore: number,
    keywordBonus: number,
    frequencyBonus: number
): void {
    const profile = getProfileFromSqlite(userId);
    if (!profile) return;

    const now = Date.now();
    const currentFavorability = applyFavorabilityDecay(
        profile.favorability,
        profile.favorabilityUpdatedAt || profile.lastSeen || now,
        now,
    ).value;

    // 好感度变化公式
    const delta = emotionScore * 2 + keywordBonus * 3 + frequencyBonus;
    const newFavorability = roundToThree(clampFavorability(currentFavorability + delta));

    if (newFavorability !== currentFavorability) {
        log.debug(`💕 好感度变化: ${profile.nickname} ${currentFavorability.toFixed(1)} -> ${newFavorability.toFixed(1)}`);
        updateProfileInSqlite(userId, {
            favorability: newFavorability,
            favorabilityUpdatedAt: now,
            favorabilityEvents: appendFavorabilityEvent(profile.favorabilityEvents, {
                timestamp: now,
                delta: roundToThree(newFavorability - currentFavorability),
                before: roundToThree(currentFavorability),
                after: newFavorability,
                source: 'profiler',
                reason: 'analysis',
                note: `情绪 ${emotionScore.toFixed(2)} / LLM ${keywordBonus.toFixed(2)} / 频率 ${frequencyBonus.toFixed(2)}`,
            }),
        });
    }
}

/**
 * 添加性格标签
 */
export function addTraitsInSqlite(userId: number, newTraits: string[]): void {
    const profile = getProfileFromSqlite(userId);
    if (!profile) return;

    const now = Date.now();
    profile.traitEvidence = updateEvidenceEntries(profile.traitEvidence, newTraits, 'llm', now);
    profile.traits = buildTopTags(profile.traitEvidence);

    saveProfileToSqlite(profile);
}

/**
 * 添加兴趣爱好
 */
export function addInterestsInSqlite(userId: number, newInterests: string[]): void {
    const profile = getProfileFromSqlite(userId);
    if (!profile) return;

    const now = Date.now();
    profile.interestEvidence = updateEvidenceEntries(profile.interestEvidence, newInterests, 'llm', now);
    profile.interests = buildTopTags(profile.interestEvidence);

    saveProfileToSqlite(profile);
}

export function addProfileEvidenceInSqlite(
    userId: number,
    valuesKey: Exclude<ProfileListField, 'traits' | 'interests'>,
    newValues: string[],
): void {
    const profile = getProfileFromSqlite(userId);
    if (!profile || newValues.length === 0) return;

    const fieldConfig = PROFILE_EVIDENCE_FIELDS.find((field) => field.valuesKey === valuesKey);
    if (!fieldConfig) {
        return;
    }

    const now = Date.now();
    profile[fieldConfig.evidenceKey] = updateEvidenceEntries(
        profile[fieldConfig.evidenceKey],
        newValues,
        'llm',
        now,
    );
    profile[fieldConfig.valuesKey] = buildTopTags(profile[fieldConfig.evidenceKey]);

    saveProfileToSqlite(profile);
}

export function addProfileMemoriesInSqlite(
    userId: number,
    field: ProfileMemoryField,
    entries: ProfileMemoryInput[],
): void {
    const profile = getProfileFromSqlite(userId);
    if (!profile || entries.length === 0) return;

    const now = Date.now();
    profile[field] = updateMemoryEntries(profile[field], entries, 'llm', field, now);
    saveProfileToSqlite(profile);
}

/**
 * 列出所有用户画像
 */
export function listAllProfilesFromSqlite(limit: number = 20): UserProfile[] {
    if (isWebOnlyProcess()) {
        return readProfilesDbSnapshot((database) => listProfiles(database, limit));
    }

    return listProfiles(getDb(), limit);
}

/**
 * 获取画像统计
 */
export function getProfileStatsFromSqlite(): { total: number; avgFavorability: number } {
    const database = getDb();
    const stmt = database.prepare('SELECT COUNT(*) as total, AVG(favorability) as avg FROM profiles');
    stmt.step();
    const row = stmt.getAsObject() as unknown as { total: number; avg: number };
    stmt.free();

    return {
        total: row.total || 0,
        avgFavorability: row.avg || FAVORABILITY_CONFIG.BASELINE,
    };
}

/**
 * 删除用户画像
 */
export function deleteProfileFromSqlite(userId: number): boolean {
    if (isWebOnlyProcess()) {
        return mutateProfilesDbSnapshot((database) => {
            database.run('DELETE FROM profiles WHERE userId = ?', [userId]);
            const changes = database.getRowsModified();
            if (changes > 0) {
                log.info(`📋 删除用户画像: ${userId}`);
                return true;
            }
            return false;
        });
    }

    const database = getDb();
    database.run('DELETE FROM profiles WHERE userId = ?', [userId]);
    const changes = database.getRowsModified();

    if (changes > 0) {
        log.info(`📋 删除用户画像: ${userId}`);
        scheduleDbFlush();
        return true;
    }
    return false;
}

export function deleteAllProfilesFromSqlite(): number {
    if (isWebOnlyProcess()) {
        return mutateProfilesDbSnapshot((database) => {
            database.run('DELETE FROM profiles');
            const changes = database.getRowsModified();
            if (changes > 0) {
                log.info(`📋 已批量删除全部用户画像: ${changes} 条`);
            }
            return changes;
        });
    }

    const database = getDb();
    database.run('DELETE FROM profiles');
    const changes = database.getRowsModified();

    if (changes > 0) {
        log.info(`📋 已批量删除全部用户画像: ${changes} 条`);
        scheduleDbFlush();
    }

    return changes;
}

export function flushProfilesDbToFile(): void {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }

    flushPendingDbToFile();
}

/**
 * 获取用户画像摘要
 */
export function getProfileSummaryFromSqlite(userId: number): string | undefined {
    const profile = getProfileFromSqlite(userId);
    if (!profile) return undefined;

    const parts: string[] = [];
    parts.push(`关系: ${getFavorabilityRelationLevel(profile.favorability)}`);

    if (profile.traits.length > 0) {
        parts.push(`性格: ${profile.traits.slice(-5).join(', ')}`);
    }

    if (profile.interests.length > 0) {
        parts.push(`兴趣: ${profile.interests.slice(-5).join(', ')}`);
    }

    if (profile.likes.length > 0) {
        parts.push(`偏好: ${profile.likes.slice(0, 3).join(', ')}`);
    }

    if (profile.redLines.length > 0) {
        parts.push(`雷区: ${profile.redLines.slice(0, 2).join(', ')}`);
    }

    if (profile.importantMemories.length > 0) {
        parts.push(`记忆: ${profile.importantMemories.slice(0, 2).map(item => item.summary).join(' / ')}`);
    }

    return parts.join(' | ');
}

/**
 * 初始化数据库（异步，需要在启动时调用）
 */
export async function initProfilesDb(): Promise<void> {
    await initDb();
}

/**
 * 关闭数据库连接
 */
export function closeDb(): void {
    if (db) {
        flushProfilesDbToFile();
        db.close();
        db = null;
        initialized = false;
        log.info('📊 SQLite 画像数据库已关闭');
    }
}
