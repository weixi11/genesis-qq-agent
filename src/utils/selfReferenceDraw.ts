import { log } from '../logger.js';
import {
    buildPersonaSelfDrawPrompt,
    getPersonaAppearance,
    getPersonaDrawAppearance,
    getPersonaDisplayName,
    isSelfReferenceDrawRequest,
} from './personaLoader.js';

export const INTERNAL_SELF_REFERENCE_DRAW_KEYS = [
    'selfReference',
    'botAppearance',
    'personaPromptResolved',
    'detectedSelfReference',
    'selfReferenceSource',
    'promptResolutionMode',
] as const;

export type InternalSelfReferenceDrawKey = typeof INTERNAL_SELF_REFERENCE_DRAW_KEYS[number];
export type SelfReferenceSource = 'upstream_flag' | 'user_text' | 'prompt_text' | 'draw_tool_prompt';
export type PromptResolutionMode =
    | 'upstream_resolved'
    | 'llm_composed'
    | 'llm_retry_composed'
    | 'fallback_visual_brief'
    | 'draw_tool_fallback'
    | 'detected_only';

interface ComposeSelfReferencePromptInput {
    appearance: string;
    personaName: string;
    userText: string;
    originalPrompt: string;
    missingAnchors?: string[];
    retry?: boolean;
}

interface NormalizeSelfReferenceDrawParamsOptions {
    params: Record<string, unknown>;
    userText: string;
    stage: string;
    composePrompt: (input: ComposeSelfReferencePromptInput) => Promise<string>;
    appearance?: string;
    personaName?: string;
}

const SELF_REFERENCE_ANCHOR_PRIORITY = [
    'pink_hair',
    'purple_eyes',
    'low_twintails',
    'cat_ears',
    'catmask_on_head',
] as const;

