// The approval page: type the code a device shows, see who is paired, revoke.
// The bridge serves it to this machine only. Every change is a same-origin
// POST, so the browser attaches this page's Origin and a page on another
// site cannot approve or revoke. Plain script, no build step: the bridge
// reads this file from disk on each request.

const $ = id => document.getElementById(id)
const form = $('approve')
const input = $('code')
const go = $('go')
const result = $('result')
const errorBanner = $('error')

/** The device last approved here, so its row stands out for a moment. */
let freshId = null
/** The one revoke button waiting for its second click, by key ("device:<id>" or "legacy"). */
let armed = null
let armedTimer = null
let last = null
// What the table and the legacy row last showed. They are rebuilt only when
// that changes, so a countdown tick never swaps a button out from under a click.
let tableShown = ''
let legacyShown = ''

function say(el, text, kind) {
  el.textContent = text
  el.className = kind ? `msg ${kind}` : 'msg'
}

async function call(method, path, body) {
  const r = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  let data
  try {
    data = await r.json()
  } catch (err) {
    data = { error: `unreadable reply (HTTP ${r.status}): ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: r.ok, status: r.status, data }
}

// Shown the way the headset shows it: capitals, a dash after three.
input.addEventListener('input', () => {
  const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  input.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw
})

form.addEventListener('submit', async e => {
  e.preventDefault()
  const code = input.value.trim()
  if (!code) return
  go.disabled = true
  say(result, 'Checking…')
  try {
    const r = await call('POST', '/api/pair/approve', { code })
    if (r.ok) {
      freshId = r.data.device.id
      say(result, `Paired: ${r.data.device.label} at ${r.data.device.ip}`, 'good')
      input.value = ''
    } else {
      say(result, r.data && r.data.error ? r.data.error : `The bridge answered HTTP ${r.status}.`, 'bad')
    }
  } catch (err) {
    say(result, `The bridge did not answer: ${err instanceof Error ? err.message : String(err)}`, 'bad')
  }
  go.disabled = false
  input.focus()
  void refresh()
})

const minutes = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function ago(t, now) {
  if (t === null) return 'not yet'
  const s = Math.round((now - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return new Date(t).toLocaleDateString()
}

function cell(text, cls) {
  const td = document.createElement('td')
  td.textContent = text
  if (cls) td.className = cls
  return td
}

/** A Revoke button that needs a second click within 4 s, so one slip unpairs nothing. */
function revokeButton(key, what, onRevoke) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = armed === key ? 'revoke armed' : 'revoke'
  b.textContent = armed === key ? 'Click again to revoke' : 'Revoke'
  b.setAttribute('aria-label', armed === key ? `Click again to revoke ${what}` : `Revoke ${what}`)
  b.addEventListener('click', async () => {
    if (armed !== key) {
      armed = key
      clearTimeout(armedTimer)
      armedTimer = setTimeout(() => {
        armed = null
        render()
      }, 4000)
      render()
      return
    }
    armed = null
    clearTimeout(armedTimer)
    b.disabled = true
    await onRevoke()
  })
  return b
}

async function revoke(body, what) {
  try {
    const r = await call('POST', '/api/pair/revoke', body)
    say(result, r.ok ? `Revoked ${what}. It must pair again to use the bridge.` : (r.data && r.data.error) || `Revoke failed: HTTP ${r.status}`, r.ok ? '' : 'bad')
  } catch (err) {
    say(result, `The bridge did not answer: ${err instanceof Error ? err.message : String(err)}`, 'bad')
  }
  await refresh()
}

function render() {
  if (!last) return
  const { data, at } = last
  const now = Date.now()

  const waiting = data.waiting
  $('waiting-section').hidden = waiting.length === 0
  const wl = $('waiting')
  wl.replaceChildren(
    ...waiting.map(w => {
      const li = document.createElement('li')
      const who = document.createElement('span')
      who.textContent = `${w.label} at ${w.ip}`
      const left = document.createElement('span')
      left.className = 'muted'
      left.textContent = `expires in ${minutes(w.expiresInMs - (now - at))}`
      li.append(who, left)
      return li
    }),
  )

  const devices = [...data.devices].sort((a, b) => b.pairedAt - a.pairedAt)
  $('devices').hidden = devices.length === 0
  $('no-devices').hidden = devices.length > 0
  const tableNow = JSON.stringify([devices.map(d => [d.id, d.label, d.ip, d.pairedAt, ago(d.lastSeen, now)]), armed, freshId])
  if (tableNow !== tableShown) {
    tableShown = tableNow
    $('devices').tBodies[0].replaceChildren(
      ...devices.map(d => {
        const tr = document.createElement('tr')
        if (d.id === freshId) tr.className = 'fresh'
        const act = document.createElement('td')
        act.className = 'act'
        act.append(revokeButton(`device:${d.id}`, `${d.label} at ${d.ip}`, () => revoke({ id: d.id }, `${d.label} at ${d.ip}`)))
        tr.append(cell(d.label), cell(d.ip), cell(new Date(d.pairedAt).toLocaleString(), 'when'), cell(ago(d.lastSeen, now), 'when seen'), act)
        return tr
      }),
    )
  }

  const fp = data.ca ? data.ca.sha256 : 'This bridge has no CA (an older bridge, or a test).'
  if ($('ca-fp').textContent !== fp) $('ca-fp').textContent = fp
  const legacyNow = JSON.stringify([data.legacy.active, armed])
  if (legacyNow === legacyShown) return
  legacyShown = legacyNow
  const legacy = $('legacy')
  const text = document.createElement('span')
  if (data.legacy.active) {
    text.textContent = 'Active. Browsers paired before pairing codes use it.'
    legacy.replaceChildren(text, revokeButton('legacy', 'the legacy token', () => revoke({ legacy: true }, 'the legacy token')))
  } else {
    text.className = 'muted'
    text.textContent = 'Not active. Only devices paired with a code can use the bridge.'
    legacy.replaceChildren(text)
  }
}

async function refresh() {
  try {
    const r = await call('GET', '/api/pair/devices')
    if (!r.ok) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`)
    last = { data: r.data, at: Date.now() }
    errorBanner.hidden = true
    render()
  } catch (err) {
    errorBanner.hidden = false
    errorBanner.textContent = `Cannot read the paired devices: ${err instanceof Error ? err.message : String(err)}`
  }
}

void refresh()
// New arrivals show up while the page is open; the countdowns tick between reads.
setInterval(() => void refresh(), 3000)
setInterval(render, 1000)
