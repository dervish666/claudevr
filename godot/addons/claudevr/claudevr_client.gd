class_name ClaudeVRClient
extends Node
## An HTTP client for the ClaudeVR bridge (bridge/src/server.ts). No XR in here.
##
## Every call is a coroutine that returns a result Dictionary, never raises:
##   { ok: bool, status: int (HTTP, 0 when no answer came), error: String,
##     json: Variant (parsed body, or null), body: PackedByteArray, mime: String }
## A failure always carries a non-empty `error`, so a caller that only prints
## `error` still reports a 401 or a TLS refusal instead of carrying on.
##
## Auth: "Authorization: Bearer <device token>" on every /api call except the
## pairing handshake (gate.ts tokenOf). The token comes from pair() and is
## kept in `token_file` (user://, app-private on Android).
##
## Trust, first that applies: `cert_path` (a PEM file you ship), else the
## bridge CA saved at pairing, else `allow_unsafe_tls`, else the system CAs
## (which refuse the bridge). With no CA saved, pair() fetches the bridge's CA
## from /api/pair/ca once, unverified (trust on first use), emits
## ca_fingerprint() so the person can compare it with the bridge's /pair page,
## saves it beside the token and pins it from then on. The bridge's server
## certificate can be remade for new addresses; the CA stays.

signal pairing_code(code: String, approve_url: String, expires_in_ms: int)
signal paired(label: String)
signal unpaired(reason: String)
signal log_line(text: String)
## The SHA-256 of the CA this client trusts, and where it came from:
## "file" (cert_path), "saved" (pinned at an earlier pairing) or "fetched"
## (trust on first use, just now: compare it with the bridge's /pair page).
signal ca_fingerprint(sha256: String, source: String)

## The bridge, as https://host:port. The certificate must cover the host name
## used here (the bridge's covers localhost, 127.0.0.1 and its LAN IPv4 addresses).
@export var bridge_url := "https://localhost:8443"
## A CA (PEM) to pin instead of fetching one: <bridge state dir>/certs/ca.pem.
## res:// or an absolute path. A self-signed server certificate also works
## (an older bridge's cert.pem); a CA-signed one does not, pin its CA.
@export var cert_path := ""
## With no cert_path and no saved CA, fetch the bridge's CA at pairing.
@export var trust_on_first_use := true
## Checked against the certificate instead of the URL's host, when they differ.
@export var tls_common_name := ""
## Skip certificate checks entirely. Prototype escape hatch only; it is logged
## as a warning on every request so it cannot be left on quietly.
@export var allow_unsafe_tls := false
@export var token_file := "user://claudevr/device.cfg"
## What the bridge's approval page calls this device (sent as the User-Agent).
@export var device_label := "Godot client"
@export var timeout_s := 20.0
## Transcription waits on ffmpeg and the model, and a cold model is slow.
@export var transcribe_timeout_s := 90.0

const USER_AGENT_PREFIX := "ClaudeVR-Godot/0.1"

var _token := ""
var _ca_pem := ""
var _tls: TLSOptions = null
var _tls_error := ""
var _tls_ready := false


func _ready() -> void:
	load_token()


# ------------------------------------------------------------------ token

func has_token() -> bool:
	return not _token.is_empty()


## Uses this token for this run only (not saved). For tests, and for proving a wrong token is refused.
func set_token_for_session(token: String) -> void:
	_token = token


func load_token() -> bool:
	var cfg := ConfigFile.new()
	var err := cfg.load(token_file)
	if err == ERR_FILE_NOT_FOUND:
		_token = ""
		return false
	if err != OK:
		_say("could not read %s (%s); pair again" % [token_file, error_string(err)])
		_token = ""
		return false
	_token = str(cfg.get_value(bridge_url, "token", ""))
	_ca_pem = str(cfg.get_value(bridge_url, "ca_pem", ""))
	_tls_ready = false
	return has_token()


