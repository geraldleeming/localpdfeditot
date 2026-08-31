import type { EditObj } from './types.ts';

/**
 * The edit journal: an ordered list of the objects the user has added, plus
 * undo/redo.
 *
 * The original PDF bytes are never mutated. Every one of the app's four actions
 * is a mutation of this list:
 *
 *   add text       -> add({ kind: 'text', ... })
 *   remove text    -> remove(id)
 *   add signature  -> add({ kind: 'sig', ... })
 *   remove signature -> remove(id)
 *
 * History is snapshot-based rather than a command stack. Objects are small and
 * few (tens, not thousands), so cloning the array on each committed change is
 * cheaper in complexity than maintaining invertible commands — and it makes
 * "remove" genuinely trivial.
 *
 * Drags and resizes must NOT call `update` per pointermove. The UI moves the
 * DOM node imperatively while the gesture is live and commits once on
 * pointerup, so history stays meaningful and we never re-render mid-gesture.
 */

const HISTORY_LIMIT = 100;

export type JournalListener = (objects: readonly EditObj[]) => void;

export class Journal {
  private objects: EditObj[] = [];
  private past: EditObj[][] = [];
  private future: EditObj[][] = [];
  private listeners = new Set<JournalListener>();

  subscribe(fn: JournalListener): () => void {
    this.listeners.add(fn);
    fn(this.objects);
    return () => this.listeners.delete(fn);
  }

  all(): readonly EditObj[] {
    return this.objects;
  }

  forPage(pageIndex: number): EditObj[] {
    return this.objects.filter((o) => o.page === pageIndex);
  }

  get(id: string): EditObj | undefined {
    return this.objects.find((o) => o.id === id);
  }

  get isEmpty(): boolean {
    return this.objects.length === 0;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  add(obj: EditObj): void {
    this.commit([...this.objects, obj]);
  }

  update<T extends EditObj>(id: string, patch: Partial<T>): void {
    let changed = false;
    const next = this.objects.map((o) => {
      if (o.id !== id) return o;
      changed = true;
      return { ...o, ...patch } as EditObj;
    });
    if (changed) this.commit(next);
  }

  remove(id: string): void {
    const next = this.objects.filter((o) => o.id !== id);
    if (next.length !== this.objects.length) this.commit(next);
  }

  /** Replace the whole list without touching history — used when loading a file. */
  reset(objects: EditObj[]): void {
    this.objects = objects;
    this.past = [];
    this.future = [];
    this.emit();
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.objects);
    this.objects = previous;
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.objects);
    this.objects = next;
    this.emit();
  }

  private commit(next: EditObj[]): void {
    this.past.push(this.objects);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
    this.objects = next;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.objects);
  }
}
