import { log } from '../logger.js';
import { techLlm } from '../llm.js';

export const IMAGE_PROMPT_RESOLUTION_MODE = 'llm_image_prompt';
export const IMAGE_PROMPT_RESOLVED_MODE = 'llm_image_prompt_resolved';

const IMAGE_PROMPT_SYSTEM_PROMPT = `You rewrite user drawing requests into final prompts for image-generation models.

Rules:
1. Output one final English prompt only.
2. Keep named characters, works, people, objects, and requested style from the user.
3. Add useful visual details: subject, composition, mood, lighting, background, camera/framing, style, quality.
4. Do not add explanations, JSON, markdown, quotes, or Chinese.
5. Preserve explicit reference-image constraints, especially whether an avatar should preserve identity or only inspire background/theme/style.
6. Do not claim the image is already generated.`;

function getPrompt(params: Record<string, unknown>): string {
    return String(params.prompt ?? params.text ?? '').trim();
}

export function needsImagePromptResolution(params: Record<string, unknown>): boolean {
    if (params.selfReference === true) {
        return false;
    }
    return params.promptResolutionMode === IMAGE_PROMPT_RESOLUTION_MODE && getPrompt(params).length > 0;
}

export function markImagePromptForResolution(params: Record<string, unknown>): Record<string, unknown> {
    return {
        ...params,
        promptResolutionMode: IMAGE_PROMPT_RESOLUTION_MODE,
    };
}

export async function resolveImagePromptParams(input: {
    toolName: string;
    params: Record<string, unknown>;
    userText: string;
    stage: string;
}): Promise<Record<string, unknown>> {
    const { toolName, params, userText, stage } = input;
    if (!needsImagePromptResolution(params)) {
        return params;
    }

    const originalPrompt = getPrompt(params);
    const mode = typeof params.mode === 'string' ? params.mode : '';

    try {
        const resolvedPrompt = (await techLlm.chat([
            {
                role: 'system',
                content: IMAGE_PROMPT_SYSTEM_PROMPT,
            },
            {
                role: 'user',
                content: `Tool: ${toolName}
Mode: ${mode || 'default'}
User request:
${userText || originalPrompt}

Current raw prompt:
${originalPrompt}

Return the final English image prompt only.`,
            },
        ], {
            temperature: 0.2,
        }, 'tech_image_prompt')).trim();

        if (!resolvedPrompt) {
            return params;
        }

        log.info(`${stage}: 已生成绘图提示词 ${toolName} "${resolvedPrompt.slice(0, 80)}..."`);
        return {
            ...params,
            prompt: resolvedPrompt,
            promptResolutionMode: IMAGE_PROMPT_RESOLVED_MODE,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`${stage}: 绘图提示词生成失败，使用原始提示词: ${message}`);
        return params;
    }
}