func _save_token(token: String, label: String) -> int:
	return _save_values({"token": token, "label": label, "paired_at": Time.get_datetime_string_from_system(true)})


func _save_values(values: Dictionary) -> int:
	var dir := token_file.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir):
		DirAccess.make_dir_recursive_absolute(dir)
	var cfg := ConfigFile.new()
	cfg.load(token_file)  # keep other bridges' entries; a missing file is fine
	for k in values:
		cfg.set_value(bridge_url, k, values[k])
	return cfg.save(token_file)


## Forgets the token. The saved CA stays, so pairing again does not trust a
## network a second time; forget_trust() drops it too.
func forget_token() -> void:
	_token = ""
	var cfg := ConfigFile.new()
	if cfg.load(token_file) == OK and cfg.has_section_key(bridge_url, "token"):
		for k in ["token", "label", "paired_at"]:
			if cfg.has_section_key(bridge_url, k):
				cfg.erase_section_key(bridge_url, k)
		cfg.save(token_file)


## Drops the saved CA, for when the bridge was given a new one on purpose.
## The next pair() fetches it again (trust on first use).
func forget_trust() -> void:
	_ca_pem = ""
	_tls_ready = false
	var cfg := ConfigFile.new()
	if cfg.load(token_file) == OK and cfg.has_section_key(bridge_url, "ca_pem"):
		cfg.erase_section_key(bridge_url, "ca_pem")
		cfg.erase_section_key(bridge_url, "ca_sha256")
		cfg.save(token_file)


## "AB:CD:..": SHA-256 of a PEM certificate's DER bytes, as the bridge's /pair page shows it.
static func pem_fingerprint(pem: String) -> String:
	var begin := pem.find("-----BEGIN CERTIFICATE-----")
	var end := pem.find("-----END CERTIFICATE-----")
	if begin == -1 or end == -1:
		return ""
	var b64 := pem.substr(begin + 27, end - begin - 27).replace("\n", "").replace("\r", "").strip_edges()
	var der := Marshalls.base64_to_raw(b64)
	if der.is_empty():
		return ""
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(der)
	var parts := PackedStringArray()
	for byte in h.finish():
		parts.append("%02X" % byte)
	return ":".join(parts)


## The CA this client pins, as {ok, sha256, source, error}. Fetches and saves
## the bridge's CA when there is none yet and trust_on_first_use is on.
func ensure_trust() -> Dictionary:
	if not cert_path.is_empty():
		var pem := FileAccess.get_file_as_string(cert_path)
		if pem.is_empty():
			return {"ok": false, "error": "could not read cert_path %s: %s" % [cert_path, error_string(FileAccess.get_open_error())]}
		return _trusted(pem, "file")
	if not _ca_pem.is_empty():
		return _trusted(_ca_pem, "saved")
	if allow_unsafe_tls or not trust_on_first_use:
		return {"ok": true, "sha256": "", "source": "none", "error": ""}
	_say("TLS: no CA pinned for %s yet; fetching it once without checks (trust on first use)" % bridge_url)
	var r := await _request(HTTPClient.METHOD_GET, "/api/pair/ca", {"auth": false, "unsafe": true})
	if not r.ok:
		return {"ok": false, "error": "could not fetch the bridge CA: " + r.error}
	var pem: String = r.body.get_string_from_utf8()
	var cert := X509Certificate.new()
	if cert.load_from_string(pem) != OK:
		return {"ok": false, "error": "the bridge sent something that is not a certificate"}
	var err := _save_values({"ca_pem": pem, "ca_sha256": pem_fingerprint(pem)})
	if err != OK:
		return {"ok": false, "error": "could not save the bridge CA to %s: %s" % [token_file, error_string(err)]}
	_ca_pem = pem
	_tls_ready = false
	return _trusted(pem, "fetched")


