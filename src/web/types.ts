import type { UserProfile } from '../types.js';

export interface KnowledgeRequest {
    text: string;
    source?: string;
    category?: string;
}

export interface BlacklistRequest {
    type?: 'user' | 'group';
    targetId: string;
    reason?: string;
    listType?: 'black' | 'white';
}

export type UpdateProfileRequest = Partial<UserProfile>;

export interface FeatureUpdateRequest {
    enabled: boolean;
}
