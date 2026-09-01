export interface NormalActionPermit {
	release(): void;
}

interface Waiter<T> {
	resolve(value: T): void;
	reject(error: unknown): void;
}

interface PriorityNode<T> {
	run: () => Promise<T>;
	waiters: Waiter<T>[];
	enqueuedAt: number;
}

interface FinalizerNode<T> {
	run: () => Promise<T>;
	waiter: Waiter<T>;
}

/** Policy-free safe point between complete normal actions, priority work, and finalization. */
export class PriorityCoordinator {
	private activeNormal = 0;
	private pending = new Map<string, PriorityNode<unknown>>();
	private finalizers: FinalizerNode<unknown>[] = [];
	private normalWaiters: Waiter<NormalActionPermit>[] = [];
	private draining = false;
	private completed = 0;
	private cancelled = 0;
	private coalesced = 0;

	acquireNormalPermit(): Promise<NormalActionPermit> {
		if (this.canAdmitNormal()) {
			this.activeNormal++;
			return Promise.resolve(this.makePermit());
		}
		return new Promise<NormalActionPermit>((resolve, reject) => {
			this.normalWaiters.push({ resolve, reject });
		});
	}

	enqueue<T>(path: string, run: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const existing = this.pending.get(path);
			if (existing) {
				existing.waiters.push({ resolve, reject });
				this.coalesced++;
				return;
			}
			this.pending.set(path, { run, waiters: [{ resolve, reject }], enqueuedAt: Date.now() });
			this.requestDrain();
		});
	}

	finalize<T>(run: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.finalizers.push({ run, waiter: { resolve, reject } });
			this.requestDrain();
		});
	}

	diagnostics(): { active: number; pending: number; coalesced: number; completed: number;
		cancelled: number; oldestPendingAgeMs: number } {
		const oldest = this.pending.values().next().value;
		return {
			active: this.activeNormal,
			pending: this.pending.size,
			coalesced: this.coalesced,
			completed: this.completed,
			cancelled: this.cancelled,
			oldestPendingAgeMs: oldest ? Math.max(0, Date.now() - oldest.enqueuedAt) : 0,
		};
	}

	private canAdmitNormal(): boolean {
		return !this.draining && this.pending.size === 0 && this.finalizers.length === 0;
	}

	private makePermit(): NormalActionPermit {
		let released = false;
		return { release: () => {
			if (released) return;
			released = true;
			this.activeNormal--;
			this.requestDrain();
		} };
	}

	private requestDrain(): void {
		if (this.draining || this.activeNormal > 0) return;
		this.draining = true;
		void this.drain();
	}

	private async drain(): Promise<void> {
		try {
			while (this.activeNormal === 0) {
				const first = this.pending.entries().next();
				if (!first.done) {
					const [path, node] = first.value;
					this.pending.delete(path);
					try {
						const value = await node.run();
						for (const waiter of node.waiters) waiter.resolve(value);
						this.completed++;
					} catch (error) {
						for (const waiter of node.waiters) waiter.reject(error);
						this.cancelled++;
					}
					continue;
				}
				const finalizer = this.finalizers.shift();
				if (finalizer) {
					try {
						finalizer.waiter.resolve(await finalizer.run());
					} catch (error) {
						finalizer.waiter.reject(error);
					}
					continue;
				}
				break;
			}
		} finally {
			this.draining = false;
			if (this.activeNormal === 0 && (this.pending.size > 0 || this.finalizers.length > 0)) {
				this.requestDrain();
			} else if (this.canAdmitNormal()) {
				const waiters = this.normalWaiters.splice(0);
				for (const waiter of waiters) {
					this.activeNormal++;
					waiter.resolve(this.makePermit());
				}
			}
		}
	}
}