func _trusted(pem: String, source: String) -> Dictionary:
	var fp := pem_fingerprint(pem)
	_say("TLS: bridge CA SHA-256 %s (%s)" % [fp, {"file": "from cert_path", "saved": "pinned at pairing", "fetched": "just fetched: check it matches the bridge's /pair page before typing the code"}[source]])
	ca_fingerprint.emit(fp, source)
	return {"ok": true, "sha256": fp, "source": source, "error": ""}


# ------------------------------------------------------------------ pairing

## The pairing handshake (pairing.ts): ask for a code, show it, poll until
## someone types it at the bridge's /pair page on its own machine.
## Emits pairing_code() once the code is known, paired() on success.
func pair(replace_existing := false) -> Dictionary:
	if has_token() and not replace_existing:
		return _ok(200, null, "already paired")
	var trust := await ensure_trust()
	if not trust.ok:
		return _fail(0, null, trust.error)
	var r := await _request(HTTPClient.METHOD_POST, "/api/pair/request", {"body": "{}".to_utf8_buffer(), "type": "application/json", "auth": false})
	if not r.ok:
		return r
	var t: Dictionary = r.json
	var code := str(t.get("code", ""))
	var approve_url := str(t.get("approveUrl", ""))
	var expires := int(t.get("expiresInMs", 120000))
	_say("pairing code %s: type it at %s on the bridge's machine (%d s)" % [code, approve_url, expires / 1000])
	pairing_code.emit(code, approve_url, expires)
	var id := str(t.get("id", ""))
	var secret := str(t.get("secret", ""))
	var deadline := Time.get_ticks_msec() + expires + 5000
	while Time.get_ticks_msec() < deadline:
		await get_tree().create_timer(1.5).timeout
		var s := await _request(HTTPClient.METHOD_GET, "/api/pair/status?id=" + id.uri_encode(), {"auth": false, "headers": ["x-pair-secret: " + secret]})
		if s.status == 0:
			return s  # TLS or network: polling again will not help
		if not s.ok:
			return _fail(s.status, s.json, "pairing request gone: " + s.error)
		var st := str(s.json.get("state", ""))
		if st == "approved":
			var token := str(s.json.get("token", ""))
			var label := str(s.json.get("label", ""))
			var err := _save_token(token, label)
			_token = token
			if err != OK:
				return _fail(0, null, "paired, but could not save the token to %s: %s" % [token_file, error_string(err)])
			_say("paired as %s; token saved to %s" % [label, token_file])
			paired.emit(label)
			return _ok(200, {"label": label}, "")
		if st != "pending":
			return _fail(s.status, s.json, "unexpected pairing state %s" % st)
	return _fail(0, null, "nobody approved code %s in time; ask for a new one" % code)


## This device revokes its own token on the bridge, then forgets it here.
func unpair() -> Dictionary:
	var r := await _request(HTTPClient.METHOD_POST, "/api/unpair", {"body": "{}".to_utf8_buffer(), "type": "application/json"})
	if r.ok:
		forget_token()
		unpaired.emit("unpaired on request")
	return r


# ------------------------------------------------------------------ API

func health() -> Dictionary:
	return await _request(HTTPClient.METHOD_GET, "/api/health", {})


func fleet() -> Dictionary:
	return await _request(HTTPClient.METHOD_GET, "/api/fleet", {})


func voice_status() -> Dictionary:
	return await _request(HTTPClient.METHOD_GET, "/api/voice", {})


## A recorded clip -> VoiceReply {transcript, interpretation, line?} in `json`.
## `context`: "none", "confirm" (a card is armed) or "target"; `focus`: the
## session id open in the reader, or "". Nothing is sent to any session here:
## a "tell" comes back as an interpretation for the app to confirm, then send().
## A failed transcription still has a VoiceReply in `json`, with
## transcript.ok false and transcript.reason saying why.
func transcribe(wav: PackedByteArray, context := "none", focus := "") -> Dictionary:
	var q := "?context=" + context.uri_encode()
	if not focus.is_empty():
		q += "&focus=" + focus.uri_encode()
	var r := await _request(HTTPClient.METHOD_POST, "/api/transcribe" + q, {"body": wav, "type": "audio/wav", "timeout": transcribe_timeout_s})
	if not r.ok and r.json is Dictionary and r.json.get("transcript") is Dictionary:
		var t: Dictionary = r.json.transcript
		r.error = "%s: %s" % [t.get("reason", "failed"), t.get("error", r.error)]
	return r


