/**
 * OllamaEmbeddingService
 *
 * Génère les embeddings vectoriels via Ollama (local).
 * Modèles recommandés :
 *   - nomic-embed-text  → 768 dims, rapide, bonne qualité
 *   - mxbai-embed-large → 1024 dims, meilleure qualité
 *   - all-minilm        → 384 dims, très rapide
 *
 * Pull du modèle : ollama pull nomic-embed-text
 */

import axios from 'axios';
import crypto from 'crypto';
import { logger, logIngestion } from '../utils/logger.js';
import 'dotenv/config';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL  || 'http://localhost:11434';
const MODEL       = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const BATCH_SIZE  = parseInt(process.env.EMBEDDING_BATCH_SIZE || '20');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');

export class OllamaEmbeddingService {
  constructor(redis = null) {
    this.redis    = redis;
    this.model    = MODEL;
    this.baseUrl  = OLLAMA_BASE;
    this.cacheTTL = 3600; // 1h
    this._client  = axios.create({
      baseURL: this.baseUrl,
      timeout: 60_000,     // Ollama local peut être lent au premier appel
    });
  }

  // ── API principale ────────────────────────────────────────────

  /**
   * Embed un seul texte (avec cache Redis si disponible)
   */
  async embed(text) {
    const cacheKey = this._cacheKey(text);

    // Lecture cache
    if (this.redis) {
      const cached = await this._fromCache(cacheKey);
      if (cached) return cached;
    }

    const [embedding] = await this._embedBatch([text]);

    // Écriture cache
    if (this.redis) {
      await this._toCache(cacheKey, embedding);
    }

    return embedding;
  }

  /**
   * Embed plusieurs textes en batches parallèles
   * Gère le cache, les retries et le rate limiting Ollama
   */
  async embedMany(texts) {
    if (!texts.length) return [];

    // Dédupliquer + vérifier cache
    const { uncached, cachedMap } = await this._splitCached(texts);

    logger.debug(`Embedding ${uncached.length}/${texts.length} texts (${texts.length - uncached.length} from cache)`);

    // Découper en batches
    const batches   = this._toBatches(uncached, BATCH_SIZE);
    const freshEmbeddings = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.debug(`Embedding batch ${i + 1}/${batches.length} (${batch.length} texts)`);

      const embeddings = await this._embedBatchWithRetry(batch);
      freshEmbeddings.push(...embeddings);

      // Mise en cache
      if (this.redis) {
        await Promise.all(
          batch.map((text, j) => this._toCache(this._cacheKey(text), embeddings[j]))
        );
      }

      // Petite pause entre batches pour ne pas surcharger Ollama
      if (i < batches.length - 1) {
        await this._sleep(100);
      }
    }

