# 消息发送 API 指南

Genesis 提供统一的消息发送 API，支持文本、图片、音乐卡片等多种消息类型。

## 快速开始

```typescript
import { connector } from './connector.js';
import { resolveFileForSend } from './utils/file.js';

// 发送文本
await connector.send(msg, [{ type: 'text', data: { text: '你好~' } }]);

// 发送图片
await connector.sendImage(msg, 'https://example.com/image.png');

// 发送本地图片（自动处理跨系统）
await connector.sendImage(msg, resolveFileForSend('/path/to/image.png'));

// 发送音乐卡片
await connector.sendMusic(msg, '163', 'songId');
```

## 文件发送模式

通过 `FILE_SEND_MODE` 环境变量配置：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `auto` | 默认使用 base64 | 通用，最兼容 |
| `base64` | 强制转 base64 | 跨系统部署 |
| `local` | 使用本地路径 | 同系统部署，高效 |

```bash
# .env
FILE_SEND_MODE=local  # 同系统部署时使用
```

说明：
- `draw`、`banana_draw` 这类会先落本地再发送的绘图工具，默认会继承全局 `FILE_SEND_MODE`
- 如果确实要单独覆盖，再设置对应工具自己的发送模式变量，例如 `DRAW_IMAGE_SEND_MODE`、`BANANA_DRAW_SEND_MODE`

## 模块返回格式

模块应使用统一的 `segments` 格式返回富媒体内容：

```typescript
return {
    success: true,
    text: '描述文本',
    segments: [
        { type: 'image', data: { file: imageUrl } },
        { type: 'music', data: { type: '163', id: 'songId' } },
    ],
};
```

## 支持的消息类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `text` | 文本 | `{ type: 'text', data: { text: '...' } }` |
| `image` | 图片 | `{ type: 'image', data: { file: '...' } }` |
| `music` | 音乐卡片 | `{ type: 'music', data: { type: '163', id: '...' } }` |
| `record` | 语音 | `{ type: 'record', data: { file: '...' } }` |
| `video` | 视频 | `{ type: 'video', data: { file: '...' } }` |
| `at` | @用户 | `{ type: 'at', data: { qq: '123' } }` |
| `face` | QQ表情 | `{ type: 'face', data: { id: '178' } }` |
| `reply` | 引用回复 | `{ type: 'reply', data: { id: 'msgId' } }` |

## 工具函数

```typescript
import { resolveFileForSend, resolveTestFile, fileToBase64 } from './utils/file.js';

// 智能解析文件路径（自动选择 base64 或本地路径）
const filePath = resolveFileForSend('/path/to/file');

// 解析测试文件（相对于 data/Test file 目录）
const testFile = resolveTestFile('image.webp');

// 强制转 base64
const base64 = fileToBase64('/path/to/file');
```
