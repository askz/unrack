# Firmware updater and firmware images

Notes from static analysis of the vendor's Windows firmware updater, done for
interoperability. Nothing here has been executed or flashed; where a statement is an
inference rather than something read directly from the code, it says so.

Analysed file: `555772_firmware_the_t.racks_dsp_4x4_mini_and_pro_v1.0.exe`
(SHA-256 `fdd0c576358a1e315140d5e6b19ad5d89a48c6401a5617df9edf79b3e84f3f14`, 1 050 112 bytes),
title "Update the t.racks DSP 4x4 Mini and Pro V1.0". No vendor binaries are kept in this repo.

## The updater
- 32-bit Borland C++Builder GUI (VCL forms `TfmIsp`, `TfmHidData`, `TfmProgData`), built
  2023-09-26. USB access goes through JEDI's `TJvHidDeviceController`.
- Buttons: **Version**, **Mcu Prog**, **Dsp Prog** (disabled in the shipped form), **Security**,
  **Start Program**. A hidden menu shows raw HID traffic.
- It recognises two USB identities:

| VID:PID | Mode |
|---------|------|
| `0168:0821` | normal application firmware (the one this project talks to) |
| `0168:0904` | bootloader / ISP |

## Embedded payloads
All three live in the `.data` section; no file is loaded from disk.

| Payload | Location | Content |
|---------|----------|---------|
| MCU image, 4x4 Mini | Intel HEX, 2 695 NUL-terminated lines, line-pointer table at VA `0x49818c` | data `0x0000–0xA81B` + 8 bytes at `0x10DF8`; version `4x4MINI V010 20230511A` |
| MCU image, 4x4 Mini Pro | Intel HEX, 2 730 lines, line-pointer table at VA `0x49aba8` | data `0x0000–0xAA4F` + 8 bytes at `0x10DF8`; version `4x4MINIPRO V010 20230106A` |
| DSP image | 3 886 little-endian dwords at VA `0x49d650` | sent big-endian per word (see `0x53` below) |

The two HEX files sit back to back in the PE (file offset `0x9FF63`), each with its own EOF
record and start address `0x000000D5`. All record checksums are valid. Both images end with
the 8 bytes `65 77 6F 50 70 73 44 72` at `0x10DF8` (`"PowerDsp"` read as little-endian words).

### MCU
ARM Cortex-M, flash at address 0 (initial SP `0x20001638`, reset `0xD5` for the Pro image).
**Inferred: Nuvoton NUC123 (Cortex-M0, 68 KB APROM)**, from:
- a 48-entry vector table (16 system + 32 IRQs) and Thumb-1-only code;
- literal-pool references to NUC1xx peripheral bases (USBD `0x40060000`, CLK `0x50000200`,
  GPIO `0x500042xx`);
- populated IRQs 8 (TMR0), 12/13 (UART0/1) and 23 (USBD), matching the NUC123 IRQ map;
- the updater's 68 KB (`0x11000`) image buffer.

Strings in the image include the version strings above, `"4x4D Amplifier"`,
`"Redx-SapphireIII"` and `"Default Preset"`.

### DSP image and the audio DSP
The device has a **separate audio DSP** with its own program, loaded from an I2C EEPROM at power-up.
The DSP is a **Blackfin** (confirmed from the live boot image, see "The DSP is a Blackfin" below).
The MCU computes all filter coefficients itself (RBJ biquad math in IEEE double at `0x3264`) and
writes them, together with gains and dynamics constants, into the DSP's parameter memory
(`0xFF80_6xxx`, i.e. Blackfin L1 data SRAM) over a separate serial bus.

- **Updater payload:** 3886 × 32-bit words (15 544 bytes, preceded by a 2-byte big-endian length
  `0x3cba`), the blob the updater sends with `0x53`. It is **not** the Blackfin program the DSP
  actually runs and does not match the live EEPROM (see "The updater payload is not the DSP program").
- **Converters / rate:** 48 kHz. The teardown (see below) shows TI/Burr-Brown parts: two **PCM5102**
  stereo DACs (the four outputs) and two Burr-Brown PCM-series ADCs (the four inputs), 20-pin TSSOP
  carrying the Burr-Brown oval logo. The spec sheet's "24-bit ADC/DAC" is consistent with these.
