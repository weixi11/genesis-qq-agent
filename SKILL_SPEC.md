# Genesis 工具开发规范

> **版本**: 1.6.0  
> **更新日期**: 2026-04-25  
> **适用范围**: `src/tools/` 目录下的所有工具

---

## 目录结构

每个工具是一个独立目录，包含以下文件：

```
src/tools/
├── weather/                    # 工具目录
│   ├── index.ts               # 🔴 必需 - 主入口
│   ├── schema.ts              # 🔴 必需 - Function Calling Schema
│   ├── config.ts              # 🟡 建议 - 配置管理
│   └── weather.skills.yaml    # 🟡 可选 - 元数据
├── loader.ts                   # 框架：工具加载器
├── executor.ts                 # 框架：工具执行器
├── types.ts                    # 框架：类型定义
└── index.ts                    # 框架：统一导出
```

---

## Bot 技能自进化与管理 (Self-Evolution)

Genesis 框架内置了强大的自我进化能力，Bot 可以在运行时通过 LLM 自行开发、修改和修复工具，**无需手动修改代码或重启项目**。这些操作由特定的内部管理工具实现，**仅限主人 (Master) 使用**。

### 1. 技能创建 (`create_skill`)
当主人向 Bot 提出 "给自己写一个 xxx 工具" 时触发。
- **工作机制**: LLM 会严格按照本 `SKILL_SPEC.md` 规范，生成完整的 `schema.ts`, `config.ts`, `index.ts` 代码，并自动写入 `src/tools/<name>/` 目录下。
- **生效方式**: 依靠工具加载器的**热重载 (Hot Reload)** 功能，新写入的工具会被自动编译并加载，立即可用。

### 2. 技能管理 (`manage_skill`)
用于管理已存在的工具，支持以下操作：
- **list**: 列出目前安装的所有技能。
- **inspect**: 读取指定工具的源代码供参考。
- **modify**: 根据主人的需求，读取指定工具的源码并交由 LLM 进行修改（如添加新功能），随后覆盖原文件并热重载。
- **fix**: 从报错信息或问题描述中学习，修复指定工具的 Bug。

> **⚠️ 注意事项**:
> 1. 为了防止误操作导致核心功能瘫痪，`create_skill` 和 `manage_skill` 等基础框架工具已被加入**保护名单**，不可通过 `manage_skill` 进行自我修改。
> 2. 生成和修改代码使用了专门的 LLM 配置（如指向本地的 Codex 或高阶推理模型），可在各工具的 `config.ts` 中配置独立的 API 密钥或通过环境变量覆盖。
> 3. 由于系统依赖 `tsx watch` 和内置的文件监听器，所有变更会瞬间在内存中更新。

---

## 快速开始

创建新工具只需 4 步：

### 1️⃣ 创建目录和 Schema

```typescript
// src/tools/my_tool/schema.ts
import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'my_tool',
    description: '工具描述（LLM 可见，决定何时调用此工具）',
    parameters: {
        type: 'object',
        properties: {
            param1: { type: 'string', description: '参数说明' },
        },
        required: ['param1'],
    },
};
```

### 2️⃣ 创建配置文件

```typescript
// src/tools/my_tool/config.ts
export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        const envEnabled = process.env.MODULE_MY_TOOL_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_MY_TOOL_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),
    
    // 其他 API 配置...
    
    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.MY_TOOL_TIMEOUT_MS || '30000', 10),
    
    /** 最大并发数 */
    concurrency: parseInt(process.env.MY_TOOL_CONCURRENCY || '5', 10),
};
```

### 3️⃣ 实现主入口

```typescript
// src/tools/my_tool/index.ts
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'my_tool';
export const description = '工具描述';
export const keywords = ['关键词1', '关键词2'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 工具逻辑
    return { success: true, text: '执行结果' };
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
```

### 4️⃣ 配置环境变量

```bash
# .env
MODULE_MY_TOOL_ENABLED=true
MY_TOOL_TIMEOUT_MS=30000
MY_TOOL_CONCURRENCY=5
```

---

## 工具如何被 Bot 看见

工具目录写好后，并不代表一定会被 Bot 使用，实际生效链路如下：

