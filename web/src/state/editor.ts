// The single edit path. Every change is normalized to the device's resolution,
// mirrored to a linked output, recorded for undo, applied to the model and sent;
// each parameter's delivery is tracked (absent from `sync` = the device has it).
//
// The state object is injected so the Svelte store can pass a reactive $state
// proxy while tests pass a plain object.
import type { Dsp } from "../dsp.ts";
import type { Calibration } from "../eq/calibration.ts";
import { ProtocolError } from "../transport/channel.ts";
import { History, type Change } from "./history.ts";
import { BAND_COUNT, OUT_BASE, CHANNEL_COUNT, clone, sameValue, type DeviceModel } from "./model.ts";
import {
  allParams, describeParam, normalizeParam, paramKey, readParam, sendParam, writeParam,
  ParamError, type ParamAssignment, type ParamKind, type ParamRef, type ParamValue,
} from "./params.ts";

export type SyncStatus = "pending" | "failed" | "offline";
export interface SyncEntry { status: SyncStatus; error?: string }

export interface EditorState {
  model: DeviceModel;
  /** Parameters not (yet) confirmed by the device, by paramKey. */
  sync: Record<string, SyncEntry>;
  /** Output EQ links, symmetric: links[a] = b and links[b] = a. */
  links: Record<number, number>;
  /** Edited since the last device readback or preset store. */
  modified: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface EditorDeps {
  dsp(): Dsp | null;
  cal: Calibration;
  onError(label: string, error: unknown): void;
  now?(): number;
  /** Channel name for undo and error labels (default: the model's channel name). */
  channelName?(ch: number): string;
}

type Value = ParamValue | null;

const EQ_KINDS: ReadonlySet<ParamKind> = new Set(["peq", "hpf", "lpf"]);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const allSucceeded = async (sends: Promise<boolean>[]) => (await Promise.all(sends)).every(Boolean);

export function createEditorState(model: DeviceModel): EditorState {
  return { model, sync: {}, links: {}, modified: false, undoLabel: null, redoLabel: null };
}

export function eqParams(ch: number): ParamRef[] {
  const refs: ParamRef[] = [{ kind: "hpf", ch }, { kind: "lpf", ch }];
  for (let band = 0; band < BAND_COUNT; band++) refs.push({ kind: "peq", ch, band });
  return refs;
}

export class Editor {
  private readonly state: EditorState;
  private readonly deps: EditorDeps;
  private readonly history: History<Value>;
  private readonly refsByKey = new Map<string, ParamRef>(allParams().map((ref) => [paramKey(ref), ref]));
  private readonly sendTokens = new Map<string, number>();
  private sendSequence = 0;

  constructor(state: EditorState, deps: EditorDeps) {
    this.state = state;
    this.deps = deps;
    this.history = new History<Value>({ now: deps.now });
  }

  get(ref: ParamRef): Value {
    return readParam(this.state.model, ref);
  }

  /** Name used in labels for a channel address. */
  readonly nameOf = (ch: number): string => this.deps.channelName?.(ch) ?? this.state.model.channels[ch]?.name ?? "";

  /** A user edit. Consecutive edits of the same parameter merge into one undo step unless merge is false. */
  set(ref: ParamRef, value: ParamValue, options: { label?: string; merge?: boolean } = {}): Promise<boolean> {
    const normalized = normalizeParam(ref, value, this.deps.cal);
    const sends: Promise<boolean>[] = [];
    const changes = this.linkedRefs(ref).flatMap((target) => this.apply(target, normalized, sends));
    if (changes.length === 0) return Promise.resolve(true);
    const label = options.label ?? describeParam(ref, this.nameOf);
    this.history.record(label, changes, options.merge === false ? undefined : paramKey(ref));
    this.touch();
    return allSucceeded(sends);
  }

  /** Several edits as one undo step (copy EQ, file import, group actions). With a merge key,
   *  consecutive calls with the same key extend that step until seal(). Null values are left untouched. */
  setMany(label: string, assignments: ParamAssignment[], options: { mergeKey?: string } = {}): Promise<boolean> {
    const normalized = assignments
      .filter((assignment) => assignment.value !== null)
      .map(({ ref, value }) => ({ ref, value: normalizeParam(ref, value as ParamValue, this.deps.cal) }));
    const sends: Promise<boolean>[] = [];
    const changes = normalized.flatMap(({ ref, value }) => this.apply(ref, value, sends));
    if (changes.length === 0) return Promise.resolve(true);
    this.history.record(label, changes, options.mergeKey);
    this.touch();
    return allSucceeded(sends);
  }

  undo(): Promise<boolean> {
    const entry = this.history.undo();
    return entry ? this.restore(entry.changes, "before") : Promise.resolve(true);
  }

