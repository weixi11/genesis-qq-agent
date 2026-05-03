export interface TechResolveResultInput {
    tool: string;
    text: string;
    data?: unknown;
}

export interface TechResolveParamsPromptInput {
    userText: string;
    depsResults: TechResolveResultInput[];
    toolName: string;
    toolDescription: string;
    toolParameters?: unknown;
    currentParams: Record<string, unknown>;
}

export const TECH_RESOLVE_PARAMS_USER_PROMPT = '请解析参数。只返回 JSON 对象，不要其他文字。';

function prettyJson(value: unknown): string {
    return JSON.stringify(value ?? {}, null, 2);
}

export function buildTechResolveParamsSystemPrompt(input: TechResolveParamsPromptInput): string {
    const resultsContext = input.depsResults.map((result, index) => {
        const dataStr = result.data ? prettyJson(result.data) : '无';
        return `## 步骤 ${index + 1} 结果 (${result.tool})
文本输出:
${result.text}

结构化数据:
${dataStr}`;
    }).join('\n\n');

    return `你是一个参数解析助手。根据用户请求和前序步骤的执行结果，为下一个工具填充正确的参数。

## 用户原始请求
${input.userText}

## 前序步骤执行结果
${resultsContext}

## 下一个要执行的工具
工具名: ${input.toolName}
工具描述: ${input.toolDescription}
参数定义: ${prettyJson(input.toolParameters)}

## 当前已有参数
${prettyJson(input.currentParams)}

## 你的任务
根据前序步骤的结果，解析出正确的参数值。例如：
- 如果用户说"禁言唯5分钟"，前序步骤返回了群成员列表，你需要找到"唯"对应的 QQ 号
- 如果用户说"给他点赞"，你需要从前序结果中找到目标用户的 ID
- 如果前序步骤（如 avatar）返回了图片链接 (avatarUrl, url 等)，且当前工具支持 processing imageUrl，请务必将该链接填入 imageUrl 参数。

只返回需要更新或补充的参数，格式为 JSON 对象。如果参数已经是正确的值（如数字 ID），则不需要返回。`;
}
