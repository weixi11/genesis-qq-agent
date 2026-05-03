# Banana Draw 工具方案

## 1. 目标

在 `Genesis` 中新增一个独立工具 `banana_draw`，用于承接 `Yunzai nano-banana` 那类能力：

- 纯文生图
- 带图改图 / 图生图
- 预设模式
  - 手办化
  - 四格漫画
  - 真人自拍化
- 可选的 `@某人头像` 作为输入图

约束：

- 不修改现有 `draw` 工具职责
- 不把 `banana` 的命令式插件逻辑直接搬进 `Genesis`
- 遵守 `Genesis` 现有 Tool/Router/Web 配置体系

## 2. 为什么要新加工具，不改 draw

`Genesis draw` 当前定位应继续保持简单：

- 单一职责：普通 AI 绘图
- 结构简单：文本提示词 -> 文生图
- 被 Router 和 Agent 当作基础通用工具调用

`banana` 则是另一类能力：

- 更强的多模态输入收集
- 更复杂的接口切换
- 更重的预设和风格化处理
- 可能需要头像解析、图片编辑、多图拼接

因此建议新增 `banana_draw`，不要继续污染 `draw`。

## 3. 建议工具名与目录

工具名：

- `banana_draw`

目录结构：

```text
src/tools/banana_draw/
  index.ts
  config.ts
  schema.ts
  banana_draw.skills.yaml
  presets.ts
  api.ts
  input.ts
  output.ts
```

说明：

- `index.ts` 只做主流程编排
- `api.ts` 负责 `chat` / `images` 两类接口切换
- `input.ts` 负责图片来源收集与归一化
- `output.ts` 负责解析图片 URL / `b64_json` / 文本输出
- `presets.ts` 维护内置预设

## 4. 工具职责边界

`draw` 保留：

- 普通文生图
- 自画像绘图

`banana_draw` 新增：

- 基于当前消息图片 / 引用图片的改图
- 多图输入
- 风格化预设模式
- `@用户头像` 作为输入图
- 供应商接口模式切换

不建议一开始就做：

- 聊天命令切换供应商 / 模型
- 思考链合并转发
- 在 Router 中自动替代所有 `draw`

## 5. Router 接入策略

第一阶段只做显式路由，不抢 `draw` 的通用入口。

推荐触发词：

- `banana`
- `手办化`
- `四格漫画`
- `自拍化`
- `按这张图 banana`
- `用 banana 改图`

Router 规则建议：

- 普通“画图/来张图”仍走 `draw`
- 明确出现 `banana` 或预设词时走 `banana_draw`
- 用户带图并要求“手办化/四格漫画/自拍化”时优先走 `banana_draw`

这样可以避免：

- 和现有 `draw` 冲突
- 让 Agent 在没有明确意图时误走重工具链

## 6. 参数设计

`schema.ts` 建议：

```ts
{
  prompt: string,
  mode?: 'auto' | 'generate' | 'edit' | 'figurine' | 'comic' | 'selfie',
  size?: string,
  preserveIdentity?: boolean
}
```

解释：

- `prompt`：自然语言提示
- `mode=auto`：根据是否有输入图自动决定文生图或改图
- `figurine/comic/selfie`：映射到内置预设
- `preserveIdentity`：头像/人物改图时追加身份保持提示词

## 7. 配置设计

不照搬 Yunzai 的“群内命令切换配置”，而是走 `Genesis` 的环境变量和后续 Web 面板。

推荐配置：

```env
BANANA_DRAW_LLM_BASE_URL=
BANANA_DRAW_LLM_API_KEY=

# chat 型模型，适合多模态 chat/completions
BANANA_DRAW_CHAT_MODEL=

# images 型模型，适合 generations/edits
BANANA_DRAW_IMAGE_MODEL=

# auto | chat | images
BANANA_DRAW_API_MODE=auto

# multipart | url_array
BANANA_DRAW_IMAGE_INPUT_MODE=multipart

BANANA_DRAW_IMAGE_SIZE=1024x1024
BANANA_DRAW_IMAGE_QUALITY=
BANANA_DRAW_SEND_MODE=local   # 可选；留空时继承全局 FILE_SEND_MODE
BANANA_DRAW_TIMEOUT_MS=240000
BANANA_DRAW_CONCURRENCY=2
```

策略：

- `API_MODE=auto` 时，根据是否有输入图和模型能力自动选 `chat` 或 `images`
- 若显式设为 `chat` 或 `images`，按配置强制执行

## 8. 输入收集设计

输入优先级建议：

1. 当前消息图片
2. 引用消息图片
3. `@用户` 头像

当前 `Genesis ToolContext` 已有：

- `ctx.imageUrls`
- `ctx.atUsers`
- `ctx.groupId`

还缺一块：

- `@用户头像` 的解析服务

建议新增服务：

- `src/services/avatar_resolver.ts`

职责：

- 根据 `ctx.groupId + ctx.atUsers[0]` 获取目标头像 URL
- 获取失败时回退 QQ 头像直链

这样 `banana_draw` 不需要直接耦合 connector 内部细节。

## 9. 接口调用设计

参考 `nano-banana`，但按 `Genesis` 重构为两条 API 流：

### A. chat 流

适用于：

- chat-completions 多模态模型
- 图片输入转成 `image_url` 或 data URL

请求体：

- `messages: [{ role: 'user', content: [...] }]`

输出解析：

- 文本
- 输出图片 URL
- `b64_json`

### B. images 流

适用于：

- `/images/generations`
- `/images/edits`

规则：

- 无输入图 -> `generations`
- 有输入图 -> `edits`
- `url_array` 模式可直接发 `image: string[]`
- `multipart` 模式走 `FormData`

## 10. 预设设计

建议内置三个预设，先做成代码常量：

- `figurine`
- `comic`
- `selfie`

后续再升级成：

- `data/banana_draw/presets.json`

这样第一阶段实现简单，第二阶段再开放自定义。

## 11. 输出设计

保持和 `Genesis` 现有工具一致：

- `text`
- `segments`
- `data`

建议 `data` 带上：

- `mode`
- `apiMode`
- `model`
- `inputImageCount`
- `remoteUrls`
- `localPaths`

不建议第一阶段复刻 Yunzai 的“思考链转发”：

- Genesis 目前没有统一的思考链消息协议
- 会增加消息发送复杂度

第一阶段最多把思考链放到 `data.reasoning`，不直接发群消息。

## 12. 测试方案

至少补这些测试：

1. 无图请求时走文生图分支
2. 有图请求时走改图分支
3. `figurine/comic/selfie` 能正确注入预设
4. `multipart` 与 `url_array` 两种输入模式都能正确构造请求
5. 输出兼容 `url` 与 `b64_json`
6. `@用户` 时头像解析失败能正确回退

## 13. 分阶段实施

### Phase 1

- 新增 `banana_draw` 工具
- 支持文生图、带图改图、三个预设
- 只使用 `ctx.imageUrls`
- 不做头像
- 不做 Web 面板

### Phase 2

- 新增头像解析服务
- 支持 `@某人头像`
- 支持 `chat/images` 双模式自动切换

### Phase 3

- 接入 Web 配置管理
- 支持预设文件热更新
- 视需要补充供应商/模型列表能力

## 14. 推荐结论

下一步最稳的做法是：

1. 保持 `draw` 不动
2. 新建 `banana_draw`
3. 先做 `Phase 1`

这样风险最小，也最符合 `Genesis` 当前架构。  
如果后续 `banana_draw` 稳定，再考虑是否让 Router 在少数场景自动优先它。
