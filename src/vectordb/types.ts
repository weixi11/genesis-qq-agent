/**
 * VectorDB Type Definitions
 */

/**
 * Embedding API Response (OpenAI compatible)
 */
export interface EmbeddingResponse {
    data: Array<{
        embedding: number[];
        index: number;
        object: string;
    }>;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

/**
 * Memory Table Item
 */
export interface MemoryItem {
    id: string;
    userId: number;
    text: string;
    vector: number[];
    type: 'chat' | 'fact' | 'preference';
    importance: number;
    timestamp: number;
    _distance?: number; // LanceDB search result field
}

/**
 * Knowledge Table Item
 */
export interface KnowledgeItem {
    id: string;
    text: string;
    vector: number[];
    source: string;
    category?: string;
    createdAt: number;
    _distance?: number; // LanceDB search result field
}

/**
 * Profile Table Item
 */
export interface ProfileItem {
    userId: number;
    nickname: string;
    gender?: string;
    ageRange?: string;
    traits: string;       // JSON string
    interests: string;    // JSON string
    favorability: number;
    mood: string;
    messageCount: number;
    lastSeen: number;
    lastAnalyzed: number;
    notes?: string;
    vector: number[];     // Placeholder
    _distance?: number;   // LanceDB search result field
}
