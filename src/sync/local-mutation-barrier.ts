/** Serializes Air Sync local mutations whose declared path sets overlap. */
export class LocalMutationBarrier {
	private active = new Set<string>();
	private pending: Array<{ paths: string[]; operation: () => Promise<unknown>;
		resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];

	async run<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
		const unique = [...new Set(paths)].sort();
		return new Promise<T>((resolve, reject) => {
			this.pending.push({
				paths: unique,
				operation,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.drain();
		});
	}

	private drain(): void {
		for (let index = 0; index < this.pending.length;) {
			const node = this.pending[index]!;
			if (node.paths.some((path) => this.active.has(path))) {
				index++;
				continue;
			}
			this.pending.splice(index, 1);
			for (const path of node.paths) this.active.add(path);
			void node.operation().then(node.resolve, node.reject).finally(() => {
				for (const path of node.paths) this.active.delete(path);
				this.drain();
			});
		}
	}
}
