/**
 * System Status 模块 - 查询系统运行状态
 */

import os from 'os';
import { execSync } from 'child_process';
import { taskManager } from '../../task/index.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'system_status';
export const description = '查询系统运行状态，比如"系统状态"、"服务器状态"、"机器人状态"';
export const keywords = ['系统状态', '运行状态', '服务器状态', '系统信息', 'bot状态', '机器人状态'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 工具函数 ====================

/** 将秒数格式化为 "X天X小时X分钟" */
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    return parts.length > 0 ? parts.join('') : '不到1分钟';
}

/** 渲染进度条 */
function progressBar(percent: number, length = 10): string {
    const filled = Math.round((percent / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

// ==================== Section 构建函数 ====================

function buildSystemSection(): string {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    // CPU 占用率（基于空闲时间比例）
    let cpuPercent = 0;
    if (cpus.length > 0) {
        const totalIdle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
        const totalTick = cpus.reduce(
            (acc, cpu) => acc + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq,
            0,
        );
        cpuPercent = Math.round((1 - totalIdle / totalTick) * 100);
    }

    const usedGB = (usedMem / 1024 / 1024 / 1024).toFixed(2);
    const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(2);
    const cpuModel = cpus[0]?.model || 'Unknown';

    return [
        '📊 系统资源',
        `  主机: ${os.hostname()} (${os.platform()}/${os.arch()})`,
        `  系统运行: ${formatUptime(os.uptime())}`,
        `  CPU: ${cpuModel} (${cpus.length}核)`,
        `  CPU占用: ${progressBar(cpuPercent)} ${cpuPercent}%`,
        `  内存: ${usedGB}/${totalGB} GB`,
        `  内存占用: ${progressBar(memPercent)} ${memPercent}%`,
    ].join('\n');
}

function buildDiskSection(): string {
    try {
        if (os.platform() === 'win32') {
            const output = execSync('wmic logicaldisk get size,freespace,caption', {
                encoding: 'utf8',
                timeout: 3000,
            });
            const lines = output.trim().split('\n').slice(1);
            const disks: string[] = [];
            let totalSize = 0;
            let totalFree = 0;
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3 && parts[1] && parts[2]) {
                    const free = parseInt(parts[1], 10) || 0;
                    const size = parseInt(parts[2], 10) || 0;
                    if (size > 0) {
                        totalFree += free;
                        totalSize += size;
                        const used = size - free;
                        const pct = Math.round((used / size) * 100);
                        const sizeGB = (size / 1024 / 1024 / 1024).toFixed(1);
                        const usedGB = (used / 1024 / 1024 / 1024).toFixed(1);
                        disks.push(`  ${parts[0]} ${usedGB}/${sizeGB} GB ${progressBar(pct)} ${pct}%`);
                    }
                }
            }
            if (disks.length > 0) {
                const totalPct = totalSize > 0 ? Math.round(((totalSize - totalFree) / totalSize) * 100) : 0;
                return ['💾 磁盘状态', ...disks, `  总占用: ${progressBar(totalPct)} ${totalPct}%`].join('\n');
            }
        } else {
            const output = execSync("df -B1 / | tail -1", { encoding: 'utf8', timeout: 3000 });
            const parts = output.trim().split(/\s+/);
            if (parts.length >= 4) {
                const size = parseInt(parts[1], 10);
                const used = parseInt(parts[2], 10);
                const free = parseInt(parts[3], 10);
                const pct = size > 0 ? Math.round((used / size) * 100) : 0;
                return [
                    '💾 磁盘状态',
                    `  /: ${(used / 1024 / 1024 / 1024).toFixed(1)}/${(size / 1024 / 1024 / 1024).toFixed(1)} GB`,
                    `  磁盘占用: ${progressBar(pct)} ${pct}%`,
                    `  可用: ${(free / 1024 / 1024 / 1024).toFixed(1)} GB`,
                ].join('\n');
            }
        }
    } catch {
        // 获取磁盘信息失败
    }
    return ['💾 磁盘状态', '  暂无法获取磁盘信息'].join('\n');
}

function buildNetworkSection(): string {
    const nets = os.networkInterfaces();
    const interfaces = Object.entries(nets)
        .filter(([name]) => !name.toLowerCase().includes('loopback'))
        .flatMap(([name, addrs]) => {
            const ipv4 = addrs?.find(a => a.family === 'IPv4' && !a.internal);
            if (!ipv4) return [];
            return [{ name, address: ipv4.address, mac: ipv4.mac }];
        })
        .slice(0, 5);

    if (interfaces.length === 0) {
        return ['🌐 网络状态', '  未检测到活动网络接口'].join('\n');
    }

    const lines = ['🌐 网络状态'];
    for (const iface of interfaces) {
        lines.push(`  ${iface.name}: ${iface.address}`);
        if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
            lines.push(`    MAC: ${iface.mac}`);
        }
    }
    return lines.join('\n');
}

