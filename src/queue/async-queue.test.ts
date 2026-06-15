import { describe, it, expect } from "vitest";
import { AsyncMutex, AsyncPool, AdaptivePool } from "./async-queue";

/** Helper that creates a promise resolvable from outside */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("AsyncMutex", () => {
	it("run() returns the callback value", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.run(() => Promise.resolve(42));
		expect(result).toBe(42);
	});

	it("run() accepts a synchronous callback", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.run(() => "sync-value");
		expect(result).toBe("sync-value");
	});

	it("isLocked is false when idle, true during execution", async () => {
		const mutex = new AsyncMutex();
		expect(mutex.isLocked).toBe(false);

		const { promise: gate, resolve: openGate } = deferred();
		const running = mutex.run(() => gate);

		expect(mutex.isLocked).toBe(true);
		openGate(undefined);
		await running;
		expect(mutex.isLocked).toBe(false);
	});

	it("concurrent run() calls execute in FIFO order", async () => {
		const mutex = new AsyncMutex();
		const order: number[] = [];

		const { promise: gate1, resolve: open1 } = deferred();
		const { promise: gate2, resolve: open2 } = deferred();
		const { promise: gate3, resolve: open3 } = deferred();

		const p1 = mutex.run(async () => {
			await gate1;
			order.push(1);
		});
		const p2 = mutex.run(async () => {
			await gate2;
			order.push(2);
		});
		const p3 = mutex.run(async () => {
			await gate3;
			order.push(3);
		});

		// Only p1 should be running; p2 and p3 are queued.
		open1(undefined);
		await p1;

		// Now p2 should be running.
		open2(undefined);
		await p2;

		// Now p3.
		open3(undefined);
		await p3;

		expect(order).toEqual([1, 2, 3]);
	});

	it("releases the lock when callback throws", async () => {
		const mutex = new AsyncMutex();

		await expect(
			mutex.run(() => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");

		expect(mutex.isLocked).toBe(false);
	});

	it("next run() succeeds after a previous run() threw", async () => {
		const mutex = new AsyncMutex();

		await expect(
			mutex.run(() => {
				throw new Error("fail");
			})
		).rejects.toThrow("fail");

		const result = await mutex.run(() => "recovered");
		expect(result).toBe("recovered");
	});

	it("many queued callers complete in order", async () => {
		const mutex = new AsyncMutex();
		const order: number[] = [];
		const count = 20;

		const promises = Array.from({ length: count }, (_, i) =>
			mutex.run(async () => {
				// Yield to simulate async work
				await Promise.resolve();
				order.push(i);
			})
		);

		await Promise.all(promises);
		expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
		expect(mutex.isLocked).toBe(false);
	});
});

describe("AsyncPool", () => {
	it("throws when concurrency is less than 1", () => {
		expect(() => new AsyncPool(0)).toThrow("concurrency must be at least 1");
		expect(() => new AsyncPool(-1)).toThrow("concurrency must be at least 1");
	});

	it("returns the callback value", async () => {
		const pool = new AsyncPool(2);
		const result = await pool.run(() => Promise.resolve(42));
		expect(result).toBe(42);
	});

	it("respects concurrency limit", async () => {
		const pool = new AsyncPool(2);
		let running = 0;
		let maxRunning = 0;

		const task = async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
		};

		await Promise.all(
			Array.from({ length: 5 }, () => pool.run(task))
		);

		expect(maxRunning).toBe(2);
	});

	it("propagates errors without breaking the pool", async () => {
		const pool = new AsyncPool(2);

		await expect(
			pool.run(() => Promise.reject(new Error("boom")))
		).rejects.toThrow("boom");

		// Pool should still work after error
		const result = await pool.run(() => Promise.resolve("ok"));
		expect(result).toBe("ok");
	});

	it("all tasks complete even when some fail", async () => {
		const pool = new AsyncPool(2);
		const completed: number[] = [];

		const promises = [0, 1, 2, 3].map((i) =>
			pool.run(() => {
				if (i === 1) return Promise.reject(new Error("fail"));
				completed.push(i);
				return Promise.resolve();
			}).catch(() => { /* swallow */ })
		);

		await Promise.all(promises);
		expect(completed).toEqual(expect.arrayContaining([0, 2, 3]));
		expect(completed).toHaveLength(3);
	});
});