- **External memory:** an **ESMT M12L64164A** SDRAM (64 Mbit, 4M×16, 16-bit bus), read directly off a
  teardown photo. This is the DSP's delay-line / working memory, so the DSP must have an external
  SDRAM / EMIF controller driving a 16-bit bus.

**OEM: Musicrown.** The device enumerates over USB as `0168:0821` "Musicrown Dsp Process"
(manufacturer *Musicrown*, i.e. Dongguan Musicrown Electronic Technology). The t.racks DSP 4x4 is a
rebadge; Peavey and Wharfedale rebrand the same platform, and Musicrown's own `DM46` listing
matches this firmware's feature set exactly (same seven PEQ types incl. ALLPASS1 = 180° / ALLPASS2 =
360°, comp/limiter params, 680 ms delay, 30 password-protected presets, built-in pink/white/sine
generator).

The teardown shows the DSP is designator **U8, a 64-pin LQFP, with its top surface professionally
sanded blank** (no recoverable part number), sitting next to the ESMT SDRAM.

#### Boot path
- The updater's `0x53` blocks are handled by `sub_6130`, which writes them to the I2C EEPROM at bus
  address `0xA6` (7-bit `0x53`) on the MCU's I2C0 (`0x40020000`), starting at EEPROM offset `0x40`,
  and reads each block back to verify it (`sub_1f18` write, `sub_1ef0` read).
- Otherwise the MCU only reads bytes `0x40–0x43` of that EEPROM (Security readout, `0x6610–0x6628`).
  No code path streams the program to the DSP. **Inferred:** the DSP boots itself from this
  EEPROM, which shares the I2C bus with the MCU.
- MCU settings and presets live in a second EEPROM at bus address `0xAE` (`sub_1ee4`).

##### Read-back of the live EEPROM (does not match the updater image)
`sub_6130` fills a 64-byte page buffer from two consecutive blocks (even block → bytes 0–31, odd
block → bytes 32–63) and writes the page **only on the odd block**. Every reply echoes 32 bytes read
from the EEPROM first (before any write). So sending **only even block numbers** reads the first half
of every 64-byte page with no write at all; the payload lands only in RAM.

Reading the EEPROM at `0xA6` this way on the live device (`eeprom_dump.ts`, 512 pages, no writes)
shows it is a **256 kbit (32 KB) part** (contents repeat every `0x8000`), with data only in
`0x44–0x1a9f` (`0x40–0x43` read `ff ff ff ff`) and the rest blank `0xff`. That stored content does
**not** match the updater's DSP image in any byte order (< 3 % of bytes agree, no 24-byte run in
common), it is denser (entropy 7.0 vs 5.7 bits/byte), and it spans at most ~6.8 KB versus the
updater image's 15.5 KB. **Open question, important before any reflash:** the live boot image is
either compressed/encrypted, or a different version than the one bundled in the updater. The
structural analysis below is of the **updater image**, which is tied to the hardware (its code
references the same `0x6xxx` parameter addresses the MCU writes), but may not be the byte-for-byte
image the DSP currently boots. Resolving this needs a full EEPROM dump (second halves require a
write, so an external programmer) or a controlled reflash-and-reread.

#### Runtime control bus
Bit-banged from MCU GPIO (block `0x50004280`: `+0x2c` data out, `+0x24` clock, `+0x20` latch,
`+0x28` data in), MSB first:

```
[cmd] [count] [address, 32-bit] [data, count × 16-bit]
cmd      0xc5 = write, 0xc8 = read
count    number of 16-bit data halfwords after the address
address  always 0xFF80_xxxx, sent high halfword first
data     32-bit values are sent low halfword first, each halfword MSB first
```

`sub_3d24(addr, value)` writes one word (`c5 02 …`, 10 bytes), `sub_45cc(buf, n)` sends raw
bytes, and reads clock in 16 bits per `sub_458c` call.

#### Parameter address map
Byte addresses within `0xFF80_xxxx` (32-bit words). Only entries traced to a handler are named.

