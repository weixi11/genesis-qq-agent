# Genesis TypeScript 开发规范

> **版本**: 1.0.0  
> **生效日期**: 2026-01-10  
> **适用范围**: Genesis 项目全部 TypeScript 代码

本规范基于 2026-01-10 代码审计报告制定，每条规则均对应项目中实际存在的问题。**所有新代码必须遵守本规范，存量代码应逐步重构达标。**

---

## 1. 核心原则 (Core Principles)

### 1.1 配置分离 (Configuration Separation)

**所有可变值必须通过配置注入，禁止硬编码**。包括但不限于：
- API 密钥、Token
- 用户 ID（管理员、主人等）
- 服务端点 URL
- 功能开关

### 1.2 严格类型 (Strict Typing)

**利用 TypeScript 类型系统，编译期捕获错误**。要求：
- 显式定义所有函数参数和返回值类型
- 禁止 `any` 类型逃逸到业务逻辑
- 外部数据必须通过类型守卫或 Schema 校验

### 1.3 单一职责 (Single Responsibility)

**每个模块/函数只做一件事**。要求：
- 函数行数不超过 80 行
- 避免 3 层以上的条件嵌套
- 复杂逻辑拆分为多个职责单一的辅助函数

### 1.4 DRY 原则 (Don't Repeat Yourself)

**消除重复代码**。要求：
- 相似逻辑超过 3 处必须抽取为公共函数
- 使用工厂模式消除重复实例化
- 常量值定义一次，全局引用

---

## 2. 零容忍规则 (Zero Tolerance)

以下规则违反将导致 **Code Review 直接拒绝**。

### 2.1 严禁硬编码密钥

#### ❌ 反面案例

```typescript
// ❌ 错误示例 - 来自 tools/weather.ts L14-15
const API_HOST = 'kw36x5kap5.re.qweatherapi.com';
const API_KEY = 'cd4b7595d5424b54919516bcedea2ce1';  // 密钥泄露！
```

#### ✅ 正确写法

```typescript
// ✅ 正确示例 - 从环境变量获取
// .env
QWEATHER_API_HOST=kw36x5kap5.re.qweatherapi.com
QWEATHER_API_KEY=cd4b7595d5424b54919516bcedea2ce1

// config.ts
export const config = {
    qweather: {
        host: process.env.QWEATHER_API_HOST || '',
        apiKey: process.env.QWEATHER_API_KEY || '',
    },
};

// weather.ts
import { config } from '../config.js';
const API_HOST = config.qweather.host;
const API_KEY = config.qweather.apiKey;
```

---

### 2.2 严禁硬编码用户 ID

#### ❌ 反面案例

```typescript
// ❌ 错误示例 - 来自 sentry.ts L284, persona.ts L176
const isMaster = msg.sender_id === 2148941548;

// ❌ 错误示例 - 来自 persona.ts L67
personality: `...踟蹰(QQ:2148941548)是落落的主人...`,
```

#### ✅ 正确写法

```typescript
// config.ts - 添加配置项
export interface Config {
    masterQQ: number;  // 主人 QQ 号
    // ...
}

export const config: Config = {
    masterQQ: parseInt(process.env.MASTER_QQ || '0', 10),
    // ...
};

// utils/identity.ts - 创建工具函数
import { config } from '../config.js';

export function isMaster(userId: number): boolean {
    return userId === config.masterQQ;
}

// 业务代码中使用
import { isMaster } from '../utils/identity.js';

if (isMaster(msg.sender_id)) {
    // 主人专属逻辑
}
```

---

### 2.3 严禁滥用 `any` 类型

#### ❌ 反面案例

```typescript
// ❌ 错误示例 - 来自 sentry.ts L299-303, memory.ts L164-176
if ((msg as any).images?.length) mediaParts.push(`[图片]`);
if ((msg as any).videos?.length) mediaParts.push(`[视频]`);
if ((msg as any).records?.length) mediaParts.push(`[语音]`);

// ❌ 错误示例 - 来自 tech.ts L250
const atIds = (message as any).at_users?.map((u: any) => u.qq) || [];
```

#### ✅ 正确写法

