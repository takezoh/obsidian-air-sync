import { describe, expect, it, vi } from "vitest";
import { PriorityCoordinator } from "./priority-coordinator";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("PriorityCoordinator", () => {
	it("runs queued priority after the active normal action and before a later permit", async () => {
		const coordinator = new PriorityCoordinator();
		const first = await coordinator.acquireNormalPermit();
		const priorityGate = deferred();
		const priority = coordinator.enqueue("note.md", async () => {
			await priorityGate.promise;
			return "applied";
		});
		const secondResolved = vi.fn();
		const second = coordinator.acquireNormalPermit().then((permit) => {
			secondResolved();
			return permit;
		});

		await Promise.resolve();
		expect(secondResolved).not.toHaveBeenCalled();
		first.release();
		await Promise.resolve();
		expect(secondResolved).not.toHaveBeenCalled();

		priorityGate.resolve();
		expect(await priority).toBe("applied");
		const secondPermit = await second;
		expect(secondResolved).toHaveBeenCalledOnce();
		secondPermit.release();
	});

	it("coalesces duplicate pending paths onto one attempt", async () => {
		const coordinator = new PriorityCoordinator();
		const normal = await coordinator.acquireNormalPermit();
		const run = vi.fn(() => Promise.resolve("unchanged" as const));
		const left = coordinator.enqueue("note.md", run);
		const right = coordinator.enqueue("note.md", run);
		normal.release();
		expect(await left).toBe("unchanged");
		expect(await right).toBe("unchanged");
		expect(run).toHaveBeenCalledOnce();
		expect(coordinator.diagnostics().coalesced).toBe(1);
	});

	it("drains priority before finalization and resumes normal work after it", async () => {
		const coordinator = new PriorityCoordinator();
		const normal = await coordinator.acquireNormalPermit();
		const order: string[] = [];
		const priority = coordinator.enqueue("note.md", () => { order.push("priority"); return Promise.resolve(); });
		const finalization = coordinator.finalize(() => { order.push("finalize"); return Promise.resolve(); });
		normal.release();
		await Promise.all([priority, finalization]);
		expect(order).toEqual(["priority", "finalize"]);
		const resumed = await coordinator.acquireNormalPermit();
		resumed.release();
	});

	it("does not run priority queued while finalization is between checkpoint and debt release", async () => {
		const coordinator = new PriorityCoordinator();
		const checkpointCommitted = deferred();
		const releaseDebt = deferred();
		const order: string[] = [];
		const finalization = coordinator.finalize(async () => {
			order.push("checkpoint");
			checkpointCommitted.resolve();
			await releaseDebt.promise;
			order.push("debt-release");
		});
		await checkpointCommitted.promise;
		const priority = coordinator.enqueue("note.md", () => {
			order.push("priority");
			return Promise.resolve();
		});
		await Promise.resolve();
		expect(order).toEqual(["checkpoint"]);

		releaseDebt.resolve();
		await Promise.all([finalization, priority]);
		expect(order).toEqual(["checkpoint", "debt-release", "priority"]);
	});
});
