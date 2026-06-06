/**
 * Routes : /api/documents & /api/upload
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { UploadController, upload } from '../controllers/uploadController.js';
import { authenticate, tenantIsolation, requireRole, handleMulterError } from '../middlewares/auth.js';
import db from '../config/database.js';
import { redis } from '../config/redis.js';

const router    = express.Router();
const ctrl      = new UploadController(db, redis);

// Rate limiting : 10 uploads / 10 min par utilisateur
const uploadLimiter = rateLimit({
  windowMs:         10 * 60 * 1000,
  max:              10,
  keyGenerator:     (req) => req.user?.id || req.ip,
  message:          { error: 'Trop d\'uploads. Veuillez patienter 10 minutes.' },
  standardHeaders:  true,
  legacyHeaders:    false,
});

// Toutes les routes nécessitent auth + tenant
router.use(authenticate, tenantIsolation);

// Upload
router.post(
  '/upload',
  uploadLimiter,
  upload.single('file'),
  handleMulterError,
  ctrl.uploadDocument
);

// Listing & détail
router.get('/documents',          ctrl.listDocuments);
router.get('/documents/:id',      ctrl.getDocument);
router.get('/documents/:id/status', ctrl.streamStatus);  // SSE

// Admin : supprimer / re-indexer
router.delete('/documents/:id',          requireRole('admin', 'manager'), ctrl.deleteDocument);
router.post  ('/documents/:id/reindex',  requireRole('admin'),            ctrl.reindex);

export default router;
