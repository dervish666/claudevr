class_name ClaudeVRMic
extends Node
## Push-to-talk recording: start(), stop() -> a WAV for ClaudeVRClient.transcribe().
##
## Two ways to read the mic, picked by `mode`:
##   "server":  AudioServer.set_input_device_active() + get_input_frames()
##              (Godot 4.5+). Reads the input device directly and touches no
##              audio bus, so it is the polite choice inside a host app.
##   "capture": an AudioStreamMicrophone playing into a muted bus that carries
##              an AudioEffectCapture. Works on older Godot; adds a bus.
##   "auto":    "server" when the engine has it, else "capture".
## Both need Project Settings > audio/driver/enable_input = true, and on
## Android the RECORD_AUDIO permission (see README).

signal level(peak: float)
## max_seconds passed; recording stopped, stop() still returns the clip.
signal capped

@export_enum("auto", "server", "capture") var mode := "auto"
## Stops on its own at this length; the bridge refuses clips over 30 s.
@export var max_seconds := 28.0
@export var bus_name := "ClaudeVRMic"

var recording := false
var _capped := false
var _samples := PackedFloat32Array()
var _peak := 0.0
var _rate := 0
var _active_mode := ""
var _player: AudioStreamPlayer = null
var _capture: AudioEffectCapture = null
var _started_ms := 0


func resolved_mode() -> String:
	if mode != "auto":
		return mode
	return "server" if ClassDB.class_has_method("AudioServer", "get_input_frames") else "capture"


## {ok, error, mode, rate, driver, device}. A refusal is reported, never swallowed.
func start() -> Dictionary:
	if recording:
		return {"ok": false, "error": "already recording"}
	var info := {"driver": AudioServer.get_driver_name(), "device": AudioServer.get_input_device(), "mode": resolved_mode()}
	if not ProjectSettings.get_setting("audio/driver/enable_input", false):
		info.merge({"ok": false, "error": "audio/driver/enable_input is off in Project Settings; the mic gives nothing"})
		return info
	_samples = PackedFloat32Array()
	_peak = 0.0
	_active_mode = info.mode
	if _active_mode == "server":
		var err: int = AudioServer.set_input_device_active(true)
		if err != OK:
			info.merge({"ok": false, "error": "AudioServer.set_input_device_active failed: %s" % error_string(err)})
			return info
		# Drop whatever was buffered before the button went down.
		AudioServer.get_input_frames(AudioServer.get_input_frames_available())
		_rate = int(AudioServer.get_input_mix_rate())
	else:
		_ensure_capture_bus()
		_capture.clear_buffer()
		_player.play()
		_rate = int(AudioServer.get_mix_rate())
	recording = true
	_capped = false
	_started_ms = Time.get_ticks_msec()
	info.merge({"ok": true, "error": "", "rate": _rate})
	return info


## Ends the recording: {ok, error, wav, frames, seconds, rate, peak}. No
## frames, or frames that are all zero, is a failure with its own words: a
## dead mic must not look like a quiet room.
func stop() -> Dictionary:
	if not recording:
		return {"ok": false, "error": "not recording"}
	if not _capped:
		_drain()
		_release_input()
	recording = false
	_capped = false
	var frames := _samples.size()
	var out := {"frames": frames, "rate": _rate, "seconds": float(frames) / maxf(1.0, _rate), "peak": _peak, "mode": _active_mode, "driver": AudioServer.get_driver_name()}
	if frames == 0:
		out.merge({"ok": false, "error": "no audio frames came from the mic (driver %s); unavailable, not silence" % out.driver, "wav": PackedByteArray()})
		return out
	if _peak == 0.0:
		var why := "the Dummy audio driver has no mic (a --headless run)" if out.driver == "Dummy" else "the mic is muted or permission was refused"
		out.merge({"ok": false, "error": "%d frames, all exactly zero: %s" % [frames, why], "wav": PackedByteArray()})
		return out
	out.merge({"ok": true, "error": "", "wav": ClaudeVRWav.encode(_samples, _rate)})
	return out


func _process(_delta: float) -> void:
	if not recording or _capped:
		return
	_drain()
	if Time.get_ticks_msec() - _started_ms > max_seconds * 1000.0:
		print("[claudevr] mic: %.0f s limit reached; stop() collects the clip" % max_seconds)
		_capped = true
		_release_input()
		capped.emit()


func _drain() -> void:
	var frames := PackedVector2Array()
	if _active_mode == "server":
		var n: int = AudioServer.get_input_frames_available()
		if n > 0:
			frames = AudioServer.get_input_frames(n)
	elif _capture:
		var n2 := _capture.get_frames_available()
		if n2 > 0:
			frames = _capture.get_buffer(n2)
	if frames.is_empty():
		return
	var p := ClaudeVRWav.append_mono(_samples, frames)
	_peak = maxf(_peak, p)
	level.emit(p)


func _release_input() -> void:
	if _active_mode == "server":
		AudioServer.set_input_device_active(false)
	elif _player:
		_player.stop()


func _ensure_capture_bus() -> void:
	var idx := AudioServer.get_bus_index(bus_name)
	if idx == -1:
		AudioServer.add_bus()
		idx = AudioServer.bus_count - 1
		AudioServer.set_bus_name(idx, bus_name)
		# Muted so the mic is not played back; effects still see the audio.
		AudioServer.set_bus_mute(idx, true)
	if _capture == null:
		for i in AudioServer.get_bus_effect_count(idx):
			var e := AudioServer.get_bus_effect(idx, i)
			if e is AudioEffectCapture:
				_capture = e
		if _capture == null:
			_capture = AudioEffectCapture.new()
			_capture.buffer_length = 1.0
			AudioServer.add_bus_effect(idx, _capture)
	if _player == null:
		_player = AudioStreamPlayer.new()
		_player.stream = AudioStreamMicrophone.new()
		_player.bus = bus_name
		add_child(_player)
