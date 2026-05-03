import { log } from '../../logger.js';
import { config } from './config.js';
import type { BananaInputImage } from './input.js';
import type { BananaOutputImage } from './output.js';

export type BananaResolvedApiMode = 'chat' | 'images';

interface ChatResponse {
    choices?: Array<{
        message?: {
            content?: unknown;
            reasoning_content?: unknown;
        };
    }>;
}

interface ImagesResponse {
    data?: BananaOutputImage[];
    revised_prompt?: string;
}

export interface BananaApiResult {
    text: string;
    images: BananaOutputImage[];
    apiMode: BananaResolvedApiMode;
    model: string;
}

function extractTextParts(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (!Array.isArray(value)) {
        return '';
    }
    return value.map((part) => {
        if (typeof part === 'string') {
            return part;
        }
        if (!part || typeof part !== 'object') {
            return '';
        }
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        return '';
    }).filter(Boolean).join('\n').trim();
}

function parseTextAndMarkdownImages(content: string): BananaApiResult['images'] {
    const images: BananaOutputImage[] = [];
    const markdownUrlMatches = content.matchAll(/!\[[\s\S]*?\]\((https?:\/\/[^\s)]+)\)/g);
    for (const match of markdownUrlMatches) {
        images.push({ url: match[1] });
    }
    const markdownBase64Matches = content.matchAll(/!\[[\s\S]*?\]\(data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)\)/g);
    for (const match of markdownBase64Matches) {
        images.push({
            b64_json: match[2],
            mime_type: `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`,
        });
    }
    return images;
}

function parseChatImages(content: unknown): BananaOutputImage[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const images: BananaOutputImage[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const record = part as Record<string, unknown>;
        if (record.type === 'image_url' || record.type === 'output_image') {
            if (record.image_url && typeof record.image_url === 'object' && typeof (record.image_url as { url?: unknown }).url === 'string') {
                images.push({ url: (record.image_url as { url: string }).url });
                continue;
            }
            if (typeof record.url === 'string') {
                images.push({ url: record.url });
                continue;
            }
        }
        if ((record.type === 'image_base64' || record.type === 'output_image') && typeof record.b64_json === 'string') {
            images.push({
                b64_json: record.b64_json,
                mime_type: typeof record.mime_type === 'string' ? record.mime_type : 'image/png',
            });
        }
    }
    return images;
}

function resolveApiMode(hasImages: boolean): BananaResolvedApiMode {
    if (config.apiMode === 'chat') return 'chat';
    if (config.apiMode === 'images') return 'images';
    if (config.imageModel) return 'images';
    if (config.chatModel) return 'chat';
    return hasImages ? 'images' : 'images';
}

function resolveModel(apiMode: BananaResolvedApiMode): string {
    if (apiMode === 'chat') {
        return config.chatModel || config.model;
    }
    return config.imageModel || config.model;
}

async function callChatApi(prompt: string, inputImages: BananaInputImage[], model: string): Promise<BananaApiResult> {
    const messages: Array<{ role: string; content: unknown }> = [{
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            ...inputImages.map((image) => ({
                type: 'image_url',
                image_url: {
                    url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
                },
            })),
        ],
    }];

    const response = await fetch(`${config.baseUrl}${config.chatPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: 4096,
            stream: false,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`banana_draw chat 接口错误: ${response.status} ${await response.text()}`);
    }

    const result = await response.json() as ChatResponse;
    const message = result.choices?.[0]?.message;
    const text = extractTextParts(message?.content) || extractTextParts(message?.reasoning_content);
    const images = [
        ...parseChatImages(message?.content),
        ...parseTextAndMarkdownImages(text),
    ];

    if (!text && images.length === 0) {
        throw new Error('banana_draw chat 接口返回空内容');
    }

    return {
        text,
        images,
        apiMode: 'chat',
        model,
    };
}

async function callImagesApi(
    prompt: string,
    inputImages: BananaInputImage[],
    model: string,
    size: string,
): Promise<BananaApiResult> {
    const quality = config.imageQuality || undefined;
    const background = config.imageBackground || undefined;
    const outputFormat = config.outputFormat || undefined;

    if (inputImages.length === 0 || config.imageInputMode === 'url_array') {
        const payload: Record<string, unknown> = {
            model,
            prompt,
            size,
        };
        if (quality) {
            payload.quality = quality;
        }
        if (background) {
            payload.background = background;
        }
        if (outputFormat) {
            payload.output_format = outputFormat;
        }
        if (inputImages.length > 0) {
            payload.image = inputImages.map((image) => image.source.startsWith('data:')
                ? `data:${image.mimeType};base64,${image.buffer.toString('base64')}`
                : image.source);
        }

        const response = await fetch(`${config.baseUrl}${config.generationPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(config.timeoutMs),
        });

        if (!response.ok) {
            throw new Error(`banana_draw 图片接口错误: ${response.status} ${await response.text()}`);
        }

        const result = await response.json() as ImagesResponse;
        return {
            text: result.revised_prompt || '',
            images: result.data || [],
            apiMode: 'images',
            model,
        };
    }

    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', size);
    if (quality) {
        form.append('quality', quality);
    }
    if (background) {
        form.append('background', background);
    }
    if (outputFormat) {
        form.append('output_format', outputFormat);
    }

    inputImages.forEach((image, index) => {
        const fieldName = index === 0 ? 'image' : 'image[]';
        form.append(fieldName, new Blob([Uint8Array.from(image.buffer)], { type: image.mimeType }), image.filename);
    });

    const response = await fetch(`${config.baseUrl}${config.editPath}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: form,
        signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`banana_draw 编辑接口错误: ${response.status} ${await response.text()}`);
    }

    const result = await response.json() as ImagesResponse;
    return {
        text: result.revised_prompt || '',
        images: result.data || [],
        apiMode: 'images',
        model,
    };
}

export async function requestBananaDraw(
    prompt: string,
    inputImages: BananaInputImage[],
    size: string,
): Promise<BananaApiResult> {
    const apiMode = resolveApiMode(inputImages.length > 0);
    const model = resolveModel(apiMode);
    log.info(`🍌 BananaDraw: apiMode=${apiMode} model=${model} inputImages=${inputImages.length}`);

    if (apiMode === 'chat') {
        return callChatApi(prompt, inputImages, model);
    }
    return callImagesApi(prompt, inputImages, model, size);
}
