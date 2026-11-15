// Theme packs on disk: <state dir>/themes/<name>/theme.json and the images
// it lists. The bridge lists the valid packs for the HUD (GET /api/themes)
// and serves their images (GET /themes/<name>/<file>), both behind the gate.
//
// Packs are private config, like the characters they dress: the folder is
// read on every request (a few small files) so a pack added or edited shows
// on the next theme change without a restart. Only real folders and regular
// files count; a symbolic link is refused, so a pack cannot reach outside
// the themes folder. An image is served only when its pack's theme.json
// lists it, it is no bigger than ASSET_MAX_BYTES, its bytes are the format
// its name says, and it is at most ASSET_MAX_PX on a side.

import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_FILE, ASSET_MAX_BYTES, ASSET_MAX_PX, PACK_NAME, THEME_JSON_MAX_BYTES, assetFiles, packFor, parseTheme, type Theme, type ThemeListing, type ThemePack } from '../../shared/theme.ts'

export type ImageType = 'image/png' | 'image/webp' | 'image/jpeg'

/** What an image's own bytes say it is, and its size in pixels, or why it is not one of the three formats. */
export function sniffImage(b: Uint8Array): { type: ImageType; width: number; height: number } | { error: string } {
  const u32be = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
  const u16be = (o: number) => (b[o]! << 8) + b[o + 1]!
  const u16le = (o: number) => b[o]! + (b[o + 1]! << 8)
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') return { type: 'image/png', width: u32be(16), height: u32be(20) }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    // Lossy: a 14-bit width and height after the frame's start code.
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: 'image/webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    // Lossless: 14 bits each, minus one, packed after the 0x2f signature.
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    // Extended: 24 bits each, minus one.
    if (chunk === 'VP8X') return { type: 'image/webp', width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 }
    return { error: 'a WebP file whose size cannot be read' }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the markers to the first start-of-frame, which holds the size.
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return { error: 'a JPEG file whose markers cannot be read' }
      const m = b[o + 1]!
      if (m === 0xff) {
        o++
        continue
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2
        continue
      }
      const len = u16be(o + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', width: u16be(o + 7), height: u16be(o + 5) }
      if (len < 2) return { error: 'a JPEG file whose markers cannot be read' }
      o += 2 + len
    }
    return { error: 'a JPEG file with no frame header' }
  }
  return { error: 'not a PNG, WebP or JPEG image' }
}

const EXT_TYPE: Record<string, ImageType> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

/** Checks an image a pack lists. Null when it is fine to serve, else why not. */
export function checkImage(file: string, data: Uint8Array): string | null {
  if (data.length > ASSET_MAX_BYTES) return `${file} is ${Math.round(data.length / 1024)} KB, over the ${ASSET_MAX_BYTES / 1024} KB limit`
  const s = sniffImage(data)
  if ('error' in s) return `${file} is ${s.error}`
  const want = EXT_TYPE[file.slice(file.lastIndexOf('.') + 1)]
  if (s.type !== want) return `${file} holds ${s.type.slice(6).toUpperCase()} data, not what its name says`
  if (s.width < 1 || s.height < 1 || s.width > ASSET_MAX_PX || s.height > ASSET_MAX_PX) return `${file} is ${s.width} by ${s.height} px; at most ${ASSET_MAX_PX} on a side`
  return null
}

export type AssetResult = { ok: true; data: Buffer; type: ImageType; etag: string } | { ok: false; status: number; error: string }

export interface ThemeStoreOptions {
  /** The folder holding one folder per pack. */
  dir: string
  log: (...a: unknown[]) => void
}

/** The packs under one folder, read from disk on each call. */
export class ThemeStore {
  readonly dir: string
  private readonly log: (...a: unknown[]) => void
  /** What was last logged about each pack, so a broken pack is logged when its problem changes, not on every read. */
  private readonly said = new Map<string, string>()

  constructor(o: ThemeStoreOptions) {
    this.dir = o.dir
    this.log = o.log
  }

