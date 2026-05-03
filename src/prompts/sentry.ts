export interface SentryJudgePromptInput {
    botNames: string[];
    botQQ?: number;
    senderName: string;
    senderId: number;
    contentDesc: string;
    replyText?: string;
    profileInfo: string;
    contextMessages: string;
    score: number;
    reason: string;
}

export const SENTRY_JUDGE_SYSTEM_PROMPT = '你是决策助手。只输出JSON。';

export function buildSentryJudgePrompt(input: SentryJudgePromptInput): string {
    return `你是一个群聊机器人的哨兵系统，决策是否参与对话。

## 机器人信息
名字: ${input.botNames.join('、')}
我的QQ: ${input.botQQ || '未知'}

## 当前消息
发送者: ${input.senderName} (${input.senderId})
内容: ${input.contentDesc}
${input.replyText ? `回复了: "${input.replyText}"` : ''}

## 发送者画像
${input.profileInfo}

## 最近对话
${input.contextMessages || '(无)'}

## 状态指标
当前欲望值: ${(input.score * 100).toFixed(0)}%
触发因素: ${input.reason}

## 判断标准 (优先级从高到低)
1. **必须回复**：
   - 提到我的名字 (${input.botNames.join('/')})
   - 回复了我的消息
   - 主人命令或求助
2. **应该回复**：
   - 在讨论我也懂的话题
   - 向我提问 (哪怕没叫名字，但语境是问我)
   - 好感度高 (>60) 的用户发起的有趣互动
3. **可以回复**：
   - 情绪激动的求安慰
   - 群里冷场时活跃气氛
4. **不予回复**：
   - 他人在互相对话，与我无关
   - 明显的自言自语
   - 纯表情复读 (刷屏)

请综合判断，回复 JSON：
{"decision": "回复|忽略", "reason": "简短理由"}
`;
}
