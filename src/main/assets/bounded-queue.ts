/**
 * A bounded work queue.
 *
 * Capture ingestion is the one place in Blossom where an unbounded producer
 * (a client loading a busy experience) meets a slower consumer (hashing and
 * indexing). An unbounded queue there would turn a heavy place into an
 * out-of-memory crash, so the queue has a ceiling and drops the oldest item
 * when it is reached — and, crucially, reports every drop rather than hiding it.
 */
export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private draining = false;
  private droppedCount = 0;
  private processedCount = 0;

  constructor(
    private readonly capacity: number,
    private readonly worker: (item: T) => Promise<void>,
    private readonly onDrop?: (item: T, totalDropped: number) => void
  ) {}

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get processed(): number {
    return this.processedCount;
  }

  /** Returns false when the push displaced an older item. */
  push(item: T): boolean {
    if (this.items.length >= this.capacity) {
      const evicted = this.items.shift();
      this.droppedCount += 1;
      if (evicted !== undefined) this.onDrop?.(evicted, this.droppedCount);
      this.items.push(item);
      void this.drain();
      return false;
    }
    this.items.push(item);
    void this.drain();
    return true;
  }

  /**
   * Processes items one at a time. Serial by design: parallel hashing of a
   * hundred assets at once would starve the rest of the process for no gain on
   * a disk-bound workload.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length) {
        const item = this.items.shift();
        if (item === undefined) continue;
        try {
          await this.worker(item);
          this.processedCount += 1;
        } catch {
          // A failed item is dropped, never retried forever, and never allowed
          // to stop the queue.
          this.droppedCount += 1;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Resolves once the queue is empty. */
  async idle(): Promise<void> {
    while (this.items.length || this.draining) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  resetCounters(): void {
    this.droppedCount = 0;
    this.processedCount = 0;
  }
}
