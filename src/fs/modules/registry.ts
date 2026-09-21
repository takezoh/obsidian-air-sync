import type { BackendModule } from "../../backend-api";
import { LEGACY_BACKEND_ALIASES, validateBackendModule } from "./validate-module";
import type { ModuleValidationIssue } from "./validate-module";

export type ModuleRegistrationResult =
	| { readonly ok: true; readonly module: BackendModule }
	| { readonly ok: false; readonly issues: readonly ModuleValidationIssue[] };

/**
 * An instance-scoped registry of validated backend modules.
 *
 * One registry belongs to one plugin runtime. It holds only stateless module
 * definitions — never tokens, active connections, or cursor state — so two
 * registries cannot share mutable state. Registration performs no I/O: a module
 * is not allowed to communicate with its provider until an adapter is created.
 */
export class BackendModuleRegistry {
	private readonly modules = new Map<string, BackendModule>();

	/**
	 * Validate then register. A duplicate id or an invalid module is rejected
	 * without registering anything, so an invalid candidate can never reach
	 * adapter/auth creation.
	 */
	register(candidate: unknown): ModuleRegistrationResult {
		const validation = validateBackendModule(candidate);
		if (!validation.ok) return validation;
		const module = candidate as BackendModule;
		if (Object.prototype.hasOwnProperty.call(LEGACY_BACKEND_ALIASES, module.id)) {
			return {
				ok: false,
				issues: [{ code: "alias_id", path: "id", message: "a legacy alias cannot be registered" }],
			};
		}
		if (this.modules.has(module.id)) {
			return {
				ok: false,
				issues: [
					{
						code: "duplicate_id",
						path: "id",
						message: `module ${module.id} is already registered`,
					},
				],
			};
		}
		this.modules.set(module.id, module);
		return { ok: true, module };
	}

	/** The module registered under `id`, or `undefined`. */
	get(id: string): BackendModule | undefined {
		return this.modules.get(id);
	}

	/** All registered modules, in registration order. */
	list(): readonly BackendModule[] {
		return [...this.modules.values()];
	}

	/** Registered module ids, in registration order. */
	ids(): readonly string[] {
		return [...this.modules.keys()];
	}
}
