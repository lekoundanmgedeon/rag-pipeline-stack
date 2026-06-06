/**
 * RecursiveChunker — découpe le texte en chunks optimaux pour le RAG
 *
 * Stratégie : récursive sur les séparateurs naturels
 *   1. Double saut de ligne (paragraphes)
 *   2. Saut de ligne simple
 *   3. Fin de phrase (. ! ?)
 *   4. Virgule / point-virgule
 *   5. Espace (dernier recours)
 *
 * Chaque chunk inclut un overlap avec le précédent pour ne pas
 * perdre le contexte en limite de chunk.
 */

import 'dotenv/config';

// Approximation tokens ≈ chars / 4 (valide pour français/anglais)
const approxTokens = (text) => Math.ceil(text.length / 4);

export class RecursiveChunker {
  constructor(opts = {}) {
    this.maxTokens     = opts.maxTokens     ?? parseInt(process.env.CHUNK_MAX_TOKENS     || '512');
    this.overlapTokens = opts.overlapTokens ?? parseInt(process.env.CHUNK_OVERLAP_TOKENS || '80');
    this.minTokens     = opts.minTokens     ?? parseInt(process.env.CHUNK_MIN_TOKENS     || '30');

    // Séparateurs par ordre de priorité décroissant
    this.separators = [
      '\n\n',       // Paragraphes
      '\n',         // Lignes
      '. ',         // Phrases
      '! ',
      '? ',
      '; ',
      ', ',
      ' ',          // Mots
      '',           // Caractères (dernier recours)
    ];
  }

  /**
   * Découpe un texte en chunks avec métadonnées
   *
   * @param {string} text - texte brut à découper
   * @param {object} baseMetadata - métadonnées communes à tous les chunks
   * @returns {Array<{content, chunkIndex, tokenCount, metadata}>}
   */
  chunk(text, baseMetadata = {}) {
    if (!text?.trim()) return [];

    // 1. Découper récursivement
    const rawChunks = this._splitRecursive(text, this.separators);

    // 2. Fusionner les petits chunks adjacents
    const merged = this._mergeSmallChunks(rawChunks);

    // 3. Ajouter l'overlap
    const withOverlap = this._addOverlap(merged);

    // 4. Filtrer et formater
    return withOverlap
      .map((content, index) => ({
        content:    content.trim(),
        chunkIndex: index,
        tokenCount: approxTokens(content),
        metadata: {
          ...baseMetadata,
          chunkStrategy: 'recursive',
          overlapTokens: this.overlapTokens,
        },
      }))
      .filter(c => c.tokenCount >= this.minTokens);
  }

  /**
   * Récursion principale : split sur le séparateur courant,
   * sous-split si un fragment dépasse maxTokens.
   */
  _splitRecursive(text, separators) {
    const [sep, ...rest] = separators;

    if (sep === undefined) {
      // Base case : découpe caractère par caractère
      const chunks = [];
      const maxChars = this.maxTokens * 4;
      for (let i = 0; i < text.length; i += maxChars) {
        chunks.push(text.slice(i, i + maxChars));
      }
      return chunks;
    }

    const parts   = sep ? text.split(sep) : [...text];
    const result  = [];
    let   current = '';

    for (const part of parts) {
      const candidate = current ? current + sep + part : part;

      if (approxTokens(candidate) <= this.maxTokens) {
        current = candidate;
      } else {
        // Flush le current
        if (current.trim()) result.push(current);

        // Le part lui-même dépasse maxTokens → récursion
        if (approxTokens(part) > this.maxTokens && rest.length > 0) {
          const subChunks = this._splitRecursive(part, rest);
          result.push(...subChunks);
          current = '';
        } else {
          current = part;
        }
      }
    }

    if (current.trim()) result.push(current);
    return result;
  }

  /**
   * Fusionne les chunks trop petits avec le suivant
   */
  _mergeSmallChunks(chunks) {
    const merged = [];
    let   buffer = '';

    for (const chunk of chunks) {
      const candidate = buffer ? buffer + '\n\n' + chunk : chunk;

      if (approxTokens(candidate) <= this.maxTokens) {
        buffer = candidate;
      } else {
        if (buffer) merged.push(buffer);
        buffer = chunk;
      }
    }

    if (buffer) merged.push(buffer);
    return merged;
  }

  /**
   * Ajoute un overlap : chaque chunk inclut les N derniers tokens
   * du chunk précédent pour préserver le contexte aux jointures.
   */
  _addOverlap(chunks) {
    if (this.overlapTokens <= 0 || chunks.length <= 1) return chunks;

    return chunks.map((chunk, i) => {
      if (i === 0) return chunk;

      const prev       = chunks[i - 1];
      const overlapStr = this._tailTokens(prev, this.overlapTokens);

      // Éviter les doublons si le chunk commence déjà par cet overlap
      if (chunk.startsWith(overlapStr.trim())) return chunk;

      return overlapStr + '\n' + chunk;
    });
  }

  /**
   * Extrait les N derniers tokens (approximatifs) d'un texte
   */
  _tailTokens(text, n) {
    const words = text.split(/\s+/);
    return words.slice(-n).join(' ');
  }

  // ── Helpers publics ──────────────────────────────────────────

  /** Retourne les statistiques d'un découpage */
  stats(chunks) {
    const tokenCounts = chunks.map(c => c.tokenCount);
    return {
      count:   chunks.length,
      minTokens: Math.min(...tokenCounts),
      maxTokens: Math.max(...tokenCounts),
      avgTokens: Math.round(tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length),
    };
  }
}

// ── Variante : chunker orienté pages (pour PDF) ───────────────────
export class PageAwareChunker extends RecursiveChunker {
  /**
   * Chunk en respectant les frontières de page.
   * Les chunks ne traversent jamais une limite de page.
   */
  chunkPages(pages, baseMetadata = {}) {
    const allChunks = [];

    for (const { page, text } of pages) {
      const pageChunks = this.chunk(text, {
        ...baseMetadata,
        page,
      });
      allChunks.push(...pageChunks);
    }

    // Re-numéroter les index globalement
    return allChunks.map((c, i) => ({ ...c, chunkIndex: i }));
  }
}
