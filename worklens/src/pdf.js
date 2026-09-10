// A minimal, dependency-free PDF writer for plain-text "implementation brief" documents.
//
// WorkLens has zero npm dependencies by design, and this session's sandbox has no way to
// verify an `npm install` on the machine that will actually run this app, so adding a PDF
// library was riskier than writing the (small) subset of the PDF format this needs. It uses
// only the built-in Courier base-14 font, which every PDF reader ships and which needs no
// font embedding. Courier is also fixed-pitch, so line-wrapping is exact character-count
// arithmetic instead of a glyph-width table — simpler and impossible to get subtly wrong.
//
// This is intentionally plain-text-first: no columns, no tables, no images. The point of the
// output (a project's milestones and tasks, structured for an AI coding agent or a person to
// read and act on) is served better by clean, linear text than by anything fancier.

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CHAR_WIDTH_EM = 0.6; // Courier glyphs are 600/1000 em wide at any point size

const STYLES = {
  title: { font: 'F2', size: 18, indent: 0, gapAfter: 12 },
  meta: { font: 'F1', size: 9, indent: 0, gapAfter: 3 },
  h2: { font: 'F2', size: 13, indent: 0, gapBefore: 18, gapAfter: 8 },
  body: { font: 'F1', size: 10, indent: 14, gapAfter: 8 },
  note: { font: 'F1', size: 9, indent: 18, gapAfter: 8 },
  bullet: { font: 'F1', size: 10, indent: 18, gapAfter: 4 },
  divider: { size: 10, gapAfter: 14 }
};

function sanitizeAscii(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\n]/g, '?');
}

function wrap(text, size, indent) {
  const maxChars = Math.max(10, Math.floor((CONTENT_WIDTH - indent) / (size * CHAR_WIDTH_EM)));
  const words = sanitizeAscii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  lines.push(line);
  return lines.length ? lines : [''];
}

function escapePdfText(text) {
  return text.replace(/[\\()]/g, m => `\\${m}`);
}

// blocks: [{ style: 'title'|'meta'|'h2'|'body'|'note'|'bullet'|'divider', text, marker? }]
export function renderTextPdf(blocks) {
  const pages = [];
  let page = [];
  let y = PAGE_HEIGHT - MARGIN;

  function startPage() { page = []; y = PAGE_HEIGHT - MARGIN; }
  function commitPage() { if (page.length) pages.push(page); }
  function ensureRoom(neededHeight) {
    if (y - neededHeight < MARGIN) { commitPage(); startPage(); }
  }

  startPage();
  for (const block of blocks) {
    const style = STYLES[block.style] || STYLES.body;
    if (block.style === 'divider') {
      ensureRoom(style.size + style.gapAfter);
      page.push({ type: 'rule', x: MARGIN, y });
      y -= style.size + style.gapAfter;
      continue;
    }
    if (style.gapBefore) y -= style.gapBefore;
    const lineHeight = style.size * 1.4;
    const lines = wrap(block.text ?? '', style.size, style.indent);
    for (const [i, lineText] of lines.entries()) {
      ensureRoom(lineHeight);
      const prefix = block.style === 'bullet' ? (i === 0 ? (block.marker || '- ') : '  ') : '';
      page.push({ type: 'text', x: MARGIN + style.indent, y, font: style.font, size: style.size, text: prefix + lineText });
      y -= lineHeight;
    }
    y -= style.gapAfter;
  }
  commitPage();
  if (!pages.length) pages.push([]);

  return assemblePdf(pages);
}

function assemblePdf(pages) {
  const objects = [];
  const push = body => { objects.push(body); return objects.length; };

  const fontF1 = push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const fontF2 = push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>');
  const pagesIndex = push(''); // filled in once page object indexes are known
  const pageIndexes = [];
  const contentIndexes = [];

  for (const page of pages) {
    let stream = '';
    for (const item of page) {
      if (item.type === 'text') {
        stream += `BT /${item.font} ${item.size} Tf ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td (${escapePdfText(item.text)}) Tj ET\n`;
      } else if (item.type === 'rule') {
        stream += `${item.x.toFixed(2)} ${item.y.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${item.y.toFixed(2)} l S\n`;
      }
    }
    contentIndexes.push(push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`));
    pageIndexes.push(push(''));
  }

  pageIndexes.forEach((pageIndex, i) => {
    objects[pageIndex - 1] = `<< /Type /Page /Parent ${pagesIndex} 0 R /Resources << /Font << /F1 ${fontF1} 0 R /F2 ${fontF2} 0 R >> >> /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentIndexes[i]} 0 R >>`;
  });
  objects[pagesIndex - 1] = `<< /Type /Pages /Kids [${pageIndexes.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIndexes.length} >>`;
  const catalogIndex = push(`<< /Type /Catalog /Pages ${pagesIndex} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((objectBody, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objectBody}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIndex} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