| Address | Content | Writer |
|---------|---------|--------|
| `0x6058` / `0x605c` | mute masks (see Mute below) | `sub_2d24` and others |
| `0x6080 + 4·ch` | input gain, 8.24 | `sub_3f28` |
| `0x6090 + 4·ch` | output gain, 8.24 | `sub_3f28` |
| `0x60c0 + 4·in` | input polarity (0/1), inputs 0–3 | `sub_4308` (`0x36`) |
| `0x60d0 + 4·out` | output polarity (0/1), outputs 0–3 | `sub_4308` (`0x36`) |
| `0x60e0 + 4·out` | routing input bitmask per output (InA=1, InB=2, InC=4, InD=8) | `sub_41f4` (`0x3a`) |
| `0x60f0` | coefficient mailbox (below) | `0x2ad4` |
| `0x6800`/`0x6804` + per channel | compressor / dynamics coefficients, from channel block +0xaa..0xb0 | `sub_3dbc` (`0x30`) |
| `0x678c` | signal generator / test-tone level | `sub_2cac` (`0x39`), `sub_1688` |
| `0x63cc + 0xdc·ch` | output high-pass biquads | `0x40a8` → `sub_2eb4`, outputs 0–3 |
| `0x63f4 + 0xdc·ch` | output low-pass biquads | `0x419c` → `sub_2eb4`, outputs 0–3 |
| `0x641c + 0xdc·ch + 0x14·band` | PEQ band biquad, 7 bands | `0x42dc`, `0x100c`, `0x2392` |
| `0x677c + 4·out` | output delay in samples, passed through unchanged from `0x38` | `sub_3ec4` |
| `0x67bc` | meter block, read with `0xc8` | `0x13b6` |

Also written but not decoded: `0x6048 + 4·in` (input, written by `sub_43d8` only when `sub_1110`
returns 1), `0x673c` (touched by almost every handler, so likely a global apply/recompute trigger),
and `0x68b0`/`0x68b4` (`sub_3fbc`, in the level/crossover path). A channel's filter block is `0xdc`
bytes, i.e. 11 biquads of 5 words: 2 high-pass, 2 low-pass (from the base addresses), then the 7 PEQ
bands. Three command codes have handlers but are not in the documented set: `0x3b` (`sub_4100`),
`0x3c` (`sub_3d5c`), `0x3d` (`0x5ecc`); they look like bulk per-channel setters.

Confirmed on hardware (reversible writes to the unused Out 2, reading the `0x40` meter reply, Out 1
left untouched):

- **Routing** (`0x60e0 + 4·out`) takes effect immediately: routing In A to Out 2 made the Out 2 meter
  track In A within ~1 dB.
- The **output meter is post-mix and post-gain**: stepping Out 2's `0x34` level moved its meter by the
  set amount, and the two-segment gain curve matched the firmware within 0.5 dB from 0 to −20 dB
  (below that the meter's ~−75 dBFS floor limited the check against the quiet source, so the lower
  segment stands on the firmware math).
- **Compressor** (`0x6800`/`0x6804`): a 20:1 compressor at −48 dB on Out 2 cut its meter by ~20 dB
  relative to In A, versus ~0 dB at the stock 1:1 setting, confirming `sub_3dbc` drives the dynamics.

#### Coefficient mailbox
Every biquad goes through one 14-halfword write to `0x60f0` (`0x2ad4`):

```
c5 0e ff80 60f0 | target 0xFF80_tttt | b0 b1 b2 -a1 -a2 | 0x0000000a
```

The coefficients are normalised by a0 and the feedback terms are sign-flipped, so the DSP adds all
five products. Each is converted with `ldexpf(c, 27)` (`sub_22c`) and truncated to int32
(`sub_5f4`), i.e. **5.27 fixed-point**. A bypassed band is sent as b0 = 1.0, the rest 0.
**Inferred:** the mailbox lets the DSP copy all five coefficients at once (a "safeload") so a filter
never runs with a half-updated set; the final word (10) matches the number of coefficient halfwords.
It has the same ingredients as ADI SigmaDSP's software safeload (five data slots, a target address
and a word count, in a different order), which suggests the designers copied that idea, not the chip.

#### Number formats
All parameters are 32-bit signed fixed-point; the DSP does not take floats. The MCU scales with
`ldexp` (`sub_56c` double, `sub_22c` float) before the integer conversion:

