# Genesis 项目与 Agent LLM `messages` 组成审计报告

审计日期：2026-02-08  
审计范围：`src/index.ts`、`src/agents/*`、`src/llm.ts`、`src/memory.ts`、`src/web/*`、`src/utils/personaLoader.ts`、`src/tools/vision/index.ts`

## 1. 执行摘要

本项目已经形成了完整的多 Agent 主链路（Sentry -> Router -> Tech/Persona + Profiler 异步侧写），但在“LLM 调用治理”上存在几类结构性问题：

1. 配置与执行出现漂移：若干 Agent 开关在配置里存在、在运行时展示可改，但主链路并未真正使用。
2. 结构化输出稳定性不足：多个 JSON 任务走 `temperature=0.7` 的通用 `ask`，解析失败后兜底策略存在误判风险。
3. 可观测性不完整：Router/Profiler 未传 `caller`，LLM 日志中会显示 `unknown`。
4. 安全与隐私风险较高：Web 控制台默认无鉴权，且可直接查看完整 LLM 请求、上下文、画像、知识库等敏感数据。
5. 长期演进成本偏高：`messages` 绝大部分是“system+user 双条消息 + 大段拼接文本”，上下文复用、去重、提示注入防护都不够系统化。

---

## 2. 当前项目主链路（与 LLM 相关）

入口主流程在 `src/index.ts:521` 开始，按阶段执行：

1. 消息入窗与历史构建：`src/index.ts:177`、`src/index.ts:193`、`src/index.ts:199`
2. 哨兵判定（是否回复）：`src/index.ts:530`
3. 路由规划（任务计划）：`src/index.ts:536`
4. 工具执行或闲聊回复：`src/index.ts:544`、`src/index.ts:554`
5. 最终回复并回写记忆：`src/index.ts:468`、`src/index.ts:484`

关键事实：当前实现先 `memory.push`，再取 `history`，因此历史中包含“当前轮消息” (`src/index.ts:193` 到 `src/index.ts:199`)。

---

## 3. LLM 请求报文统一形态

统一入口在 `src/llm.ts`：

- `chat()`：直接发送 `model + messages + temperature + max_tokens` 到 `/chat/completions` (`src/llm.ts:84` 到 `src/llm.ts:98`)
- `ask()`：封装为 `messages=[system?, user]` (`src/llm.ts:166` 到 `src/llm.ts:172`)
- `chatWithTools()`：增加 `tools` (`src/llm.ts:185` 到 `src/llm.ts:208`)
- `chatWithImages()`：最后一条 user content 为多模态数组；日志里会替换 base64 占位 (`src/llm.ts:347` 到 `src/llm.ts:367`)

默认温度：

- `chat` / `ask`: `0.7` (`src/llm.ts:87`)
- `chatWithTools`: `0.3` (`src/llm.ts:188`)

---

## 4. 每个 Agent 的 LLM `messages` 组成

## 4.1 SentryAgent（有 LLM）

调用点：

- 主判定：`sentryLlm.ask(...)` (`src/agents/sentry.ts:405`)
- 连续对话检测：`sentryLlm.ask(...)` (`src/agents/sentry.ts:470`)

### A. 主判定（`llmJudge`）

`messages` 结构：

1. `system`: `"你是决策助手。只输出JSON。"`
2. `user`: 大段判定提示词（机器人信息、当前消息、发送者画像、最近对话、规则、JSON格式）

`user` 内容拼装来源：

- 当前消息文本与媒体标签：`src/agents/sentry.ts:348` 到 `src/agents/sentry.ts:360`
- 发送者画像：`src/agents/sentry.ts:333` 到 `src/agents/sentry.ts:346`
- 最近对话（来自滑窗记忆）：`src/agents/sentry.ts:331`、`src/agents/sentry.ts:376`

### B. 连续对话检测（`checkContinuousDialogue`）

`messages` 结构：

1. `system`: `"你是对话分析助手，只输出JSON。"`
2. `user`: “机器人刚才说 + 用户现在说 + 判断标准 + JSON格式”

拼装点：`src/agents/sentry.ts:453` 到 `src/agents/sentry.ts:470`

---

## 4.2 PlanRouter（有 LLM）

调用点：`routerLlm.ask(userPrompt, this.getPlanPrompt())` (`src/agents/router.ts:209`)

`messages` 结构：

1. `system`: `getPlanPrompt()` 生成的大提示词（工具清单、禁用工具、规则、示例）
2. `user`: `buildUserPrompt()` 生成的用户上下文（用户消息、SENDER/AT、媒体记录、最近对话）

`user` 内容拼装来源：

