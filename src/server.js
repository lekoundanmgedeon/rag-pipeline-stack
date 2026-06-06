/**
 * Serveur Express principal
 * Pipeline RAG — Ingestion documentaire avec Ollama
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { checkDbConnection } from './config/database.js';
import { redis } from './config/redis.js';
import { OllamaEmbeddingService } from './services/EmbeddingService.js';
import uploadRoutes from './routes/upload.js';
import { logger } from './utils/logger.js';

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── Sécurité ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:  process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Parsing ──────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Routes ───────────────────────────────────────────────────────
app.use('/api', uploadRoutes);

// ── Health check ─────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = {};

  try {
    checks.db = await checkDbConnection();
    checks.db = 'ok';
  } catch (err) {
    checks.db = `error: ${err.message}`;
  }

  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch (err) {
    checks.redis = `error: ${err.message}`;
  }

  try {
    const embedSvc = new OllamaEmbeddingService();
    const health   = await embedSvc.healthCheck();
    checks.ollama  = health.ok ? 'ok' : health.message;
  } catch (err) {
    checks.ollama = `error: ${err.message}`;
  }

  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ── Error handler global ─────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error:  err.message,
    stack:  err.stack,
    path:   req.path,
    method: req.method,
  });
  res.status(500).json({
    error:   'Erreur interne',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ── Démarrage ────────────────────────────────────────────────────
async function start() {
  // Vérification connexions au démarrage
  try {
    const dbVersion = await checkDbConnection();
    logger.info(`PostgreSQL connected: ${dbVersion.split(' ').slice(0,2).join(' ')}`);
  } catch (err) {
    logger.error('Cannot connect to PostgreSQL', { error: err.message });
    process.exit(1);
  }

  try {
    await redis.connect();
    logger.info('Redis connected');
  } catch (err) {
    logger.warn('Redis connection failed (queuing disabled)', { error: err.message });
  }

  const embedSvc = new OllamaEmbeddingService();
  const ollamaHealth = await embedSvc.healthCheck();
  if (!ollamaHealth.ok) {
    logger.warn(`Ollama: ${ollamaHealth.message}`);
    logger.warn(`Run: ollama pull ${process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'}`);
  } else {
    logger.info(`Ollama ready: ${ollamaHealth.target}`);
  }

  app.listen(PORT, () => {
    logger.info(`🚀 RAG Ingestion API running on http://localhost:${PORT}`);
    logger.info(`   Environment : ${process.env.NODE_ENV}`);
    logger.info(`   Embed model : ${process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'}`);
    logger.info(`   LLM model   : ${process.env.OLLAMA_LLM_MODEL  || 'qwen3:8b'}`);
  });
}

start().catch(err => {
  logger.error('Startup failed', { error: err.message });
  process.exit(1);
});

export default app;
