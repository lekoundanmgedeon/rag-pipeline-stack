/**
 * IngestionService — orchestre le pipeline complet :
 *   Upload → Parse → Clean → Chunk → Persist → Queue Embedding
 */

import { join, basename, extname } from 'path';
import { rename, unlink } from 'fs/promises';
import { DocumentParser } from './DocumentParser.js';
import { RecursiveChunker, PageAwareChunker } from './Chunker.js';
import { DocumentRepository } from '../repositories/DocumentRepository.js';
import { OllamaEmbeddingService } from './EmbeddingService.js';
import { Queue } from 'bullmq';
import { QUEUES, JOB_OPTIONS } from '../config/redis.js';
import { logger, logIngestion } from '../utils/logger.js';
import 'dotenv/config';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

export class IngestionService {
  constructor(db, redis) {
    this.db         = db;
    this.repo       = new DocumentRepository(db);
    this.embedSvc   = new OllamaEmbeddingService(redis);
    this.chunker    = new RecursiveChunker();
    this.pageChunker= new PageAwareChunker();
    this.queue      = new Queue(QUEUES.EMBEDDING, { connection: redis });
  }

  // ── 1. Ingestion depuis un upload HTTP ───────────────────────

  /**
   * Point d'entrée principal : reçoit un fichier uploadé via Multer
   * et démarre le pipeline asynchrone.
   *
   * @param {object} file    - fichier Multer { path, originalname, mimetype, size }
   * @param {object} options - { tenantId, userId, metadata }
   * @returns {object} document créé (status: 'pending')
   */
  async ingestFile(file, { tenantId, userId, metadata = {} }) {
    const fileName    = file.originalname;
    const fileType    = extname(fileName).replace('.', '').toLowerCase();
    const storagePath = join(UPLOAD_DIR, `${tenantId}/${Date.now()}_${fileName}`);

    // Déplacer le fichier temporaire vers le stockage définitif
    await this._ensureDir(join(UPLOAD_DIR, tenantId));
    await rename(file.path, storagePath);

    // Créer l'entrée en base
    const document = await this.repo.create({
      tenantId,
      userId,
      title:       metadata.title || basename(fileName, extname(fileName)),
      fileName,
      fileType,
      fileSize:    file.size,
      storagePath,
      metadata,
    });

    logIngestion(document.id, 'Document created', { fileType, size: file.size });

    // Mettre en queue le traitement (asynchrone)
    const job = await this.queue.add(
      'process-document',
      { documentId: document.id, tenantId, storagePath },
      JOB_OPTIONS
    );

    await this.repo.createJob(document.id, job.id);

    return document;
  }

  // ── 2. Pipeline de traitement (appelé par le Worker) ─────────