1. `src/tools/<tool>/` 下的工具会被加载器扫描并注册。
2. 只有 `enabled()` 返回 `true` 的工具，才会进入 `getEnabledModules()`。
3. 已启用工具的 `schema` / `description` 会通过 `getModuleSchemas()`、`getModuleBriefs()` 暴露给 LLM。
4. Function Calling 阶段默认使用 `tool_choice: 'auto'`，由模型在已启用工具中自行选择。

这意味着：

- `schema.description` 必须清楚描述使用边界，尤其是和其他工具能力重叠时。
- 如果工具存在明显规则路由，还要同步检查 `src/agents/router.ts` 和 `src/group_aggregator.ts`。
- 例如当前绘图能力中，`banana_draw` 与 `draw` 并不完全依赖 LLM 自选，部分请求会先被规则层直接分流。

---

## 核心接口

### Tool（必须导出）

```typescript
interface Tool {
    name: string;                          // 工具唯一标识
    description: string;                   // 工具描述
    keywords: string[];                    // 触发关键词
    enabled: () => boolean;                // 是否启用
    schema: ToolSchema;                    // Function Calling Schema
    execute: ToolExecuteFn;                // 执行函数
    getTaskConfig?: () => ToolTaskConfig;  // 任务配置（可选但建议实现）
}
```

### ToolContext（执行上下文）

```typescript
interface ToolContext {
    senderId: number;                      // 发送者 QQ
    groupId?: number;                      // 群 ID（私聊时 undefined）
    imageUrls?: string[];                  // 图片 URL 列表
    videoPaths?: string[];                 // 视频路径列表
    audioPaths?: string[];                 // 音频路径列表
    filePaths?: string[];                  // 文件路径列表
    atUsers?: number[];                    // @的用户 ID
    targetUser?: number;                   // 目标用户 ID
    senderRole?: 'owner' | 'admin' | 'member';
}
```

### ToolResult（执行结果）

```typescript
interface ToolResult {
    success: boolean;                      // 是否成功
    text: string;                          // 工具原始结果文本（会再进入 Persona 润色）
    segments?: MessageSegment[];           // 消息段（图片/音乐卡片等）
    files?: Array<{ path: string; name?: string }>; // 通过 QQ 文件接口上传的本地文件
    data?: Record<string, unknown>;        // 附加数据
}
```

### ToolResult 文本规范

- `text` 默认视为“工具执行结果草稿”，不是最终发给用户的成品文案。
- 常规工具返回的 `text` 会进入 `responseEnhancer -> persona.enhanceToolResult()`，再转成带人格的最终回复。
- 因此工具层不要硬编码过强的人设口癖，例如 `画好啦喵~`、`处理完成喵~`、`我帮你看完啦`。优先返回事实结果、错误原因、必要摘要。
- 如果工具需要给富媒体结果补一条简短说明，优先放在 `data.message`，用于“媒体已发送后的人格化汇报”。
- 失败时也应返回清晰、可诊断的错误文本，主流程会再做人设化转述；不要只返回笼统的“失败了”。

推荐：

```typescript
return {
    success: true,
    text: remoteUrl ? `图片已生成\n${remoteUrl}` : '图片已生成',
    data: { message: '图片已经生成好了' },
    segments,
};
```

不推荐：

```typescript
return {
    success: true,
    text: '🍌 Banana 处理完成喵~',
    segments,
};
```

### ToolTaskConfig（任务配置）

```typescript
interface ToolTaskConfig {
    timeoutMs: number;                     // 超时时间（毫秒）
    concurrency: number;                   // 最大并发数
}
```

> **说明**: 任务配置用于 `TaskManager` 和 `TaskQueue`，控制工具执行的超时和并发限制。

---

## Schema 编写规范

Schema 决定 LLM 何时调用工具以及如何提取参数：

```typescript
export const schema: ToolSchema = {
    name: 'weather',
    description: '查询天气预报。当用户询问某个城市的天气时调用。',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: '城市名称，如"北京"、"上海"',
            },
            date: {
                type: 'string',
                enum: ['today', 'tomorrow', '3days'],
                description: '查询日期',
            },
        },
        required: ['location'],
    },
};
```

### 参数类型

| 类型      | 说明   | 示例           |
| --------- | ------ | -------------- |
| `string`  | 字符串 | 城市名、提示词 |
| `number`  | 数字   | 数量、索引     |
| `integer` | 整数   | 用户 ID        |
| `boolean` | 布尔值 | 开关选项       |
| `array`   | 数组   | 需配合 `items` |

