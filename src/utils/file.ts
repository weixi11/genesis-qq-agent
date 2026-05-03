/**
 * 文件发送工具
 * 智能处理本地文件发送（支持同系统/跨系统）
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getGlobalFileSendMode, type FileSendMode } from './file_send_mode.js';

/** 文件发送模式 */
export type { FileSendMode } from './file_send_mode.js';

/**
 * 获取文件发送模式配置
 */
export function getFileSendMode(): FileSendMode {
    return getGlobalFileSendMode();
}

/**
 * 获取本地路径前缀（用于同系统部署时）
 * 例如：如果 NapCat 和 Genesis 在同一 Linux 系统，设置为空
 * 如果 NapCat 在 WSL，Genesis 在 Windows，设置路径映射
 */
export function getLocalPathPrefix(): string {
    return process.env.LOCAL_PATH_PREFIX || '';
}

/**
 * 将本地文件转换为 base64:// 格式
 * @param filePath - 本地文件绝对路径
 * @returns base64:// 格式字符串
 */
export function fileToBase64(filePath: string): string {
    try {
        const buffer = fs.readFileSync(filePath);
        const base64Str = `base64://${buffer.toString('base64')}`;
        log.debug(`📦 文件转 base64: ${path.basename(filePath)} (${Math.round(buffer.length / 1024)}KB)`);
        return base64Str;
    } catch (err) {
        log.error(`文件读取失败: ${filePath}`, err);
        throw err;
    }
}

/**
 * 检测当前是否为同系统部署
 * 通过检查 FILE_SEND_MODE 配置判断
 */
export function isSameSystemDeployment(): boolean {
    const mode = getFileSendMode();
    return mode === 'local';
}

/**
 * 智能解析文件路径用于发送
 * 
 * 根据配置选择最佳发送方式:
 * - local: 直接返回本地路径（同系统部署）
 * - base64: 转换为 base64 格式（跨系统部署）
 * - auto: 默认使用 base64（最兼容）
 * 
 * @param filePath - 本地文件绝对路径
 * @returns 可发送的文件路径/URI
 */
export function resolveFileForSend(filePath: string): string {
    const mode = getFileSendMode();

    // 如果已经是 base64:// 或 http/https URL，直接返回
    if (filePath.startsWith('base64://') ||
        filePath.startsWith('http://') ||
        filePath.startsWith('https://')) {
        return filePath;
    }

    switch (mode) {
        case 'local': {
            // 同系统部署：使用本地路径
            const prefix = getLocalPathPrefix();
            const resolved = prefix ? path.join(prefix, filePath) : filePath;
            // 统一使用正斜杠（Linux 兼容）
            const normalizedPath = resolved.replace(/\\/g, '/');
            log.debug(`📂 使用本地路径: ${normalizedPath}`);
            return normalizedPath;
        }

        case 'base64':
        case 'auto':
        default: {
            // 跨系统部署或自动模式：使用 base64
            return fileToBase64(filePath);
        }
    }
}

/**
 * 获取测试文件目录路径
 */
export function getTestFileDir(): string {
    return path.join(process.cwd(), 'data', 'Test file');
}

/**
 * 解析测试文件路径用于发送
 * @param filename - 测试文件名（相对于 Test file 目录）
 * @returns 可发送的文件路径/URI
 */
export function resolveTestFile(filename: string): string {
    const filePath = path.join(getTestFileDir(), filename);
    return resolveFileForSend(filePath);
}