  redo(): Promise<boolean> {
    const entry = this.history.redo();
    return entry ? this.restore(entry.changes, "after") : Promise.resolve(true);
  }

  /** End the current gesture (pointer up): the next edit starts a new undo step. */
  seal(): void {
    this.history.seal();
  }

  /** Copy one output's EQ (crossovers + 7 bands) onto another. */
  copyEq(src: number, dst: number, label?: string): Promise<boolean> {
    this.requireOutput(src);
    this.requireOutput(dst);
    const assignments = eqParams(dst).map((ref) => ({ ref, value: this.get({ ...ref, ch: src }) }));
    return this.setMany(label ?? `Copy EQ ${this.nameOf(src)} → ${this.nameOf(dst)}`, assignments);
  }

  /** Link two outputs' EQ (b takes a's EQ now; later edits to either mirror to the other). */
  link(a: number, b: number): Promise<boolean> {
    this.requireOutput(a);
    this.requireOutput(b);
    if (a === b) throw new ParamError("an output cannot be linked to itself");
    this.unlink(a);
    this.unlink(b);
    this.state.links = { ...this.state.links, [a]: b, [b]: a };
    return this.copyEq(a, b, `Link EQ ${this.nameOf(a)} + ${this.nameOf(b)}`);
  }

  unlink(ch: number): void {
    const partner = this.state.links[ch];
    if (partner === undefined) return;
    const links = { ...this.state.links };
    delete links[ch];
    delete links[partner];
    this.state.links = links;
  }

  /** Replace the model with what the device reports. Clears history and sync state. */
  load(model: DeviceModel): void {
    this.state.model = clone(model);
    this.state.sync = {};
    this.sendTokens.clear();
    this.history.clear();
    this.state.modified = false;
    this.refreshLabels();
  }

  /** The live state was stored into a preset slot. */
  markStored(): void {
    this.state.modified = false;
  }

  /** Re-send every parameter whose delivery failed or happened while offline. */
  resendUnsynced(): Promise<boolean> {
    const keys = Object.keys(this.state.sync).filter((key) => this.state.sync[key]!.status !== "pending");
    return allSucceeded(keys.map((key) => this.send(this.refsByKey.get(key)!)));
  }

  private apply(ref: ParamRef, value: Value, sends: Promise<boolean>[]): Change<Value>[] {
    const before = clone(this.get(ref));
    if (sameValue(before, value)) return [];
    writeParam(this.state.model, ref, clone(value));
    sends.push(this.send(ref));
    return [{ key: paramKey(ref), before, after: clone(value) }];
  }

  private restore(changes: Change<Value>[], side: "before" | "after"): Promise<boolean> {
    const sends = changes.map((change) => {
      const ref = this.refsByKey.get(change.key)!;
      writeParam(this.state.model, ref, clone(change[side]));
      return this.send(ref);
    });
    this.touch();
    return allSucceeded(sends);
  }

  private send(ref: ParamRef): Promise<boolean> {
    const key = paramKey(ref);
    const value = this.get(ref);
    if (value === null) {
      delete this.state.sync[key]; // unknown (e.g. mute after connect): nothing to send
      return Promise.resolve(true);
    }
    const dsp = this.deps.dsp();
    if (!dsp) {
      this.state.sync[key] = { status: "offline" };
      return Promise.resolve(false);
    }
    const token = ++this.sendSequence;
    this.sendTokens.set(key, token);
    this.state.sync[key] = { status: "pending" };
    const snapshot = clone(value);
    return Promise.resolve()
      .then(() => sendParam(dsp, ref, snapshot, this.deps.cal))
      .then(
        () => {
          if (this.sendTokens.get(key) === token) {
            this.sendTokens.delete(key);
            delete this.state.sync[key];
          }
          return true;
        },
        (error: unknown) => {
          if (this.sendTokens.get(key) !== token) return false;
          this.sendTokens.delete(key);
          if (error instanceof ProtocolError && error.kind === "closed") {
            this.state.sync[key] = { status: "offline" };
          } else {
            this.state.sync[key] = { status: "failed", error: messageOf(error) };
            this.deps.onError(describeParam(ref, this.nameOf), error);
          }
          return false;
        },
      );
  }

  private linkedRefs(ref: ParamRef): ParamRef[] {
    const partner = EQ_KINDS.has(ref.kind) ? this.state.links[ref.ch] : undefined;
    return partner === undefined ? [ref] : [ref, { ...ref, ch: partner }];
  }

  private requireOutput(ch: number): void {
    if (ch < OUT_BASE || ch >= CHANNEL_COUNT) throw new ParamError(`channel ${ch} is not an output`);
  }

  private touch(): void {
    this.state.modified = true;
    this.refreshLabels();
  }

  private refreshLabels(): void {
    this.state.undoLabel = this.history.undoLabel;
    this.state.redoLabel = this.history.redoLabel;
  }
}
