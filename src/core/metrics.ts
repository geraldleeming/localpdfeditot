import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

/**
 * Font metrics, shared by the overlay and the exporter.
 *
 * The overlay must size a text box using the *same* numbers the exporter will
 * use, or what the user positions on screen will not be what lands in the file.
 * So both ask this module, which measures with the real Helvetica AFM widths via
 * a throwaway pdf-lib document rather than with `canvas.measureText`.
 *
 * Helvetica is one of the PDF standard 14 fonts, so using it costs zero embedded
 * bytes. The price is WinAnsi's character set — see `toWinAnsiText`.
 */

export const LINE_HEIGHT_RATIO = 1.2;
/** Inset between the annotation rect and the text, in points. */
export const TEXT_PADDING = 2;
/** Fraction of the font size from the top of a line box down to the baseline. */
export const BASELINE_RATIO = 0.85;
/** Slack on the measured width, absorbing per-renderer differences in advances. */
const WIDTH_HEADROOM = 1.04;

let fontPromise: Promise<PDFFont> | null = null;

export function helvetica(): Promise<PDFFont> {
  fontPromise ??= (async () => {
    const scratch = await PDFDocument.create();
    return scratch.embedFont(StandardFonts.Helvetica);
  })();
  return fontPromise;
}

/**
 * WinAnsi's 0x80-0x9F range holds typographic characters that are NOT at their
 * Latin-1 code points. Smart quotes and dashes arrive constantly via paste, so
 * mapping them is the difference between a usable tool and one that prints "?"
 * every time someone copies text out of a word processor.
 */
const WIN_ANSI_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
};

function isWinAnsiSupported(ch: string): boolean {
  if (ch in WIN_ANSI_HIGH) return true;
  const code = ch.charCodeAt(0);
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
}

/**
 * Replace characters Helvetica/WinAnsi cannot represent with '?', keeping the
 * result as ordinary Unicode. Everything downstream — measuring, the on-screen
 * overlay, and the exported stream — works from this same string, so the user
 * sees exactly what they will get.
 */
export function toWinAnsiText(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '\n') out += ch;
    else if (isWinAnsiSupported(ch)) out += ch;
    else out += '?';
  }
  return out;
}

/** True when the text contains anything Helvetica cannot render. */
export function hasUnsupportedChars(value: string): boolean {
  for (const ch of value) {
    if (ch !== '\n' && !isWinAnsiSupported(ch)) return true;
  }
  return false;
}

/**
 * Encode WinAnsi-safe text to a string whose char codes are the PDF byte values.
 * pdf-lib writes stream contents with `charCodeAt`, so a string built this way
 * serialises to the right bytes.
 */
export function toWinAnsiBytes(value: string): string {
  let out = '';
  for (const ch of value) {
    const high = WIN_ANSI_HIGH[ch];
    out += high === undefined ? ch : String.fromCharCode(high);
  }
  return out;
}

export interface TextMetrics {
  /** Full box width including padding, in points. */
  width: number;
  /** Full box height including padding, in points. */
  height: number;
  lines: string[];
}

/**
 * Measure a text box. There is deliberately no auto-wrapping: the box hugs the
 * widest line the user typed. Wrapping would have to be reimplemented
 * identically in CSS and in the exporter, and any drift between the two shows up
 * as text that moves when you save.
 */
export function measureText(font: PDFFont, value: string, size: number): TextMetrics {
  const lines = toWinAnsiText(value).split('\n');
  let widest = 0;
  for (const line of lines) {
    const w = line.length === 0 ? 0 : font.widthOfTextAtSize(line, size);
    if (w > widest) widest = w;
  }
  return {
    // A little wider than the glyphs strictly need. Type rendered at small
    // sizes has its advances rounded up, and the appearance stream's BBox clips
    // whatever does not fit inside it, so a box measured exactly can shave the
    // last character. The text still starts at the same point, so nothing moves.
    width: Math.max(widest * WIDTH_HEADROOM, size * 0.75) + TEXT_PADDING * 2,
    height: lines.length * size * LINE_HEIGHT_RATIO + TEXT_PADDING * 2,
    lines,
  };
}