## Types `text` into a session (rate limited by the bridge). `request_id`
## makes a retry safe: the bridge answers a repeated id once.
func send(session_id: String, text: String, request_id := "") -> Dictionary:
	var body := {"sessionId": session_id, "text": text}
	if not request_id.is_empty():
		body.requestId = request_id
	return await _request(HTTPClient.METHOD_POST, "/api/send", {"body": JSON.stringify(body).to_utf8_buffer(), "type": "application/json"})


## Speech for `text`: `body` holds the audio, `mime` its type. `format` "mp3"
## or "wav" asks the bridge to convert it; "" is the provider's own (WebM/Opus
## for say, which Godot cannot play). speech_stream() turns it into an AudioStream.
func speak(text: String, format := "mp3") -> Dictionary:
	var q := "" if format.is_empty() else "?format=" + format.uri_encode()
	return await _request(HTTPClient.METHOD_POST, "/api/speak" + q, {"body": JSON.stringify({"text": text}).to_utf8_buffer(), "type": "application/json", "timeout": transcribe_timeout_s})


## A speak() result as something an AudioStreamPlayer can play:
## {ok, stream: AudioStream, error}. MP3 (fish.audio) and WAV work; the say
## provider's WebM/Opus does not, because Godot has no WebM or Opus decoder.
static func speech_stream(r: Dictionary) -> Dictionary:
	if not r.get("ok", false):
		return {"ok": false, "stream": null, "error": r.get("error", "no speech")}
	var mime := str(r.get("mime", ""))
	var body: PackedByteArray = r.get("body", PackedByteArray())
	if mime.begins_with("audio/mpeg"):
		var mp3 := AudioStreamMP3.new()
		mp3.data = body
		return {"ok": true, "stream": mp3, "error": ""}
	if mime.begins_with("audio/wav") or mime.begins_with("audio/x-wav"):
		var wav := AudioStreamWAV.load_from_buffer(body)
		return {"ok": wav != null, "stream": wav, "error": "" if wav else "could not read the WAV"}
	return {"ok": false, "stream": null, "error": "Godot cannot play %s; ask speak() for format mp3 or wav" % mime}


# ------------------------------------------------------------------ HTTP

## TLS settings, made once. Pinned certificate, else the explicit unsafe
## switch, else the system CAs (which refuse the bridge's self-signed one).
func _tls_options() -> TLSOptions:
	if _tls_ready:
		return _tls
	_tls_ready = true
	if not bridge_url.begins_with("https://"):
		_tls_error = "bridge_url must be https:// (the bridge serves HTTPS only)"
		return null
	_tls_error = ""
	if not cert_path.is_empty():
		var cert := X509Certificate.new()
		var err := cert.load(cert_path)
		if err != OK:
			_tls_error = "could not load the pinned certificate %s: %s" % [cert_path, error_string(err)]
			return null
		_tls = TLSOptions.client(cert, tls_common_name)
		_say("TLS: pinned to %s" % cert_path)
	elif not _ca_pem.is_empty():
		var ca := X509Certificate.new()
		if ca.load_from_string(_ca_pem) != OK:
			_tls_error = "the CA saved in %s is unreadable; forget_trust() and pair again" % token_file
			return null
		_tls = TLSOptions.client(ca, tls_common_name)
		_say("TLS: pinned to the bridge CA saved at pairing")
	elif allow_unsafe_tls:
		_tls = TLSOptions.client_unsafe()
		_say("TLS: WARNING certificate checks are OFF (allow_unsafe_tls); anyone on the network can read the token")
	else:
		_tls = TLSOptions.client()
		_say("TLS: no cert_path set, using system CAs; the bridge's self-signed certificate will be refused")
	return _tls


