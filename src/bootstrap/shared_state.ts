import { loadSentryState } from '../agents/sentry.js';
import { initProfilesDb } from '../profiler/store.js';
import { mediaTracker } from '../services/media_tracker.js';
import { initGenesisDb } from '../storage/genesis-db.js';
import { taskManager } from '../task/manager.js';
import { initModuleLoader } from '../tools/index.js';
import { llmStats } from '../web/store/llm_stats.js';
import { toolStats } from '../web/store/tool_stats.js';
import { memory } from '../memory.js';

export type SharedRuntimeInitMode = 'full' | 'web-readonly';

interface SharedRuntimeInitOptions {
    mode?: SharedRuntimeInitMode;
}

export function shouldLoadHotRuntimeState(mode: SharedRuntimeInitMode = 'full'): boolean {
    return mode === 'full';
}

export async function initializeSharedRuntimeState(options: SharedRuntimeInitOptions = {}): Promise<void> {
    const mode = options.mode || 'full';

    await initProfilesDb();
    await initGenesisDb({ mode: mode === 'web-readonly' ? 'readonly' : 'readwrite' });
    await initModuleLoader(true);

    llmStats.loadFromDb();
    toolStats.loadFromDb();

    if (shouldLoadHotRuntimeState(mode)) {
        memory.loadFromDb();
        mediaTracker.loadFromDb();
        taskManager.loadFromDb();
        loadSentryState();
    }
}