```typescript
// types.ts - 完善类型定义
export interface MediaImage {
    file?: string;
    url?: string;
    path?: string;
}

export interface FormattedMessage {
    // 基础字段
    message_id: number;
    sender_id: number;
    sender_name: string;
    text?: string;
    
    // 媒体字段 - 完整定义，不再需要 as any
    images: MediaImage[];
    videos: MediaImage[];
    records: { file?: string; url?: string }[];
    files: { name: string; size: number; url?: string }[];
    cards: { title?: string; desc?: string; url?: string }[];
    
    // @ 相关
    at_users: number[];
    at_all: boolean;
    
    // 其他...
}

// 业务代码 - 直接使用类型安全的字段
if (msg.images.length > 0) {
    mediaParts.push(`[图片x${msg.images.length}]`);
}
```

---

### 2.4 严禁未校验的 JSON 解析

#### ❌ 反面案例

```typescript
// ❌ 错误示例 - 直接断言，无运行时校验
const result = JSON.parse(jsonMatch[0]) as ToolAnalysis;
```

#### ✅ 正确写法

```typescript
// 方案 A：手动校验
function parseToolAnalysis(raw: string): ToolAnalysis | null {
    try {
        const data = JSON.parse(raw);
        if (typeof data.needsTool !== 'boolean') return null;
        if (!Array.isArray(data.tools)) return null;
        return data as ToolAnalysis;
    } catch {
        return null;
    }
}

// 方案 B：使用 Zod（推荐）
import { z } from 'zod';

const ToolAnalysisSchema = z.object({
    tools: z.array(z.object({
        name: z.enum(['weather', 'like', 'profile', 'poke', 'vision', 'draw', 'none']),
        params: z.record(z.unknown()),
    })),
    needsTool: z.boolean(),
    directReply: z.string().optional(),
});

const result = ToolAnalysisSchema.safeParse(JSON.parse(raw));
if (result.success) {
    // result.data 是类型安全的 ToolAnalysis
}

---

### 2.5 工具必须使用独立 API 配置

**每个需要调用外部 API 的工具，必须拥有独立的 API 配置**。禁止多个工具共用同一个 API 配置，以避免单点故障导致多个工具同时不可用。

#### ❌ 反面案例

```typescript
// ❌ 错误示例 - 多个工具共用 visionLlm 配置
// read_audio.ts
const cfg = config.visionLlm;  // 共用 vision 配置

// read_video.ts  
const cfg = config.visionLlm;  // 共用 vision 配置

// read_file.ts
const llm = visionLlm || mainLlm;  // 共用 vision 配置

// 问题：visionLlm API 挂掉 → 音频、视频、文件、识图全部不可用！
```

#### ✅ 正确写法

```typescript
// config.ts - 每个工具独立配置
export interface Config {
    // ... 其他配置 ...
    
    // 每个工具独立的 LLM 配置
    visionLlm: LlmConfig;  // 识图工具专用
    audioLlm: LlmConfig;   // 音频分析工具专用
    videoLlm: LlmConfig;   // 视频分析工具专用
    fileLlm: LlmConfig;    // 文件分析工具专用
    drawLlm: LlmConfig;    // 绘图工具专用
}

// 配置实现 - 独立环境变量
audioLlm: {
    baseUrl: process.env.AUDIO_LLM_BASE_URL || process.env.LLM_BASE_URL || '...',
    apiKey: process.env.AUDIO_LLM_API_KEY || process.env.LLM_API_KEY || '',
    model: process.env.AUDIO_LLM_MODEL || 'gemini-3-flash-preview',
},

// read_audio.ts - 使用独立配置
const cfg = config.audioLlm;  // 独立配置，不影响其他工具

