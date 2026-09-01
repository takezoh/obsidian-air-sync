import { describe, expect, it } from "vitest";
import { LocalMutationBarrier } from "./local-mutation-barrier";

describe("LocalMutationBarrier", () => {
	it("serializes overlapping path sets but not disjoint paths", async () => {
		const barrier = new LocalMutationBarrier();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const first = barrier.run(["a.md", "b.md"], async () => {
			order.push("first-start");
			await firstGate;
			order.push("first-end");
		});
		const overlapping = barrier.run(["b.md"], () => { order.push("overlap"); return Promise.resolve(); });
		const disjoint = barrier.run(["c.md"], () => { order.push("disjoint"); return Promise.resolve(); });
		await disjoint;
		expect(order).toEqual(["first-start", "disjoint"]);
		releaseFirst();
		await Promise.all([first, overlapping]);
		expect(order).toEqual(["first-start", "disjoint", "first-end", "overlap"]);
	});
});
