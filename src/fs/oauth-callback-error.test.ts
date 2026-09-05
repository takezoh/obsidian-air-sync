import { describe, expect, it } from "vitest";
import {
	correlateOAuthCallbackError,
	handleOAuthProtocolCallback,
	projectOAuthCallbackError,
} from "./oauth-callback-error";

describe("OAuth callback error projection", () => {
	it("uses the fixed access-denied message", () => {
		expect(projectOAuthCallbackError("access_denied")).toEqual({
			code: "access_denied",
			message: "Authorization was denied.",
		});
	});

	it("preserves a bounded safe error code without provider descriptions", () => {
		expect(projectOAuthCallbackError("temporarily_unavailable")).toEqual({
			code: "temporarily_unavailable",
			message: "Authorization failed (temporarily_unavailable).",
		});
		expect(projectOAuthCallbackError("<secret-sentinel>"))
			.toEqual({ code: "invalid_error", message: "Authorization failed (invalid_error)." });
	});

	it("correlates only an exact nonempty active pending state", () => {
		const params = { error: "access_denied", state: "current", code: "must-not-win" };
		expect(correlateOAuthCallbackError(params, "current")?.message).toBe("Authorization was denied.");
		expect(correlateOAuthCallbackError(params, "other")).toBeNull();
		expect(correlateOAuthCallbackError(params, "")).toBeNull();
	});

	it("lets a denial win over success fields without dispatching", () => {
		const notices: string[] = [];
		let dispatches = 0;
		handleOAuthProtocolCallback(
			{
				error: "access_denied",
				error_description: "secret sentinel",
				state: "current",
				code: "must-not-win",
				access_token: "must-not-win",
				picked_file_ids: "must-not-win",
			},
			"current",
			{
				notify: (message) => notices.push(message),
				completeConnect: () => { dispatches += 1; },
				completeFolderPick: () => { dispatches += 1; },
			},
		);
		expect(notices).toEqual(["Authorization was denied."]);
		expect(dispatches).toBe(0);
		expect(notices.join(" ")).not.toContain("sentinel");
	});

	it("has no denial side effect when the active state is unavailable or changed", () => {
		for (const pending of [undefined, "", "other"]) {
			let effects = 0;
			handleOAuthProtocolCallback(
				{ error: "access_denied", state: "current", code: "must-not-win" },
				pending,
				{
					notify: () => { effects += 1; },
					completeConnect: () => { effects += 1; },
					completeFolderPick: () => { effects += 1; },
				},
			);
			expect(effects).toBe(0);
		}
	});
});
