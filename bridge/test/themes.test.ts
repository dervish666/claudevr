// Theme packs: the schema and its defaults, the image checks, the pack
// folder (listing, symbolic links, oversized and unlisted files), the two
// routes behind the gate, which pack a character wears, and the persona
// status carrying it. The packs are copies of the tracked example
// (themes/bosun) and broken ones made here; nothing private is read.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { TtsStatus } from '../../shared/protocol.ts'
import { ASSET_MAX_BYTES, contrastErrors, contrastRatio, DEFAULT_THEME, packFor, parseTheme, type ThemeListing } from '../../shared/theme.ts'
import { TODAY, paletteCss, rolesFor } from '../../client/src/instrument/themes/palette.ts'
import { checkImage, sniffImage, ThemeStore } from '../src/themes.ts'
import { parseCharacters } from '../src/config.ts'
import { Persona } from '../src/persona/persona.ts'
import { StubFrontMan } from '../src/persona/frontman.ts'
import type { Character } from '../src/persona/prompt.ts'
import type { TtsProvider } from '../src/voice/tts.ts'
import { createBridge, type Bridge } from '../src/server.ts'
import { FakeAdapter } from '../src/backend/fake.ts'
import { makeCert } from '../src/cert.ts'

const REPO = join(import.meta.dirname, '..', '..')
const BOSUN_DIR = join(REPO, 'themes', 'bosun')
const FIX = join(REPO, 'fixtures')
const TOKEN = 'cd'.repeat(16)

/** A PNG's first 33 bytes: the signature and an IHDR chunk for w by h, padded to `size` bytes. */
function png(w: number, h: number, size = 64): Buffer {
  const b = Buffer.alloc(Math.max(33, size))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment to step over, then SOF0 with the size.
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0])
}

function webpLossless(w: number, h: number): Buffer {
  const b = Buffer.alloc(32)
  b.write('RIFF', 0, 'ascii')
  b.write('WEBP', 8, 'ascii')
  b.write('VP8L', 12, 'ascii')
  b[20] = 0x2f
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21)
  return b
}

// ---------------------------------------------------------------- schema

test('schema: an empty theme.json is today\'s look, and a partial one keeps the defaults it does not set', () => {
  const empty = parseTheme({})
  assert.ok(empty.ok)
  assert.deepEqual(empty.theme, DEFAULT_THEME)
  const some = parseTheme({ schema: 1, palette: { accent: '#D4A443' }, frame: { corner: 'chamfer' } })
  assert.ok(some.ok)
  assert.equal(some.theme.palette.accent, '#d4a443')
  assert.equal(some.theme.palette.plate, DEFAULT_THEME.palette.plate)
  assert.equal(some.theme.frame.corner, 'chamfer')
  assert.equal(some.theme.frame.weight, 1)
  assert.equal(some.theme.core.renderer, 'rings')
})

test('schema: the example pack parses', () => {
  const r = parseTheme(JSON.parse(readFileSync(join(BOSUN_DIR, 'theme.json'), 'utf8')))
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  assert.equal(r.theme.core.renderer, 'rings')
  assert.equal(r.theme.assets.emblem, 'emblem.png')
})

test('schema: bad values and unknown keys are refused, each with its path', () => {
  const bad = parseTheme({
    palette: { accent: 'orange', glowStrength: 9, sparkle: true },
    typography: { heading: { font: 'comic-sans', letterSpacing: 2 } },
    frame: { corner: 'wavy', weight: 0 },
    core: { renderer: 'lens', under: 'bars' },
    motion: { ringSpeed: -1, transition: 'dissolve' },
    assets: { emblem: '../../etc/passwd.png', panelOpacity: 1 },
    text: { label: 'x'.repeat(41) },
    extra: 1,
  })
  assert.equal(bad.ok, false)
  const all = bad.ok ? '' : bad.errors.join('\n')
  for (const path of ['palette.accent', 'palette.glowStrength', 'palette.sparkle', 'typography.heading.font', 'typography.heading.letterSpacing', 'frame.corner', 'frame.weight', 'core.under', 'motion.ringSpeed', 'motion.transition', 'assets.emblem', 'assets.panelOpacity', 'text.label', 'theme.extra']) assert.match(all, new RegExp(path.replace('.', '\\.')), path)
  const img = parseTheme({ core: { renderer: 'image' } })
  assert.equal(img.ok, false)
  assert.match(img.ok ? '' : img.errors[0]!, /needs assets.core/)
  assert.equal(parseTheme([]).ok, false)
  assert.equal(parseTheme({ schema: 2 }).ok, false)
})

