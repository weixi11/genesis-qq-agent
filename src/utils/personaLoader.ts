/**
 * 人设加载器
 * 
 * 功能：
 * - 从 persona/ 目录加载人设配置
 * - 支持多人设切换（通过 PERSONA_NAME 环境变量）
 * - 自动使用 LLM 将 txt 转换为 JSON
 * - 缓存 JSON 避免重复转换
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../logger.js';
import { config } from '../config.js';
import { LLMClient } from '../llm.js';
import { isRecord, safeParseJson } from './json.js';

// 人设加载器专用 LLM（独立配置，故障隔离）
const personaLoaderLlm = new LLMClient(
    config.personaLoaderLlm.baseUrl,
    config.personaLoaderLlm.apiKey,
    config.personaLoaderLlm.model
);

export function refreshPersonaLoaderLlm(): void {
    personaLoaderLlm.setConfig(
        config.personaLoaderLlm.baseUrl,
        config.personaLoaderLlm.apiKey,
        config.personaLoaderLlm.model
    );
}

// ES Module __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 人设目录路径 */
const PERSONA_DIR = path.resolve(__dirname, '../../persona');

/** 人设配置接口 */
export interface PersonaData {
    /** 名字 */
    name: string;
    /** 种族/类型 */
    species?: string;
    /** 年龄 */
    age?: string;
    /** 外貌描述 */
    appearance?: string;
    /** 服装 */
    clothing?: string;
    /** 特征 */
    features?: string;
    /** 喜好 */
    likes?: string[];
    /** 厌恶 */
    dislikes?: string[];
    /** 额外属性或设定 (动态扩充) */
    attributes?: Record<string, string>;
    /** 性格 */
    personality: string;
    /** 说话风格 */
    speakingStyle: string;
    /** 特殊指令 */
    customInstructions?: string;
}

/** 缓存的人设数据 */
let cachedPersona: PersonaData | null = null;
let cachedPersonaName: string | null = null;

function parsePersonaData(raw: string): PersonaData | null {
    const parsed = safeParseJson(raw);
    if (!isRecord(parsed) || typeof parsed.name !== 'string' || !parsed.name.trim()) {
        return null;
    }

    const parseStringArray = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value)) return undefined;
        return value.filter((item): item is string => typeof item === 'string');
    };

    const attributes = isRecord(parsed.attributes)
        ? Object.fromEntries(
            Object.entries(parsed.attributes)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
        : undefined;

    return {
        name: parsed.name.trim(),
        species: typeof parsed.species === 'string' ? parsed.species : undefined,
        age: typeof parsed.age === 'string' ? parsed.age : undefined,
        appearance: typeof parsed.appearance === 'string' ? parsed.appearance : undefined,
        clothing: typeof parsed.clothing === 'string' ? parsed.clothing : undefined,
        features: typeof parsed.features === 'string' ? parsed.features : undefined,
        likes: parseStringArray(parsed.likes),
        dislikes: parseStringArray(parsed.dislikes),
        attributes,
        personality: typeof parsed.personality === 'string' ? parsed.personality : '',
        speakingStyle: typeof parsed.speakingStyle === 'string' ? parsed.speakingStyle : '',
        customInstructions: typeof parsed.customInstructions === 'string' ? parsed.customInstructions : undefined,
    };
}

/**
 * 加载人设配置
 * @param name 人设名称（对应 persona/xxx.txt）
 */