| Scale | Format | Used for |
|-------|--------|----------|
| `2^24` | 8.24 | channel gains (`sub_6880`/`sub_6830`) and other level values (`0x2c6e`, `0x2c92`, `0x2e8e`) |
| `2^27` | 5.27 | biquad coefficients (`0x2ad4`) |
| `2^31` | 1.31 | dynamics time constants (`0x2bcc`, `0x2ce8`, `0x2dd2`, `0x2e30`) |
| `2^26` | 6.26 | one site at `0x217e`, not decoded |

#### The DSP is a Blackfin (confirmed from the live boot image)
The code read off the live boot EEPROM (`0xA6`, first halves only, see above) is **Blackfin machine
code**. This corrects an earlier conclusion in this file that excluded Blackfin; that exclusion was
drawn from the updater's payload, which is **not** the program the DSP runs (see below).

Evidence, from the `0x44–0x1a9f` region (3392 known bytes = the first 32 of every 64-byte page):

- The halfword `0xE1xx` (Blackfin `reg.L/reg.H = imm16`) is **7.4 % of all aligned halfwords** (126
  of 1696), versus ~0.5 % in random bytes and 0 % in the updater payload in every byte order.
- Those loads cluster on the pointer registers with matched low-half/high-half counts — P0.L 11 /
  P0.H 10, P1.L 16 / P1.H 14, P2.L 12 / P2.H 14 — exactly the paired `Px.L=…; Px.H=…` sequences that
  build a 32-bit pointer.
- Real control flow is present: 6 × `RTS` (`0x0010`), 12 × `LINK`/`UNLINK` (`0xE8xx`), 27 × `NOP`.
- Disassembled, short runs read as coherent code, e.g. `P0.L=0xa9a4; P0.H=0x7678; R0.L=0x984;
  R0.H=0x7638; [P0++]=R0` (load a pointer, load a value, store and post-increment).
- `bfin-elf` objdump still reports ~20 % `ILLEGAL`, but that is expected: we have only every other
  32-byte run, so instruction alignment resets wrongly at each page gap. The idiom statistics above
  do not depend on alignment and are decisive.

So the community's long-standing guess (a Blackfin, specifically the ADSP-BF592) was right about the
**instruction set**. The exact part is still open: the pointer constants seen so far build addresses
like `0x7678_a9a4`, which is not a standard ADI Blackfin memory region, and the parameter space the
MCU writes is `0xFF80_6xxx` (ADI Blackfin L1 data SRAM is `0xFF80_0000–0xFF80_7FFF`, consistent).
A 64-pin LQFP with external SDRAM is also not a catalog ADI Blackfin (those are ≥160-pin). The most
likely reading is a **Blackfin-ISA-compatible part, probably a Chinese clone**, which also fits the
deliberately sanded top. Confirming the exact part needs the full EEPROM image (second halves need a
write, so an external programmer) and/or pin tracing.

This is good news for recompiling: Blackfin has a complete open toolchain (`bfin-elf-gcc`, binutils,
gdb), so we can assemble and compile directly once the full image and its load/entry layout are known.

#### The updater payload is not the DSP program
The 15.5 KB image embedded in the updater (analysed below) is **not** Blackfin and does **not** match
the live EEPROM in any byte order (< 3 % of bytes agree, no shared 24-byte run, 0 % `0xE1xx`
idioms). What it is, and why the updater writes it to the same EEPROM region that holds Blackfin code,
is unresolved. Candidates: a different/older version, a scrambled or packed container decoded by the
boot ROM, or a data/parameter blob rather than code. Do not assume flashing it (modified or not) will
boot until this is resolved.

Structure of the updater payload (kept for reference; relevance to the running DSP is now uncertain):

- **16-bit granular.** Unrolled loops repeat with periods of 10, 12, 36, 44 and 84 bytes, and both
  halves of every 32-bit word share one per-bit entropy profile.
- Each halfword looks like a 9-bit high field plus a 7-bit low field; `9e08 xxxx` (171×) reads as a
  two-halfword move with `[9-bit source][7-bit destination]`, and `5ffe` (214×) as a filler. A ~1.4 KB
  routine at `0x1e2a` repeats at `0x25ce` with one operand per stage differing by a constant, 7 stages
  that line up with the 7 PEQ bands. These patterns are self-consistent but have no counterpart in the
  confirmed Blackfin image, so they describe the payload's own format, whatever that is.

Airbus `cpu_rec` (statistical ISA classifier, ~80 corpora) matches nothing for the updater payload in
any byte order, while correctly classifying the MCU image as ARM — consistent with the payload not
being plain code.

