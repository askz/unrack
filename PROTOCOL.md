# t.racks DSP 4x4 Mini Pro — protocol notes

Clean-room, interoperability-focused notes describing the device's USB-HID control
protocol **as observed on the wire**: framing, command set, data model and unit scalings
were derived by watching the USB traffic and by probing the device directly (write a
distinctive known value, read it back, match the bytes).

## Transport
- USB HID, VID `0x0168` / PID `0x0821`. One interface; two 64-byte **interrupt** endpoints:
  `0x02 OUT` (host→device), `0x81 IN` (device→host). No report IDs. Request/reply.

## Frame format
**Request (host→device):**
```
10 02            DLE STX
00               (reserved/seq)
addr             device address (0x01 on USB)
N                payload length = 1 + data.length  (code byte + data)
code             command code
<data…>          N-1 bytes
10 03            DLE ETX
checksum         = XOR(00, addr, N, code, …data) ^ 1
```
Sent in a 64-byte interrupt OUT report (trailing bytes are stale/ignored). Payload
bytes equal to 0x10 are **not** escaped: the device locates the terminator by the length
field, and escaping breaks the frame (hardware-verified). Verified: poll `10 02 00 01 01 40 10 03 41`
(0x40, cksum 0x41), mute `10 02 00 01 03 35 04 01 10 03 33`.

**Reply (device→host):** framed like a request.
```
10 02            DLE STX
01               device id
00
N                payload length = 1 + data.length  (code byte + data)
code             reply code, e.g. 0x52 = version reply
<data…>          N-1 bytes
10 03            DLE ETX   (found by the length field, not by scanning)
checksum         = XOR(01, 00, N, code, …data) ^ 1
```
Total frame = N+8 bytes (≤ 64). At the codec layer the reply payload is read as
`[0x01, 0x00, N, code, …data]` (`web/src/protocol/frame.ts`).

> Note: a *different* 16-bit one's-complement checksum applies to the unit's RS-232 /
> network transport — don't confuse it with the USB-HID `XOR(bytes)^1` above.

## Request/reply semantics (measured on `4x4MINIPRO V010 20230106A`)
- **Queries echo their code** (`0x10`, `0x13`, `0x14`, `0x22`, `0x29`, `0x2c`, `0x40`, `0x52`);
  `0x27` READ_CHANNEL answers with code `0x24`. Indexed queries (`0x27`, `0x29`) echo the index
  as the first data byte.
- **Every write is acked with code `0x01`** (N=1, no data): level, mute, polarity, routing, delay,
  crossover, PEQ, compressor, gate, recall, store, `0x12` INIT_DONE.
- **Unknown opcode → code `0x02`** (NAK). **Bad checksum → no reply.**
- **One transaction at a time.** A frame sent while the device is still processing the previous
  one is silently dropped (two back-to-back writes produce a single ack).
- **No unsolicited traffic**: the device only speaks when asked (meters are polled with `0x40`).
- The first transaction after open is *not* dropped on this firmware.
- **Timing:** typical round trip 3–10 ms, up to ~40 ms (compressor); **recall ≈ 0.66 s**,
  **store ≈ 2.2 s** before the ack. Retry windows must be sized per command, or a re-sent
  recall/store produces a second ack that is mistaken for the reply to the next request.
- **Preset slots are 0–29** (30 names via `0x29`). The device does **not** range-check
  recall/store: slot 30 is acked and becomes the active slot.
- `0x14` returns the **active preset slot**, updated by both recall and store.

## Confirmed opcode map (observed one control at a time)
| code | command | payload |
|------|---------|---------|
| `0x40` | poll in/out audio **levels** | – (reply carries 8 levels) |
| `0x35` | **mute** | `[chan, on]` |
| `0x36` | **polarity** invert | `[chan, invert]` |
| `0x34` | **level/gain** | `[chan, val16]` raw 0–400, two segments: **raw ≥ 80: dB=(raw−280)/10**; **raw < 80: dB=raw/2−60**; raw 0 = hard mute (firmware-confirmed) |
| `0x33` | **PEQ band** | `[chan, band, gain16, freq16, q8, type8, bypass8]` (capture-calibrated) |
| `0x26` | **set name** | 14 ASCII bytes |
| `0x21`/`0x20` | **store / recall preset** | `[slot]` |
| `0x27` | indexed readback | `[0..8]` |

Channels: **Output 1 = 0x04** (inputs 0x00–0x03, outputs 0x04–0x07). The full control
set (per-channel gain/mute/polarity, 7-band PEQ, crossover, compressor, gate, delay,
routing, linking) is exposed by the app.

