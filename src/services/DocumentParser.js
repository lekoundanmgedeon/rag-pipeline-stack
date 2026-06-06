/**
 * DocumentParser — extrait le texte brut depuis différents formats
 * Formats supportés : PDF, DOCX, XLSX, CSV, HTML, TXT
 */

import { readFile } from 'fs/promises';
import { extname } from 'path';
import { logger } from '../utils/logger.js';

// ── PDF ──────────────────────────────────────────────────────────
async function parsePdf(filePath) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const buffer = await readFile(filePath);
  const data   = await pdfParse(buffer);

  return {
    text:     data.text,
    metadata: {
      pageCount: data.numpages,
      info:      data.info,
    },
    pages: data.text
      .split(/\f/)                       // form-feed = saut de page PDF
      .map((p, i) => ({ page: i + 1, text: p.trim() }))
      .filter(p => p.text.length > 0),
  };
}

// ── DOCX ─────────────────────────────────────────────────────────
async function parseDocx(filePath) {
  const mammoth = await import('mammoth');
  const buffer  = await readFile(filePath);

  const [textResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    mammoth.convertToHtml({ buffer }),
  ]);

  // Extraire les sections depuis les headings HTML
  const sections = extractSectionsFromHtml(htmlResult.value);

  return {
    text:     textResult.value,
    metadata: { sections: sections.length },
    sections,
  };
}

// ── XLSX ─────────────────────────────────────────────────────────
async function parseXlsx(filePath) {
  const XLSX   = await import('xlsx');
  const buffer = await readFile(filePath);
  const wb     = XLSX.read(buffer, { type: 'buffer' });

  let fullText = '';
  const sheets = [];

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Convertir en texte tabulaire lisible
    const rows = data
      .filter(row => row.some(cell => String(cell).trim()))
      .map(row => row.map(c => String(c).trim()).join(' | '));

    const sheetText = `[Feuille: ${sheetName}]\n${rows.join('\n')}`;
    fullText += sheetText + '\n\n';
    sheets.push({ name: sheetName, rowCount: rows.length, text: sheetText });
  }

  return {
    text:     fullText,
    metadata: { sheetCount: wb.SheetNames.length },
    sheets,
  };
}

// ── CSV ──────────────────────────────────────────────────────────
async function parseCsv(filePath) {
  return new Promise(async (resolve, reject) => {
    const csvParser = (await import('csv-parser')).default;
    const { createReadStream } = await import('fs');

    const rows   = [];
    let headers  = [];

    createReadStream(filePath)
      .pipe(csvParser())
      .on('headers', (h) => { headers = h; })
      .on('data',  (row) => rows.push(row))
      .on('end', () => {
        // Convertir en texte : chaque ligne = "colonne: valeur, ..."
        const textRows = rows.map(row =>
          headers.map(h => `${h}: ${row[h] ?? ''}`).join(' | ')
        );
        const text = `Colonnes: ${headers.join(', ')}\n\n${textRows.join('\n')}`;
        resolve({
          text,
          metadata: { rowCount: rows.length, headers },
        });
      })
      .on('error', reject);
  });
}

// ── HTML ─────────────────────────────────────────────────────────
async function parseHtml(filePath) {
  const { load } = await import('cheerio');
  const html     = await readFile(filePath, 'utf-8');
  const $        = load(html);

  // Supprimer scripts, styles, nav, footer, ads
  $('script, style, nav, footer, header, aside, .ads, [role="banner"]').remove();

  const title   = $('title').text().trim() || $('h1').first().text().trim();
  const text    = $('body').text().replace(/\s{3,}/g, '\n\n').trim();
  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    headings.push({ level: el.tagName, text: $(el).text().trim() });
  });

  return {
    text,
    metadata: { title, headingCount: headings.length },
    headings,
  };
}

// ── TXT ──────────────────────────────────────────────────────────
async function parseTxt(filePath) {
  const text = await readFile(filePath, 'utf-8');
  return {
    text: text.replace(/\r\n/g, '\n').trim(),
    metadata: {},
  };
}

// ── Helper : extraction sections depuis HTML ──────────────────────
function extractSectionsFromHtml(html) {
  const sections = [];
  const regex    = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    sections.push(match[1].replace(/<[^>]+>/g, '').trim());
  }
  return sections;
}

// ── Dispatcher principal ──────────────────────────────────────────
export class DocumentParser {
  static SUPPORTED_TYPES = {
    '.pdf':  parsePdf,
    '.docx': parseDocx,
    '.xlsx': parseXlsx,
    '.xls':  parseXlsx,
    '.csv':  parseCsv,
    '.html': parseHtml,
    '.htm':  parseHtml,
    '.txt':  parseTxt,
    '.md':   parseTxt,
  };

  /**
   * @param {string} filePath - chemin absolu du fichier
   * @returns {{ text: string, metadata: object, pages?: array }}
   */
  static async parse(filePath) {
    const ext    = extname(filePath).toLowerCase();
    const parser = this.SUPPORTED_TYPES[ext];

    if (!parser) {
      throw new Error(`Format non supporté : ${ext}. Formats acceptés : ${Object.keys(this.SUPPORTED_TYPES).join(', ')}`);
    }

    logger.debug(`Parsing ${ext} file`, { filePath });
    const startMs = Date.now();

    const result = await parser(filePath);

    // Nettoyage universel du texte extrait
    result.text = cleanText(result.text);
    result.parseMs = Date.now() - startMs;
    result.charCount = result.text.length;

    logger.debug(`Parsed in ${result.parseMs}ms`, {
      chars: result.charCount,
      ext,
    });

    return result;
  }

  static isSupported(mimeType, filename) {
    const ext = extname(filename || '').toLowerCase();
    return ext in this.SUPPORTED_TYPES;
  }
}

// ── Nettoyage du texte ────────────────────────────────────────────
function cleanText(text) {
  if (!text) return '';
  return text
    // Normaliser les fins de ligne
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Supprimer les caractères de contrôle (sauf \n \t)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Remplacer les caractères Unicode de remplacement
    .replace(/\uFFFD/g, '')
    // Réduire les espaces multiples sur une même ligne
    .replace(/[^\S\n]{2,}/g, ' ')
    // Réduire les sauts de ligne multiples (max 2)
    .replace(/\n{3,}/g, '\n\n')
    // Supprimer les lignes vides avec juste des espaces
    .replace(/\n[ \t]+\n/g, '\n\n')
    .trim();
}