export async function loadPersona(name: string = 'default'): Promise<PersonaData> {
    // 检查缓存
    if (cachedPersona && cachedPersonaName === name) {
        return cachedPersona;
    }

    const txtPath = path.join(PERSONA_DIR, `${name}.txt`);
    const jsonPath = path.join(PERSONA_DIR, `${name}.json`);

    // 确保目录存在
    if (!fs.existsSync(PERSONA_DIR)) {
        fs.mkdirSync(PERSONA_DIR, { recursive: true });
    }

    // 检查 txt 文件是否存在
    if (!fs.existsSync(txtPath)) {
        log.warn(`人设文件不存在: ${txtPath}，使用默认人设`);
        return getDefaultPersona();
    }

    // 获取文件修改时间
    const txtStat = fs.statSync(txtPath);
    const jsonExists = fs.existsSync(jsonPath);
    let jsonStat: fs.Stats | null = null;
    if (jsonExists) {
        jsonStat = fs.statSync(jsonPath);
    }

    // 如果 JSON 存在且比 txt 新，直接使用 JSON
    if (jsonExists && jsonStat && jsonStat.mtimeMs > txtStat.mtimeMs) {
        try {
            const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
            const persona = parsePersonaData(jsonContent);
            if (!persona) {
                throw new Error('缓存 JSON 结构无效');
            }
            log.info(`📜 加载人设 [${name}] (从缓存 JSON)`);
            cachedPersona = persona;
            cachedPersonaName = name;
            return persona;
        } catch (err: unknown) {
            log.warn(`JSON 解析失败，重新生成: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // 读取 txt 并调用 LLM 转换
    const txtContent = fs.readFileSync(txtPath, 'utf-8');
    log.info(`📜 加载人设 [${name}]，调用 LLM 解析 txt...`);

    try {
        const persona = await parsePersonaTxt(txtContent);

        // 缓存到 JSON 文件
        fs.writeFileSync(jsonPath, JSON.stringify(persona, null, 2), 'utf-8');
        log.info(`📜 人设 [${name}] 已缓存到 JSON`);

        cachedPersona = persona;
        cachedPersonaName = name;
        return persona;
    } catch (err: unknown) {
        log.error(`LLM 解析人设失败: ${err instanceof Error ? err.message : String(err)}`);
        return getDefaultPersona();
    }
}

/**
 * 使用 LLM 解析人设 txt 为结构化数据
 */
async function parsePersonaTxt(txtContent: string): Promise<PersonaData> {
    const prompt = `请将以下人设描述转换为 JSON 格式。

人设描述：
---
${txtContent}
---

请输出以下格式的 JSON（只输出 JSON，不要其他内容）：
{
  "name": "角色名字",
  "species": "种族/类型（如猫娘、女仆等）",
  "age": "年龄",
  "appearance": "外貌描述",
  "clothing": "服装描述",
  "features": "特殊特征",
  "likes": ["喜欢的事物1", "喜欢的事物2"],
  "dislikes": ["讨厌的事物1", "讨厌的事物2"],
  "attributes": {
    "设定名称": "具体设定内容"
  },
  "personality": "性格描述",
  "speakingStyle": "说话风格描述，完整保留原文",
  "customInstructions": "特殊指令，完整保留原文"
}

注意：
1. 直接输出 JSON，不要包含 \`\`\`json 标记
2. 保留原文中的细节，不要省略
3. 如果某个字段在原文中没有，可以设为空字符串或空数组/对象
4. personality 和 speakingStyle 和 customInstructions 字段必须完整保留原文内容，可以适当精简合并
5. 如果原文有其他详细属性或设定（例如身世背景、能力、口头禅等），请以键值对形式提取到 attributes 中`;

    // 使用 chat 并设置更高的 max_tokens 防止响应被截断
    const response = await personaLoaderLlm.chat(
        [
            { role: 'system', content: '你是一个 JSON 转换助手，只输出有效的 JSON，不输出其他内容。' },
            { role: 'user', content: prompt }
        ],
        { max_tokens: 4096 },
        'persona_loader_parse',
    );

    // 尝试解析 JSON
    let jsonStr = response.trim();

    // 移除可能的 markdown 代码块标记
    if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
    }
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const persona = parsePersonaData(jsonStr);
    if (!persona) {
        throw new Error('人设 JSON 结构无效');
    }

    // 验证必需字段
    if (!persona.name) {
        throw new Error('人设缺少 name 字段');
    }
    if (!persona.personality) {
        persona.personality = '';
    }
    if (!persona.speakingStyle) {
        persona.speakingStyle = '';
    }

    return persona;
}

/**
 * 获取默认人设（兜底）
 */
function getDefaultPersona(): PersonaData {
    return {
        name: '落落',
        species: '猫娘少女',
        age: '16岁',
        appearance: '粉色头发，紫色眼睛，低双马尾，猫耳，头戴猫猫眼罩',
        clothing: '戴着蝴蝶结发饰，脖子上系着带铃铛的项圈',
        features: '猫耳和尾巴会随情绪抖动，是可爱的猫娘少女',
        likes: ['吃鱼', '睡觉', '被主人摸头'],
        dislikes: ['洗澡', '被冷落', '狗'],
        attributes: {
            '隐藏身份': '偶尔会有小恶魔的一面'
        },
        personality: '傲娇、粘人、偶尔会撒娇',
        speakingStyle: '像猫娘一样说话，偶尔在句尾加"喵~"',
        customInstructions: '不要说自己是AI或机器人',
    };
}

function readPersonaSnapshotSync(name: string): PersonaData | null {
    const jsonPath = path.join(PERSONA_DIR, `${name}.json`);
    if (!fs.existsSync(jsonPath)) {
        return null;
    }

    try {
        const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
        return parsePersonaData(jsonContent);
    } catch (error) {
        log.warn(`同步读取人设快照失败: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * 清除人设缓存（用于热更新）
 */
export function clearPersonaCache(): void {
    cachedPersona = null;
    cachedPersonaName = null;
    log.info('📜 人设缓存已清除');
}

/**
 * 获取当前使用的人设名称
 */
export function getCurrentPersonaName(): string {
    return process.env.PERSONA_NAME || 'default';
}

/**
 * 列出所有可用人设
 */
export function listPersonas(): string[] {
    if (!fs.existsSync(PERSONA_DIR)) {
        return ['default'];
    }

    const files = fs.readdirSync(PERSONA_DIR);
    return files
        .filter(f => f.endsWith('.txt'))
        .map(f => f.replace('.txt', ''));
}

/**
 * 获取当前人设的外貌描述（用于绘图等工具）
 * 同步返回缓存的人设，如果未加载则返回默认值
 */
export function getPersonaAppearance(): string {
    const persona = cachedPersona || readPersonaSnapshotSync(getCurrentPersonaName()) || getDefaultPersona();

    const parts: string[] = [];
    if (persona.appearance) parts.push(persona.appearance);
    if (persona.clothing) parts.push(persona.clothing);
    if (persona.features) parts.push(persona.features);
    if (persona.species) parts.push(persona.species);
    if (persona.age) parts.push(persona.age);

    return parts.join('，') || persona.name;
}

function stripEnglishTagTail(text: string): string {
    return text
        .replace(/外貌特征包含[:：].*$/u, '')
        .replace(/[a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)+/gi, '')
        .replace(/[。；;，,、\s]+$/u, '')
        .trim();
}

function sanitizeVisualChineseText(text: string | undefined): string {
    if (!text) return '';

    const cleaned = stripEnglishTagTail(text)
        .split(/[。！？!\n；;]/u)
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => !/(主人|QQ[:：]|专属所有物|群友身份|活跃在群|潜伏|自由意志|高智商|情感丰富|身份|定位)/u.test(part))
        .join('，')
        .replace(/\s+/g, ' ')
        .replace(/^[，,、]+|[，,、]+$/gu, '')
        .trim();

    return cleaned;
}

const PERSONA_CORE_TAGS = [
    '1girl',
    'solo',
    'cat_girl',
    'pink_hair',
    'purple_eyes',
    'cat_ears',
    'low_twintails',
    'long_hair',
    'hair_bow',
    'choker',
    'catmask_on_head',
    'looking_at_viewer',
] as const;

const PERSONA_NOISY_TAGS = new Set([
    'simple_background',
    'white_background',
    'upper_body',
    'virtual_youtuber',
    'blush',
    'blush_stickers',
    'animal_ears',
    'bangs',
    'bow',
    'twintails',
    'purple_bow',
]);

function uniqTags(tags: string[]): string[] {
    return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
}

function extractMappedVisualTags(text: string | undefined): string[] {
    if (!text) return [];

    const mapped: string[] = [];
    const source = text.toLowerCase();
    if (/粉色|pink/u.test(source)) mapped.push('pink_hair');
    if (/紫色|purple/u.test(source)) mapped.push('purple_eyes');
    if (/双马尾|twintail/u.test(source)) mapped.push('low_twintails');
    if (/长发|long_hair/u.test(source)) mapped.push('long_hair');
    if (/猫耳|cat_ears/u.test(source)) mapped.push('cat_ears');
    if (/猫娘|cat_girl/u.test(source)) mapped.push('cat_girl');
    if (/眼罩|catmask|catmask_on_head/u.test(source)) mapped.push('catmask_on_head');
    if (/项圈|颈圈|choker/u.test(source)) mapped.push('choker');
    if (/铃铛|bell/u.test(source)) mapped.push('bell');
    if (/蝴蝶结|bow|发饰/u.test(source)) mapped.push('hair_bow');
    return mapped;
}

function buildPersonaAppearanceTags(appearance?: string, clothing?: string, features?: string): string {
    const extracted = getEnglishTagList(appearance);
    const mapped = [
        ...extractMappedVisualTags(appearance),
        ...extractMappedVisualTags(clothing),
        ...extractMappedVisualTags(features),
    ];
    const filteredExtracted = extracted
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
        .filter(tag => !PERSONA_NOISY_TAGS.has(tag));

    return uniqTags([
        ...PERSONA_CORE_TAGS,
        ...filteredExtracted,
        ...mapped,
    ]).join(', ');
}

function getPersonaDrawAppearanceFromText(text: string | undefined): string {
    const visual = sanitizeVisualChineseText(text);
    const tags = buildPersonaAppearanceTags(text);
    return [tags, visual].filter(Boolean).join(', ');
}

/**
 * 获取当前人设的英文外貌标签（用于 AI 绘图）
 * 从 appearance 字段中提取 danbooru 风格标签
 */
export function getPersonaAppearanceTags(): string {
    const persona = cachedPersona || readPersonaSnapshotSync(getCurrentPersonaName()) || getDefaultPersona();
    return buildPersonaAppearanceTags(persona.appearance, persona.clothing, persona.features);
}

/**
 * 获取当前人设的绘图专用描述
 * 仅保留稳定可视特征，避免把主人、QQ群身份等非视觉设定污染进提示词
 */
export function getPersonaDrawAppearance(overrideAppearance?: string): string {
    if (overrideAppearance?.trim()) {
        const visual = getPersonaDrawAppearanceFromText(overrideAppearance);
        if (visual) {
            return visual;
        }
    }

    const persona = cachedPersona || readPersonaSnapshotSync(getCurrentPersonaName()) || getDefaultPersona();
    const visualParts: string[] = [];

    const appearance = sanitizeVisualChineseText(persona.appearance);
    const clothing = sanitizeVisualChineseText(persona.clothing);
    const tags = getPersonaAppearanceTags();

    if (tags) visualParts.push(tags);
    if (appearance) visualParts.push(appearance);
    if (clothing) visualParts.push(clothing);
    if (persona.species?.includes('猫')) visualParts.push('猫娘');
    if (persona.age) visualParts.push(persona.age);

    return visualParts.join('，') || '粉色头发，紫色眼睛，低双马尾，猫耳，猫娘少女';
}

/**
 * 构建机器人自画像的绘图 prompt
 */
export function buildPersonaSelfDrawPrompt(scenePrompt: string, overrideAppearance?: string): string {
    const appearanceText = getPersonaDrawAppearance(overrideAppearance);
    const normalizedScene = scenePrompt
        .replace(/画(一[张个幅]|个|张)?\s*(你自己|你|落落自己|落落本体|落落)/gu, ' ')
        .replace(/把\s*(你自己|你|落落自己|落落)\s*画成/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parts = [
        appearanceText,
        normalizedScene || '自画像',
    ].filter(Boolean);

    return parts.join('，');
}

export type SelfReferenceDrawIntent = 'selfPortrait' | 'personaInspired' | 'none';

export function getSelfReferenceDrawIntent(text: string | undefined): SelfReferenceDrawIntent {
    if (!text) {
        return 'none';
    }

    const normalized = text.trim();
    if (!normalized) {
        return 'none';
    }

    if (/(你自己|画你|画个你|画一下你|画下你|你的样子|你长什么样|落落自己|落落本体|自画像|画落落|落落的样子|落落长什么样|画一下落落|画下落落)/u.test(normalized)) {
        return 'selfPortrait';
    }

    if (/(像你一样|像落落一样|按你的风格|按落落的风格|参考你的样子|参考落落的样子|参考你的人设|参考落落的人设|你这种风格|落落风格|照着你的人设|照着落落的人设)/u.test(normalized)) {
        return 'personaInspired';
    }

    return 'none';
}

export function isSelfReferenceDrawRequest(text: string | undefined): boolean {
    return getSelfReferenceDrawIntent(text) === 'selfPortrait';
}

function getEnglishTagList(text: string | undefined): string {
    if (!text) {
        return '';
    }
    const tagMatches = text.match(/[a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)*/gi);
    if (!tagMatches || tagMatches.length === 0) {
        return '';
    }

    const longestMatch = tagMatches.reduce((a, b) => a.length > b.length ? a : b, '');
    return longestMatch.includes(',') ? longestMatch.trim() : '';
}

/**
 * 获取当前人设名称（同步）
 */
export function getPersonaDisplayName(): string {
    return cachedPersona?.name || '落落';
}

/**
 * 获取缓存的人设数据（同步）
 */
export function getCachedPersona(): PersonaData | null {
    return cachedPersona;
}

