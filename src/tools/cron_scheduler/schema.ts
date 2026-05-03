import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'cron_scheduler',
    description: '管理定时/周期任务：创建、查询、更新、删除、启停、立即执行。任务可调度白名单工具并传入 JSON 参数，支持模板变量 {{now}}/{{today}}。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'list', 'get', 'update', 'delete', 'enable', 'disable', 'run_now'],
                description: '操作类型',
            },
            task_id: { type: 'string', description: '任务 ID（get/update/delete/enable/disable/run_now 必填）' },
            name: { type: 'string', description: '任务名称' },
            schedule_type: { type: 'string', enum: ['once', 'cron'], description: '调度类型：一次性或 cron 周期' },
            run_at: { type: 'string', description: '一次性任务执行时间（建议 ISO8601）' },
            cron: { type: 'string', description: 'cron 表达式（5段：分 时 日 月 周）' },
            timezone: { type: 'string', description: '时区，默认 Asia/Shanghai' },
            tool_name: { type: 'string', description: '要执行的工具名（必须在白名单中）' },
            group_id: {
                oneOf: [
                    { type: 'integer', minimum: 1 },
                    { type: 'null' },
                ],
                description: '可选的群号；update 时传 null 可清空群上下文',
            },
            tool_params: {
                oneOf: [
                    { type: 'object', additionalProperties: true },
                    { type: 'string' },
                ],
                description: '工具参数（JSON 对象或 JSON 字符串）',
            },
            enabled: { type: 'boolean', description: '是否启用任务' },
            retries: { type: 'integer', minimum: 0, description: '失败重试次数' },
            timeout_sec: { type: 'integer', minimum: 1, description: '单次执行超时秒数' },
            max_concurrency: { type: 'integer', minimum: 1, description: '任务级并发上限' },
            notify_on_fail: { type: 'boolean', description: '失败时是否告警（记录日志）' },
            filters: {
                oneOf: [
                    {
                        type: 'object',
                        properties: {
                            status: { type: 'string' },
                            tool_name: { type: 'string' },
                            created_by: { type: 'integer' },
                            enabled: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    },
                    { type: 'string' },
                ],
                description: 'list 过滤器（对象或 JSON 字符串）',
            },
            page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
            page_size: { type: 'integer', minimum: 1, description: '每页数量，默认 20' },
        },
        required: ['action'],
    },
} as unknown as ModuleSchema;
