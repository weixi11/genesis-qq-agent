process.env.GENESIS_PROCESS_ROLE = 'web';

import { initializeSharedRuntimeState } from '../src/bootstrap/shared_state.ts';
import { startWebServer } from '../src/web/server.ts';
import { connector } from '../src/connector.ts';
import { log } from '../src/logger.ts';
await initializeSharedRuntimeState({ mode: 'web-readonly' });

startWebServer();

connector.connect().catch((error) => {
    log.warn(`Web 控制台消息流连接失败: ${error instanceof Error ? error.message : String(error)}`);
});

setInterval(() => {}, 1000);
