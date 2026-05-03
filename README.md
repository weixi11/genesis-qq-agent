# Genesis QQ AI Agent System

Genesis 是一个面向 QQ 私聊和群聊场景的 AI Agent 系统。它不是单轮问答机器人，而是围绕真实群聊、私聊、工具调用、长期运行和人格化交互设计的多 Agent 框架。

项目当前用于驱动一个 QQ 机器人，使其能够判断是否应该回复、规划任务、调用工具、聚合结果，并以稳定的人设口吻向用户反馈。

## 核心能力

- **Sentry 哨兵判断**：根据被 @、名称提及、连续追问、群聊热度、冷却时间等信号判断是否响应，降低刷屏和漏回复。
- **Router 任务规划**：把自然语言请求转为结构化 `TaskPlan`，判断是否需要工具、需要哪些步骤，以及步骤之间的依赖。
- **Tech / Orchestrator 执行层**：执行单工具或多工具任务，支持顺序执行、并行执行、依赖拓扑、参数占位符传递和结果聚合。
- **Persona 回复层**：将工具执行结果转成符合机器人设定的自然回复，并结合用户画像、好感度、历史记忆和情绪分析调整语气。
- **工具系统**：支持绘图、图生图、识图、头像获取、网页研究、天气、音乐、文件读取、音视频读取、博客发布、定时任务、群管理、任务查询和工具日志。
- **自维护能力**：通过 `create_skill` / `manage_skill` 让主人可以用对话要求机器人创建、修改或修复工具。

## 典型工作流

用户在 QQ 群中发送：

```text
画 @某人的头像风格图
```

Genesis 会规划并执行：

1. 调用 `avatar` 获取被 @ 用户头像。
2. 调用 `vision` 分析头像主体、场景、风格和构图。
3. 调用 `banana_draw` 以头像作为视觉参考生成图片。
4. 聚合工具结果，并由 `Persona` 生成自然回复。

如果头像不是人物，而是风景、物品、Logo 或抽象图，系统不会强行当成人脸处理，而是作为背景、主题或风格参考。

## 技术栈

- Node.js
- TypeScript
- Express
- WebSocket
- sql.js
- LanceDB
- Zod
- PM2
- pnpm

## 项目结构

```text
src/
  agents/          多 Agent 逻辑：Sentry、Router、Tech、ReAct、Persona、Profiler
  services/        编排、媒体追踪、响应增强、工具测试、模型服务等
  tools/           可动态加载的工具模块
  task/            任务队列、缓存、重试、取消和状态管理
  storage/         本地状态存储
  web/             Web 管理面板
  utils/           通用工具函数
tests/             单元测试和集成测试
docs/              架构说明、消息 API、申请材料和开发文档
persona/           默认人设配置
scripts/           独立启动脚本
```

## 安装

```bash
pnpm install
```

复制配置模板：

```bash
cp .env.example .env
```

然后按需配置 QQ 连接、LLM Provider、Web 管理密码和各工具 API。

## 常用命令

```bash
# 开发模式
pnpm dev

# 构建
pnpm build

# 运行构建产物
pnpm start

# 仅启动 Agent
pnpm agent

# 仅启动 Web 面板
pnpm web

# 运行提示词快照测试
pnpm test:prompts

# 运行定时任务测试
pnpm test:scheduler
```

## 公开仓库说明

本仓库是 Genesis 的公开代码快照，已排除本机运行数据和隐私内容：

- `.env`
- API key、token、cookie
- 本地数据库
- 运行日志
- 用户画像和聊天数据
- 生成图片缓存
- QQ 账号和群聊运行产物

仓库保留源码、测试、文档和配置示例，便于展示 Agent 架构和开发实现。

## 申请材料

- [Xiaomi MiMo 100T 申请内容](docs/xiaomi-mimo-100t-application.md)
- [架构优化总览](docs/plan_part1_overview.md)
- [消息 API 文档](docs/MESSAGE_API.md)

## License

当前未指定开源许可证。公开展示和学习可参考代码结构；正式复用前请先联系作者确认授权范围。
