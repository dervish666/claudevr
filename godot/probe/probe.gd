extends Node
## Desktop probe for addons/claudevr.
##
## Interactive (a window): pairs if needed, then hold SPACE to talk, release
## to send. The transcript and interpretation print to the log and the window.
##
## Scripted (headless), arguments after "--":
##   --bridge=https://localhost:8443   the bridge (default)
##   --cert=/path/ca.pem               pin this CA file (default: none; pairing fetches the bridge CA and pins it)
##   --unsafe-tls                      no certificate check (logged loudly)
##   --token-file=/path/device.cfg     where the device token lives (default user://claudevr/device.cfg)
##   --token=<t>                       use this token for the run, not the saved one
##   --pair                            pair now (prints the code to type at /pair)
##   --health  --fleet  --voice        call those routes
##   --wav=/path/clip.wav              send a WAV through the same encoder and upload as the mic
##   --mic-test=3                      record the live mic for N seconds, then send it
##   --mic-mode=auto|server|capture    how ClaudeVRMic reads the mic
##   --cn=<name>                       check the certificate against this name instead of the URL's host
##   --send=<sessionId>|<text>         POST /api/send
##   --speak=<text>                    POST /api/speak, decode the audio and report its length
##   --speak-format=mp3|wav|           the format to ask for ("" is the provider's own WebM, which Godot cannot play)
##   --forget-trust                    drop the saved CA first, so pairing fetches it again
## Exits 0 when every step passed, 1 otherwise, with "PROBE FAIL" lines saying why.

var client: ClaudeVRClient
var mic: ClaudeVRMic
var label: Label
var busy := false
var fingerprint := ""
var player: AudioStreamPlayer
var failures: Array[String] = []


func _ready() -> void:
	var args := _args()
	client = ClaudeVRClient.new()
	client.bridge_url = args.get("bridge", "https://localhost:8443")
	client.cert_path = args.get("cert", "")
	client.allow_unsafe_tls = args.has("unsafe-tls")
	if args.has("unsafe-tls"):
		client.cert_path = ""
	if args.has("cn"):
		client.tls_common_name = args["cn"]
	if args.has("token-file"):
		client.token_file = args["token-file"]
	client.device_label = "ClaudeVR Godot probe"
	add_child(client)
	if args.has("token"):
		client.set_token_for_session(args["token"])
	if args.has("forget-trust"):
		client.forget_trust()
	mic = ClaudeVRMic.new()
	if args.has("mic-mode"):
		mic.mode = args["mic-mode"]
	add_child(mic)

	var scripted := ["pair", "health", "fleet", "voice", "wav", "mic-test", "send", "speak"].any(func(k): return args.has(k))
	if scripted:
		await _run_script(args)
		_finish()
	else:
		_build_ui()
		if not client.has_token():
			_show("Not paired. Fetching the bridge's certificate and a code...")
			var r := await client.pair()
			if not r.ok:
				_fail("pair", r.error)
				return
		_show("Paired with %s.\nHold SPACE to talk, release to send." % client.bridge_url)


func _run_script(args: Dictionary) -> void:
	_log("bridge %s, cert %s, token file %s, token %s" % [client.bridge_url, client.cert_path if client.cert_path else "(none)", client.token_file, "given on the command line" if args.has("token") else ("saved" if client.has_token() else "none yet")])
	if args.has("pair"):
		var p := await client.pair(true)
		_check("pair", p)
		if not p.ok:
			return
	if args.has("health"):
		var h := await client.health()
		if _check("health", h):
			_log("health: backend %s ok=%s" % [h.json.backend.name, h.json.backend.ok])
	if args.has("voice"):
		var v := await client.voice_status()
		if _check("voice", v):
			_log("voice: stt %s (%s), tts %s ok=%s" % [v.json.stt.get("provider"), v.json.stt.get("state"), v.json.tts.get("provider"), v.json.tts.get("ok")])
	if args.has("fleet"):
		var f := await client.fleet()
		if _check("fleet", f):
			var fl: Variant = f.json.get("fleet")
			var names: Array = []
			if fl is Dictionary:
				for s in fl.get("sessions", []):
					names.append("%s (%s)" % [s.get("callsign", "?"), s.get("id", "?")])
			_log("fleet: %d sessions: %s" % [names.size(), ", ".join(names)])
	if args.has("wav"):
		var bytes := FileAccess.get_file_as_bytes(args["wav"])
		if bytes.is_empty():
			_fail("wav", "could not read %s: %s" % [args["wav"], error_string(FileAccess.get_open_error())])
		else:
			var d := ClaudeVRWav.decode(bytes)
			if not d.ok:
				_fail("wav", d.error)
			else:
				_log("wav: %s, %d samples at %d Hz, re-encoding through ClaudeVRWav.encode" % [args["wav"], d.samples.size(), d.rate])
				await _send_clip(ClaudeVRWav.encode(d.samples, d.rate))
	if args.has("mic-test"):
		var secs := float(args["mic-test"]) if args["mic-test"] is String and args["mic-test"].is_valid_float() else 3.0
		var s := mic.start()
		_log("mic: start -> %s" % JSON.stringify(s))
		if not s.ok:
			_fail("mic-start", s.error)
		else:
			await get_tree().create_timer(secs).timeout
			var m := mic.stop()
			_log("mic: %d frames, %.2f s at %d Hz, peak %.4f, mode %s, driver %s" % [m.frames, m.seconds, m.rate, m.peak, m.mode, m.driver])
			if not m.ok:
				_fail("mic", m.error)
			else:
				await _send_clip(m.wav)
	if args.has("send"):
		var parts: PackedStringArray = str(args["send"]).split("|", true, 1)
		if parts.size() != 2:
			_fail("send", "--send wants <sessionId>|<text>")
		else:
			var r := await client.send(parts[0], parts[1], "probe-%d" % Time.get_unix_time_from_system())
			if _check("send", r):
				_log("send: %s" % JSON.stringify(r.json))
	if args.has("speak"):
		var fmt: String = args.get("speak-format", "mp3") if args.get("speak-format", "mp3") is String else ""
		var sp := await client.speak(str(args["speak"]), fmt)
		if _check("speak", sp):
			_log("speak: %d bytes of %s" % [sp.body.size(), sp.mime])
			var st := ClaudeVRClient.speech_stream(sp)
			if st.ok:
				_log("speak: playable as %s, %.2f s" % [st.stream.get_class(), st.stream.get_length()])
			else:
				_fail("speak-playable", st.error)


