import express from 'express';
import type { Router } from 'express';
import { systemRouter } from './system.js';
import { featuresRouter } from './features.js';
import { resourcesRouter } from './resources.js';
import { contextRouter } from './context.js';
import { schedulerRouter } from './scheduler.js';

export const apiRouter: Router = express.Router();

apiRouter.use(systemRouter);
apiRouter.use(featuresRouter);
apiRouter.use(resourcesRouter);
apiRouter.use(contextRouter);
apiRouter.use(schedulerRouter);
