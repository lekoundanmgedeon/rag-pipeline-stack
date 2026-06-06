/**
 * DocumentRepository — toutes les opérations DB liées aux documents
 */

import { logger } from '../utils/logger.js';

export class DocumentRepository {
  constructor(db) {
    this.db = db;
  }

  // ── Documents ────────────────────────────────────────────────

  async create({ tenantId, userId, title, fileName, fileType, fileSize, storagePath, metadata = {} }) {
    const { rows } = await this.db.query(
      `INSERT INTO documents
         (tenant_id, user_id, title, file_name, file_type, file_size, storage_path, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, userId, title, fileName, fileType, fileSize, storagePath, JSON.stringify(metadata)]
    );
    return rows[0];
  }

  async findById(id, tenantId) {
    const { rows } = await this.db.query(
      `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rows[0] || null;
  }

  async updateStatus(id, status, extra = {}) {
    const sets  = ['status = $2', 'updated_at = NOW()'];
    const vals  = [id, status];
    let   idx   = 3;

    if (extra.errorMessage !== undefined) {
      sets.push(`error_message = $${idx++}`);
      vals.push(extra.errorMessage);
    }
    if (extra.chunkCount !== undefined) {
      sets.push(`chunk_count = $${idx++}`);
      vals.push(extra.chunkCount);
    }
    if (status === 'indexed') {
      sets.push(`indexed_at = NOW()`);
    }

    const { rows } = await this.db.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      vals
    );
    return rows[0];
  }

  async listByTenant(tenantId, { limit = 20, offset = 0, status } = {}) {
    const conditions = ['tenant_id = $1'];
    const values     = [tenantId];
    let   idx        = 2;

    if (status) {
      conditions.push(`status = $${idx++}`);
      values.push(status);
    }

    const { rows } = await this.db.query(
      `SELECT id, title, file_name, file_type, file_size, status, chunk_count, created_at, indexed_at
       FROM documents
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset]
    );
    return rows;
  }

  async delete(id, tenantId) {
    const { rowCount } = await this.db.query(
      `DELETE FROM documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return rowCount > 0;
  }

  // ── Chunks ───────────────────────────────────────────────────

  async insertChunks(chunks) {
    if (!chunks.length) return;

    // Bulk insert via unnest
    await this.db.query(
      `INSERT INTO document_chunks
         (document_id, tenant_id, chunk_index, content, token_count, metadata)
       SELECT
         unnest($1::uuid[]),
         unnest($2::uuid[]),
         unnest($3::int[]),
         unnest($4::text[]),
         unnest($5::int[]),
         unnest($6::jsonb[])`,
      [
        chunks.map(c => c.documentId),
        chunks.map(c => c.tenantId),
        chunks.map(c => c.chunkIndex),
        chunks.map(c => c.content),
        chunks.map(c => c.tokenCount),
        chunks.map(c => JSON.stringify(c.metadata)),
      ]
    );

    logger.debug(`Inserted ${chunks.length} chunks`);
  }

  async deleteChunksByDocument(documentId) {
    const { rowCount } = await this.db.query(
      `DELETE FROM document_chunks WHERE document_id = $1`,
      [documentId]
    );
    return rowCount;
  }

  async countChunksWithoutEmbedding(documentId) {
    const { rows } = await this.db.query(
      `SELECT COUNT(*) FROM document_chunks WHERE document_id = $1 AND embedding IS NULL`,
      [documentId]
    );
    return parseInt(rows[0].count);
  }

  // ── Jobs ─────────────────────────────────────────────────────

  async createJob(documentId, queueJobId) {
    const { rows } = await this.db.query(
      `INSERT INTO ingestion_jobs (document_id, queue_job_id, status)
       VALUES ($1, $2, 'queued')
       RETURNING *`,
      [documentId, queueJobId]
    );
    return rows[0];
  }

  async updateJob(documentId, updates) {
    const sets = [];
    const vals = [documentId];
    let   idx  = 2;

    const fields = ['status', 'progress', 'stats', 'error', 'started_at', 'completed_at'];
    for (const field of fields) {
      if (updates[field] !== undefined) {
        sets.push(`${field} = $${idx++}`);
        vals.push(typeof updates[field] === 'object' && updates[field] !== null
          ? JSON.stringify(updates[field])
          : updates[field]
        );
      }
    }

    if (!sets.length) return;

    await this.db.query(
      `UPDATE ingestion_jobs SET ${sets.join(', ')} WHERE document_id = $1`,
      vals
    );
  }

  async getJob(documentId) {
    const { rows } = await this.db.query(
      `SELECT * FROM ingestion_jobs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [documentId]
    );
    return rows[0] || null;
  }
}
