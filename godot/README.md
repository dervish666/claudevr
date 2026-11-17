# ClaudeVR for Godot (prototype)

Step one of an in-app ClaudeVR buddy: a Godot 4.7 app pairs with the bridge,
records speech, posts it to `/api/transcribe` and gets back the transcript and
what the bridge made of it. Desktop only so far.

- `addons/claudevr/` is the part to vendor. Plain GDScript, no XR, no plugin to enable.
  - `claudevr_client.gd` (`ClaudeVRClient`, a Node): pairing, token storage, pinning the bridge CA, and `health`, `fleet`, `voice_status`, `transcribe`, `send`, `speak` (MP3 or WAV), `unpair`.
  - `claudevr_mic.gd` (`ClaudeVRMic`, a Node): push-to-talk recording, `start()` / `stop()` returns a WAV.
  - `claudevr_wav.gd` (`ClaudeVRWav`): PCM16 WAV encode (resampled to 16 kHz mono), decode, resample.
- `probe/` is a desktop test scene that uses the addon.

## Run the desktop probe

Start the bridge as usual (`npm start` or `npm run demo` in the repo root). Then:

```sh
cd godot
godot --path .            # a window: pairs if needed, then hold SPACE to talk
```

On first run the probe fetches the bridge's CA (once, unverified) and shows
its SHA-256 fingerprint with a code like `J7Q-RAE`. Open
https://localhost:8443/pair on the Mac, check the fingerprint under "Bridge
certificate" matches, then type the code. The token and the CA land in
`user://claudevr/device.cfg` (on macOS, `~/Library/Application Support/Godot/app_userdata/ClaudeVR Probe/`),
and every later request is pinned to that CA. After a transcript the probe
speaks the answer (MP3 from `/api/speak?format=mp3`).

Headless, scripted (exit code 0 when every step passed, 1 with `PROBE FAIL` lines otherwise):

```sh
say -o /tmp/x.wav --data-format=LEI16@16000 "tell Harbour run the tests"
godot --headless --path . -- --pair --health          # prints a code; approve it at /pair
godot --headless --path . -- --wav=/tmp/x.wav --fleet --speak="hello"   # --speak-format=wav for WAV
```

All the flags are listed at the top of `probe/probe.gd`. `--wav` decodes the
file and pushes the samples through the same `ClaudeVRWav.encode` and
`ClaudeVRClient.transcribe` the mic uses.

## Using the addon

```gdscript
var client := ClaudeVRClient.new()
client.bridge_url = "https://192.168.1.20:8443"
add_child(client)                    # loads the saved token and CA in _ready
if not client.has_token():
	client.ca_fingerprint.connect(func(sha256, _source): show_fingerprint(sha256))
	client.pairing_code.connect(func(code, url, _ms): show_code(code))
	var p := await client.pair()     # fetches and pins the CA first
var mic := ClaudeVRMic.new()
add_child(mic)
mic.start()
# ... button released
var clip := mic.stop()
if clip.ok:
	var r := await client.transcribe(clip.wav)
	if r.ok:
		print(r.json.transcript.text, " -> ", r.json.interpretation)
		var st := ClaudeVRClient.speech_stream(await client.speak(r.json.interpretation.say))
		if st.ok:
			$AudioStreamPlayer.stream = st.stream
			$AudioStreamPlayer.play()
	else:
		print(r.error)             # always set on failure: 401, TLS, "silent", "busy"...
```

Nothing is ever sent to a session by `transcribe`. A `tell` interpretation is
for the app to confirm, then `send(sessionId, text)`.

Set `token_file` and `bridge_url` before `add_child`, or call `load_token()` after
changing them. Tokens are kept per bridge URL.

## Mic

`ClaudeVRMic.mode = "auto"` uses `AudioServer.set_input_device_active` +
`get_input_frames` (Godot 4.5+), which reads the input device without adding
a bus to the host app's layout. `"capture"` is the older AudioStreamMicrophone
into a muted bus with an AudioEffectCapture. Both need
`audio/driver/enable_input=true` in Project Settings.

`stop()` refuses a clip with no frames or with every sample exactly zero, so a
dead mic reads as a failure and not as a quiet room.

## TLS

The bridge has a local CA that signs its server certificate (see "Certificates"
in the repo README). The client pins the CA, so the bridge can remake its server
certificate for a new address without breaking the app. Where the CA comes from,
first that applies:

1. `cert_path`: a PEM you ship or point at (`.local/certs/ca.pem`). Pin the CA,
   not `cert.pem`: Godot's TLS (mbedtls) only takes a server certificate as a
   trust anchor when it is self-signed, and the bridge's no longer is.
2. The CA saved at pairing (trust on first use): `pair()` fetches
   `/api/pair/ca` once without checks, emits `ca_fingerprint`, saves it beside
   the token, and pins it from then on. Compare the fingerprint with `/pair`
   before typing the code; that comparison is what makes the first fetch safe.
3. `allow_unsafe_tls = true`: no checks, warned on every request. Prototype only.

If the bridge is given a new CA on purpose, `forget_trust()` and pair again.

Tested headless on the Mac: pinning works by name (`localhost`) and by IP SAN
(`127.0.0.1`); a new server certificate for a new address keeps working; a
bridge with a different CA, a pinned `cert.pem`, no pin, or a name the
certificate does not cover all fail with "TLS handshake failed".

## Quest (not done yet, nothing here is verified on a headset)

- Export preset: permissions `record_audio` and `internet`. At runtime call
  `OS.request_permissions()` (or `OS.request_permission("android.permission.RECORD_AUDIO")`)
  before the first `mic.start()`. The exact permission name and prompt flow on Quest are untested.
- Add the Quest's address to the bridge's `allowIps` and use the Mac's LAN IP in `bridge_url`.
- Pairing fetches the CA by itself. Shipping it instead (`cert_path` to a
  `res://` PEM) needs `*.pem` in the export preset's non-resource include filter.
- `speak()` asks for MP3 by default. Without a format the `say` provider sends
  WebM/Opus, which Godot cannot decode; `speech_stream()` says so.