    // Reconstruire dans l'ordre original
    let freshIdx = 0;
    return texts.map(text => {
      const key = this._cacheKey(text);
      if (cachedMap.has(key)) return cachedMap.get(key);
      return freshEmbeddings[freshIdx++];
    });
  }

  // ── Indexation d'un document ─────────────────────────────────

  /**
   * Génère et persiste les embeddings pour tous les chunks d'un document.
   * Appelé par le worker BullMQ.
   *
   * @param {string} documentId - UUID du document
   * @param {pg.Pool} db - pool PostgreSQL
   * @param {Function} onProgress - callback(percent)
   */
  async indexDocument(documentId, db, onProgress = null) {
    const startMs = Date.now();

    // Récupérer les chunks sans embedding
    const { rows: chunks } = await db.query(
      `SELECT id, content FROM document_chunks
       WHERE document_id = $1 AND embedding IS NULL
       ORDER BY chunk_index`,
      [documentId]
    );

    if (!chunks.length) {
      logIngestion(documentId, 'No chunks to embed');
      return { embedded: 0, skipped: 0 };
    }

    logIngestion(documentId, 'Starting embedding', { total: chunks.length });

    const batches = this._toBatches(chunks, BATCH_SIZE);
    let   embedded = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch      = batches[i];
      const texts      = batch.map(c => c.content);
      const embeddings = await this._embedBatchWithRetry(texts);

      // Upsert en bulk via unnest
      await db.query(
        `UPDATE document_chunks AS dc
         SET embedding = v.emb::vector
         FROM (
           SELECT
             unnest($1::uuid[])   AS id,
             unnest($2::text[])   AS emb
         ) AS v
         WHERE dc.id = v.id`,
        [
          batch.map(c => c.id),
          embeddings.map(e => '[' + e.join(',') + ']'),
        ]
      );

      embedded += batch.length;
      const pct = Math.round((embedded / chunks.length) * 100);
      onProgress?.(pct);

      logIngestion(documentId, 'Embedding progress', {
        embedded,
        total: chunks.length,
        pct,
        batchMs: Date.now() - startMs,
      });
    }

    // Marquer le document comme indexé
    await db.query(
      `UPDATE documents
       SET status = 'indexed', indexed_at = NOW(), chunk_count = $1
       WHERE id = $2`,
      [chunks.length, documentId]
    );

    const totalMs = Date.now() - startMs;
    logIngestion(documentId, 'Embedding complete', {
      embedded,
      totalMs,
      avgMsPerChunk: Math.round(totalMs / embedded),
    });

    return { embedded, totalMs };
  }

  // ── Méthodes privées ─────────────────────────────────────────

  async _embedBatch(texts) {
    // Ollama /api/embed accepte un tableau depuis v0.3+
    // Fallback sur appels individuels pour versions antérieures
    try {
      const response = await this._client.post('/api/embed', {
        model: this.model,
        input: texts,
      });

      // Ollama v0.3+ : { embeddings: [[...], [...]] }
      if (response.data.embeddings) {
        return response.data.embeddings;
      }

      // Ollama < 0.3 : { embedding: [...] } (un seul)
      return [response.data.embedding];

    } catch (err) {
      // Fallback : appels individuels
      if (texts.length > 1) {
        logger.debug('Batch embed failed, falling back to individual calls');
        return Promise.all(texts.map(t => this._embedSingle(t)));
      }
      throw err;
    }
  }

  async _embedSingle(text) {
    const response = await this._client.post('/api/embeddings', {
      model: this.model,
      prompt: text,
    });
    return response.data.embedding;
  }

  async _embedBatchWithRetry(texts, attempt = 0) {
    try {
      return await this._embedBatch(texts);
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        logger.error('Embedding failed after retries', {
          model: this.model,
          attempt,
          error: err.message,
        });
        throw err;
      }

      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(`Embedding retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`, {
        error: err.message,
      });
      await this._sleep(delay);
      return this._embedBatchWithRetry(texts, attempt + 1);
    }
  }

  async _splitCached(texts) {
    const cachedMap = new Map();
    const uncached  = [];

    if (!this.redis) {
      return { uncached: texts, cachedMap };
    }

    await Promise.all(texts.map(async (text) => {
      const key    = this._cacheKey(text);
      const cached = await this._fromCache(key);
      if (cached) {
        cachedMap.set(key, cached);
      } else {
        uncached.push(text);
      }
    }));

    return { uncached, cachedMap };
  }

  async _fromCache(key) {
    if (!this.redis) return null;
    try {
      const val = await this.redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  }

  async _toCache(key, embedding) {
    if (!this.redis) return;
    try {
      await this.redis.setex(key, this.cacheTTL, JSON.stringify(embedding));
    } catch (err) {
      logger.debug('Cache write failed', { error: err.message });
    }
  }

  _cacheKey(text) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    return `emb:${this.model}:${hash}`;
  }

  _toBatches(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size) {
      batches.push(arr.slice(i, i + size));
    }
    return batches;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Santé du service ─────────────────────────────────────────

  async healthCheck() {
    try {
      const response = await this._client.get('/api/tags');
      const models   = response.data.models?.map(m => m.name) || [];
      const hasModel = models.some(m => m.includes(this.model.split(':')[0]));
      return {
        ok:     hasModel,
        models,
        target: this.model,
        message: hasModel
          ? `Model ${this.model} available`
          : `Model ${this.model} NOT found. Run: ollama pull ${this.model}`,
      };
    } catch (err) {
      return {
        ok:      false,
        message: `Cannot connect to Ollama at ${this.baseUrl}: ${err.message}`,
      };
    }
  }
}