test('contrast: text under 4.5:1 or dim under 3:1 on the plate or the panel is refused, with the path and the ratio', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00')
  assert.equal(contrastRatio('#777777', '#777777'), 1)
  // Dark grey text on the default dark plates.
  const dark = parseTheme({ palette: { text: '#333333' } })
  assert.ok(!dark.ok)
  assert.equal(dark.errors.length, 2, dark.errors.join('; '))
  assert.match(dark.errors[0]!, /^palette\.text: #333333 on palette\.plate #0e1216 has a contrast of 1\.\d\d:1; text needs at least 4\.5:1/)
  assert.match(dark.errors[1]!, /^palette\.text: #333333 on palette\.panel #0a0e11 /)
  // Dim needs only 3:1: a mid grey passes as dim and fails as text.
  const mid = '#6e6e6e'
  assert.ok(contrastRatio(mid, DEFAULT_THEME.palette.plate) > 3 && contrastRatio(mid, DEFAULT_THEME.palette.plate) < 4.5)
  assert.ok(parseTheme({ palette: { dim: mid } }).ok)
  assert.ok(!parseTheme({ palette: { text: mid } }).ok)
  // A light panel under the default light text: the pair is named by the surface that fails.
  const pale = parseTheme({ palette: { panel: '#d0d0d0' } })
  assert.ok(!pale.ok)
  assert.ok(pale.errors.every(e => / on palette\.panel #d0d0d0 /.test(e)), pale.errors.join('; '))
  assert.deepEqual(pale.errors.map(e => e.split(':')[0]), ['palette.text', 'palette.dim'])
  // A colour that is not a colour is reported as such, not measured as well.
  assert.deepEqual(parseTheme({ palette: { text: 'black' } }), { ok: false, errors: ['palette.text: a colour as #rrggbb, got "black"'] })
  // The tracked pack still reads.
  const bosun = parseTheme(JSON.parse(readFileSync(join(BOSUN_DIR, 'theme.json'), 'utf8')))
  assert.ok(bosun.ok, bosun.ok ? '' : bosun.errors.join('; '))
  assert.deepEqual(contrastErrors(bosun.theme.palette), [])
})

test('schema: a pack name is lowercase letters, digits and hyphens; a character name maps to one', () => {
  assert.equal(packFor('Bosun'), 'bosun')
  assert.equal(packFor('Chief Engineer'), 'chief-engineer')
  assert.equal(packFor('../x'), null)
})

test('palette: the default palette gives exactly the colours the scene drew before themes, and sets nothing on the 2D page', () => {
  assert.deepEqual(rolesFor(DEFAULT_THEME.palette), TODAY)
  assert.deepEqual(paletteCss(DEFAULT_THEME.palette), {})
  const r = rolesFor({ ...DEFAULT_THEME.palette, accent: '#d4a443' })
  assert.equal(r.c.cyan, '#d4a443')
  assert.deepEqual(r.plates.tile, TODAY.plates.tile, 'a plate made only from the panel colour is untouched by the accent')
  assert.notDeepEqual(r.plates.hover, TODAY.plates.hover)
  assert.deepEqual(paletteCss({ ...DEFAULT_THEME.palette, accent: '#d4a443' }), { '--accent': '#d4a443' })
})

// ---------------------------------------------------------------- images

test('images: the size is read from the bytes, and the limits hold', () => {
  assert.deepEqual(sniffImage(png(128, 64)), { type: 'image/png', width: 128, height: 64 })
  assert.deepEqual(sniffImage(jpeg(300, 200)), { type: 'image/jpeg', width: 300, height: 200 })
  assert.deepEqual(sniffImage(webpLossless(512, 256)), { type: 'image/webp', width: 512, height: 256 })
  assert.ok('error' in sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))
  assert.equal(checkImage('a.png', png(1024, 1024)), null)
  assert.match(checkImage('a.png', png(1025, 10))!, /at most 1024/)
  assert.match(checkImage('a.png', png(10, 10, ASSET_MAX_BYTES + 1))!, /over the 400 KB limit/)
  assert.match(checkImage('a.jpg', png(10, 10))!, /PNG data, not what its name says/)
  assert.equal(checkImage('a.jpeg', jpeg(10, 10)), null)
  assert.equal(checkImage('a.webp', webpLossless(10, 10)), null)
  // The example pack's emblem is within the limits.
  assert.equal(checkImage('emblem.png', readFileSync(join(BOSUN_DIR, 'emblem.png'))), null)
})

// ---------------------------------------------------------------- the pack folder and the routes

let dir: string
let themesDir: string
let store: ThemeStore
let bridge: Bridge
let fake: FakeAdapter
let port: number
const logs: string[] = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claudevr-themes-'))
  themesDir = join(dir, 'themes')
  // The example pack, and an unlisted picture beside its listed one.
  mkdirSync(join(themesDir, 'bosun'), { recursive: true })
  for (const f of ['theme.json', 'emblem.png']) copyFileSync(join(BOSUN_DIR, f), join(themesDir, 'bosun', f))
  writeFileSync(join(themesDir, 'bosun', 'extra.png'), png(8, 8))
  // A pack whose listed panel is over the size limit, and whose emblem is too many pixels.
  mkdirSync(join(themesDir, 'heavy'))
  writeFileSync(join(themesDir, 'heavy', 'theme.json'), JSON.stringify({ assets: { panel: 'panel.png', emblem: 'wide.png' } }))
  writeFileSync(join(themesDir, 'heavy', 'panel.png'), png(64, 64, ASSET_MAX_BYTES + 10))
  writeFileSync(join(themesDir, 'heavy', 'wide.png'), png(4096, 16))
  // Broken packs: not JSON, a bad value, a link to a real pack, a bad folder name, and a stray file.
  mkdirSync(join(themesDir, 'garbled'))
  writeFileSync(join(themesDir, 'garbled', 'theme.json'), '{ not json')
  mkdirSync(join(themesDir, 'wrong'))
  writeFileSync(join(themesDir, 'wrong', 'theme.json'), JSON.stringify({ core: { renderer: 'teapot' } }))
  symlinkSync(join(themesDir, 'bosun'), join(themesDir, 'linked'))
  mkdirSync(join(themesDir, 'Shouty'))
  writeFileSync(join(themesDir, 'notes.txt'), 'not a pack')
  store = new ThemeStore({ dir: themesDir, log: (...a) => logs.push(a.join(' ')) })

  const certs = makeCert(join(dir, 'certs'), ['localhost', '127.0.0.1'])
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>hud</title>')
  fake = FakeAdapter.fromFixtures(FIX, { pollMs: 50, log: () => {} })
  bridge = createBridge({
    backend: fake,
    token: TOKEN,
    allowIps: [],
    clientDir: join(dir, 'client'),
    probeLog: join(dir, 'probe.log'),
    cert: readFileSync(certs.cert),
    key: readFileSync(certs.key),
    sendsPerMinute: 3,
    sendsPerHour: 100,
    themes: store,
    log: (...a) => logs.push(a.join(' ')),
  })
  await new Promise<void>(ok => bridge.server.listen(0, '127.0.0.1', ok))
  port = (bridge.server.address() as AddressInfo).port
})

