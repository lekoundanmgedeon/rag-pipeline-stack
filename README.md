# RAG Ingestion Pipeline
**Node.js + PostgreSQL/pgvector + Ollama (Qwen3 / Gemma)**

Pipeline d'ingestion documentaire complet pour architecture RAG.  
Formats supportés : PDF, DOCX, XLSX, CSV, HTML, TXT, Markdown.

---

## Stack

| Composant       | Technologie                |
|-----------------|----------------------------|
| Runtime         | Node.js 20+ (ESM)          |
| Base de données | PostgreSQL 16 + pgvector   |
| Queue           | BullMQ + Redis 7           |
| Embeddings      | Ollama (`nomic-embed-text`) |
| LLM             | Ollama (`qwen3:8b`)        |
| Upload          | Multer                     |

---

## Démarrage rapide

### 1. Prérequis

```bash
# Node.js 20+
node --version

# Docker + Docker Compose
docker --version

# Ollama installé localement
curl -fsSL https://ollama.ai/install.sh | sh
```

### 2. Infrastructure (Docker)

```bash
# Lancer PostgreSQL + Redis + Ollama
docker-compose up -d

# Vérifier que tout est up
docker-compose ps
```

### 3. Modèles Ollama

```bash
# Modèle d'embeddings (OBLIGATOIRE)
ollama pull nomic-embed-text

# Modèle LLM (choisir selon votre RAM)
ollama pull qwen3:8b        # 8B — recommandé (8 Go RAM)
ollama pull qwen3:14b       # 14B — meilleure qualité (16 Go RAM)
ollama pull gemma3:9b       # Alternative Google
ollama pull mistral:7b      # Alternative légère

# Vérifier les modèles disponibles
ollama list
```

> **Note sur les dimensions :**  
> Si vous changez de modèle d'embeddings, adaptez `EMBEDDING_DIMENSIONS` dans `.env`
> et modifiez le type de colonne : `ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(1024);`

### 4. Configuration

```bash
cp .env.example .env
# Éditer .env selon votre configuration
```

### 5. Migration base de données

```bash
npm install
npm run migrate
```

Sortie attendue :
```
▶  Applying 001_initial_schema.sql...
✅  Applied 001_initial_schema.sql
✅  All migrations applied.
```

### 6. Lancer l'API

```bash
# Développement (auto-reload)
npm run dev

# Production
npm start
```

### 7. Lancer le Worker (terminal séparé)

```bash
npm run worker
```

---

## Architecture des fichiers

```
src/
├── config/
│   ├── database.js       # Pool PostgreSQL
│   └── redis.js          # Config BullMQ + queues
├── controllers/
│   └── uploadController.js  # Endpoints upload, liste, status SSE
├── services/
│   ├── DocumentParser.js    # PDF, DOCX, XLSX, CSV, HTML, TXT
│   ├── Chunker.js           # RecursiveChunker + PageAwareChunker
│   ├── EmbeddingService.js  # Ollama embeddings + cache Redis
│   └── IngestionService.js  # Orchestration du pipeline complet
├── repositories/
│   └── DocumentRepository.js  # Toutes les requêtes SQL
├── middlewares/
│   └── auth.js             # JWT + tenant isolation
├── routes/
│   └── upload.js           # Définition des routes
├── workers/
│   └── ingestionWorker.js  # BullMQ worker (processus séparé)
├── utils/
│   └── logger.js           # Winston structured logging
└── server.js               # Point d'entrée Express
```

---

## API Reference

### Upload d'un document

```bash
POST /api/upload
Authorization: Bearer <jwt>
Content-Type: multipart/form-data

# Champs
file     : fichier (PDF, DOCX, etc.)
title    : "Mon document" (optionnel)
language : "fr" | "en" | "es" | "de" | "ar"
tags     : '["procedure","rh"]' (JSON array en string)
```

Réponse `202 Accepted` :
```json
{
  "success": true,
  "document": {
    "id": "uuid",
    "title": "Mon document",
    "status": "pending"
  },
  "message": "Document reçu. Indexation en cours..."
}
```

### Suivi temps réel (SSE)

```bash
GET /api/documents/:id/status
Authorization: Bearer <jwt>
Accept: text/event-stream
```

Événements reçus :
```
data: {"status":"parsing","progress":5}
data: {"status":"chunking","progress":20}
data: {"status":"embedding","progress":65}
data: {"status":"done","progress":100,"stats":{"chunks_total":42}}
```

### Liste des documents

```bash
GET /api/documents?limit=20&offset=0&status=indexed
Authorization: Bearer <jwt>
```

### Santé du système

```bash
GET /health
```

```json
{
  "status": "healthy",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "ollama": "ok"
  }
}
```

---

## Paramétrage Chunking

| Paramètre              | Défaut | Description                              |
|------------------------|--------|------------------------------------------|
| `CHUNK_MAX_TOKENS`     | 512    | Taille max d'un chunk (≈ chars / 4)      |
| `CHUNK_OVERLAP_TOKENS` | 80     | Overlap entre chunks consécutifs         |
| `CHUNK_MIN_TOKENS`     | 30     | Taille minimum (chunks plus petits filtrés) |

**Recommandations selon l'usage :**
- Documents techniques / procédures : `512 / 80`
- Questions-réponses courtes : `256 / 40`
- Documents longs / livres : `1024 / 150`

---

## Modèles Ollama recommandés

### Embeddings

| Modèle                | Dims | Vitesse | Qualité |
|-----------------------|------|---------|---------|
| `nomic-embed-text`    | 768  | ★★★★★  | ★★★★☆  |
| `mxbai-embed-large`   | 1024 | ★★★☆☆  | ★★★★★  |
| `all-minilm`          | 384  | ★★★★★  | ★★★☆☆  |

### LLM (pour le RAG)

| Modèle       | RAM min | Vitesse | Qualité |
|--------------|---------|---------|---------|
| `qwen3:8b`   | 8 Go    | ★★★★☆  | ★★★★☆  |
| `qwen3:14b`  | 16 Go   | ★★★☆☆  | ★★★★★  |
| `gemma3:9b`  | 10 Go   | ★★★★☆  | ★★★★☆  |
| `mistral:7b` | 8 Go    | ★★★★★  | ★★★☆☆  |

---

## Génération d'un JWT de test

```js
// Générer un token de test (dev uniquement)
import jwt from 'jsonwebtoken';
const token = jwt.sign(
  {
    sub:      'user-uuid-here',
    tenantId: '00000000-0000-0000-0000-000000000001',
    email:    'test@example.com',
    roles:    ['admin'],
  },
  process.env.JWT_SECRET,
  { expiresIn: '24h' }
);
console.log(token);
```

---

## Étapes suivantes

1. **Moteur RAG** : construire le `RAGService` avec hybrid search + appel Ollama LLM
2. **Chat API** : endpoint SSE `/api/chat` avec streaming des réponses
3. **Frontend Vue.js** : composant chat avec affichage des sources
4. **Monitoring** : intégration LangFuse pour tracer les appels LLM