  /** Every folder in the themes folder: the valid packs, and the others with what is wrong. */
  async list(): Promise<ThemeListing> {
    let names: string[]
    try {
      // Folders and links (refused below, with why); a file beside the packs is not a pack and is passed over.
      names = (await readdir(this.dir, { withFileTypes: true }))
        .filter(d => !d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink()))
        .map(d => d.name)
        .sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { themes: [], invalid: [] }
      throw err
    }
    const out: ThemeListing = { themes: [], invalid: [] }
    for (const name of names) {
      const r = await this.load(name)
      if (r.ok) out.themes.push(r.pack)
      else if (r.error !== 'not a folder') out.invalid.push({ name, error: r.error })
    }
    return out
  }

  /** Whether a folder by this name holds a theme.json, valid or not. Synchronous, for the persona status. */
  has(name: string): boolean {
    if (!PACK_NAME.test(name)) return false
    try {
      return lstatSync(join(this.dir, name, 'theme.json')).isFile()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') this.note(name, `cannot be read: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * The pack a character wears: its own `theme` when it names one (false:
   * none), else a pack named after it when there is one, else null for the
   * default look. A named pack that is missing or broken is still returned:
   * the HUD then says why it shows the default look.
   */
  resolve(c: { name: string; theme?: string | false | null }): string | null {
    if (c.theme === false) return null
    if (typeof c.theme === 'string') return c.theme
    const own = packFor(c.name)
    return own && this.has(own) ? own : null
  }

  /** One pack, validated, with its images checked; or why it is not usable. */
  async load(name: string): Promise<{ ok: true; pack: ThemePack; listed: string[] } | { ok: false; error: string }> {
    const fail = (error: string) => {
      // A file beside the packs, or a name nobody made, is nothing to report.
      if (error !== 'not a folder' && error !== 'no such pack') this.note(name, error)
      return { ok: false as const, error }
    }
    if (!PACK_NAME.test(name)) return fail('the folder name must be lowercase letters, digits and hyphens, at most 40')
    const dir = join(this.dir, name)
    try {
      const st = await lstat(dir)
      if (st.isSymbolicLink()) return fail('is a symbolic link; a pack must be a real folder')
      if (!st.isDirectory()) return fail('not a folder')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail('no such pack')
      throw err
    }
    const json = await this.regular(join(dir, 'theme.json'), THEME_JSON_MAX_BYTES)
    if (!json.ok) return fail(json.error === 'missing' ? 'no theme.json' : `theme.json ${json.error}`)
    let raw: unknown
    try {
      raw = JSON.parse(json.data.toString('utf8'))
    } catch (err) {
      return fail(`theme.json is not JSON: ${(err as Error).message}`)
    }
    const parsed = parseTheme(raw)
    if (!parsed.ok) return fail(`bad theme.json: ${parsed.errors.join('; ')}`)
    const theme: Theme = parsed.theme
    const listed = assetFiles(theme)
    const notes: string[] = []
    // Each image is checked now, so the HUD never asks for one the bridge would refuse, and says why it is missing.
    for (const role of ['core', 'emblem', 'panel'] as const) {
      const file = theme.assets[role]
      if (!file) continue
      const img = await this.regular(join(dir, file), ASSET_MAX_BYTES)
      const why = !img.ok ? `${file} ${img.error === 'missing' ? 'is missing' : img.error}` : checkImage(file, img.data)
      if (why) {
        notes.push(`${role} image not shown: ${why}`)
        theme.assets = { ...theme.assets, [role]: null }
      }
    }
    if (theme.core.renderer === 'image' && !theme.assets.core) {
      const instead = theme.core.under ?? 'rings'
      notes.push(`the image core has no picture, so it draws ${instead}`)
      theme.core = { ...theme.core, renderer: instead, under: null }
    }
    this.note(name, notes.length ? `usable, but: ${notes.join('; ')}` : null)
    return { ok: true, pack: { name, theme, notes }, listed }
  }

  /** An image of a valid pack, for GET /themes/<name>/<file>. */
  async asset(name: string, file: string): Promise<AssetResult> {
    if (!PACK_NAME.test(name) || !ASSET_FILE.test(file)) return { ok: false, status: 404, error: 'not found' }
    const p = await this.load(name)
    if (!p.ok) return { ok: false, status: 404, error: `no usable pack called ${name}: ${p.error}` }
    // Checked against what theme.json names, so a listed image that is too big gets 413 rather than looking absent.
    if (!p.listed.includes(file)) return { ok: false, status: 404, error: `${file} is not an image this pack's theme.json lists` }
    const img = await this.regular(join(this.dir, name, file), ASSET_MAX_BYTES)
    if (!img.ok) return { ok: false, status: img.tooBig ? 413 : 404, error: `${file} ${img.error}` }
    const why = checkImage(file, img.data)
    if (why) return { ok: false, status: 415, error: why }
    const type = sniffImage(img.data) as { type: ImageType }
    return { ok: true, data: img.data, type: type.type, etag: `"${createHash('sha256').update(img.data).digest('hex').slice(0, 24)}"` }
  }

  /** A regular file's bytes, refusing links and anything over `max` before reading it. */
  private async regular(path: string, max: number): Promise<{ ok: true; data: Buffer } | { ok: false; error: string; tooBig?: true }> {
    try {
      const st = await lstat(path)
      if (st.isSymbolicLink()) return { ok: false, error: 'is a symbolic link' }
      if (!st.isFile()) return { ok: false, error: 'is not a file' }
      if (st.size > max) return { ok: false, error: `is ${Math.round(st.size / 1024)} KB, over the ${Math.round(max / 1024)} KB limit`, tooBig: true }
      return { ok: true, data: await readFile(path) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'missing' }
      throw err
    }
  }

  /** Logs what is wrong with a pack when that changes; null when nothing is. */
  private note(name: string, problem: string | null): void {
    const was = this.said.get(name) ?? null
    if (problem === was) return
    if (problem === null) {
      this.said.delete(name)
      this.log(`themes: ${name} is fine now`)
      return
    }
    if (this.said.size > 200) this.said.clear()
    this.said.set(name, problem)
    this.log(`themes: ${name}: ${problem}`)
  }
}
