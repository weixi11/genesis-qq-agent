import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'read_file',
    description: '读取并分析文档文件内容。支持格式：.docx, .doc, .xlsx, .xls, .txt, .md, .py, .js, .ts, .json, .csv, .xml 等文本/代码文件。注意：图片文件(.jpg/.png等)和PDF文件请使用 vision 工具。',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '文件路径（可不填，自动从消息获取）' },
            file: { type: 'string', description: '文件路径（path 的别名）' },
            question: { type: 'string', description: '关于文件的问题' },
        },
        required: [],
    },
};
