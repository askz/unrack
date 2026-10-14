// Undo/redo stack of parameter changes. Consecutive edits to the same parameter
// within the merge window collapse into one entry (a fader or EQ-handle drag is a
// single undo step); seal() ends a gesture explicitly.

export interface Change<V> {
  key: string;
  before: V;
  after: V;
}

export interface HistoryEntry<V> {
  label: string;
  changes: Change<V>[];
  mergeKey?: string;
  lastAt: number;
}

export interface HistoryOptions<V> {
  limit?: number;
  mergeWindowMs?: number;
  now?: () => number;
  /** Value equality; when a group ends, its changes that came back to their start are dropped. */
  same?: (a: V, b: V) => boolean;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MERGE_WINDOW_MS = 1000;

export class History<V> {
  private readonly undoStack: HistoryEntry<V>[] = [];
  private readonly redoStack: HistoryEntry<V>[] = [];
  private readonly limit: number;
  private readonly mergeWindowMs: number;
  private readonly now: () => number;
  private readonly same: (a: V, b: V) => boolean;
  private sealed = true;
  private group: { label: string; entry: HistoryEntry<V> | null } | null = null;

  constructor(options: HistoryOptions<V> = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.same = options.same ?? ((a, b) => Object.is(a, b));
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get grouping(): boolean {
    return this.group !== null;
  }

  /** Until endGroup(), every record joins one entry with this label, whatever its merge key or timing. */
  beginGroup(label: string): void {
    this.group = { label, entry: null };
    this.sealed = true;
  }

  /** Close the group: changes back at their start value are dropped, an entry left empty is removed. */
  endGroup(): void {
    const entry = this.group?.entry ?? null;
    this.group = null;
    this.sealed = true;
    if (!entry) return;
    entry.changes = entry.changes.filter((change) => !this.same(change.before, change.after));
    if (entry.changes.length === 0 && this.undoStack[this.undoStack.length - 1] === entry) this.undoStack.pop();
  }

  /** Record changes. With a mergeKey, extends the previous entry if it is the same ongoing edit. */
  record(label: string, changes: Change<V>[], mergeKey?: string): void {
    if (changes.length === 0) return;
    const at = this.now();
    this.redoStack.length = 0;
    if (this.group) {
      if (this.group.entry) this.merge(this.group.entry, changes, at);
      else this.group.entry = this.push({ label: this.group.label, changes: [...changes], lastAt: at });
      return;
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && !this.sealed && mergeKey !== undefined && top.mergeKey === mergeKey && at - top.lastAt <= this.mergeWindowMs) {
      this.merge(top, changes, at);
      return;
    }
    this.push({ label, changes, mergeKey, lastAt: at });
    this.sealed = mergeKey === undefined;
  }

  /** End the current gesture: the next edit starts a new entry even within the merge window. */
  seal(): void {
    this.sealed = true;
  }

  /** Undo and redo end an open group. */
  undo(): HistoryEntry<V> | undefined {
    this.group = null;
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    this.sealed = true;
    return entry;
  }

  redo(): HistoryEntry<V> | undefined {
    this.group = null;
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    this.sealed = true;
    return entry;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.group = null;
    this.sealed = true;
  }

  private push(entry: HistoryEntry<V>): HistoryEntry<V> {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    return entry;
  }

  private merge(entry: HistoryEntry<V>, changes: Change<V>[], at: number): void {
    for (const change of changes) {
      const existing = entry.changes.find((c) => c.key === change.key);
      if (existing) existing.after = change.after;
      else entry.changes.push(change);
    }
    entry.lastAt = at;
  }
}
