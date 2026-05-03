import express from 'express';
import type { Router, Request, Response } from 'express';
import {
    clearAllContextFromDisk,
    clearContextSessionFromDisk,
    getContextSessionFromDisk,
    listContextSessionsFromDisk,
    memory,
} from '../../memory.js';
import { log } from '../../logger.js';
import { getGenesisProcessRole, syncGenesisAgentProcess } from '../services/process_control.js';

export const contextRouter: Router = express.Router();

function buildContextSyncMessage(scope: 'single' | 'all', applied: boolean): string {
    if (scope === 'all') {
        return applied
            ? '已清除全部会话记忆，genesis-agent 已同步'
            : '已清除全部会话记忆，但 genesis-agent 同步失败';
    }

    return applied
        ? '会话记忆已清除，genesis-agent 已同步'
        : '会话记忆已清除，但 genesis-agent 同步失败';
}

/**
 * 获取所有活跃会话列表
 */
contextRouter.get('/context', async (req: Request, res: Response) => {
    try {
        if (getGenesisProcessRole() === 'web') {
            return res.json(await listContextSessionsFromDisk());
        }

        const sessions = memory.getAllSessions();
        const details = sessions.map(s => {
            const msgs = memory.getSessionByKey(s.key);
            const lastMsg = msgs && msgs.length > 0 ? msgs[msgs.length - 1] : null;
            return {
                key: s.key,
                count: s.count,
                lastActivity: lastMsg ? lastMsg.time * 1000 : 0,
            };
        });

        details.sort((a, b) => b.lastActivity - a.lastActivity);
        res.json(details);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

/**
 * 获取指定会话的上下文详情
 */
contextRouter.get('/context/:key', async (req: Request<{ key: string }>, res: Response) => {
    try {
        const key = decodeURIComponent(req.params.key);
        const messages = getGenesisProcessRole() === 'web'
            ? await getContextSessionFromDisk(key)
            : memory.getSessionByKey(key);
        if (!messages) {
            return res.status(404).json({ error: 'Session not found' });
        }
        res.json(messages);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

/**
 * 清除所有会话
 */
contextRouter.delete('/context', async (req: Request, res: Response) => {
    try {
        if (getGenesisProcessRole() === 'web') {
            await clearAllContextFromDisk();
            const agentSync = await syncGenesisAgentProcess();
            log.info('🧹 清除所有会话记忆并同步 genesis-agent (Web控制台)');
            return res.json({
                success: true,
                agentSync,
                message: buildContextSyncMessage('all', agentSync.applied),
            });
        }

        memory.clearAll();
        log.info('🧹 清除所有会话记忆 (Web控制台)');
        res.json({ success: true });
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

/**
 * 清除指定会话
 */
contextRouter.delete('/context/:key', async (req: Request<{ key: string }>, res: Response) => {
    try {
        const key = decodeURIComponent(req.params.key);
        if (getGenesisProcessRole() === 'web') {
            await clearContextSessionFromDisk(key);
            const agentSync = await syncGenesisAgentProcess();
            log.info(`🧹 清除会话记忆并同步 genesis-agent: ${key} (Web控制台)`);
            return res.json({
                success: true,
                agentSync,
                message: buildContextSyncMessage('single', agentSync.applied),
            });
        }

        memory.clear(key);
        log.info(`🧹 清除会话记忆: ${key} (Web控制台)`);
        res.json({ success: true });
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});