describe("AdaptivePool", () => {
	const ok = () => Promise.resolve();

	it("validates opts and clamps start into [min, max]", () => {
		expect(() => new AdaptivePool({ min: 0, start: 1, max: 1, rampAfter: 1 })).toThrow("min must be at least 1");
		expect(() => new AdaptivePool({ min: 2, start: 2, max: 1, rampAfter: 1 })).toThrow("max must be >= min");
		expect(() => new AdaptivePool({ min: 1, start: 1, max: 1, rampAfter: 0 })).toThrow("rampAfter must be at least 1");
		expect(new AdaptivePool({ min: 2, start: 1, max: 5, rampAfter: 1 }).limit).toBe(2); // clamped up to min
		expect(new AdaptivePool({ min: 2, start: 99, max: 5, rampAfter: 1 }).limit).toBe(5); // clamped down to max
	});

	it("admits at most `limit` tasks concurrently", async () => {
		const pool = new AdaptivePool({ min: 1, start: 2, max: 2, rampAfter: 100 });
		let running = 0;
		let maxRunning = 0;
		const task = async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
		};
		await Promise.all(Array.from({ length: 5 }, () => pool.run(task)));
		expect(maxRunning).toBe(2);
	});

	it("ramps the limit +1 after `rampAfter` clean runs, capped at `max`", async () => {
		const pool = new AdaptivePool({ min: 1, start: 2, max: 4, rampAfter: 3 });
		expect(pool.limit).toBe(2);
		for (let i = 0; i < 3; i++) await pool.run(ok);
		expect(pool.limit).toBe(3);
		for (let i = 0; i < 3; i++) await pool.run(ok);
		expect(pool.limit).toBe(4);
		for (let i = 0; i < 3; i++) await pool.run(ok);
		expect(pool.limit).toBe(4); // capped at max
	});

	it("halves the limit on noteRateLimit, floored at `min`", () => {
		const pool = new AdaptivePool({ min: 1, start: 8, max: 8, rampAfter: 100 });
		pool.noteRateLimit();
		expect(pool.limit).toBe(4);
		pool.noteRateLimit();
		expect(pool.limit).toBe(2);
		pool.noteRateLimit();
		expect(pool.limit).toBe(1);
		pool.noteRateLimit();
		expect(pool.limit).toBe(1); // floored at min
	});

	it("coalesces a burst: rate-limit signals while above the reduced ceiling don't re-halve", async () => {
		const pool = new AdaptivePool({ min: 1, start: 8, max: 8, rampAfter: 100 });
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		// Fill the pool: 8 tasks holding their slots (start == limit == 8).
		const inflight = Array.from({ length: 8 }, () => pool.run(() => gate));
		await Promise.resolve();
		expect(pool.running).toBe(8);

		pool.noteRateLimit(); // running(8) > limit(8)? no → halve to 4
		expect(pool.limit).toBe(4);
		pool.noteRateLimit(); // running(8) > limit(4)? yes → same episode, ignored
		pool.noteRateLimit();
		expect(pool.limit).toBe(4); // one decrease, not collapsed toward min

		release();
		await Promise.all(inflight);
	});

	it("resets the success streak on a rate-limit (pre-signal successes don't count)", async () => {
		const pool = new AdaptivePool({ min: 1, start: 4, max: 8, rampAfter: 3 });
		await pool.run(ok);
		await pool.run(ok); // streak 2
		pool.noteRateLimit(); // limit 2, streak reset
		expect(pool.limit).toBe(2);
		await pool.run(ok);
		await pool.run(ok); // streak 2 (not 4) → no ramp
		expect(pool.limit).toBe(2);
		await pool.run(ok); // streak 3 → ramp
		expect(pool.limit).toBe(3);
	});

	it("resets the success streak on a rejected run (never ramps while failing)", async () => {
		const pool = new AdaptivePool({ min: 1, start: 4, max: 8, rampAfter: 3 });
		await pool.run(ok);
		await pool.run(ok); // streak 2
		await expect(pool.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom"); // streak reset
		await pool.run(ok);
		await pool.run(ok); // streak 2
		expect(pool.limit).toBe(4); // not ramped
		await pool.run(ok); // streak 3 → ramp
		expect(pool.limit).toBe(5);
	});

	it("a woken waiter re-checks a shrunk limit (no admission while running >= limit)", async () => {
		const pool = new AdaptivePool({ min: 1, start: 3, max: 3, rampAfter: 100 });
		const g1 = deferred();
		const g2 = deferred();
		const g3 = deferred();
		const p1 = pool.run(() => g1.promise);
		const p2 = pool.run(() => g2.promise);
		const p3 = pool.run(() => g3.promise);
		await Promise.resolve();
		expect(pool.running).toBe(3); // all admitted at start=3

		// Queue a 4th while full; it waits.
		let fourthStarted = false;
		const p4 = pool.run(() => { fourthStarted = true; return Promise.resolve(); });

		// Shrink the limit to 1 mid-flight.
		pool.noteRateLimit();
		expect(pool.limit).toBe(1);

		// running 3→2: still >= 1, 4th must NOT start.
		g1.resolve();
		await p1;
		await Promise.resolve();
		expect(fourthStarted).toBe(false);
		expect(pool.running).toBe(2);

		// running 2→1: still >= 1, 4th must NOT start.
		g2.resolve();
		await p2;
		await Promise.resolve();
		expect(fourthStarted).toBe(false);
		expect(pool.running).toBe(1);

		// running 1→0: now < 1, the 4th is admitted.
		g3.resolve();
		await p3;
		await p4;
		expect(fourthStarted).toBe(true);
	});
});
