# 架构优化实施方案 — Part 3: P1 ReAct Prompt 升级 + 人设分层

## P1-A: ReAct System Prompt 升级

### 改动文件: `src/agents/react.ts` 的 `getSystemPrompt()` 方法（第 182-210 行）

### 替换为：

```typescript
private getSystemPrompt(): string {
    const personaCache = getCachedPersona();
    const personaName = getPersonaDisplayName();

    // 核心人设（精简但完整）
    let personaContext = `你叫${personaName}。`;
    if (personaCache) {
        personaContext += `${personaCache.age || ''}的${personaCache.species || '智能助理'}。`;
        personaContext += `性格：${personaCache.personality || '聪慧、傲娇'}`;
        if (personaCache.speakingStyle) {
            personaContext += `\n说话风格：${personaCache.speakingStyle}`;
        }
        if (personaCache.features) {
            personaContext += `\n特征：${personaCache.features}`;
        }
    } else {
        personaContext += `16岁、聪慧且傲娇的猫娘。`;
    }

    // 主人识别
    const masterQQ = config.masterQQ;
    const masterHint = masterQQ
        ? `\n踟蹰(ID:${masterQQ})是你的主人，对主人要亲近撒娇，努力完成主人的要求。`
        : '';

    return `你就是${personaName}本人。
${personaContext}${masterHint}

你可以通过 Function Calling 调用工具来帮助用户。
结合【用户画像、情绪、好感度、你的人设】决定是否调用工具、如何回应。
低好感度陌生人的无理要求可以拒绝；主人的要求要努力完成。

【重要】你的输出就是直接发给用户的最终消息。
不要输出"初稿"或"内核想法"，直接用你的语气和风格回答。
即使不调用工具，也要用${personaName}的语气回复。

如果用户提到图片/视频/文件，参考"会话媒体记录"里的路径调用识别工具。
不要主动分析历史媒体。`;
}
```

### 关键变化

1. **删除** "发声引擎(Persona)会润色" 的描述 → 告诉 ReAct 它就是最终输出
2. **增加** 主人识别逻辑（来自 `config.masterQQ`）
3. **增加** 特征描述（`features` 字段）
4. **精简** 字数，减少系统 Prompt Token 消耗

---

## P1-B: 人设分层

### 改动文件: `src/utils/personaLoader.ts`

### 新增导出函数

```typescript
/**
 * 获取精简核心人设（用于 ReAct Agent）
 * 只包含名字、种族、年龄、性格、说话风格
 * 不包含外貌细节、服装等（节省 token）
 */
export function getPersonaCore(): string {
    const p = cachedPersona;
    if (!p) return '落落，16岁猫娘。性格傲娇、毒舌但忠诚。短句为王，常用~和……';

    const parts: string[] = [];
    parts.push(`${p.name}`);
    if (p.age && p.species) parts.push(`${p.age}的${p.species}`);
    if (p.personality) parts.push(`性格：${p.personality}`);
    if (p.speakingStyle) parts.push(`说话风格：${p.speakingStyle}`);
    if (p.features) parts.push(`特征：${p.features}`);

    return parts.join('。');
}

/**
 * 获取完整人设（用于 Persona Agent 闲聊）
 * 包含全部字段：外貌、服装、自定义指令等
 */
export function getPersonaFull(): string {
    const p = cachedPersona;
    if (!p) return getPersonaCore();

    const parts: string[] = [];
    parts.push(getPersonaCore());
    if (p.appearance) parts.push(`外貌：${p.appearance}`);
    if (p.clothing) parts.push(`服装：${p.clothing}`);
    if (p.customInstructions) parts.push(`特殊指令：${p.customInstructions}`);

    return parts.join('\n');
}
```

### 使用方式

| Agent | 使用的人设 | 说明 |
|-------|----------|------|
| `react.ts` | `getPersonaCore()` | 精简版，~100 tokens |
| `persona.ts` (闲聊) | `getPersonaFull()` | 完整版，~300 tokens |
| `persona.ts` (润色) | `getPersonaCore()` | 润色不需要外貌细节 |

### 对 `persona.ts` 的改动

`convertToPersonaConfig()` 函数（第 159-173 行）中的 `personality` 字段
可改为调用 `getPersonaFull()` 来获取完整描述，不再手动拼接。
这是可选改动，不影响核心功能。