after(async () => {
  await bridge.close()
  fake.close()
  rmSync(dir, { recursive: true, force: true })
})

function get(path: string, opts: { token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c as Buffer))
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('error', fail)
    req.end()
  })
}

test('folder: the valid packs are listed, the broken ones with why, links and stray files never served', async () => {
  const l = await store.list()
  assert.deepEqual(l.themes.map(t => t.name), ['bosun', 'heavy'])
  const why = Object.fromEntries(l.invalid.map(i => [i.name, i.error]))
  assert.match(why.garbled!, /not JSON/)
  assert.match(why.wrong!, /core\.renderer/)
  assert.match(why.linked!, /symbolic link/)
  assert.match(why.Shouty!, /lowercase/)
  assert.equal(why['notes.txt'], undefined, 'a file beside the packs is not a pack')
  const heavy = l.themes.find(t => t.name === 'heavy')!
  assert.equal(heavy.theme.assets.panel, null, 'an oversized image is dropped from the pack')
  assert.equal(heavy.theme.assets.emblem, null)
  assert.equal(heavy.notes.length, 2)
  assert.ok(logs.some(x => /themes: garbled: theme.json is not JSON/.test(x)), 'a broken pack is logged')
  const before = logs.length
  await store.list()
  assert.equal(logs.length, before, 'and logged once, not on every read')
})

test('folder: a missing themes folder lists nothing', async () => {
  assert.deepEqual(await new ThemeStore({ dir: join(dir, 'nowhere'), log: () => {} }).list(), { themes: [], invalid: [] })
})

test('GET /api/themes: behind the token and the origin check', async () => {
  assert.equal((await get('/api/themes')).status, 401)
  assert.equal((await get('/api/themes', { token: 'ef'.repeat(16) })).status, 401)
  assert.equal((await get('/api/themes', { token: TOKEN, headers: { origin: 'https://evil.example' } })).status, 403)
  const r = await get('/api/themes', { token: TOKEN })
  assert.equal(r.status, 200)
  const l = JSON.parse(r.body.toString('utf8')) as ThemeListing
  assert.deepEqual(l.themes.map(t => t.name), ['bosun', 'heavy'])
})