// read_video.ts - 使用独立配置
const cfg = config.videoLlm;  // 独立配置，不影响其他工具
```
可以在 **2.5** 后面直接补充一个 **2.6**，强调「凡是使用 LLM 的地方都必须独立配置 API」，并把范围从“工具”扩大到“任何 LLM 使用场景（工具 / 服务 / 模块 / fallback）”。

下面是一版**风格、力度与 2.5 保持一致**、可直接粘贴的 2.6：

---

### 2.6 每个使用 LLM 的模块都必须独立配置 API

**凡是直接或间接调用 LLM 的模块（工具、服务、子流程、fallback 逻辑等），都必须拥有独立的 API 配置**。
禁止多个模块共用同一个 LLM 配置对象或实例（包括主 LLM、fallback LLM、vision LLM 等）。

这样可以避免：

* 单一 API 故障导致**大面积功能失效**
* 不同场景的 **QPS / Token / 计费 / 模型能力** 相互影响
* 后续 **独立降级、切换模型或限流** 无法实施

#### ❌ 反面案例

```typescript
// ❌ 错误示例 - 多个模块共用 mainLlm
// summarize.ts
const llm = config.mainLlm;

// translate.ts
const llm = config.mainLlm;

// rag_answer.ts
const llm = mainLlm || backupLlm;

// 问题：
// 1. mainLlm 挂掉 → 总结 / 翻译 / RAG 全部不可用
// 2. 某模块高并发 → 拖垮所有功能
```

#### ✅ 正确写法

```typescript
// config.ts - 每个 LLM 使用场景独立配置
export interface Config {
  // 通用能力
  chatLlm: LlmConfig;        // 普通对话
  summarizeLlm: LlmConfig;   // 总结
  translateLlm: LlmConfig;   // 翻译
  ragLlm: LlmConfig;         // RAG 问答
  fallbackLlm: LlmConfig;    // 兜底 / 降级
}
```

```typescript
// 独立环境变量，允许回退但不强制共用
summarizeLlm: {
  baseUrl: process.env.SUMMARIZE_LLM_BASE_URL || process.env.LLM_BASE_URL || '',
  apiKey: process.env.SUMMARIZE_LLM_API_KEY || process.env.LLM_API_KEY || '',
  model: process.env.SUMMARIZE_LLM_MODEL || 'gpt-4.1-mini',
},
```

```typescript
// summarize.ts
const cfg = config.summarizeLlm; // 仅影响总结功能

// translate.ts
const cfg = config.translateLlm; // 仅影响翻译功能
```

#### 📌 统一原则

* **一个 LLM 使用场景 = 一套独立配置**
* **配置可以继承默认值，但实例必须独立**
* **不得在代码中复用同一个 LLM client / config 对象**

> ✅ 即使使用相同模型、相同厂商，也必须在配置层面保持独立

---

#### 📋 配置模板

每个需要外部 API 的工具应在 `config.ts` 中添加：

```typescript
// Config 接口
xxxLlm: LlmConfig;  // xxx 工具专用

// 配置实现
xxxLlm: {
    baseUrl: process.env.XXX_LLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.XXX_LLM_API_KEY || process.env.LLM_API_KEY || '',
    model: process.env.XXX_LLM_MODEL || 'default-model',
},
```

并在 `.env` 中添加：

```bash
# xxx 工具 LLM (独立配置)
XXX_LLM_BASE_URL=https://your-api.com/v1
XXX_LLM_API_KEY=sk-your-api-key
XXX_LLM_MODEL=your-model
```

#### 🎯 设计原则

1. **故障隔离**：一个工具的 API 失效不影响其他工具
2. **灵活切换**：可以为不同工具使用不同的 API 提供商
3. **成本优化**：可以为不同工具配置不同性价比的模型
4. **默认回退**：未配置时回退到主 `LLM_*` 配置

---

## 3. 代码风格与最佳实践

### 3.1 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 变量/函数 | camelCase | `senderId`, `formatMessage()` |
| 类/接口/类型 | PascalCase | `FormattedMessage`, `LLMClient` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `API_TIMEOUT_MS` |
| 私有成员 | 前缀 `#` 或 `private` | `#cache`, `private config` |
| 布尔变量 | is/has/should 前缀 | `isConnected`, `hasPermission` |

#### ❌ 禁止混用风格

```typescript
// ❌ 来自 types.ts - 混用下划线和驼峰
interface FormattedMessage {
    sender_id: number;    // 下划线
    senderName: string;   // 驼峰 (假设)
}
```

#### ✅ 统一规范

对于外部 API 返回的下划线命名，在边界层转换：

```typescript
// 边界层转换
function normalizeMessage(raw: RawMessage): FormattedMessage {
    return {
        senderId: raw.sender_id,
        senderName: raw.sender_name,
        // ...
    };
}
```

