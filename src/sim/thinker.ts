// Generic thinker list (p_tick.c semantics): a doubly-linked list run
// once per tic in insertion order. Thinkers appended during the tic run
// in the same tic; removed thinkers are unlinked lazily. Execution order
// is part of determinism — never reorder.

export interface Thinker {
  tprev: Thinker | null;
  tnext: Thinker | null;
  removed: boolean;
  think(): void;
}

export class ThinkerList {
  head: Thinker | null = null;
  tail: Thinker | null = null;
  count = 0;

  add(t: Thinker): void {
    t.tnext = null;
    t.tprev = this.tail;
    if (this.tail) this.tail.tnext = t;
    else this.head = t;
    this.tail = t;
    this.count++;
  }

  private unlink(t: Thinker): void {
    if (t.tprev) t.tprev.tnext = t.tnext;
    else this.head = t.tnext;
    if (t.tnext) t.tnext.tprev = t.tprev;
    else this.tail = t.tprev;
    this.count--;
  }

  /** P_RunThinkers: advance via tnext AFTER thinking (tail appends run). */
  run(): void {
    let t = this.head;
    while (t) {
      if (t.removed) {
        const next = t.tnext;
        this.unlink(t);
        t = next;
        continue;
      }
      t.think();
      t = t.tnext;
    }
  }

  *[Symbol.iterator](): IterableIterator<Thinker> {
    for (let t = this.head; t; t = t.tnext) {
      if (!t.removed) yield t;
    }
  }
}
