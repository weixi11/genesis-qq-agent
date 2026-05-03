import fs from 'fs';
import path from 'path';

type Mode = 'video' | 'audio';

const DEFAULT_BASE_URL = 'https://senapi.fun/v1';
const DEFAULT_MODEL = 'gemini-3-flash-preview';

function usage(): never {
    console.log(`
用法:
  node --import tsx tests/manual/test_gemini_media.ts <video|audio> <filePath> [question]

示例:
  node --import tsx tests/manual/test_gemini_media.ts video "data/Test file/0ea911a5ad2763b9.mp4" "请描述这个视频内容"
  node --import tsx tests/manual/test_gemini_media.ts audio "data/Test file/6a81bcd044425bed111c8ad530419f86.amr.mp3" "请转写并总结这段音频"

环境变量:
  MEDIA_TEST_BASE_URL   默认: ${DEFAULT_BASE_URL}
  MEDIA_TEST_API_KEY    必填
  MEDIA_TEST_MODEL      默认: ${DEFAULT_MODEL}
`);
    process.exit(1);
}

function getMimeType(ext: string): string {
    switch (ext) {
        case '.mp4':
            return 'video/mp4';
        case '.mov':
            return 'video/quicktime';
        case '.webm':
            return 'video/webm';
        default:
            return 'application/octet-stream';
    }
}

function getAudioFormat(ext: string): 'mp3' | 'wav' {
    if (ext === '.wav') return 'wav';
    return 'mp3';
}

function safePreview(text: string, max = 600): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function callChatCompletions(payload: unknown, baseUrl: string, apiKey: string) {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    const raw = await response.text();
    let json: unknown = null;
    try {
        json = JSON.parse(raw);
    } catch {
        json = raw;
    }

    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data: json,
        raw,
    };
}

async function testVideo(filePath: string, question: string, baseUrl: string, apiKey: string, model: string) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(ext);
    const base64 = fs.readFileSync(filePath).toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;

    const payload = {
        model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: question },
                    { type: 'image_url', image_url: { url: dataUri } },
                ],
            },
        ],
    };

    return callChatCompletions(payload, baseUrl, apiKey);
}

async function testAudio(filePath: string, question: string, baseUrl: string, apiKey: string, model: string) {
    const ext = path.extname(filePath).toLowerCase();
    const base64 = fs.readFileSync(filePath).toString('base64');
    const format = getAudioFormat(ext);

    const payload = {
        model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: question },
                    {
                        type: 'input_audio',
                        input_audio: {
                            data: base64,
                            format,
                        },
                    },
                ],
            },
        ],
    };

    return callChatCompletions(payload, baseUrl, apiKey);
}

async function main() {
    const [, , modeArg, fileArg, ...questionParts] = process.argv;
    if (!modeArg || !fileArg) usage();

    const mode = modeArg as Mode;
    if (mode !== 'video' && mode !== 'audio') usage();

    const baseUrl = process.env.MEDIA_TEST_BASE_URL || DEFAULT_BASE_URL;
    const apiKey = process.env.MEDIA_TEST_API_KEY || '';
    const model = process.env.MEDIA_TEST_MODEL || DEFAULT_MODEL;
    const question = questionParts.join(' ').trim()
        || (mode === 'video' ? '请描述这个视频的主要内容。' : '请转写并总结这段音频内容。');

    if (!apiKey) {
        console.error('缺少 MEDIA_TEST_API_KEY');
        process.exit(2);
    }

    const absolutePath = path.resolve(fileArg);
    if (!fs.existsSync(absolutePath)) {
        console.error(`文件不存在: ${absolutePath}`);
        process.exit(3);
    }

    const size = fs.statSync(absolutePath).size;
    console.log(`模式: ${mode}`);
    console.log(`文件: ${absolutePath}`);
    console.log(`大小: ${size} bytes`);
    console.log(`模型: ${model}`);
    console.log(`接口: ${baseUrl}/chat/completions`);
    console.log(`问题: ${question}`);
    console.log('开始请求...\n');

    const result = mode === 'video'
        ? await testVideo(absolutePath, question, baseUrl, apiKey, model)
        : await testAudio(absolutePath, question, baseUrl, apiKey, model);

    console.log(`HTTP ${result.status} ${result.statusText}`);

    if (typeof result.data === 'string') {
        console.log(safePreview(result.data));
        process.exit(result.ok ? 0 : 10);
    }

    console.log(JSON.stringify(result.data, null, 2));

    if (!result.ok) {
        process.exit(10);
    }
}

main().catch((error) => {
    console.error('测试失败:');
    console.error(error);
    process.exit(99);
});