func _request(method: int, path: String, o: Dictionary) -> Dictionary:
	var tls: TLSOptions
	if o.get("unsafe", false):
		tls = TLSOptions.client_unsafe()
	else:
		tls = _tls_options()
		if not _tls_error.is_empty():
			return _fail(0, null, _tls_error)
	var headers := PackedStringArray(["User-Agent: %s (%s)" % [USER_AGENT_PREFIX, device_label]])
	if o.get("auth", true):
		if _token.is_empty():
			return _fail(0, null, "not paired: call pair() first")
		headers.append("Authorization: Bearer " + _token)
	if o.has("type"):
		headers.append("Content-Type: " + str(o.type))
	headers.append_array(o.get("headers", []))
	if o.get("unsafe", false) or (allow_unsafe_tls and cert_path.is_empty() and _ca_pem.is_empty()):
		_say("TLS: unverified request to %s" % path)

	var http := HTTPRequest.new()
	http.use_threads = true
	http.timeout = float(o.get("timeout", timeout_s))
	http.set_tls_options(tls)
	add_child(http)
	var body: PackedByteArray = o.get("body", PackedByteArray())
	var err := http.request_raw(bridge_url + path, headers, method, body)
	if err != OK:
		http.queue_free()
		return _fail(0, null, "could not start the request to %s: %s" % [path, error_string(err)])
	var done: Array = await http.request_completed
	http.queue_free()
	var result: int = done[0]
	var status: int = done[1]
	var resp_headers: PackedStringArray = done[2]
	var resp: PackedByteArray = done[3]
	if result != HTTPRequest.RESULT_SUCCESS:
		return _fail(0, null, "%s %s: %s" % [_method_name(method), path, _result_text(result)])

	var mime := ""
	for h in resp_headers:
		if h.to_lower().begins_with("content-type:"):
			mime = h.substr(13).strip_edges()
	var json: Variant = null
	if mime.begins_with("application/json"):
		json = JSON.parse_string(resp.get_string_from_utf8())
	var r := {"ok": status >= 200 and status < 300, "status": status, "error": "", "json": json, "body": resp, "mime": mime}
	if not r.ok:
		var why := ""
		if json is Dictionary and json.has("error"):
			why = str(json.error)
		r.error = "HTTP %d from %s %s%s" % [status, _method_name(method), path, (": " + why) if why else ""]
		if status == 401:
			r.error += " (the device token was refused: pair again)"
			unpaired.emit("token refused")
	return r


func _result_text(result: int) -> String:
	match result:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "cannot connect (is the bridge running at %s?)" % bridge_url
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "cannot resolve the host in %s" % bridge_url
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "connection error"
		HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
			return "TLS handshake failed: the bridge's certificate is not signed by the pinned CA, or does not cover this host name (if the bridge was given a new CA on purpose, forget_trust() and pair again)"
		HTTPRequest.RESULT_NO_RESPONSE:
			return "no response"
		HTTPRequest.RESULT_BODY_SIZE_LIMIT_EXCEEDED:
			return "response too big"
		HTTPRequest.RESULT_TIMEOUT:
			return "timed out"
		_:
			return "request failed (HTTPRequest result %d)" % result


func _method_name(m: int) -> String:
	return "POST" if m == HTTPClient.METHOD_POST else "GET"


func _ok(status: int, json: Variant, note: String) -> Dictionary:
	return {"ok": true, "status": status, "error": "", "json": json, "body": PackedByteArray(), "mime": "", "note": note}


func _fail(status: int, json: Variant, error: String) -> Dictionary:
	return {"ok": false, "status": status, "error": error, "json": json, "body": PackedByteArray(), "mime": ""}


func _say(text: String) -> void:
	print("[claudevr] ", text)
	log_line.emit(text)