---

### 3.2 函数复杂度控制

| 指标 | 上限 | 参考案例 |
|------|------|---------|
| 函数行数 | 80 行 | `handleDebouncedMessage` 245 行 ❌ |
| 嵌套深度 | 3 层 | `switch > if > if > if` ❌ |
| 圈复杂度 | 10 | 多个相似 if-else 分支应重构 |

#### ❌ 反面案例

```typescript
// ❌ 来自 index.ts - handleDebouncedMessage 函数过长
async function handleDebouncedMessage(debounced: DebouncedMessage): Promise<void> {
    // ... 245 行代码 ...
}
```

#### ✅ 正确做法

```typescript
// 拆分为多个职责单一的函数
async function handleDebouncedMessage(debounced: DebouncedMessage): Promise<void> {
    const msg = await prepareMessage(debounced);
    
    if (await handleAdminCommandIfNeeded(msg)) return;
    
    const emotion = await analyzeEmotionIfAvailable(msg);
    const decision = await evaluateSentryDecision(msg, emotion);
    
    if (!decision.shouldRespond) return;
    
    const response = await generateResponse(msg, emotion, decision);
    await sendAndRecordResponse(msg, response);
}

// 每个子函数职责单一，行数控制在 30 行以内
async function prepareMessage(debounced: DebouncedMessage): Promise<PreparedMessage> { /* ... */ }
async function handleAdminCommandIfNeeded(msg: PreparedMessage): Promise<boolean> { /* ... */ }
// ...
```

---

### 3.3 工厂模式应用

#### ❌ 反面案例

```typescript
// ❌ 来自 llm.ts L261-307 - 重复实例化 7 次
export const llm = new LLMClient(config.llm.baseUrl, config.llm.apiKey, config.llm.model);
export const sentryLlm = new LLMClient(config.sentryLlm.baseUrl, config.sentryLlm.apiKey, config.sentryLlm.model);
export const routerLlm = new LLMClient(config.routerLlm.baseUrl, config.routerLlm.apiKey, config.routerLlm.model);
// ... 重复 4 次更多 ...
```

#### ✅ 正确做法

```typescript
// 工厂函数
function createLlmClient(cfg: LlmConfig): LLMClient {
    return new LLMClient(cfg.baseUrl, cfg.apiKey, cfg.model);
}

// 类型安全的客户端映射
type LlmClientName = 'main' | 'sentry' | 'router' | 'vision' | 'profiler' | 'persona' | 'tech';

const llmConfigMap: Record<LlmClientName, LlmConfig> = {
    main: config.llm,
    sentry: config.sentryLlm,
    router: config.routerLlm,
    vision: config.visionLlm,
    profiler: config.profilerLlm,
    persona: config.personaLlm,
    tech: config.techLlm,
};

// 统一创建
export const llmClients = Object.fromEntries(
    Object.entries(llmConfigMap).map(([name, cfg]) => [name, createLlmClient(cfg)])
) as Record<LlmClientName, LLMClient>;

// 使用方式
import { llmClients } from './llm.js';
await llmClients.sentry.ask(prompt);
```

---

### 3.4 魔法数字处理

#### ❌ 反面案例

```typescript
// ❌ 来自 sentry.ts - 未命名的数值
const bonus = Math.min(0.3, (userState.messageCount - 1) * 0.1);
if (now - state.lastMessageTime > 120000) { ... }  // 120000 是什么？
```

#### ✅ 正确做法

```typescript
// 定义命名常量
const SENTRY_CONFIG = {
    /** 追问累加系数 - 每次追问增加 10% 欲望值 */
    QUESTION_BONUS_RATE: 0.1,
    /** 追问累加上限 */
    QUESTION_BONUS_MAX: 0.3,
    /** 活跃用户过期时间（毫秒）- 2 分钟 */
    ACTIVE_USER_EXPIRE_MS: 2 * 60 * 1000,
} as const;

// 使用
const bonus = Math.min(
    SENTRY_CONFIG.QUESTION_BONUS_MAX,
    (userState.messageCount - 1) * SENTRY_CONFIG.QUESTION_BONUS_RATE
);

if (now - state.lastMessageTime > SENTRY_CONFIG.ACTIVE_USER_EXPIRE_MS) { ... }
```