- 用户原文与元信息：`src/agents/router.ts:232` 到 `src/agents/router.ts:237`
- 媒体追踪上下文：`src/agents/router.ts:229` 到 `src/agents/router.ts:245`
- 对话历史：`src/agents/router.ts:248` 到 `src/agents/router.ts:256`

注意：此调用未传 `caller`，会落到 `unknown`（`ask` 默认值在 `src/llm.ts:166`）。

---

## 4.3 PersonaAgent（有 LLM）

### A. 闲聊回复 `respond`

调用点：`personaLlm.ask(message.text || '(媒体消息)', systemPrompt, 'persona')` (`src/agents/persona.ts:390`)

`messages` 结构：

1. `system`: 人设 + 用户信息 + 情绪 + 画像 + 历史 + RAG
2. `user`: 当前用户消息文本（无文本时用 `(媒体消息)`）

`system` 拼装来源：

- 情绪上下文：`src/agents/persona.ts:360`
- 用户画像与被@画像：`src/agents/persona.ts:361` 到 `src/agents/persona.ts:363`
- 历史上下文：`src/agents/persona.ts:363`
- RAG 知识：`src/agents/persona.ts:364`、`src/agents/persona.ts:326` 到 `src/agents/persona.ts:331`
- 最终系统提示组装：`src/agents/persona.ts:373` 到 `src/agents/persona.ts:387`

### B. 工具结果润色 `enhanceToolResult`

调用点：`personaLlm.chat([...], {}, 'persona')` (`src/agents/persona.ts:514`)

`messages` 结构：

1. `system`: 人设 + 工具执行结果 + 风格/约束
2. `user`: 固定 `"请生成回复"`

工具结果注入点：`src/agents/persona.ts:490` 到 `src/agents/persona.ts:493`

---

## 4.4 ProfilerAgent（有 LLM）

调用点：`profilerLlm.ask(prompt, '你是用户画像分析专家...')` (`src/agents/profiler.ts:231`)

`messages` 结构：

1. `system`: 画像分析专家 + 仅输出 JSON
2. `user`: 待分析消息（含上下文）、已有 traits/interests、评分规则、JSON格式

`user` 内容拼装来源：

- 目标消息 + 群聊上下文拼接：`src/agents/profiler.ts:189` 到 `src/agents/profiler.ts:199`
- 分析规则与输出格式：`src/agents/profiler.ts:201` 到 `src/agents/profiler.ts:228`

注意：此调用同样未传 `caller`，日志里也是 `unknown`。

---

## 4.5 TechAgent（当前无 LLM）

Tech 只执行 Router 给出的工具计划，不直接发起 LLM 请求（`src/agents/tech.ts:76`、`src/agents/tech.ts:116`）。  
`config.techLlm` 虽存在配置项 (`src/config.ts:132`)，但当前主链路未使用。

---

## 4.6 Orchestrator（当前无 LLM）

`src/agents/orchestrator/*` 负责多工具编排计划与执行，不直接调用 LLM。

---

## 4.7 非 Agent 的 LLM 旁路调用（建议纳入治理）

1. Persona 加载器：`src/utils/personaLoader.ts:155`（system+user 两条消息）
2. Vision 工具：`src/tools/vision/index.ts:76`、`src/tools/vision/index.ts:118`、`src/tools/vision/index.ts:179`（多模态）

---

## 5. 现有问题（长期视角，按优先级）

## P0（应优先修复）

1. Web 控制台与敏感数据接口缺少鉴权  
证据：`src/web/server.ts:44` 到 `src/web/server.ts:48` 直接暴露 `/api`；  
`/api/llm/logs` 返回完整请求报文（含 `messages`）在 `src/web/routes/features.ts:267` 到 `src/web/routes/features.ts:271`；  
`/api/context/:key` 直接返回完整上下文在 `src/web/routes/context.ts:40` 到 `src/web/routes/context.ts:48`；  
`/api/profiles` 暴露画像在 `src/web/routes/resources.ts:11`。  
风险：隐私泄露、Prompt 泄露、运维面暴露。

2. Sentry 兜底判定存在“误回复”风险  
证据：解析失败时用 `response.includes('回复')` 判定（`src/agents/sentry.ts:417`）。  
风险：`“忽略，不回复”` 也会命中“回复”子串，行为反转。

3. 配置开关与运行行为漂移  
证据：配置定义了 `sentryEnabled/routerLlmEnabled/routerRuleMatchEnabled/vectordbEnabled`（`src/config.ts:147` 到 `src/config.ts:151`），但主链路固定执行 `sentry.evaluate` 与 `router.plan`（`src/index.ts:530`、`src/index.ts:536`），且记忆写入未受 `vectordbEnabled` 保护（`src/index.ts:258` 到 `src/index.ts:265`）。  
风险：控制面“看起来可控”，实际不可控，长期会导致线上策略失真。

