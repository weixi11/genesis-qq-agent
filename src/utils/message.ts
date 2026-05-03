/**
 * 消息构建工具
 * 统一消息段类型和链式构建能力
 */

// ==================== 消息段类型定义 ====================

/** 文本消息段 */
export interface TextSegment {
    type: 'text';
    data: { text: string };
}

/** 图片消息段 */
export interface ImageSegment {
    type: 'image';
    data: {
        file: string;       // URL / base64:// / 本地路径
        url?: string;       // 可选的显示 URL
        summary?: string;   // 图片描述（用于无障碍）
    };
}

/** 语音消息段 */
export interface RecordSegment {
    type: 'record';
    data: {
        file: string;
        url?: string;
    };
}

/** 视频消息段 */
export interface VideoSegment {
    type: 'video';
    data: {
        file: string;
        url?: string;
    };
}

/** @用户消息段 */
export interface AtSegment {
    type: 'at';
    data: {
        qq: string;
    };
}

/** QQ表情消息段 */
export interface FaceSegment {
    type: 'face';
    data: {
        id: string;
    };
}

/** 音乐卡片消息段 */
export interface MusicSegment {
    type: 'music';
    data: {
        type: '163' | 'qq' | 'custom';
        id?: string;
        url?: string;
        audio?: string;
        title?: string;
        content?: string;
        image?: string;
    };
}

/** 引用回复消息段 */
export interface ReplySegment {
    type: 'reply';
    data: {
        id: string;
    };
}

/** JSON消息段（小程序/卡片） */
export interface JsonSegment {
    type: 'json';
    data: {
        data: string;
    };
}

/** 统一消息段类型 */
export type MessageSegment =
    | TextSegment
    | ImageSegment
    | RecordSegment
    | VideoSegment
    | AtSegment
    | FaceSegment
    | MusicSegment
    | ReplySegment
    | JsonSegment;

// ==================== 消息构建器 ====================

/**
 * 消息链式构建器
 * 
 * @example
 * const msg = new MessageBuilder()
 *     .text('你好！')
 *     .image('https://example.com/image.png')
 *     .build();
 */
export class MessageBuilder {
    private segments: MessageSegment[] = [];

    /** 添加文本 */
    text(content: string): this {
        if (content) {
            this.segments.push({ type: 'text', data: { text: content } });
        }
        return this;
    }

    /** 添加图片 */
    image(file: string, options?: { url?: string; summary?: string }): this {
        this.segments.push({
            type: 'image',
            data: { file, ...options },
        });
        return this;
    }

    /** 添加语音 */
    record(file: string, url?: string): this {
        this.segments.push({
            type: 'record',
            data: { file, url },
        });
        return this;
    }

    /** 添加视频 */
    video(file: string, url?: string): this {
        this.segments.push({
            type: 'video',
            data: { file, url },
        });
        return this;
    }

    /** 添加 @用户 */
    at(userId: number | 'all'): this {
        this.segments.push({
            type: 'at',
            data: { qq: userId === 'all' ? 'all' : String(userId) },
        });
        return this;
    }

    /** 添加表情 */
    face(faceId: number | string): this {
        this.segments.push({
            type: 'face',
            data: { id: String(faceId) },
        });
        return this;
    }

    /** 添加音乐卡片 */
    music(musicType: '163' | 'qq', id: string): this {
        this.segments.push({
            type: 'music',
            data: { type: musicType, id },
        });
        return this;
    }

    /** 添加自定义音乐卡片 */
    customMusic(options: {
        url: string;
        audio: string;
        title: string;
        content?: string;
        image?: string;
    }): this {
        this.segments.push({
            type: 'music',
            data: { type: 'custom', ...options },
        });
        return this;
    }

    /** 添加引用回复 */
    reply(messageId: number | string): this {
        this.segments.push({
            type: 'reply',
            data: { id: String(messageId) },
        });
        return this;
    }

    /** 添加 JSON 卡片 */
    json(data: string | object): this {
        this.segments.push({
            type: 'json',
            data: { data: typeof data === 'string' ? data : JSON.stringify(data) },
        });
        return this;
    }

    /** 添加已有消息段 */
    add(segment: MessageSegment): this {
        this.segments.push(segment);
        return this;
    }

    /** 添加多个消息段 */
    addAll(segments: MessageSegment[]): this {
        this.segments.push(...segments);
        return this;
    }

    /** 构建消息段数组 */
    build(): MessageSegment[] {
        return [...this.segments];
    }

    /** 是否为空 */
    isEmpty(): boolean {
        return this.segments.length === 0;
    }

    /** 清空 */
    clear(): this {
        this.segments = [];
        return this;
    }
}

// ==================== 便捷工厂函数 ====================

/** 创建文本消息段 */
export function text(content: string): TextSegment {
    return { type: 'text', data: { text: content } };
}

/** 创建图片消息段 */
export function image(file: string, options?: { url?: string; summary?: string }): ImageSegment {
    return { type: 'image', data: { file, ...options } };
}

/** 创建语音消息段 */
export function record(file: string, url?: string): RecordSegment {
    return { type: 'record', data: { file, url } };
}

/** 创建视频消息段 */
export function video(file: string, url?: string): VideoSegment {
    return { type: 'video', data: { file, url } };
}

/** 创建 @用户消息段 */
export function at(userId: number | 'all'): AtSegment {
    return { type: 'at', data: { qq: userId === 'all' ? 'all' : String(userId) } };
}

/** 创建表情消息段 */
export function face(faceId: number | string): FaceSegment {
    return { type: 'face', data: { id: String(faceId) } };
}

/** 创建音乐卡片消息段 */
export function music(musicType: '163' | 'qq', id: string): MusicSegment {
    return { type: 'music', data: { type: musicType, id } };
}

/** 创建引用回复消息段 */
export function reply(messageId: number | string): ReplySegment {
    return { type: 'reply', data: { id: String(messageId) } };
}

/**
 * 格式化文本中的 @提及
 * 将 @QQ 替换为 @昵称(QQ)
 */
export function formatAtMentions(text: string, atDetails?: Array<{ id: number; name: string; card?: string; role?: string }>): string {
    if (!text || !atDetails || atDetails.length === 0) {
        return text;
    }

    let result = text;
    // 先按 ID 长度降序排序，避免部分匹配（虽然QQ号长度通常固定，但保险起见）
    const details = [...atDetails].sort((a, b) => String(b.id).length - String(a.id).length);

    for (const u of details) {
        const name = u.card || u.name || String(u.id);
        const replacement = `@${name}(${u.id})`;

        // 尝试替换 @123456
        // 注意：napcat 可能在 @QQ 后加了空格，也可能没加
        // 这里简单替换所有出现的 @QQ，且排除后面紧跟数字的情况（避免 @123 误替换 @1234）
        const regex = new RegExp(`@${u.id}(?![0-9])`, 'g');
        if (regex.test(result)) {
            result = result.replace(regex, replacement);
        }
    }

    return result;
}
