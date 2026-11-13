import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { camelize } from './lib/camelize.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { docsRouter } from './routes/docs.js';
import { studentRouter } from './routes/student.js';
import { tutorRouter } from './routes/tutor.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(attachUser);
  // Every JSON response is camelCase (see lib/camelize.ts).
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(camelize(body));
    next();
  });

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use(docsRouter);
  app.use('/auth', authRouter);
  app.use('/admin', adminRouter);
  app.use('/tutor', tutorRouter);
  app.use('/student', studentRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
