/**
 * UploadController — gestion des uploads de documents
 * avec validation, rate limiting et feedback temps réel
 */

import multer from 'multer';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { z } from 'zod';
import { IngestionService } from '../services/IngestionService.js';
import { DocumentRepository } from '../repositories/DocumentRepository.js';
import { logger } from '../utils/logger.js';
import 'dotenv/config';

const MAX_FILE_SIZE  = parseInt(process.env.MAX_FILE_SIZE_MB || '50') * 1024 * 1024;
const UPLOAD_DIR     = process.env.UPLOAD_DIR || './uploads';
const ALLOWED_TYPES  = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'text/html',
  'text/plain',
  'text/markdown',
]);

// ── Multer : stockage temporaire ─────────────────────────────────
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const tmpDir = join(UPLOAD_DIR, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Type de fichier non supporté : ${file.mimetype}`), false);
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// ── Validation metadata ──────────────────────────────────────────
const uploadSchema = z.object({
  title:    z.string().max(255).optional(),
  language: z.enum(['fr', 'en', 'es', 'de', 'ar']).optional(),
  tags:     z.string().optional(), // JSON array string
});

// ── Controller ───────────────────────────────────────────────────
export class UploadController {
  constructor(db, redis) {
    this.ingestionSvc = new IngestionService(db, redis);
    this.repo         = new DocumentRepository(db);
  }

  // POST /api/upload
  uploadDocument = async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    // Valider les metadata
    const parseResult = uploadSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error:   'Paramètres invalides',
        details: parseResult.error.errors,
      });
    }

    const { title, language, tags } = parseResult.data;
    const metadata = {
      title,
      language: language || 'fr',
      tags:     tags ? JSON.parse(tags) : [],
      uploadedAt: new Date().toISOString(),
      originalName: req.file.originalname,
    };

    try {
      const document = await this.ingestionSvc.ingestFile(req.file, {
        tenantId: req.user.tenantId,
        userId:   req.user.id,
        metadata,
      });

      logger.info('Document upload queued', {
        documentId: document.id,
        userId:     req.user.id,
        fileName:   req.file.originalname,
      });

      return res.status(202).json({
        success: true,
        document: {
          id:       document.id,
          title:    document.title,
          fileName: document.file_name,
          fileType: document.file_type,
          fileSize: document.file_size,
          status:   document.status,
        },
        message: 'Document reçu. Indexation en cours...',
      });

    } catch (err) {
      logger.error('Upload failed', { error: err.message, file: req.file.originalname });
      return res.status(500).json({ error: 'Erreur lors de l\'ingestion', details: err.message });
    }
  };

  // GET /api/documents
  listDocuments = async (req, res) => {
    const { limit = 20, offset = 0, status } = req.query;

    const documents = await this.repo.listByTenant(req.user.tenantId, {
      limit:  Math.min(parseInt(limit), 100),
      offset: parseInt(offset),
      status,
    });

    return res.json({ documents });
  };

  // GET /api/documents/:id
  getDocument = async (req, res) => {
    const doc = await this.repo.findById(req.params.id, req.user.tenantId);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });

    const job = await this.repo.getJob(req.params.id);
    return res.json({ document: doc, job });
  };

  // GET /api/documents/:id/status (SSE pour suivi temps réel)
  streamStatus = async (req, res) => {
    const { id } = req.params;
    const doc     = await this.repo.findById(id, req.user.tenantId);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Polling sur le job jusqu'à completion
    const interval = setInterval(async () => {
      try {
        const job = await this.repo.getJob(id);
        if (!job) return;

        sendEvent({
          status:   job.status,
          progress: job.progress,
          stats:    job.stats,
          error:    job.error,
        });

        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(interval);
          res.end();
        }
      } catch (err) {
        clearInterval(interval);
        res.end();
      }
    }, 1500);

    req.on('close', () => clearInterval(interval));
  };

  // DELETE /api/documents/:id
  deleteDocument = async (req, res) => {
    try {
      await this.ingestionSvc.deleteDocument(req.params.id, req.user.tenantId);
      return res.json({ success: true });
    } catch (err) {
      if (err.message === 'Document introuvable') {
        return res.status(404).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
  };

  // POST /api/documents/:id/reindex
  reindex = async (req, res) => {
    try {
      await this.ingestionSvc.reindex(req.params.id, req.user.tenantId);
      return res.json({ success: true, message: 'Re-indexation démarrée' });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  };
}