#### Other candidates, now moot
With the ISA confirmed as Blackfin, the earlier survey (SHARC, SigmaDSP, Cirrus, TI TAS3204, AKM,
Yamaha, NXP, Dream, NJR) is moot. For the record, Musicrown's own pages say "SHARC" for their 96 kHz
lines (DS4040II, DC48, DMH) but only "32 bit DSP" for the 48 kHz DM series this unit belongs to
([DM46](http://en.musicrown-audio.com/a/products/DSPshuzichuliqi/71.html)); no public teardown names
the part, and every "smart" chip on the board is sanded while commodity parts keep their markings.

### Teardown
Source: the diyAudio thread *"T.racks 4x4 miniDSP undressed"* (user Turbowatch2, Jan 2023,
<https://www.diyaudio.com/community/threads/t-racks-4x4-minidsp-undressed.394296/>), nine board photos.
Markings read from the original-resolution images:

| Part | Marking | Role |
|------|---------|------|
| DSP | `U8`, 64-pin LQFP, **top sanded blank** | the audio DSP; no part number recoverable |
| SDRAM | **ESMT M12L64164A** (64 Mbit, 4M×16) | DSP delay-line / working memory, 16-bit bus |
| DAC ×2 | **PCM5102** + Burr-Brown oval logo (lot `AX6684`) | the four outputs (two stereo DACs) |
| ADC ×2 | Burr-Brown oval logo, PCM-series TSSOP-20 | the four inputs (two stereo ADCs) |
| PCB | silkscreen **"4X4 DSP PCB 2017-26 REV.B"**, QC sticker "PCB A TEST OK" | 2017-era Musicrown design |

The MCU (Nuvoton NUC123) and a crystal sit near the DSP; the poster also identifies the balanced
output buffers as a Chinese "RT3609" op-amp. The pattern is consistent across every source: the
converters and SDRAM are standard, commodity silicon with intact markings, while the DSP is the one
part that is deliberately anonymized.

## Normal-mode commands used by the updater
Same framing as [`PROTOCOL.md`](../PROTOCOL.md) (`10 02 00 01 N code data… 10 03 cksum`).

| code | Use in the updater |
|------|--------------------|
| `0x10` | Reply data[0] is the **model byte**: `0x1e` = 4x4 Mini (selects the Mini image), `0x1f` = 4x4 Mini Pro. Anything else: "Invalid Unit Type", then `0x11`. |
| `0x13` | Version string. Model prefix must be `4x4MINI` / `4x4MINIPRO` and the 3 version digits must lie between a minimum and maximum that are both `010`. Otherwise "Invalid Unit Type", then `0x11`. |
| `0x08` | Sent right after `0x10` by **Mcu Prog**, after which the updater waits for `0168:0904`. Inferred: reboot into the bootloader. |
| `0x11` | Sent when aborting (bad unit, version out of range, end of Security readout). |
| `0x12`, `0x04` | Sent after a successful flash once the device is back on `0168:0821`. `0x04`'s meaning is unknown. |
| `0x53` | DSP image block: `[block_hi, block_lo, 32 bytes]`. The image is `[len_hi, len_lo]` (length 15 546) followed by the 3 886 words big-endian; blocks 0–485 are sent one per ack. The device stores them in the DSP's boot EEPROM (see "Boot path"). |
| `0xa8` | **Security** readout: request `[page]` for pages 0–10; reply `[page, data…]`, stored at `page·50`. Pages 0–9 carry 50 bytes and page 10 carries 12, a 512-byte block in total. Then `0x11`. |
| `0x1a` | Sent once, on the first `0xa8` reply, built from the arguments `(1, 0, 1, 0)` (purpose unknown). |

## Bootloader (ISP) protocol
Used on `0168:0904`. It follows the Nuvoton ISP sequence with remapped command bytes.

**Request**: one raw 70-byte buffer (no DLE framing), little-endian fields; bytes not listed are 0.

| Offset | Field |
|--------|-------|
| 0 | command byte |
| 4 | u32 packet sequence number (1 on Connect, incremented per packet) |
| 8 | payload |

**Reply**: `[u32 checksum][payload…]`. The checksum must equal the byte-sum of the 70-byte
request, otherwise the updater aborts.

| Step | cmd | UI text | Payload / reply |
|------|-----|---------|-----------------|
| 1 | `0x80` | Connect | – |
| 2 | `0x81` | Sync Package | – |
| 3 | `0x82` | Get Firmware Version | reply[4] = bootloader version byte |
| 4 | `0x83` | Get Device ID | reply[4..7] = u32 device ID |
| 5 | `0x84` | Read Config | reply[4..7], reply[8..11] = two u32 config words |
| 6 | `0x81` | Sync Program | – |
| 7 | `0x85` | Start Program | `+8` u32 start address (0) · `+12` u32 image length · `+16` first 48 image bytes |
| 8 | `0x00` | Mcu Programing | `+8` next 56 image bytes; repeated until the length is reached |
| 9 | `0x86` | MCU Reset | then "Program OK" |

`0x88` ("Erase All") is implemented but no code path selects it.

Image length is the number of data bytes in the selected HEX file (43 608 for the Pro image).
The updater sends buffer bytes `[0, length)`, so for these images the trailing `PowerDsp` record
at `0x10DF8` is loaded but never transmitted.

## Application firmware internals (Pro MCU image)
Static analysis of the decoded 4x4 Mini Pro image (`4x4MINIPRO V010 20230106A`, data
`0x0000–0xAA4F`), to settle the open encoding questions in [`PROTOCOL.md`](../PROTOCOL.md).
Addresses below are offsets inside that image. Nothing was executed.

### Command dispatch
The USB report lands in a RAM receive buffer at `0x200004fe`: byte 5 is the command code and
byte 6 onward is the payload, matching the on-wire frame `10 02 00 01 N code data…`. The
dispatcher (`0x5ace`) selects a handler through two Thumb jump tables (helper at `0x6d00`),
one for codes `0x04–0x2e` and one for `0x30–0x3e`. Replies are assembled in a transmit buffer
at `0x2000047e` (`+4` = code, `+5` = first data byte) and sent by `sub_6248(len)`. Writes ack
with code `0x01` (`sub_6324`); an unknown code answers `0x02` (`sub_64ac`). This is exactly the
query/ack/NAK behaviour the project already documents.

Per-channel parameters live in a RAM block at `0x20000290`, 50 (`0x32`) bytes per channel.
Channel reads (`0x27`/`0x28`) return that block for outputs (channel `< 9`) and a shorter
20/30-byte slice for inputs; mute is **not** in this block.

### PEQ band (`0x33`) coefficient math
The biquad builder at `0x3264` takes `(gainRaw, freqIdx, qRaw, type)` and computes, in IEEE-754
doubles (literals read from the pool):

- Gain: `gainDb = (gainRaw - 120) / 10`, then peaking amplitude `A = 10^(gainDb/20)`.
- Frequency: `f = 1000 · 1.023373^(freqIdx - 170)`, i.e. `f = 19.72 · 2^(freqIdx/30)`. This
  matches the app's `peqIndexToHz = 19.7 · 2^(i/30)`.
- **Q (settles the open gap):** the firmware forms `1/Q = 1.0594^(100 - qRaw) / 128`, so
  `Q = 128 / 1.0594^(100 - qRaw) ≈ 2^((qRaw - 16) / 12)`. It is an **exponential** encoding:
  `qRaw = 16` gives `Q = 1.0`, each +12 counts doubles Q, and `qRaw = 100` gives `Q = 128`.

  The web app's `rawToQ = raw / 10` (and `qToRaw = round(q·10)`) is linear and does **not**
  match. The factory default `FACTORY_Q_RAW = 25` is read by the device as `Q ≈ 1.69`, not the
  `2.5` the app assumes. The correct inverse is `qRaw = round(100 - log(128/Q) / log(1.0594))`.

The `1.0594` constant is the firmware's stored value for `2^(1/12)`; using it verbatim
reproduces the device exactly (it drifts up to ~0.4 % from the clean `2^((raw-16)/12)` form).

### Channel level (`0x34`) gain curve
Code `0x34` is the 5th entry of the `0x30–0x3e` byte table at `0x5c01` (byte `0xef`, stub
`0x5dde`), which calls `sub_3f28(chan, raw16)`. For every channel in the link mask returned by
`sub_ea4(chan)`, inputs convert the raw value with `sub_6880` and write it to DSP address
`0x6080 + 4·ch`; outputs use `sub_6830` (byte-identical) and `0x6090 + 4·ch`. The raw value is
also stored in the channel block at `0x20000290` (`+0x22` inputs, `+0xb2` outputs).

The converter is two-segment:

- `raw >= 80`: `x = raw - 280`
- `raw < 80`: `x = 5·raw - 600`
- `gain = 10^(x / 200) · 2^24` (8.24 fixed-point; literals `200.0`, `10.0`), and `raw == 0`
  is forced to `0` (hard mute).

So `dB = (raw - 280) / 10` from -20 to +12 dB (0.1 dB/step) and `dB = raw/2 - 60` below
-20 dB (0.5 dB/step). Up to commit `2ebc829` the app used the first formula over the whole range,
so any level below -20 dB was cut much harder than displayed (e.g. -25 dB was sent as raw 30 =
-45 dB), and its -28 dB minimum was sent as raw 0, which mutes the channel.

### Level meters (`0x40`)
The meter loop at `0x13b6` sends a read request (`c8 13 ff80 67bc`) over the control bus, then clocks in
nine 32-bit words with `sub_458c` (16 bits per call, low half first) into `0x200001e8`. If word 0
(a status word) is `<= 0xff`, the set is copied to `0x2000020c`: word 0 is the status, words 1–8
are the eight channel levels (In A–D, Out 1–4), passed through unchanged from the DSP.

The `0x40` handler (`0x5fce`) reads those words via `sub_4570(ch)` and packs each into 3 reply
bytes as `[bits23..16, bits31..24, bits15..8]`, dropping bits 7..0. It then appends the status
word's low byte and two GPIO reads (`0x500042c0`, `0x500042c4`), 28 bytes in total.

The words are linear amplitude with full scale `2^24` (the DSP's 8.24 format). On hardware with
programme audio on In A routed to Out 1 at 0 dB, the decoded Out 1 level matched In A within
+0.25 dB (median of 115 paired samples), and idle channels sat at −87 dBFS (inputs) and
−75.5 dBFS (outputs). The absolute full-scale reference is inferred from the 8.24 format and not
yet checked against a known-level signal.

### Dynamics (`0x30`/`0x31`/`0x32`) time and ratio encoding
- **Time (settles the open gap):** the attack/release converter `sub_2c34` evaluates
  `48000 · (raw + 1) / 1000`, so the on-wire time in **milliseconds is `raw + 1`**. The app now
  applies this (`timeMsToRaw`/`timeRawToMs`) instead of passing the raw byte through unchanged.
- **Ratio:** the compressor ratio index selects from a 15-entry table at `0xa52c`:
  `1.0, 1.1, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0, 10.0, 20.0`. This matches
  the app's ratio list.

### Mute (`0x35`) has no readback (settles the open gap)
The mute handler `sub_2d24(channel, on)` keeps state in two RAM half-words, `0x20000428`
(outputs, bits for channels 0–3) and `0x2000042a` (inputs, channels 4–7), applies the channel
link mask from `sub_ea4`, pushes the result to the DSP coefficient pair `0x6058`/`0x605c`, and
persists it via `sub_17d4`. No command handler ever copies these half-words into a reply, so the
device offers no mute query. The app's "no mute readback" note is correct; mute must be tracked
host-side.

### Presets and security
- 30 preset slots. Each preset is a 450-byte (`0x1c2`) record in the external I2C EEPROM; the
  record holds a "used" flag and a 14-byte name at offset `+2`. The occupancy block query
  (`0x22`) returns the 30 used-flags; the name query (`0x29`) returns `[slot, 14-byte name]`,
  falling back to `"Default Preset"` when the flag is clear. Recall is `0x20`, store is `0x21`,
  active slot is tracked at `0x20000120` and persisted to store address 1.
- The unlock handler (`0x2d`) compares four payload bytes against ASCII `"8841"`
  (`0x38 0x38 0x34 0x31`). The Security readout's final page additionally reads EEPROM bytes
  `0x40–0x43`.

## Reproducing
- MCU images: take the NUL-separated lines starting at file offset `0x9FF63` and split at each
  `:00000001FF` EOF record.
- DSP image: read 3 886 little-endian dwords at file offset `0x9C250` and write each one
  big-endian.
