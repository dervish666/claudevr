class_name ClaudeVRWav
extends RefCounted
## WAV in and out, for the clips the bridge transcribes.
##
## The bridge runs every clip through ffmpeg to 16 kHz mono s16 PCM, so any
## PCM16 WAV works. This encodes mono PCM16 at 16 kHz by default: 32 kB a
## second, so the bridge's 2 MB clip cap holds its whole 30 s limit.

const TARGET_RATE := 16000


## Float samples in -1..1 at `rate` Hz -> a PCM16 mono WAV at `out_rate` Hz.
static func encode(samples: PackedFloat32Array, rate: int, out_rate: int = TARGET_RATE) -> PackedByteArray:
	var mono := samples if rate == out_rate else resample(samples, rate, out_rate)
	var pcm := PackedByteArray()
	pcm.resize(mono.size() * 2)
	for i in mono.size():
		var v := int(round(clampf(mono[i], -1.0, 1.0) * 32767.0))
		pcm.encode_s16(i * 2, v)
	return _wrap(pcm, out_rate, 1)


## Linear interpolation, with a box average over the source span when going
## down, which keeps most of the aliasing out of speech-band audio.
static func resample(samples: PackedFloat32Array, rate: int, out_rate: int) -> PackedFloat32Array:
	var out := PackedFloat32Array()
	if samples.is_empty() or rate <= 0 or out_rate <= 0:
		return out
	var step := float(rate) / float(out_rate)
	var n := int(floor(samples.size() / step))
	out.resize(n)
	var last := samples.size() - 1
	for i in n:
		var pos := i * step
		if step > 1.0:
			var a := int(pos)
			var b := mini(int(pos + step), last + 1)
			var sum := 0.0
			for j in range(a, b):
				sum += samples[j]
			out[i] = sum / float(maxi(1, b - a))
		else:
			var a2 := int(pos)
			var t := pos - a2
			var b2 := mini(a2 + 1, last)
			out[i] = lerpf(samples[a2], samples[b2], t)
	return out


## Stereo frames from the audio server -> mono floats, appended to `into`.
## Returns the loudest absolute sample seen, for "is the mic live" checks.
static func append_mono(into: PackedFloat32Array, frames: PackedVector2Array) -> float:
	var start := into.size()
	into.resize(start + frames.size())
	var peak := 0.0
	for i in frames.size():
		var f := frames[i]
		var m := (f.x + f.y) * 0.5
		into[start + i] = m
		peak = maxf(peak, absf(m))
	return peak


## A PCM16 WAV (any rate, mono or stereo) -> {ok, samples (mono float), rate, error}.
## For feeding a file through the same encode and upload path as the mic.
static func decode(bytes: PackedByteArray) -> Dictionary:
	if bytes.size() < 12 or bytes.slice(0, 4).get_string_from_ascii() != "RIFF" or bytes.slice(8, 12).get_string_from_ascii() != "WAVE":
		return {"ok": false, "error": "not a RIFF/WAVE file"}
	var pos := 12
	var fmt_found := false
	var channels := 0
	var rate := 0
	var bits := 0
	var format := 0
	while pos + 8 <= bytes.size():
		var id := bytes.slice(pos, pos + 4).get_string_from_ascii()
		var size := bytes.decode_u32(pos + 4)
		var body := pos + 8
		if id == "fmt ":
			format = bytes.decode_u16(body)
			channels = bytes.decode_u16(body + 2)
			rate = bytes.decode_u32(body + 4)
			bits = bytes.decode_u16(body + 14)
			fmt_found = true
		elif id == "data":
			if not fmt_found:
				return {"ok": false, "error": "data chunk before fmt chunk"}
			# 1 is PCM; 0xFFFE (extensible) carries PCM in this prototype's inputs.
			if (format != 1 and format != 0xFFFE) or bits != 16 or channels < 1:
				return {"ok": false, "error": "only PCM16 WAV is supported (format %d, %d bits, %d channels)" % [format, bits, channels]}
			var end := mini(body + size, bytes.size())
			var frame_bytes := 2 * channels
			var count := (end - body) / frame_bytes
			var out := PackedFloat32Array()
			out.resize(count)
			for i in count:
				var sum := 0.0
				for c in channels:
					sum += bytes.decode_s16(body + i * frame_bytes + c * 2) / 32768.0
				out[i] = sum / channels
			return {"ok": true, "samples": out, "rate": rate}
		pos = body + size + (size & 1)
	return {"ok": false, "error": "no data chunk"}


static func _wrap(pcm: PackedByteArray, rate: int, channels: int) -> PackedByteArray:
	var h := PackedByteArray()
	h.resize(44)
	h.encode_u32(0, 0x46464952)  # "RIFF"
	h.encode_u32(4, 36 + pcm.size())
	h.encode_u32(8, 0x45564157)  # "WAVE"
	h.encode_u32(12, 0x20746d66)  # "fmt "
	h.encode_u32(16, 16)
	h.encode_u16(20, 1)  # PCM
	h.encode_u16(22, channels)
	h.encode_u32(24, rate)
	h.encode_u32(28, rate * channels * 2)
	h.encode_u16(32, channels * 2)
	h.encode_u16(34, 16)
	h.encode_u32(36, 0x61746164)  # "data"
	h.encode_u32(40, pcm.size())
	h.append_array(pcm)
	return h
