import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger.js';
import { safeParseJson } from './json.js';

function unquoteEnvValue(rawValue: string): string {
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        const parsed = safeParseJson(rawValue);
        return typeof parsed === 'string' ? parsed : rawValue.slice(1, -1);
    }
    if (rawValue.startsWith('\'') && rawValue.endsWith('\'')) {
        return rawValue.slice(1, -1);
    }
    return rawValue;
}

export function parseEnvFileSync(envPath: string): Record<string, string> {
    if (!fs.existsSync(envPath)) {
        return {};
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const equalsIndex = line.indexOf('=');
        if (equalsIndex === -1) continue;
        const key = line.slice(0, equalsIndex).trim();
        result[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
    }
    return result;
}

/**
 * 更新 .env 文件中的环境变量
 * 如果键存在则更新，不存在则追加
 */
export function updateEnvVariable(
    key: string,
    value: string,
    options: { sensitive?: boolean; envPath?: string } = {}
): boolean {
    try {
        const envPath = options.envPath
            ? path.resolve(options.envPath)
            : path.resolve(process.cwd(), '.env');

        if (!fs.existsSync(envPath)) {
            log.warn('.env 文件不存在，无法持久化配置');
            return false;
        }

        const content = fs.readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');
        let found = false;
        const newLines = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // 匹配 KEY=VALUE，忽略注释
            if (trimmed.startsWith(`${key}=`)) {
                newLines.push(`${key}=${value}`);
                found = true;
            } else {
                newLines.push(line);
            }
        }

        if (!found) {
            // 如果文件末尾没有换行，先追加一个
            if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== '') {
                newLines.push('');
            }
            newLines.push(`${key}=${value}`);
        }

        fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
        const displayValue = options.sensitive ? '[REDACTED]' : value;
        log.info(`💾 配置已保存: ${key}=${displayValue}`);
        return true;
    } catch (err) {
        log.error(`保存配置失败 (${key}):`, err);
        return false;
    }
}
