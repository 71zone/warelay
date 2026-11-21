/** Widest line of a monospace table grid, in characters, that still fits a phone chat bubble without wrapping. */
export const MAX_GRID_WIDTH = 40;
/** Most data rows a monospace table grid may have. */
export const MAX_GRID_ROWS = 30;
/**
 * Most data rows a table may have and still count as small: a table with more rows is big even when its grid would fit, because a long grid is hard to
 * read in a chat and is better delivered as a picture (plus a spreadsheet file when only the text is available).
 */
export const SMALL_TABLE_MAX_ROWS = 8;

function width(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** One line per cell: a table cell is a single run of text. */
export function cleanCell(cell: string): string {
  return cell.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim();
}

/** Pads every row, and the header, to the widest row so a ragged table is rectangular. */
export function normalizeTable(header: string[], rows: string[][]): { header: string[]; rows: string[][] } {
  const columns = Math.max(header.length, ...rows.map(row => row.length));
  const pad = (row: string[]): string[] => Array.from({ length: columns }, (_, index) => row[index] ?? '');
  return { header: pad(header), rows: rows.map(pad) };
}

/** Aligned monospace grid, or null when it would be wider than `maxWidth` or taller than `maxRows`. A table without any header text gets no header lines. */
export function tableToGrid(header: string[], rows: string[][], maxWidth = MAX_GRID_WIDTH, maxRows = MAX_GRID_ROWS): string | null {
  if (rows.length > maxRows) return null;
  const table = normalizeTable(header.map(cleanCell), rows.map(row => row.map(cleanCell)));
  const titled = table.header.some(cell => cell !== '');
  const widths = table.header.map((_, column) => Math.max(titled ? width(table.header[column] ?? '') : 0, ...table.rows.map(row => width(row[column] ?? ''))));
  const render = (row: string[]): string =>
    row.map((cell, column) => cell + ' '.repeat((widths[column] ?? 0) - width(cell))).join(' | ').trimEnd();
  const rule = widths.map(size => '-'.repeat(Math.max(size, 1))).join('-+-');
  const lines = [...(titled ? [render(table.header), rule] : []), ...table.rows.map(render)];
  if (lines.some(line => width(line) > maxWidth)) return null;
  return lines.join('\n');
}

/** True when a table is better delivered as a picture of itself than as text: it has more than SMALL_TABLE_MAX_ROWS rows, or it does not fit the phone grid. */
export function isBigTable(header: string[], rows: string[][]): boolean {
  return rows.length > SMALL_TABLE_MAX_ROWS || tableToGrid(header, rows) === null;
}