---

## 配置规范

遵循项目开发规范，**每个工具独立配置**。

### 基础配置模板

```typescript
// config.ts - 所有工具必备
export const config = {
    /** 是否启用模块 */
    enabled: (() => {
        // 优先使用新命名，兼容旧命名
        const envEnabled = process.env.MODULE_XXX_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_XXX_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        return value !== 'false' && value !== '0';
    })(),
    
    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.XXX_TIMEOUT_MS || '30000', 10),
    
    /** 最大并发数 */
    concurrency: parseInt(process.env.XXX_CONCURRENCY || '5', 10),
};
```

### 外部 API 配置模板

```typescript
// config.ts - 调用外部 API 的工具
export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_WEATHER_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_WEATHER_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        const apiKey = process.env.QWEATHER_API_KEY;
        // 必须有 API Key 才能启用
        return (value !== 'false' && value !== '0') && !!apiKey;
    })(),
    
    /** API 域名（工具独立配置，故障隔离） */
    apiHost: process.env.QWEATHER_API_HOST || '',
    
    /** API Key */
    apiKey: process.env.QWEATHER_API_KEY || '',
    
    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.WEATHER_TIMEOUT_MS || '10000', 10),
    
    /** 最大并发数 */
    concurrency: parseInt(process.env.WEATHER_CONCURRENCY || '5', 10),
};
```

### LLM 工具配置模板

```typescript
// config.ts - 调用 LLM 的工具（vision/draw/read_audio 等）
export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_VISION_ENABLED?.toLowerCase();
        const oldEnabled = process.env.TOOL_VISION_ENABLED?.toLowerCase();
        const value = envEnabled ?? oldEnabled;
        // 独立 API Key，可回退到主 LLM
        const apiKey = process.env.VISION_LLM_API_KEY || process.env.LLM_API_KEY;
        return (value !== 'false' && value !== '0') && !!apiKey;
    })(),
    
    /** LLM API 地址（独立配置，可回退） */
    baseUrl: process.env.VISION_LLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    
    /** LLM API 密钥（独立配置，可回退） */
    apiKey: process.env.VISION_LLM_API_KEY || process.env.LLM_API_KEY || '',
    
    /** LLM 模型名 */
    model: process.env.VISION_LLM_MODEL || 'gemini-3-flash-preview',
    
    /** 最大文件大小（字节） */
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || '20971520', 10),
    
    /** 任务超时时间（毫秒） */
    timeoutMs: parseInt(process.env.VISION_TIMEOUT_MS || '60000', 10),
    
    /** 最大并发数 */
    concurrency: parseInt(process.env.VISION_CONCURRENCY || '3', 10),
};
```

### 环境变量命名规范

| 类型           | 格式                  | 示例                              |
| -------------- | --------------------- | --------------------------------- |
| 启用开关       | `MODULE_XXX_ENABLED`  | `MODULE_WEATHER_ENABLED=true`     |
| 启用开关（旧） | `TOOL_XXX_ENABLED`    | `TOOL_WEATHER_ENABLED=true`       |
| 超时时间       | `XXX_TIMEOUT_MS`      | `WEATHER_TIMEOUT_MS=10000`        |
| 并发数         | `XXX_CONCURRENCY`     | `WEATHER_CONCURRENCY=5`           |
| 外部 API Key   | `SERVICENAME_API_KEY` | `QWEATHER_API_KEY=xxx`            |
| LLM Base URL   | `XXX_LLM_BASE_URL`    | `VISION_LLM_BASE_URL=https://...` |
| LLM API Key    | `XXX_LLM_API_KEY`     | `VISION_LLM_API_KEY=sk-xxx`       |
| LLM 模型       | `XXX_LLM_MODEL`       | `VISION_LLM_MODEL=gpt-4o`         |

> **设计原则**:
>
> 1. **故障隔离**: 每个工具独立配置，一个 API 失效不影响其他工具
> 2. **灵活切换**: 可为不同工具使用不同 API 提供商
> 3. **成本优化**: 可为不同工具配置不同性价比的模型
> 4. **默认回退**: 未设置时回退到主 `LLM_*` 配置

---

## 消息段（MessageSegment）

用于发送富媒体内容：

