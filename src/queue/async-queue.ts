/**
 * Promise-based mutual exclusion lock.
 *
 * **Non-reentrant** – calling `run()` from within a `run()` callback on the
 * same instance will deadlock. Design callers so that nested locking is
 * never required.
 */
export class AsyncMutex {
	private locked = false;
	private waiting: (() => void)[] = [];

	/** Acquire the lock. Resolves when the lock is available. */
	private async acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true;
			return;
		}
		return new Promise<void>((resolve) => {
			this.waiting.push(resolve);
		});
	}

	/**
	 * Release the lock, allowing the next waiter to proceed.
	 *
	 * @throws {Error} If the lock is not currently held.
	 */
	private release(): void {
		if (!this.locked) {
			throw new Error("AsyncMutex.release() called while not locked");
		}
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.locked = false;
		}
	}

	/**
	 * Execute a callback while holding the lock.
	 *
	 * The lock is always released after `fn` settles, even if it throws.
	 * Accepts both synchronous and asynchronous callbacks.
	 */
	async run<T>(fn: () => T | Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	/** Check if the lock is currently held. */
	get isLocked(): boolean {
		return this.locked;
	}
}

/**
 * Promise-based concurrency pool.
 *
 * Allows up to `concurrency` tasks to run simultaneously.
 * Additional tasks wait until a slot becomes available.
 */
export class AsyncPool {
	private running = 0;
	private waiting: (() => void)[] = [];

	constructor(private readonly concurrency: number) {
		if (concurrency < 1) {
			throw new Error("AsyncPool: concurrency must be at least 1");
		}
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.running >= this.concurrency) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.running++;
		try {
			return await fn();
		} finally {
			this.running--;
			const next = this.waiting.shift();
			if (next) next();
		}
	}
}

/** Tuning for an {@link AdaptivePool}: bounds + ramp cadence. */
export interface AdaptivePoolOpts {
	/** Lower bound the limit can never drop below (must be >= 1). */
	min: number;
	/** Initial limit (clamped into [min, max]). */
	start: number;
	/** Upper bound the limit can never rise above. */
	max: number;
	/** Raise the limit by 1 after this many consecutive clean (resolved) runs. */
	rampAfter: number;
}

/**
 * Concurrency pool with an AIMD (additive-increase / multiplicative-decrease)
 * limit: it ramps the in-flight ceiling up on sustained success and halves it on a
 * rate-limit signal. Used for the transfer phase so a large initial/bulk sync
 * discovers the provider's sustainable throughput instead of running at a fixed
 * (possibly too-low, or too-high and 429-prone) concurrency.
 *
 * Differences from {@link AsyncPool} that are load-bearing:
 *  - the limit is MUTABLE, so a woken waiter must RE-CHECK it in a `while` loop —
 *    a single `if` is only correct for a fixed limit; after a halving a waiter
 *    could otherwise wake into an over-limit pool and silently defeat throttling;
 *  - the success streak advances only on a RESOLVED run and resets on a rejected
 *    one, so the pool never ramps up while tasks are failing.
 */
export class AdaptivePool {
	private _running = 0;
	private waiting: (() => void)[] = [];
	private _limit: number;
	private successStreak = 0;
	private readonly min: number;
	private readonly max: number;
	private readonly rampAfter: number;

	constructor(opts: AdaptivePoolOpts) {
		if (opts.min < 1) throw new Error("AdaptivePool: min must be at least 1");
		if (opts.max < opts.min) throw new Error("AdaptivePool: max must be >= min");
		if (opts.rampAfter < 1) throw new Error("AdaptivePool: rampAfter must be at least 1");
		this.min = opts.min;
		this.max = opts.max;
		this.rampAfter = opts.rampAfter;
		this._limit = Math.min(this.max, Math.max(this.min, opts.start));
	}

	/** Current in-flight ceiling (observability/tests). */
	get limit(): number {
		return this._limit;
	}

	/** Tasks currently running (observability/tests). */
	get running(): number {
		return this._running;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		// The limit is mutable; re-check after every wake (a halving may have
		// dropped it below `running` while this waiter was queued).
		while (this._running >= this._limit) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this._running++;
		try {
			const result = await fn();
			// Success accounting on the resolved path only — a failed run must not
			// count toward ramp-up.
			this.successStreak++;
			if (this.successStreak >= this.rampAfter && this._limit < this.max) {
				this._limit++;
				this.successStreak = 0;
				// Newly-created headroom may admit a waiter.
				this.waiting.shift()?.();
			}
			return result;
		} catch (err) {
			// A rejected run breaks the clean streak (don't ramp up while failing).
			this.successStreak = 0;
			throw err;
		} finally {
			this._running--;
			if (this._running < this._limit) this.waiting.shift()?.();
		}
	}

	/**
	 * Signal a rate-limit hit: multiplicatively decrease the limit (floor `min`)
	 * and reset the success streak. Call this BEFORE backing off (sleeping) so the
	 * decrease takes effect immediately. Does not wake waiters — shrinking can only
	 * reduce admissions, never enable one.
	 *
	 * Coalesces a burst into ONE decrease per episode: while the pool is still above
	 * the just-reduced ceiling (`_running > _limit`) it is already shedding load, so
	 * the concurrent 429s that triggered it belong to the same episode and are ignored
	 * — otherwise N simultaneously rate-limited tasks would each halve, collapsing
	 * straight to `min`. A new 429 after the pool drains to the ceiling halves again.
	 */
	noteRateLimit(): void {
		if (this._running > this._limit) return;
		this._limit = Math.max(this.min, Math.floor(this._limit / 2));
		this.successStreak = 0;
	}
}
