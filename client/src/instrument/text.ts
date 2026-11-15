// Session text for uikit. uikit draws whole paragraphs in one style, so the
// Stream is block-level only: headings, bullets, numbered items, code blocks
// and paragraphs, with the inline markers (bold, code ticks, link targets)
// dropped cleanly. Every string is also mapped onto the glyphs the atlas
// really has, because a missing glyph draws as a solid box.

import { GLYPHS } from './glyphs.ts'

export type Block =
  | { kind: 'h'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'li'; text: string; depth: 0 | 1 }
  | { kind: 'num'; n: string; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'gap' }

const SWAPS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '′': "'",
  '″': '"',
  '→': '->',
  '←': '<-',
  '⇒': '=>',
  '↑': '^',
  '↓': 'v',
  '↔': '<->',
  '✓': 'ok',
  '✔': 'ok',
  '✗': 'x',
  '✘': 'x',
  ' ': ' ',
  '\t': '  ',
  '−': '-',
  '‐': '-',
  '‑': '-',
  '•': '-',
  '●': '-',
  '▶': '>',
  '│': '|',
  '─': '-',
  '━': '-',
  '═': '=',
  '├': '|',
  '└': '`',
  '…': '...',
}

const sets = new Map<string, Set<string>>()
function setOf(font: keyof typeof GLYPHS): Set<string> {
  let s = sets.get(font)
  if (!s) sets.set(font, (s = new Set(Array.from(GLYPHS[font]))))
  return s
}

/**
 * The string with every character the font lacks swapped for an ASCII
 * stand-in, or dropped (emoji, box drawing, other scripts). Accents are
 * stripped from letters the atlas does not carry.
 */
export function fit(text: string, font: keyof typeof GLYPHS = 'inter-400'): string {
  const have = setOf(font)
  let out = ''
  for (const ch of text) {
    if (ch === '\n' || have.has(ch)) {
      out += ch
      continue
    }
    const swap = SWAPS[ch]
    if (swap !== undefined) {
      out += Array.from(swap).every(c => have.has(c)) ? swap : ''
      continue
    }
    const bare = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    if (bare !== ch && Array.from(bare).every(c => have.has(c))) out += bare
    // anything else (emoji, CJK, box drawing) is dropped
  }
  return out
}

/** Bold, code ticks, underscores and link targets removed; the words kept. */
export function plain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

export function blocks(text: string): Block[] {
  const out: Block[] = []
  let code: string[] | null = null
  let para: string[] = []
  const endPara = () => {
    if (para.length) out.push({ kind: 'p', text: fit(plain(para.join(' '))) })
    para = []
  }
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        out.push({ kind: 'code', text: fit(code.join('\n')) })
        code = null
      } else {
        endPara()
        code = []
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const bullet = /^(\s*)[-*+•]\s+(.*)$/.exec(line)
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    const rule = /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    const tableRule = /^\s*\|?\s*:?-{3,}/.test(line) && line.includes('|')
    if (heading) {
      endPara()
      out.push({ kind: 'h', text: fit(plain(heading[1]!), 'inter-600') })
    } else if (rule || tableRule) {
      endPara()
    } else if (bullet) {
      endPara()
      out.push({ kind: 'li', text: fit(plain(bullet[2]!)), depth: bullet[1]!.length >= 2 ? 1 : 0 })
    } else if (numbered) {
      endPara()
      out.push({ kind: 'num', n: `${numbered[1]}.`, text: fit(plain(numbered[2]!)) })
    } else if (!line.trim()) {
      endPara()
      if (out.length && out.at(-1)!.kind !== 'gap') out.push({ kind: 'gap' })
    } else if (line.includes('|') && /^\s*\|/.test(line)) {
      // A table row: its cells as one line, separated plainly.
      endPara()
      out.push({ kind: 'p', text: fit(plain(line.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim()).join('   '))) })
    } else {
      para.push(quote ? quote[1]! : line.trim())
    }
  }
  endPara()
  // An unclosed fence still shows what it held.
  if (code) out.push({ kind: 'code', text: fit((code as string[]).join('\n')) })
  while (out.at(-1)?.kind === 'gap') out.pop()
  return out
}
