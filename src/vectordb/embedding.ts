/**
 * Embedding 服务
 * 使用 LLM API 生成文本向量
 */

import { config } from '../config.js';
import { log } from '../logger.js';
import type { EmbeddingResponse } from './types.js';

function getEmbeddingConfig() {
    return {
        baseUrl: config.embeddingLlm.baseUrl,
        apiKey: config.embeddingLlm.apiKey,
        model: config.embeddingLlm.model,
    };
}

/**
 * 向量维度配置
 * - text-embedding-3-small: 1536
 * - text-embedding-3-large: 3072
 * - all-MiniLM-L6-v2: 384
 * - 阿里/智谱模型: 通常 768 或 1024
 */
export const VECTOR_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || '768', 10);

/**
 * 生成文本的向量表示
 * 
 * 注意：yuanplus.chat API 代理对短查询可能返回缓存结果。
 * 但由于存储和查询都使用相同的 embedding 函数，即使缓存也能匹配。
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const embeddingConfig = getEmbeddingConfig();
    const url = `${embeddingConfig.baseUrl.replace(/\/+$/, '')}/embeddings`;

    // 记录请求（调试用）
    log.debug(`🔢 Embedding 请求: input="${text.slice(0, 30)}..." (len=${text.length})`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${embeddingConfig.apiKey}`,
                'Cache-Control': 'no-cache, no-store',
            },
            body: JSON.stringify({
                model: embeddingConfig.model,
                input: text,
            }),
        });

        if (!response.ok) {
            throw new Error(`Embedding API 错误: ${response.status}`);
        }

        const data = await response.json() as EmbeddingResponse;
        const embedding = data.data?.[0]?.embedding;

        if (!embedding || !Array.isArray(embedding)) {
            throw new Error('Embedding 响应格式错误');
        }

        // Debug: log vector stats
        const sum = embedding.reduce((a, b) => a + b, 0);
        const nonZero = embedding.filter(v => v !== 0).length;
        log.debug(`🔢 Embedding 响应: dim=${embedding.length}, sum=${sum.toFixed(4)}, first3=[${embedding.slice(0, 3).map(v => v.toFixed(4)).join(',')}]`);

        return embedding;
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error('生成 Embedding 失败:', error.message);
        throw error;
    }
}

/**
 * 批量生成向量
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddingConfig = getEmbeddingConfig();
    const url = `${embeddingConfig.baseUrl.replace(/\/+$/, '')}/embeddings`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            cache: 'no-store',  // 禁用 HTTP 缓存
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${embeddingConfig.apiKey}`,
                'Cache-Control': 'no-cache, no-store',  // 防止代理缓存
            },
            body: JSON.stringify({
                model: embeddingConfig.model,
                input: texts,
            }),
        });

        if (!response.ok) {
            throw new Error(`Embedding API 错误: ${response.status}`);
        }

        const data = await response.json() as EmbeddingResponse;
        const embeddings = data.data?.map((d) => d.embedding);

        if (!embeddings || !Array.isArray(embeddings)) {
            throw new Error('Embedding 响应格式错误');
        }

        return embeddings;
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error('批量生成 Embedding 失败:', error.message);
        throw error;
    }
}
