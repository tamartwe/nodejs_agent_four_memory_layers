/**
 * L1 — the token accountant.
 *
 * Working memory owns the arithmetic that keeps L2 honest. You cannot know the exact
 * token count of a payload before you send it, so we budget to `headroom` and correct
 * the estimate at commit time.
 */
export class TokenBudget {
  private spent = 0;
  private readonly reservations = new Map<string, number>();

  constructor(
    readonly max: number,
    private readonly headroom = 0.9,
  ) {}

  get limit(): number {
    return Math.floor(this.max * this.headroom);
  }

  get used(): number {
    return this.spent;
  }

  get available(): number {
    return this.limit - this.spent;
  }

  /** Reserve before you build the payload. Returns false instead of throwing: callers evict. */
  reserve(key: string, estimate: number): boolean {
    if (estimate > this.available) return false;
    this.reservations.set(key, estimate);
    this.spent += estimate;
    return true;
  }

  /** Correct the estimate once the true count is known. Never double-counts. */
  commit(key: string, actual: number): void {
    const est = this.reservations.get(key) ?? 0;
    this.spent += actual - est;
    this.reservations.delete(key);
  }

  release(key: string): void {
    this.spent -= this.reservations.get(key) ?? 0;
    this.reservations.delete(key);
  }

  reset(): void {
    this.spent = 0;
    this.reservations.clear();
  }
}
