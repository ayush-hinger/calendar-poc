import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, googleConfigured, microsoftConfigured } from './config.ts';
import './db.ts';
import { apiRouter } from './routes/api.ts';
import { oauthRouter } from './routes/oauth.ts';
import { startWorker } from './sync/worker.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(here, 'web')));

app.use('/api', apiRouter);
app.use('/', oauthRouter);

app.get('/', (_req, res) => {
  res.sendFile(path.join(here, 'web', 'teacher.html'));
});

app.get('/student/:id', (_req, res) => {
  res.sendFile(path.join(here, 'web', 'student.html'));
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[http]', err);
    res.status(500).json({ error: err.message });
  },
);

app.listen(config.PORT, () => {
  console.log(`\n  Calendar sync POC -> ${config.APP_BASE_URL}`);
  console.log(
    `  providers: google=${googleConfigured ? 'configured' : 'not configured'} ` +
      `microsoft=${microsoftConfigured ? 'configured' : 'not configured'} apple=app-password`,
  );
  if (!config.ENCRYPTION_KEY) {
    console.warn(
      '  warning: ENCRYPTION_KEY is unset, so provider tokens are stored unencrypted.',
    );
  }
  console.log('');
  startWorker();
});