async function buildBotSection(): Promise<string> {
    let connected = false;
    try {
        const { connector } = await import('../../connector.js');
        connected = connector.connected;
    } catch {
        // connector 未初始化
    }

    const statusIcon = connected ? '🟢 已连接' : '🔴 未连接';

    return [
        '🤖 机器人状态',
        `  连接状态: ${statusIcon}`,
        `  进程PID: ${process.pid}`,
        `  进程运行: ${formatUptime(Math.floor(process.uptime()))}`,
        `  Node版本: ${process.version}`,
    ].join('\n');
}

function buildTasksSection(): string {
    const stats = taskManager.getStats();
    const allTasks = taskManager.getAllTasks(100);

    const completedTasks = allTasks.filter(t => t.status === 'success' || t.status === 'failed');
    const totalDuration = completedTasks.reduce((sum, t) => {
        if (t.finishedAt && t.startedAt) {
            return sum + (t.finishedAt - t.startedAt);
        }
        return sum;
    }, 0);
    const avgDuration = completedTasks.length > 0 ? Math.round(totalDuration / completedTasks.length / 1000) : 0;

    return [
        '📋 任务统计',
        `  总任务数: ${stats.total}`,
        `  等待中: ${stats.byStatus.pending} | 执行中: ${stats.byStatus.running}`,
        `  已完成: ${stats.byStatus.success} | 已失败: ${stats.byStatus.failed}`,
        `  平均耗时: ${avgDuration}秒`,
    ].join('\n');
}

async function buildToolsSection(): Promise<string> {
    let enabledNames: string[] = [];
    let totalCount = 0;

    try {
        const { toolRegistry } = await import('../../services/tool_registry.js');
        enabledNames = toolRegistry.getEnabledToolNames();
        totalCount = toolRegistry.getAllModules().length;
    } catch {
        // tool_registry 未初始化
    }

    const listStr = enabledNames.length > 0 ? enabledNames.join(', ') : '无';

    return [
        '🔧 工具状态',
        `  已启用: ${enabledNames.length}/${totalCount} 个工具`,
        `  列表: ${listStr}`,
    ].join('\n');
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    _ctx: ModuleContext,
): Promise<ModuleResult> {
    const section = params.section as string | undefined;

    const sections: string[] = [];

    if (!section || section === 'system') {
        sections.push(buildSystemSection());
    }
    if (!section || section === 'disk') {
        sections.push(buildDiskSection());
    }
    if (!section || section === 'network') {
        sections.push(buildNetworkSection());
    }
    if (!section || section === 'bot') {
        sections.push(await buildBotSection());
    }
    if (!section || section === 'tasks') {
        sections.push(buildTasksSection());
    }
    if (!section || section === 'tools') {
        sections.push(await buildToolsSection());
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.toTimeString().slice(0, 8)}`;

    const header = '🖥️ Genesis 系统状态报告';
    const footer = `⏰ ${timestamp}`;

    const text = [header, '', ...sections, '', footer].join('\n');

    return { success: true, text };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;