```typescript
// 文本
{ type: 'text', data: { text: '消息内容' } }

// 图片
{ type: 'image', data: { file: '/path/to/image.png' } }

// 音乐卡片
{ type: 'music', data: { type: 'custom', title: '歌名', ... } }

// 回复
{ type: 'reply', data: { id: message_id } }
```

示例：

```typescript
import { resolveFileForSend } from '../../utils/file.js';

export async function execute(params, ctx): Promise<ToolResult> {
    const localPath = '/path/to/generated.png';
    return {
        success: true,
        text: '生成了一张图片',
        segments: [
            { type: 'image', data: { file: resolveFileForSend(localPath) } },
        ],
    };
}
```

### 本地媒体发送约定

- 需要发送本地图片、音频、视频时，统一通过 `resolveFileForSend()` 处理，不要直接裸传本地路径。
- 需要发送 docx/html/js/txt/md/xlsx/py 等普通文件时，返回 `files: [{ path, name }]`，由主流程走 NapCat 文件上传接口发送。
- 发送模式优先级为：工具级覆盖环境变量 → 全局 `FILE_SEND_MODE` → 工具默认回退策略。
- 图像类工具建议统一采用“先落本地，再发送”的链路，便于日志排查、复发和本机直发。
- 如果 NapCat 与 Genesis 在同一台机器，推荐设置 `FILE_SEND_MODE=local`。

### 富媒体工具返回规范

- 绘图、识图附图、音视频、文件类工具，优先返回 `segments`，不要把远程 URL 当作唯一交付形式。
- 生成型工具建议先把输出下载到本地，再通过 `resolveFileForSend()` 发送；不要默认依赖远程 URL 直发。
- 如果工具返回了 `segments`，仍建议保留一段简短的事实性 `text` 或 `data.message`，供主流程做人格化汇报。
- 主流程会先尝试发送 `segments`；如果媒体一张都没真正发出去，会按失败语义处理，不应再把工具成功文案直接暴露给用户。
- 工具不应假设自己返回的 `text` 一定会原样显示给用户，尤其是在富媒体场景。

### 多模态输入规范

- 参考图、音频、视频、文件等输入应来自显式参数，如 `imagePath`、`imageUrls`、`audioPaths`、`filePaths`。
- 不要从 `@用户`、头像、历史消息等上下文里隐式偷取媒体输入，除非工具职责本身就是“获取头像/提取媒体”。
- 如果要和其他工具链式配合，优先通过明确字段传递中间结果，例如头像工具输出 URL，识图工具再显式接收该 URL。

---

## skills.yaml（可选，建议）

配置触发规则、权限、冷却：

```yaml
name: weather
displayName: 天气查询
version: "1.0.0"
description: 查询城市天气预报

triggers:
  keywords:
    - 天气
    - 气温

permissions:
  allowGroups: all
  allowPrivate: true
  requiredRole: member    # owner / admin / member

cooldown:
  perUser: 5              # 用户冷却（秒）
  global: 0               # 全局冷却（秒）

onError:
  - condition: "error.message.includes('找不到')"
    response: "找不到这个城市呢~"
```

---

## 热重载

工具支持热重载，修改后自动生效：

- 修改 `index.ts` → 自动重新加载
- 添加/删除工具目录 → 自动发现

---

## 类型兼容性说明

为保持向后兼容，旧类型名仍可使用但已标记为 `@deprecated`：

| 旧类型名        | 新类型名      | 说明        |
| --------------- | ------------- | ----------- |
| `Module`        | `Tool`        | 工具接口    |
| `ModuleContext` | `ToolContext` | 执行上下文  |
| `ModuleResult`  | `ToolResult`  | 执行结果    |
| `ModuleSchema`  | `ToolSchema`  | Schema 类型 |
| `ModuleMeta`    | `ToolMeta`    | 元数据类型  |
| `LoadedModule`  | `LoadedTool`  | 已加载工具  |

> **建议**: 新工具应使用新类型名（`Tool*`），已有代码可逐步迁移。

---

## 示例工具

参考以下目录查看完整实现：

| 工具                     | 说明         | 配置类型 |
| ------------------------ | ------------ | -------- |
| `src/tools/weather/`     | 天气查询     | 外部 API |
| `src/tools/vision/`      | 图片识别     | LLM API  |
| `src/tools/draw/`        | AI 绘图      | LLM API  |
| `src/tools/task_status/` | 任务状态查询 | 基础配置 |
| `src/tools/mute/`        | 群禁言       | 权限控制 |