func _send_clip(wav: PackedByteArray) -> void:
	_log("transcribe: uploading %d bytes of audio/wav" % wav.size())
	var r := await client.transcribe(wav)
	if r.json is Dictionary:
		_log("transcribe: HTTP %d reply %s" % [r.status, JSON.stringify(r.json)])
	if _check("transcribe", r):
		var t: Dictionary = r.json.transcript
		var i: Variant = r.json.interpretation
		_log("TRANSCRIPT: \"%s\" (%d ms audio, %d ms model, %d ms total)" % [t.text, t.audioMs, t.sttMs, t.totalMs])
		if i is Dictionary:
			_log("INTERPRETATION: kind=%s say=\"%s\"" % [i.get("kind"), i.get("say", "")])
		_show("You said: %s\n%s\n\nHold SPACE to talk again." % [t.text, i.get("say", "") if i is Dictionary else ""])
		# The interactive probe answers out loud, the way the buddy will.
		if player and i is Dictionary and str(i.get("say", "")) != "":
			var st := ClaudeVRClient.speech_stream(await client.speak(str(i.say)))
			if st.ok:
				player.stream = st.stream
				player.play()
			else:
				_fail("speak", st.error)


# ------------------------------------------------------------------ interactive

func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey) or event.echo or event.keycode != KEY_SPACE:
		return
	if event.pressed and not mic.recording and not busy:
		var s := mic.start()
		if s.ok:
			_show("Recording (%s, %d Hz)... release SPACE to send." % [s.mode, s.rate])
		else:
			_fail("mic-start", s.error)
	elif not event.pressed and mic.recording:
		var m := mic.stop()
		if not m.ok:
			_fail("mic", m.error)
			return
		busy = true
		_show("Sending %.1f s..." % m.seconds)
		await _send_clip(m.wav)
		busy = false


func _build_ui() -> void:
	label = Label.new()
	label.autowrap_mode = TextServer.AUTOWRAP_WORD
	label.set_anchors_preset(Control.PRESET_FULL_RECT)
	label.offset_left = 24
	label.offset_top = 24
	label.offset_right = -24
	label.add_theme_font_size_override("font_size", 22)
	add_child(label)
	client.ca_fingerprint.connect(func(fp, _source): fingerprint = fp)
	client.pairing_code.connect(func(code, url, ms): _show("Pairing code: %s\nType it at %s on the bridge's machine (%d s).\n\nFirst check this matches the fingerprint on that page:\n%s" % [code, url, ms / 1000, fingerprint]))
	player = AudioStreamPlayer.new()
	add_child(player)


func _show(text: String) -> void:
	_log(text.replace("\n", " "))
	if label:
		label.text = text


# ------------------------------------------------------------------ plumbing

func _check(step: String, r: Dictionary) -> bool:
	if r.ok:
		_log("%s: ok (HTTP %d)" % [step, r.status])
		return true
	_fail(step, r.error)
	return false


func _fail(step: String, why: String) -> void:
	failures.append("%s: %s" % [step, why])
	printerr("PROBE FAIL %s: %s" % [step, why])
	if label:
		label.text = "%s failed:\n%s" % [step, why]


func _finish() -> void:
	if failures.is_empty():
		print("PROBE PASS")
		get_tree().quit(0)
	else:
		print("PROBE FAIL (%d): %s" % [failures.size(), "; ".join(failures)])
		get_tree().quit(1)


func _log(text: String) -> void:
	print("[probe] ", text)


func _args() -> Dictionary:
	var out := {}
	for a in OS.get_cmdline_user_args():
		if not a.begins_with("--"):
			continue
		var kv := a.substr(2).split("=", true, 1)
		out[kv[0]] = kv[1] if kv.size() == 2 else true
	return out
