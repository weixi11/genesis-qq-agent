export type BananaDrawMode = 'auto' | 'generate' | 'edit' | 'figurine' | 'comic' | 'selfie';

export const BANANA_PRESETS: Record<Exclude<BananaDrawMode, 'auto' | 'generate' | 'edit'>, string> = {
    figurine: 'masterpiece, best quality, photorealistic, ultra detailed, A commercial 1/7 scale figurine of the character, full body shot, on a transparent acrylic base, displayed on a realistic computer desk, toy box with original art beside it',
    comic: 'Create a four-panel comic from the provided images, add suitable speech bubbles, panel composition, story continuity, and cohesive backgrounds',
    selfie: 'Transform the character into a realistic person and create an iPhone-style casual selfie, natural lighting, slight motion blur, spontaneous snapshot, 9:16',
};

export function normalizeBananaMode(value: unknown): BananaDrawMode {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'generate') return 'generate';
    if (text === 'edit') return 'edit';
    if (text === 'figurine') return 'figurine';
    if (text === 'comic') return 'comic';
    if (text === 'selfie') return 'selfie';
    return 'auto';
}

export function getPresetPrompt(mode: BananaDrawMode): string {
    if (mode === 'figurine' || mode === 'comic' || mode === 'selfie') {
        return BANANA_PRESETS[mode];
    }
    return '';
}

export function buildBananaPrompt(
    prompt: string,
    mode: BananaDrawMode,
    preserveIdentity: boolean,
): string {
    const parts: string[] = [];
    const preset = getPresetPrompt(mode);
    if (preset) {
        parts.push(preset);
    }
    if (preserveIdentity) {
        parts.push('Preserve the person identity, facial features, hairstyle, body shape, and distinctive appearance unless explicitly changed');
    }
    if (prompt.trim()) {
        parts.push(prompt.trim());
    }
    return parts.join(', ').trim();
}