**Full DSP-block opcodes (observed, one control at a time):**
| code | block | payload | notes |
|------|-------|---------|-------|
| `0x30` | compressor | `[chan, ratio, knee, attack16, release16, threshold16]` | ratio idx 0–14 into `[1.0, 1.1, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0, 10.0, 20.0]` (firmware table at `0xa52c`); the app also sends index 15, shown as *Limit* (used by Setup's protection limiters), which has no entry in that table, so what the device does with it is not verified; knee 0–12 dB; **attack/release raw, ms = raw + 1** (firmware-confirmed); **threshold raw=(dB+90)·2** |
| `0x31` | crossover LPF | `[chan, freq16, slope]` | **freq Hz = 19.7·2^(raw/30)**, raw 0–300 (30 steps/oct — coarser than PEQ); slope codes below |
| `0x32` | crossover HPF | `[chan, freq16, slope]` | same freq scale as LPF |
| `0x33` | PEQ band | `[chan, band, gain16, freq16, q8, type8, bypass8]` | **gain raw 0–240, 0 dB=120, 0.1 dB/step** (`dB=(raw−120)/10`); **freq = 16-bit log index, Hz=19.7·2^(idx/30)** (idx 0–300, *same scale as crossover*); **q8** single byte, **exponential `Q = 128 / 1.0594^(100−q8)`** (q8 16 = Q 1.0, every +12 doubles Q, q8 100 = Q 128 — firmware-confirmed, see [`docs/FIRMWARE.md`](docs/FIRMWARE.md)); type below. NB gain comes first (not RBJ order) — capture-verified (40.3 Hz = idx 31) |
| `0x34` | level/gain | `[chan, val16]` | raw 0–400; **raw ≥ 80 (−20..+12 dB): dB=(raw−280)/10**, 0.1 dB/step, 0 dB=280 (factory default of every channel reads back 280); **raw < 80: dB=raw/2−60**, 0.5 dB/step; **raw 0 = hard mute**. Firmware converters `sub_6880` (inputs) / `sub_6830` (outputs) compute `10^(x/200)·2^24` with `x = raw−280` or `5·raw−600` (see [`docs/FIRMWARE.md`](docs/FIRMWARE.md)) |
| `0x35` | mute | `[chan, on]` | |
| `0x36` | polarity | `[chan, invert]` | |
| `0x38` | delay | `[chan, samples16]` | **48 kHz**; ms=samples/48; max 32640=680 ms |
| `0x3a` | routing | `[out_chan, input_mask]` | bits InA=1,InB=2,InC=4,InD=8 |
| `0x3e` | gate | `[chan, attack16, release16, hold16, threshold16]` | **attack/release/hold raw, ms = raw + 1** (as the compressor); threshold raw=(dB+90)·2 (range 0–180) |
| `0x2f` | lock password | `[4 ASCII]` | default "1234" |
| `0x39` | test tone | `[source, freqIndex]` | source 0=off/input,1=pink,2=white,3=sine; freqIndex 0–30 = 1/3-oct 20 Hz–20 kHz |

**Startup handshake** (observed at editor launch, in order): `0x10`→status byte; `0x13`→version
string `"4x4MINIPRO V010"`; `0x2c`→7-byte config; `0x22`→30-byte flags/link table; `0x14`→active preset slot;
`0x29 [0..29]`→read all 30 preset names (14 ASCII); `0x27 [0..8]`→read all 9 channel state
blocks (reply code `0x24`, 50 bytes each: name + DSP params); `0x12`→finalize (ack `0x01`);
then steady `0x40` level polling. (`0x52` also returns a longer version string, e.g.
`"4x4MINIPRO V010 20230106A"`.)

Unrack connects with a shorter sequence: `0x10`, `0x13`, `0x52`, then `0x27 [0..8]`, `0x14`,
`0x29 [0..29]`, then `0x12`, and polls `0x40`. It skips `0x2c` and `0x22`, which it does not need.

**Level reply (`0x40`)** — reply `[01,00,N=0x1c,0x40, …27 data bytes]`. 8 channels × 3 bytes,
order **In A–D, Out 1–4**. Each triplet `[d0, d1, d2]` is a 32-bit linear DSP level word packed as
`word = d1<<24 | d0<<16 | d2<<8` (bits 7..0 dropped; packing firmware-confirmed, see
[`docs/FIRMWARE.md`](docs/FIRMWARE.md)); **full scale = 2^24** (inferred from the DSP's 8.24
format), so `dBFS = 20·log10(word / 2^24)`.
Data byte 24 is the DSP status word's low byte, bytes 25–26 are GPIO reads. Idle hardware reads
≈ −87 dBFS (inputs) and −75.5 dBFS (outputs); with Out 1 at 0 dB fed only by In A, Out 1 − In A
measured +0.25 dB median on programme audio. Decoded in `web/src/protocol/readback.ts`
(`levelsDbFromReply`; `levelsFromReply` maps −72..0 dBFS onto the 0..1 meters). Earlier builds read
only `d2` (bits 15..8), which wraps every 256 counts and made the meters look random.

**Channel-state image (`0x27`→`0x24`)** — the nine `0x24` pages each carry `[idx, …50 bytes]`;
concatenating pages 0–8 (50 B each) rebuilds a **450-byte preset image**. All field offsets
below are **probe-verified** (wrote distinctive known values, read back, matched bytes):
- `+0..1` flags · `+2` **preset name** (14 ASCII).
- **input records** (24 B) at `16/40/64/88` (relative offsets): `+0` name (10 B) · `+10` gate
  attack (u16) · `+12` gate release · `+14` gate hold · `+16` gate threshold (raw `(dB+90)·2`) ·
  `+18` gain (u16, level-raw scale) · `+20` polarity (bool) · `+22` channel-id bit.
- **output records** (74 B) at `112/186/260/334`: `+0` name (8 B) · `+8` routing input mask
  (InA=1..InD=8) · `+10` HPF freq raw · `+12` LPF freq raw · `+14` HPF slope · `+15` LPF slope ·
  `+16..57` **7 PEQ bands** × 6 B = `[gain16 (0–240, 0 dB=120), freq16 (log idx /30), q8, type8]` ·
  `+58` comp ratio idx · `+59` comp knee · `+60` comp attack (u16) · `+62` release · `+64`
  threshold (raw) · `+66` gain (u16) · `+68` polarity (bool) · `+70` delay (u16 samples) ·
  `+72` channel-id bit.
- **Mute has NO readback.** Empirically, muting changes *none* of the device's readbacks
  (`0x10`/`0x14`/`0x22`/`0x24`/`0x2c`/`0x40` all unchanged) — mute state is held separately from
  the per-channel record array that `0x27`/`0x24` serializes, and no opcode the editor uses
  exposes it. The firmware confirms this: the `0x35` handler keeps mute in two RAM half-words
  (outputs/inputs), pushes them to DSP coefficients, and no command handler ever returns them.
  So neither the editor nor this app can restore mute on connect: the vendor editor assumes
  un-muted, Unrack shows each mute as unknown (`?`) until it is set, and keeps a mute it knows
  across a preset recall. `0x22` is a static `ff ff 00 00…` channel-present/link map, **not** mute. PEQ
  per-band **bypass** also isn't in the image (command-only).

Decoded in `readback.ts` (`parsePresetImage`); the store hydrates every field on connect.

**Calibration** (from editor capture, 2026-06-16): gain (`0x34`), comp/gate threshold,
delay samples@48 kHz, PEQ freq (`19.7·2^(idx/30)`, 30/oct like the crossover), **PEQ gain
(`(raw−120)/10`)**, **crossover freq (`19.7·2^(raw/30)`)**. The PEQ-gain calibration also
revealed the `0x33` gain/freq field order (gain is the 16-bit field first, freq the log index) —
corrected in the codec.

**Slope codes** (`0x31`/`0x32` byte[3]; 0=bypass): `01`BW-6 `02`BL-6 `03`BW-12 `04`BL-12
`05`LK-12 `06`BW-18 `07`BL-18 `08`BW-24 `09`BL-24 `0a`LK-24.
**PEQ types** (`0x33` byte[7]): `0`Peak `1`Low-Shelf `2`High-Shelf `3`Low-Pass `4`High-Pass
`5`Allpass1 `6`Allpass2.

## Implementation
Built + golden-tested in `web/src/protocol/{frame,commands,control,blocks,readback,exchange}.ts`.
The codec sends high-level parameters (freq/gain/Q/type); the device computes the biquads
internally. `exchange.ts` holds the reply rules above and the reply timeouts (150 ms, recall
1.5 s, store 4 s); `web/src/transport/channel.ts` keeps one transaction in flight, retries,
puts user edits before meter polls, and merges queued writes to the same parameter.

The editor quantizes every value to these encodings before sending
(`web/src/state/params.ts`). `npm run hw:smoke` writes PEQ bands, a crossover, delay,
compressor, gate, gain and routing, reads the preset image back and checks that the device
holds exactly the model's values (verified on `4x4MINIPRO V010 20230106A`).

**Firmware cross-check:** static analysis of the vendor MCU image settled the encodings that
capture alone left open (see [`docs/FIRMWARE.md`](docs/FIRMWARE.md)). Confirmed from the image:
the PEQ Q curve (`Q = 128 / 1.0594^(100−q8)`, now used by the codec instead of the earlier linear
guess), PEQ frequency (`19.72·2^(idx/30)`), the compressor ratio table, compressor/gate time
scaling (`ms = raw + 1`), and that mute has no query path.

**Remaining gaps:** a handful of low opcodes seen in the startup handshake are unmapped readback
variants, and compressor ratio index 15 (*Limit*) is outside the firmware's ratio table.