function sanitizeGeneratedDrawPrompt(text: string): string {
    return text
        .replace(/^```[\w-]*\s*/u, '')
        .replace(/```$/u, '')
        .replace(/^["'`]|["'`]$/gu, '')
        .replace(/\s+/g, ' ')
        .replace(/[，、；;]+/gu, ', ')
        .trim();
}

function normalizeAnchorText(text: string): string {
    return text.toLowerCase().replace(/[\s-]+/g, '_');
}

function buildAnchorPattern(anchor: string): RegExp {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexible = escaped.replace(/_/g, '[ _-]?');
    return new RegExp(flexible, 'iu');
}

function extractRequiredAnchors(appearanceText: string): string[] {
    const normalizedAppearance = normalizeAnchorText(appearanceText);
    const anchors = SELF_REFERENCE_ANCHOR_PRIORITY.filter((anchor) => normalizedAppearance.includes(anchor));
    return anchors.length > 0 ? [...anchors] : ['pink_hair', 'purple_eyes', 'cat_ears'];
}

function findMissingAnchors(prompt: string, appearanceText: string): string[] {
    const normalizedPrompt = normalizeAnchorText(prompt);
    return extractRequiredAnchors(appearanceText).filter((anchor) => {
        if (normalizedPrompt.includes(anchor)) {
            return false;
        }
        return !buildAnchorPattern(anchor).test(prompt);
    });
}

function detectSelfReferenceSource(
    params: Record<string, unknown>,
    userText: string,
    originalPrompt: string,
): SelfReferenceSource | undefined {
    if (params.selfReference === true) {
        return 'upstream_flag';
    }
    if (isSelfReferenceDrawRequest(userText)) {
        return 'user_text';
    }
    if (isSelfReferenceDrawRequest(originalPrompt)) {
        return 'prompt_text';
    }
    return undefined;
}

function withInternalDebugFields(
    params: Record<string, unknown>,
    source: SelfReferenceSource,
    mode: PromptResolutionMode,
): Record<string, unknown> {
    return {
        ...params,
        selfReference: true,
        detectedSelfReference: true,
        selfReferenceSource: source,
        promptResolutionMode: mode,
    };
}

export function isInternalSelfReferenceDrawKey(key: string): key is InternalSelfReferenceDrawKey {
    return (INTERNAL_SELF_REFERENCE_DRAW_KEYS as readonly string[]).includes(key);
}

export function applyDrawToolSelfReferenceFallback(params: Record<string, unknown>): Record<string, unknown> {
    const prompt = typeof params.prompt === 'string'
        ? params.prompt.trim()
        : typeof params.text === 'string'
            ? params.text.trim()
            : '';

    if (!prompt || params.selfReference === true || !isSelfReferenceDrawRequest(prompt)) {
        return params;
    }

    return withInternalDebugFields(params, 'draw_tool_prompt', 'draw_tool_fallback');
}

export async function normalizeSelfReferenceDrawParams(
    options: NormalizeSelfReferenceDrawParamsOptions,
): Promise<Record<string, unknown>> {
    const { params, userText, stage, composePrompt } = options;
    const originalPrompt = typeof params.prompt === 'string'
        ? params.prompt.trim()
        : typeof params.text === 'string'
            ? params.text.trim()
            : '';

    const source = detectSelfReferenceSource(params, userText, originalPrompt);
    if (!source) {
        return params;
    }

    const rawAppearance = options.appearance?.trim() || getPersonaAppearance();
    const appearance = getPersonaDrawAppearance(rawAppearance);
    const personaName = options.personaName?.trim() || getPersonaDisplayName();

    if (!originalPrompt) {
        return withInternalDebugFields(params, source, 'detected_only');
    }

    if (params.selfReference !== true) {
        log.info(`${stage}: 根据用户原话自动补上自画像标记`);
    }

    if (params.personaPromptResolved === true) {
        return {
            ...withInternalDebugFields(params, source, 'upstream_resolved'),
            botAppearance: appearance,
        };
    }

    const buildFallback = (): Record<string, unknown> => ({
        ...withInternalDebugFields(params, source, 'fallback_visual_brief'),
        prompt: buildPersonaSelfDrawPrompt(originalPrompt, appearance),
        personaPromptResolved: true,
        botAppearance: appearance,
    });

    const composeAttempt = async (retry: boolean, missingAnchors: string[] = []) => {
        const raw = await composePrompt({
            appearance,
            personaName,
            userText,
            originalPrompt,
            missingAnchors,
            retry,
        });
        const prompt = sanitizeGeneratedDrawPrompt(raw);
        const hasChinese = /[\u3400-\u9fff]/u.test(prompt);
        const missing = prompt ? findMissingAnchors(prompt, appearance) : extractRequiredAnchors(appearance);
        return { prompt, hasChinese, missing };
    };

    try {
        const first = await composeAttempt(false);
        if (first.prompt && !first.hasChinese && first.missing.length === 0) {
            log.info(`${stage}: 已为自画像生成最终英文 prompt`);
            log.debug(`${stage}: 自画像 prompt = "${first.prompt.slice(0, 160)}..."`);
            return {
                ...withInternalDebugFields(params, source, 'llm_composed'),
                prompt: first.prompt,
                personaPromptResolved: true,
                botAppearance: appearance,
            };
        }

        if (first.missing.length > 0) {
            log.warn(`${stage}: 自画像 prompt 缺少关键锚点，准备强制重试 -> ${first.missing.join(', ')}`);
        } else if (first.hasChinese) {
            log.warn(`${stage}: 自画像 prompt 仍含中文，准备强制重试`);
        }

        const second = await composeAttempt(true, first.missing);
        if (second.prompt && !second.hasChinese && second.missing.length === 0) {
            log.info(`${stage}: 自画像重试后已补齐关键锚点`);
            log.debug(`${stage}: 自画像 prompt = "${second.prompt.slice(0, 160)}..."`);
            return {
                ...withInternalDebugFields(params, source, 'llm_retry_composed'),
                prompt: second.prompt,
                personaPromptResolved: true,
                botAppearance: appearance,
            };
        }

        if (second.missing.length > 0) {
            log.warn(`${stage}: 自画像 prompt 二次生成仍缺少锚点，回退到视觉摘要 -> ${second.missing.join(', ')}`);
        } else if (second.hasChinese) {
            log.warn(`${stage}: 自画像 prompt 二次生成仍含中文，回退到视觉摘要`);
        }
    } catch (error) {
        log.warn(`${stage}: 自画像 prompt 生成失败，回退到视觉摘要`, error instanceof Error ? error.message : String(error));
    }

    return buildFallback();
}