test('GET /themes/<name>/<file>: a listed image, with its type, cache headers and etag', async () => {
  assert.equal((await get('/themes/bosun/emblem.png')).status, 401)
  assert.equal((await get('/themes/bosun/emblem.png', { token: TOKEN, headers: { origin: 'https://evil.example' } })).status, 403)
  const r = await get('/themes/bosun/emblem.png', { token: TOKEN })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'image/png')
  assert.equal(r.headers['cache-control'], 'private, max-age=300')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.ok(r.body.equals(readFileSync(join(BOSUN_DIR, 'emblem.png'))))
  const again = await get('/themes/bosun/emblem.png', { token: TOKEN, headers: { 'if-none-match': String(r.headers.etag) } })
  assert.equal(again.status, 304)
})

test('GET /themes/<name>/<file>: traversal, unlisted, oversized and broken all refused', async () => {
  const status = async (p: string) => (await get(p, { token: TOKEN })).status
  assert.equal(await status('/themes/bosun/extra.png'), 404, 'a picture the theme.json does not list')
  assert.equal(await status('/themes/bosun/theme.json'), 404)
  assert.equal(await status('/themes/bosun/..%2ftheme.json'), 404)
  assert.equal(await status('/themes/bosun/%2e%2e/%2e%2e/package.json'), 404)
  assert.equal(await status('/themes/..%2f..%2fpackage.json/x.png'), 404)
  assert.equal(await status('/themes/linked/emblem.png'), 404, 'a pack that is a link')
  assert.equal(await status('/themes/garbled/emblem.png'), 404)
  assert.equal(await status('/themes/Shouty/a.png'), 404)
  assert.equal(await status('/themes/bosun/emblem.png/x'), 404)
  assert.equal(await status('/themes/heavy/panel.png'), 413, 'listed but over the size limit')
  assert.equal(await status('/themes/heavy/wide.png'), 415, 'listed but too many pixels')
})

// ---------------------------------------------------------------- which pack a character wears

class StubTts implements TtsProvider {
  readonly name = 'stub'
  current = 'a'
  status(): TtsStatus {
    return { provider: 'stub', ok: true, error: null }
  }
  async speak() {
    return { audio: Buffer.from('x'), mime: 'audio/webm' }
  }
  voices() {
    return [
      { name: 'a', heardAs: [] },
      { name: 'b', heardAs: [] },
    ]
  }
  voice() {
    return this.current
  }
  select(n: string) {
    this.current = n
  }
}

test('config: a character may name a pack, or false for none', () => {
  const c = parseCharacters({ bosun: { voice: 'a', prompt: 'p' }, purser: { voice: 'a', prompt: 'p', theme: 'ledger' }, cook: { voice: 'a', prompt: 'p', theme: false } }, null)
  assert.deepEqual(c.map(x => x.theme), [null, 'ledger', false])
  assert.throws(() => parseCharacters({ b: { voice: 'a', prompt: 'p', theme: '../x' } }, null), /theme/)
  assert.throws(() => parseCharacters({ b: { voice: 'a', prompt: 'p', theme: 3 } }, null), /theme/)
})

test('resolve: a named pack, else the pack with the character\'s own name, else none', () => {
  const ch = (name: string, theme: string | false | null): Character => ({ name, voice: 'a', prompt: 'p', confirm: 'card', heardAs: [], accent: null, theme })
  assert.equal(store.resolve(ch('bosun', null)), 'bosun', 'its own name')
  assert.equal(store.resolve(ch('bosun', false)), null, 'false turns it off')
  assert.equal(store.resolve(ch('bosun', 'heavy')), 'heavy')
  assert.equal(store.resolve(ch('purser', null)), null, 'no pack by that name')
  assert.equal(store.resolve(ch('purser', 'missing')), 'missing', 'a named pack that is missing is still named, so the HUD can say why')
  assert.equal(store.resolve(ch('garbled', null)), 'garbled', 'a broken pack under its own name is named too')
})

test('persona: the status carries the pack each character wears', () => {
  const chars: Character[] = [
    { name: 'bosun', voice: 'a', prompt: 'p', confirm: 'quick', heardAs: [], accent: '#f5a524', theme: null },
    { name: 'purser', voice: 'b', prompt: 'p', confirm: 'card', heardAs: [], accent: null, theme: 'heavy' },
  ]
  const p = new Persona({ characters: chars, frontMan: new StubFrontMan(), classifier: new StubFrontMan(), tts: new StubTts(), stateFile: null, initial: 'bosun', log: () => {}, themeOf: c => store.resolve(c) })
  const s = p.status()
  assert.equal(s.character?.theme, 'bosun')
  assert.deepEqual(s.characters.map(c => c.theme), ['bosun', 'heavy'])
  // Without a store the persona names only what the config names.
  const bare = new Persona({ characters: chars, frontMan: new StubFrontMan(), classifier: new StubFrontMan(), tts: new StubTts(), stateFile: null, initial: 'purser', log: () => {} })
  assert.deepEqual(bare.status().characters.map(c => c.theme), [null, 'heavy'])
})
