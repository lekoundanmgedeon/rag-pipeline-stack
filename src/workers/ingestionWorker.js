/**
 * IngestionWorker — Worker BullMQ
 *
 * Traite les jobs d'ingestion documentaire de façon asynchrone.
 * Lancer séparément : node src/workers/ingestionWorker.js
 */

import 'dotenv/config';
import { Worker, QueueEvents } from 'bullmq';
import { redis, QUEUES } from '../config/redis.js';
import db from '../config/database.js';
import { IngestionService } from '../services/IngestionService.js';
import { logger } from '../utils/logger.js';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3');

const ingestionSvc = new IngestionService(db, redis);

// ── Worker ───────────────────────────────────────────────────────
const worker = new Worker(
  QUEUES.EMBEDDING,
  async (job) => {
    const { documentId, tenantId, storagePath } = job.data;

    logger.info(`Processing job ${job.id}`, { documentId });

    await ingestionSvc.processDocument(
      documentId,
      tenantId,
      storagePath,
      // Mise à jour progression BullMQ
      async ({ stage, pct }) => {
        await job.updateProgress(pct);
        await job.log(`[${stage}] ${pct}%`);
      }
    );

    return { documentId, status: 'indexed' };
  },
  {
    connection:  redis,
    concurrency: CONCURRENCY,
    // Délai entre tentatives visible dans les logs
    stalledInterval: 30_000,
    lockDuration:    60_000,
  }
);

// ── Event listeners ──────────────────────────────────────────────
worker.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`, { documentId: job.data.documentId });
});

worker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed`, {
    documentId: job?.data?.documentId,
    error: err.message,
    attempt: job?.attemptsMade,
  });
});

worker.on('progress', (job, progress) => {
  logger.debug(`Job ${job.id} progress: ${progress}%`);
});

worker.on('error', (err) => {
  logger.error('Worker error', { error: err.message });
});

// ── Graceful shutdown ────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`Worker received ${signal}, shutting down gracefully...`);
  await worker.close();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

logger.info(`Ingestion Worker started`, {
  queue:       QUEUES.EMBEDDING,
  concurrency: CONCURRENCY,
  ollamaModel: process.env.OLLAMA_EMBED_MODEL,
});
