# 架构优化实施方案 — Part 1: 总览与问题分析

## 目标

让"落落"更智能、更拟人，同时控制 Token 成本的长期增长。

## 当前架构问题

### 问题 1: ReAct→Persona 二次调用浪费

**流程**: ReAct 输出自然语言 → `responseEnhancer` → Persona `enhanceToolResult()` 再润色一遍

**浪费**: 每次多花 ~800 tokens + 一次 LLM 延迟，且 Persona 经常只是复读 ReAct 的内容加个"喵呜~"

**证据**: 对比 `ReActAgent.txt` 和 `persona.txt` 的报文，Persona 的输出几乎是 ReAct 输出的复读

### 问题 2: 全量工具 Schema 每次都塞入 ReAct

**现状**: 20 个工具 Schema 占 ~2500 tokens（占总输入的 60%），每次请求都全量注入

**趋势**: 工具增长到 50 个时，光 Schema 就要 ~6000 tokens

### 问题 3: ReAct 人设不完整

**现状**: `react.ts` 的 `getSystemPrompt()` 只注入了名字、年龄、种族、性格和说话风格

**缺失**: 完整的外貌描述、特征、主人识别逻辑、自定义指令等都没有

## 解决方案概览

| 优先级 | 方案 | 涉及文件 | 效果 |
|-------|------|---------|------|
| P0 | 条件润色 | `index.ts` | 省一次 LLM 调用 |
| P0 | 两阶段 FC | 新建 `tool_selector.ts` + 改 `react.ts`, `index.ts`, `config.ts`, `llm.ts` | Schema Token 降 80% |
| P1 | ReAct Prompt 升级 | `react.ts` | 输出质量大幅提升 |
| P1 | 人设分层 | `personaLoader.ts` | ReAct 用精简版, Persona 用完整版 |

详细修改见 Part 2-4。