---

## 开发检查清单

- `schema.description` 是否足够清楚，能和相似工具拉开边界。
- `config.ts` 是否支持 `MODULE_XXX_ENABLED`，并兼容旧的 `TOOL_XXX_ENABLED`。
- 是否为工具自身的 API / LLM 提供了独立配置，并在未设置时合理回退。
- 如果要发送本地媒体，是否统一经过 `resolveFileForSend()`。
- 如果要发送普通文件，是否返回 `files` 而不是把完整文件内容塞进回复文本。
- 是否避免把工具层 `text` 写成最终用户文案，尤其不要把固定口癖直接硬编码进工具返回。
- 如果工具返回富媒体，是否同时提供了简短、事实性的 `text` 或 `data.message` 供主流程人格化汇报。
- 如果工具依赖图片/音频/文件输入，是否只接受显式参数，而不是从 `@` 或头像等隐式上下文偷输入。
- 如果工具会被规则层优先分流，是否同步检查了 `src/agents/router.ts`、`src/group_aggregator.ts` 和对应测试。
- 是否补充了最基本的执行、路由或配置测试。

---

## 最佳实践

### 参数名称兼容

LLM 可能使用不同的参数名，工具应支持多种命名：

```typescript
// ❌ 只支持一种参数名
let targetId = params.targetId as number | undefined;

// ✅ 支持多种参数名 + 类型转换
const rawTargetId = params.targetId ?? params.user_id ?? params.userId ?? params.target;
if (rawTargetId !== undefined) {
    targetId = typeof rawTargetId === 'number' 
        ? rawTargetId 
        : parseInt(String(rawTargetId), 10);
    if (isNaN(targetId)) targetId = undefined;
}
```

### 智能单位检测

LLM 可能混淆单位（如秒/分钟），添加智能检测：

```typescript
// 解析时长（期望分钟）
let duration = typeof params.duration === 'number' ? params.duration : 10;

// 智能检测：如果传入值 >= 60 且是 60 的倍数，可能是秒
if (duration >= 60 && duration % 60 === 0) {
    const possibleMinutes = duration / 60;
    if (possibleMinutes >= 1 && possibleMinutes <= 1440) {
        log.debug(`智能转换时长: ${duration}秒 -> ${possibleMinutes}分钟`);
        duration = possibleMinutes;
    }
}
```

### 权限控制模式（标准）

应使用 `src/utils/identity.ts` 提供的标准函数进行权限检查：

```typescript
import { 
    getUserLevel, 
    ROLE_LEVEL, 
    checkPermission, 
    isMaster, 
    isGlobalAdmin 
} from '../../utils/identity.js';

export async function execute(params, ctx: ToolContext): Promise<ToolResult> {
    // 1. 检查请求者权限
    const reqLevel = getUserLevel(ctx.senderId, ctx.senderRole);
    if (reqLevel < ROLE_LEVEL.admin) {
        return { success: false, text: `操作失败：权限不足` };
    }

    // 2. 检查 Bot 权限 (需要异步查询)
    if (!config.botQQ) { /* handle missing botQQ */ }
    const botInfo = await getGroupMemberInfo(ctx.groupId, config.botQQ);
    if (botInfo.role !== 'owner' && botInfo.role !== 'admin') {
         return { success: false, text: '我不是管理员，无法执行操作' };
    }

    // 3. 检查目标权限 (防反杀)
    const targetLevel = getUserLevel(targetId, targetRole);
    if (targetLevel >= reqLevel && !isMaster(ctx.senderId)) {
        return { success: false, text: '不能操作权限比你高的人哦' };
    }
    
    // ...
}
```

### 清晰的错误消息

**区分不同的失败原因**，避免 Persona 润色时误解：

```typescript
// ❌ 指代不清
return { success: false, text: '没有权限哦~' };

// ✅ 明确指出是谁没权限
// 请求者没权限
return { success: false, text: `操作失败：请求者(${ctx.senderId})不是群管理员，无权使用禁言功能` };

// Bot 没权限
return { success: false, text: '我不是管理员，没法禁言别人呢 QAQ' };

// 目标权限更高
return { success: false, text: `不能禁言${targetRoleName}哦，权限不够喵~` };
```
