import { log } from '../logger.js';
import { claimPendingToolTestRequest, completeToolTestRequest } from './tool_test_request_store.js';
import { executePreparedToolTest, recordToolTestLog } from './tool_test_runner.js';

const TOOL_TEST_REQUEST_POLL_MS = 1000;

class ToolTestRequestWorker {
    private timer: NodeJS.Timeout | null = null;
    private processing = false;

    start(): void {
        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => {
            void this.processQueuedRequests();
        }, TOOL_TEST_REQUEST_POLL_MS);
        this.timer.unref?.();

        void this.processQueuedRequests();
    }

    stop(): void {
        if (!this.timer) {
            return;
        }

        clearInterval(this.timer);
        this.timer = null;
    }

    private async processQueuedRequests(): Promise<void> {
        if (this.processing) {
            return;
        }

        this.processing = true;
        try {
            while (true) {
                const request = await claimPendingToolTestRequest();
                if (!request) {
                    break;
                }

                try {
                    const result = await executePreparedToolTest(request.payload);
                    recordToolTestLog(request.toolName, request.payload.requestParams, result);
                    await completeToolTestRequest(request.requestId, {
                        status: 'success',
                        durationMs: result.duration,
                        response: result.response,
                    });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    log.warn('🧪 Web 工具测试队列执行失败:', error);
                    await completeToolTestRequest(request.requestId, {
                        status: 'failed',
                        durationMs: 0,
                        errorMessage,
                    });
                }
            }
        } finally {
            this.processing = false;
        }
    }
}

export const toolTestRequestWorker = new ToolTestRequestWorker();
