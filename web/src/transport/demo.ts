// The demo device: the simulated DSP of mock.ts plus the state its meters depend on
// (gain, mute, routing, test tone), so the levels react to edits like the real unit's.
// Every preset slot holds the demo preset; a recall puts the state back to it.
import { MockDsp, type MockDspOptions, type MockReply } from "./mock.ts";
import { defaultPresetPages } from "./factory-pages.ts";
import { meterLevels, type DemoMix } from "./demoLevels.ts";
import { Command, ToneSource } from "../protocol/commands.ts";
import { gainRawToDb } from "../protocol/control.ts";
import { parsePresetImage, reconstructPresetImage } from "../protocol/readback.ts";

const PAGE_SIZE = 50;
const CHANNEL_COUNT = 8;
const OUT_BASE = 4;
/** Routing bytes of Out 3 and Out 4 in the preset image (output records at 260 and 334, routing at +8). */
const DEMO_ROUTING = [{ offset: 268, mask: 0b0011 }, { offset: 342, mask: 0b0011 }];
const LEVEL_INTERVAL_MS = 100;
const SLOW_COMMAND_LATENCY_MS = { [Command.RECALL_PRESET]: 660, [Command.STORE_PRESET]: 2200 };

/** The factory preset image with Out 3 and Out 4 fed from In A + In B, as nine channel pages. */
export function demoPresetPages(): Uint8Array[] {
  const image = reconstructPresetImage(defaultPresetPages());
  for (const { offset, mask } of DEMO_ROUTING) image[offset] = mask;
  return Array.from({ length: image.length / PAGE_SIZE }, (_, i) => image.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
}

function mixFromPages(pages: Uint8Array[]): DemoMix {
  const preset = parsePresetImage(reconstructPresetImage(pages));
  const records = [...preset.inputs, ...preset.outputs];
  return {
    gainsDb: records.map((record) => gainRawToDb(record.gainRaw)),
    mutes: records.map(() => false),
    routing: preset.outputs.map((output) => output.routingMask),
    toneOn: false,
  };
}

export class DemoDsp extends MockDsp {
  readonly productName: string = "Demo DSP";
  readonly simulated = true;
  mix: DemoMix;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MockDspOptions = {}) {
    super({ latencyMs: options.latencyMs ?? SLOW_COMMAND_LATENCY_MS });
    this.pages = demoPresetPages();
    this.mix = mixFromPages(this.pages);
    this.refreshLevels();
  }

  async open(): Promise<void> {
    await super.open();
    this.timer ??= setInterval(() => this.refreshLevels(), LEVEL_INTERVAL_MS);
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await super.close();
  }

  protected answer(code: number, data: Uint8Array): MockReply | null {
    this.apply(code, data);
    return super.answer(code, data);
  }

  private apply(code: number, data: Uint8Array): void {
    const chan = data[0] ?? 0;
    switch (code) {
      case Command.LEVEL:
        if (chan < CHANNEL_COUNT) this.mix.gainsDb[chan] = gainRawToDb((data[1] ?? 0) | ((data[2] ?? 0) << 8));
        break;
      case Command.MUTE:
        if (chan < CHANNEL_COUNT) this.mix.mutes[chan] = data[1] !== 0;
        break;
      case Command.ROUTING:
        if (chan >= OUT_BASE && chan < CHANNEL_COUNT) this.mix.routing[chan - OUT_BASE] = data[1] ?? 0;
        break;
      case Command.TEST_TONE:
        this.mix.toneOn = chan !== ToneSource.OFF;
        break;
      case Command.RECALL_PRESET:
        this.mix = mixFromPages(this.pages);
        break;
      default:
        return;
    }
    this.refreshLevels();
  }

  private refreshLevels(): void {
    this.levels = meterLevels(this.mix, Date.now());
  }
}
