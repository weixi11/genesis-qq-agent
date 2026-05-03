# 架构优化实施方案 — Part 4: 数据流图 + 验证计划

## 改造前后数据流对比

### 改造前（当前）

```
用户消息
  → Sentry（要不要回复？）
  → ReAct（全量 20 个工具 Schema，~4100 input tokens）
  → ReAct 输出自然语言
  → responseEnhancer → Persona.enhanceToolResult（又 ~800 tokens）
  → 发送回复

总计: ~5000 tokens/次，2 次 LLM 调用
```

### 改造后

```
用户消息
  → Sentry（要不要回复？）
  → ToolSelector（轻量选择，~500 tokens，最便宜的模型）
    ├─ isChat=true → 直接 Persona 闲聊（~300 tokens）→ 回复
    └─ isChat=false → 选出 2~3 个工具
  → ReAct（只加载选中工具 Schema，~800-1200 tokens）
  → needsPolish 判断
    ├─ false → 直接发送（0 额外 token）
    └─ true → Persona 润色（仅对天气等数据工具）
  → 发送回复

闲聊: ~300 tokens, 1 次调用（之前也要 ~4100+800）
工具: ~500+1000=1500 tokens, 2 次调用（之前 ~4100+800=4900）
节省: 闲聊 93%，工具 69%
```

## 文件改动清单

| 文件 | 操作 | 改动量 |
|-----|------|-------|
| `src/agents/tool_selector.ts` | 新建 | ~80 行 |
| `src/agents/react.ts` | 修改 | ~30 行（prompt + 参数） |
| `src/config.ts` | 修改 | ~6 行（新增 LLM 配置） |
| `src/llm.ts` | 修改 | ~2 行（新增客户端） |
| `src/index.ts` | 修改 | ~25 行（两阶段流程 + needsPolish） |
| `src/utils/personaLoader.ts` | 修改 | ~30 行（新增 getPersonaCore/Full） |
| `.env` | 修改 | ~3 行（新增环境变量） |

## `.env` 需要添加的环境变量

```bash
# 工具选择器 LLM（用最便宜的模型，任务简单）
TOOL_SELECTOR_LLM_BASE_URL=  # 不填则使用 LLM_BASE_URL
TOOL_SELECTOR_LLM_API_KEY=   # 不填则使用 LLM_API_KEY
TOOL_SELECTOR_LLM_MODEL=gemini-2.0-flash-lite
```

## 验证计划

### 编译验证

```bash
cd genesis
npm run build
```

### 手动测试场景

| 测试消息 | 预期 ToolSelector 输出 | 预期行为 |
|---------|---------------------|---------|
| "早上好" | `["none"]` | 直接走 Persona 闲聊 |
| "这张图是什么"（带图） | `["vision"]` | 只加载 vision Schema |
| "画个猫" | `["draw"]` | 只加载 draw Schema |
| "落落画个类似的"（有历史图片） | `["draw"]` 或 `["vision","draw"]` | 加载 1-2 个 Schema |
| "把xx踢了" | `["group_kick"]` | 只加载 group_kick |
| "今天北京天气" | `["weather"]` | 只加载 weather |
| "帮我看看这个"（含文件） | `["read_file"]` | 根据附件类型选择 |

### 日志观察点

修改后在日志中应该能看到：
- `🎯 工具选择: [vision] (1 schemas)` — 确认只加载了需要的工具
- `🧠 ReAct 循环结束` — 确认 ReAct 正常工作
- 不应再看到每条消息都触发 `📝 准备润色` 的日志

## 实施顺序建议

1. 先改 `config.ts` + `llm.ts`（加配置，无风险）
2. 新建 `tool_selector.ts`（独立模块，不影响现有功能）
3. 改 `react.ts`（加参数，向后兼容）
4. 改 `personaLoader.ts`（加函数，不影响现有调用）
5. 最后改 `index.ts`（串联所有改动，这步是开关）

这样每一步都可以独立验证，出问题可以快速回滚。
