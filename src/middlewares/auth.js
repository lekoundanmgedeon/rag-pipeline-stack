/**
 * Middlewares : authentification JWT + isolation tenant
 */

import jwt from 'jsonwebtoken';
import 'dotenv/config';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

// ── Authentification JWT ──────────────────────────────────────────
export const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id:       decoded.sub,
      tenantId: decoded.tenantId || '00000000-0000-0000-0000-000000000001',
      email:    decoded.email,
      roles:    decoded.roles || ['user'],
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};

// ── Isolation tenant (double protection) ─────────────────────────
export const tenantIsolation = (req, res, next) => {
  if (!req.user?.tenantId) {
    return res.status(403).json({ error: 'Tenant non identifié' });
  }
  // Injecte le tenantId dans chaque requête SQL via le contexte
  // (peut aussi être utilisé avec PostgreSQL SET LOCAL app.tenant_id)
  req.tenantId = req.user.tenantId;
  next();
};

// ── Vérification de rôle ──────────────────────────────────────────
export const requireRole = (...roles) => (req, res, next) => {
  const hasRole = roles.some(r => req.user?.roles?.includes(r));
  if (!hasRole) {
    return res.status(403).json({ error: 'Permission insuffisante' });
  }
  next();
};

// ── Gestion des erreurs Multer ────────────────────────────────────
export const handleMulterError = (err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    const maxMb = parseInt(process.env.MAX_FILE_SIZE_MB || '50');
    return res.status(413).json({ error: `Fichier trop volumineux (max ${maxMb} Mo)` });
  }
  if (err?.message?.includes('Type de fichier')) {
    return res.status(415).json({ error: err.message });
  }
  next(err);
};