---

## 4. 工具链配置

### 4.1 ESLint 配置 (`.eslintrc.cjs`)

```javascript
module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    plugins: ['@typescript-eslint'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:@typescript-eslint/recommended-requiring-type-checking',
    ],
    rules: {
        // ===== 零容忍规则 =====
        
        // 禁止 any 类型
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        
        // 强制显式返回类型
        '@typescript-eslint/explicit-function-return-type': ['error', {
            allowExpressions: true,
            allowTypedFunctionExpressions: true,
        }],
        
        // 禁止魔法数字
        '@typescript-eslint/no-magic-numbers': ['warn', {
            ignore: [0, 1, -1, 2, 10, 100, 1000],
            ignoreArrayIndexes: true,
            ignoreEnums: true,
            ignoreReadonlyClassProperties: true,
        }],
        
        // ===== 代码风格 =====
        
        // 统一命名规范
        '@typescript-eslint/naming-convention': [
            'error',
            { selector: 'default', format: ['camelCase'] },
            { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
            { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
            { selector: 'typeLike', format: ['PascalCase'] },
            { selector: 'enumMember', format: ['UPPER_CASE'] },
        ],
        
        // 函数复杂度
        'complexity': ['warn', { max: 10 }],
        'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
        'max-depth': ['warn', { max: 3 }],
        
        // ===== 最佳实践 =====
        
        // 禁止未使用的变量
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        
        // 必须处理 Promise
        '@typescript-eslint/no-floating-promises': 'error',
        
        // 禁止非空断言
        '@typescript-eslint/no-non-null-assertion': 'warn',
    },
};
```

### 4.2 TypeScript 配置增强 (`tsconfig.json`)

```json
{
    "compilerOptions": {
        "strict": true,
        "noImplicitAny": true,
        "strictNullChecks": true,
        "noImplicitReturns": true,
        "noFallthroughCasesInSwitch": true,
        "noUncheckedIndexedAccess": true,
        "exactOptionalPropertyTypes": true
    }
}
```

### 4.3 Pre-commit Hook (`.husky/pre-commit`)

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# 运行 ESLint 检查
npx eslint src/ --max-warnings=0

# 运行类型检查
npx tsc --noEmit

# 检查是否有硬编码密钥
if grep -rE "(API_KEY|SECRET|PASSWORD)\s*=\s*['\"][^'\"]+['\"]" src/; then
    echo "❌ 检测到硬编码密钥！请迁移到环境变量。"
    exit 1
fi
```

---

## 5. 附录

### 5.1 类型定义模板

```typescript
// types/message.ts

/** 媒体图片 */
export interface MediaImage {
    file?: string;
    url?: string;
    path?: string;
}

/** 媒体文件 */
export interface MediaFile {
    name: string;
    size: number;
    url?: string;
}

/** 引用消息 */
export interface ReplyMessage {
    message_id: number;
    sender_id: number;
    sender_name?: string;
    text?: string;
    time?: number;
    media?: {
        images?: MediaImage[];
        videos?: MediaImage[];
        records?: { file?: string; url?: string }[];
        files?: MediaFile[];
    };
}

/** 格式化消息（完整类型） */
export interface FormattedMessage {
    message_id: number;
    time: number;
    time_str?: string;
    type: 'group' | 'private';
    self_id?: number;
    summary?: string;
    
    // 发送者信息
    sender_id: number;
    sender_name: string;
    sender_role?: 'owner' | 'admin' | 'member';
    
    // 群相关
    group_id?: number;
    
    // 内容
    text?: string;
    reply?: ReplyMessage;
    
    // 媒体（完整定义，无需 as any）
    images: MediaImage[];
    videos: MediaImage[];
    records: { file?: string; url?: string }[];
    files: MediaFile[];
    cards: { title?: string; desc?: string; url?: string }[];
    mface_urls: string[];
    
    // @ 相关
    at_users: number[];
    at_all: boolean;
}
```
**本规范由团队共同制定，如有疑问或建议请提交 Issue 讨论。**