  /**
   * Pipeline complet : parse → chunk → persist → embed
   * Appelé par le BullMQ Worker.
   */
  async processDocument(documentId, tenantId, storagePath, onProgress = null) {
    const startMs = Date.now();
    await this.repo.updateStatus(documentId, 'processing');
    await this.repo.updateJob(documentId, {
      status:     'parsing',
      started_at: new Date().toISOString(),
    });

    try {
      // ── Étape 1 : Parsing ───────────────────────────────────
      logIngestion(documentId, 'Parsing document');
      onProgress?.({ stage: 'parsing', pct: 5 });

      const parsed  = await DocumentParser.parse(storagePath);
      const { text, pages, metadata: parsedMeta } = parsed;

      if (!text || text.length < 50) {
        throw new Error('Document vide ou non lisible (< 50 caractères extraits)');
      }

      logIngestion(documentId, 'Parsed', { chars: text.length, parseMs: parsed.parseMs });
      await this.repo.updateJob(documentId, { status: 'chunking', progress: 20 });
      onProgress?.({ stage: 'chunking', pct: 20 });

      // ── Étape 2 : Chunking ─────────────────────────────────
      let chunks;
      if (pages?.length > 1) {
        // PDF avec pages → respecter les frontières de page
        chunks = this.pageChunker.chunkPages(pages, parsedMeta);
      } else {
        chunks = this.chunker.chunk(text, parsedMeta);
      }

      const chunkStats = this.chunker.stats(chunks);
      logIngestion(documentId, 'Chunked', chunkStats);

      if (!chunks.length) {
        throw new Error('Aucun chunk généré depuis le document');
      }

      // ── Étape 3 : Persistance des chunks ───────────────────
      await this.repo.updateJob(documentId, { status: 'chunking', progress: 40 });

      // Supprimer les anciens chunks si re-indexation
      await this.repo.deleteChunksByDocument(documentId);

      // Insérer en bulk
      const chunkRows = chunks.map(c => ({
        documentId,
        tenantId,
        chunkIndex:  c.chunkIndex,
        content:     c.content,
        tokenCount:  c.tokenCount,
        metadata:    c.metadata,
      }));

      await this.repo.insertChunks(chunkRows);
      await this.repo.updateJob(documentId, {
        status:   'embedding',
        progress: 50,
        stats:    { chunks_total: chunks.length, ...chunkStats, parse_ms: parsed.parseMs },
      });
      onProgress?.({ stage: 'embedding', pct: 50 });

      // ── Étape 4 : Génération des embeddings ────────────────
      logIngestion(documentId, 'Starting embedding', { chunks: chunks.length });

      await this.embedSvc.indexDocument(
        documentId,
        this.db,
        (pct) => {
          const globalPct = 50 + Math.round(pct * 0.45); // 50% → 95%
          this.repo.updateJob(documentId, { progress: globalPct });
          onProgress?.({ stage: 'embedding', pct: globalPct });
        }
      );

      // ── Étape 5 : Finalisation ─────────────────────────────
      const totalMs = Date.now() - startMs;

      await this.repo.updateStatus(documentId, 'indexed', {
        chunkCount: chunks.length,
      });
      await this.repo.updateJob(documentId, {
        status:       'done',
        progress:     100,
        completed_at: new Date().toISOString(),
        stats: {
          chunks_total: chunks.length,
          ...chunkStats,
          parse_ms:  parsed.parseMs,
          total_ms:  totalMs,
        },
      });

      logIngestion(documentId, 'Ingestion complete', {
        chunks:  chunks.length,
        totalMs,
      });

      onProgress?.({ stage: 'done', pct: 100 });
      return { documentId, chunks: chunks.length, totalMs };

    } catch (err) {
      logger.error('Ingestion failed', { documentId, error: err.message, stack: err.stack });

      await this.repo.updateStatus(documentId, 'error', { errorMessage: err.message });
      await this.repo.updateJob(documentId, {
        status: 'failed',
        error:  err.message,
      });

      throw err;
    }
  }

  // ── 3. Re-indexation ─────────────────────────────────────────

  async reindex(documentId, tenantId) {
    const doc = await this.repo.findById(documentId, tenantId);
    if (!doc) throw new Error('Document introuvable');
    if (!doc.storage_path) throw new Error('Fichier source introuvable');

    logIngestion(documentId, 'Re-indexing');
    return this.processDocument(documentId, tenantId, doc.storage_path);
  }

  // ── 4. Suppression ───────────────────────────────────────────

  async deleteDocument(documentId, tenantId) {
    const doc = await this.repo.findById(documentId, tenantId);
    if (!doc) throw new Error('Document introuvable');

    // Supprimer le fichier physique
    if (doc.storage_path) {
      try { await unlink(doc.storage_path); } catch {}
    }

    // La suppression en DB cascade sur les chunks (ON DELETE CASCADE)
    await this.repo.delete(documentId, tenantId);
    logIngestion(documentId, 'Document deleted');
  }

  // ── Utilitaires ──────────────────────────────────────────────

  async _ensureDir(dir) {
    const { mkdir } = await import('fs/promises');
    await mkdir(dir, { recursive: true });
  }
}