## P1（建议近期修复）

4. Router/Profiler 调用未打 `caller` 标签  
证据：`routerLlm.ask(...)` 在 `src/agents/router.ts:209`、`profilerLlm.ask(...)` 在 `src/agents/profiler.ts:231`，未传第三参；`ask` 默认 `caller='unknown'` (`src/llm.ts:166`)。  
风险：日志可观测性下降，成本分摊和回溯困难。

5. JSON 任务默认温度偏高，结构化稳定性不足  
证据：`chat` 默认 `temperature=0.7` (`src/llm.ts:87`)；Sentry/Router/Profiler 均通过 `ask()` 走该默认。  
风险：JSON 抖动率高，触发解析失败、回退策略和行为随机性。

6. 当前消息被重复注入上下文，且防抖“合并文本”未进入主判定消息  
证据：先 push 再取 history (`src/index.ts:193` 到 `src/index.ts:199`)，随后 Sentry/Router/Persona 都以 `first` 作为当前消息 (`src/index.ts:530`、`src/index.ts:536`)；而防抖合并文本在 `src/debouncer.ts:89`，仅用于分析流程 (`src/index.ts:527`)。  
风险：token 浪费、语义重复、碎片消息下判定偏差。

7. Prompt 注入面较大（工具输出直接进 system）  
证据：`toolResult` 直接插入 Persona system prompt（`src/agents/persona.ts:490` 到 `src/agents/persona.ts:493`）。  
风险：当工具输出来自外部内容（文件、网页、OCR）时，可能影响最终人设回复策略。

## P2（中长期）

8. Prompt 体积与复杂度持续增长，成本会非线性上升  
证据：Router system prompt 带多段规则与示例 (`src/agents/router.ts:45` 开始)，且每轮都发；历史+媒体+画像也持续叠加。  
风险：高并发时成本和时延增长，模型切换与质量回归难度增大。

9. LLM 网络调用缺少统一超时/重试策略  
证据：`fetch` 调用未设置 AbortController 超时或重试（`src/llm.ts:101`、`src/llm.ts:371`）。  
风险：上游抖动时调用悬挂，响应链路不稳定。

---

## 6. 建议与落地方案

## 第一阶段（1-2周，止血）

1. 给 Web 控制台加鉴权中间件（至少 Token/Bearer）；默认关闭敏感接口。
2. Sentry 兜底改为严格判定：仅接受可解析 JSON；解析失败时按分数阈值回退，不做 `includes('回复')`。
3. 在 Router/Profiler/工具侧 LLM 调用补齐 `caller`（如 `router`、`profiler`、`tool:vision`）。
4. 为 Sentry/Router/Profiler 的结构化任务设置低温度（0~0.2）和固定 `max_tokens`。
5. 让 `AGENT_*` 开关真正生效：在 `index.ts` 主链路使用；`vectordbEnabled` 控制 `storeMemory` 与 Persona RAG。

## 第二阶段（1-2个月，稳态化）

1. 抽象 `askJson<T>()`：统一 JSON schema 校验（建议 `zod`），替代散落 `safeParseLLMJson`。
2. 统一 PromptBuilder：把历史、画像、媒体上下文标准化为可复用组件，减少重复拼接和遗漏。
3. 调整上下文注入策略：避免“当前消息在 user 和 history 中重复”；优先使用防抖后的语义主文本。
4. 为 `llmStats` 增加脱敏层（如路径、手机号、key pattern 掩码），并支持可配置保留期。

## 第三阶段（季度级，长期演进）

1. 把“文本协议 JSON”逐步迁移为“结构化输出协议”（schema/工具调用优先）。
2. 建立 Agent 行为契约测试（固定输入消息 -> 期望 plan/decision），持续验证模型升级影响。
3. 建立数据治理策略：按会话级别配置日志留存、画像可见性、导出权限与审计记录。

---

## 7. 结论

从长期看，当前架构方向是正确的（分层清晰、职责分明、可扩展），但要进入“可持续演进”的状态，核心不在于再加更多 prompt，而在于三件事：

1. 把配置控制面和执行面重新对齐。  
2. 把结构化输出从“提示词约束”升级为“协议约束”。  
3. 把可观测与安全默认值从“开放”改为“最小暴露”。  

这样后续无论模型替换、工具扩展还是用户规模增长，系统都能更稳定地演进。

