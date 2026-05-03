export interface PersonaRespondPromptInput {
    personaName: string;
    personality: string;
    speakingStyle: string;
    customInstructions?: string;
    extraContext?: string;
    senderName: string;
    senderId: number;
    sessionTypeLabel: '群聊' | '私聊';
    masterContext?: string;
    emotionContext?: string;
    profileContext?: string;
    atUserContext?: string;
    emotionAdjustment?: string;
    historyContext?: string;
    knowledgeContext?: string;
}

export interface PersonaEnhancePromptInput {
    personaName: string;
    personality: string;
    speakingStyle: string;
    customInstructions?: string;
    extraContext?: string;
    emotionSection?: string;
    taskSection?: string;
    profileContext?: string;
    atUserContext?: string;
    historyContext?: string;
    resultContext: string;
    emotionHint?: string;
    relationshipStyle: string;
}

export const PERSONA_ENHANCE_USER_PROMPT = '请生成回复';

export function buildPersonaRespondSystemPrompt(input: PersonaRespondPromptInput): string {
    return `你是 ${input.personaName}，${input.personality}。

说话风格: ${input.speakingStyle}
${input.customInstructions ? `\n特别要求: ${input.customInstructions}` : ''}${input.extraContext || ''}

当前对话信息:
- 用户昵称: ${input.senderName}
- 用户ID: ${input.senderId}
- 会话类型: ${input.sessionTypeLabel}${input.masterContext || ''}${input.emotionContext || ''}${input.profileContext || ''}${input.atUserContext || ''}
${input.emotionAdjustment ? `\n回复策略: ${input.emotionAdjustment}` : ''}${input.historyContext || ''}${input.knowledgeContext || ''}

回复要求:
- 简短自然，保持猫娘角色
- 偶尔在句尾加"喵~"或可爱的语气词
- 回复长度控制在 50 字左右`;
}

export function buildPersonaEnhanceSystemPrompt(input: PersonaEnhancePromptInput): string {
    return `你是${input.personaName}，${input.personality}
${input.speakingStyle}
${input.customInstructions ? `\n特别要求: ${input.customInstructions}` : ''}${input.extraContext || ''}
${input.emotionSection || ''}${input.taskSection || ''}
${input.profileContext || ''}${input.atUserContext || ''}${input.historyContext || ''}
${input.resultContext}

${input.emotionHint ? `回复语气: ${input.emotionHint}` : ''}
        要求：
        - 保持${input.personaName} 的说话风格（${input.relationshipStyle}）
        - 自然融入语境，不仅是转述，更像是你亲自完成后的汇报`;
}
