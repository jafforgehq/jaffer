/** Tiny typed event emitter; avoids pulling EventEmitter's loose typing into the core. */
export class Emitter<T> {
  private handlers = new Set<(v: T) => void>();
  on(fn: (v: T) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  emit(v: T): void {
    for (const h of [...this.handlers]) {
      try {
        h(v);
      } catch {
        /* a listener must never break the emitter */
      }
    }
  }
  get size(): number {
    return this.handlers.size;
  }
}
