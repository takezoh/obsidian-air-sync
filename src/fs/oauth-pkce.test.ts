import { describe, it, expect, vi } from "vitest";
import {
	base64ToBase64Url,
	generateRandomString,
	computeS256Challenge,
	buildOAuthState,
	BaseOAuthTokenManager,
	type OAuthTokenResponse,
} from "./oauth-pkce";
import { AuthError } from "./errors";

describe("base64ToBase64Url", () => {
	it("replaces +,/ and strips padding", () => {
		expect(base64ToBase64Url("ab+/cd==")).toBe("ab-_cd");
		expect(base64ToBase64Url("plain")).toBe("plain");
	});
});

describe("generateRandomString", () => {
	it("produces a string of the requested length from the URL-safe charset", () => {
		const s = generateRandomString(64);
		expect(s).toHaveLength(64);
		expect(s).toMatch(/^[A-Za-z0-9]+$/);
	});

	it("is overwhelmingly unlikely to repeat", () => {
		expect(generateRandomString(32)).not.toBe(generateRandomString(32));
	});
});

describe("computeS256Challenge", () => {
	it("matches the RFC 7636 Appendix B test vector", async () => {
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const challenge = await computeS256Challenge(verifier);
		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});
});

describe("buildOAuthState", () => {
	it("is URL-safe and decodes to the app id, a nonce, and any extra fields", () => {
		const state = buildOAuthState({ custom: true });
		// base64url: no chars a form-decoder would mangle.
		expect(state).not.toMatch(/[+/=]/);
		const b64 = state.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = JSON.parse(
			atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
		) as { app: string; nonce: string; custom?: boolean };
		expect(decoded.app).toBe("obsidian-plugin");
		expect(typeof decoded.nonce).toBe("string");
		expect(decoded.custom).toBe(true);
	});
});

/** Minimal concrete manager whose refresh returns a controllable response. */
class TestTokenManager extends BaseOAuthTokenManager {
	refreshCount = 0;
	response: OAuthTokenResponse = { access_token: "AT", expires_in: 3600 };
	error: unknown = null;

	protected notAuthenticatedMessage(): string {
		return "not authed (test)";
	}

	protected sessionExpiredMessage(): string {
		return "session expired (test)";
	}

	protected async performRefresh(): Promise<string> {
		this.refreshCount++;
		await Promise.resolve();
		if (this.error) this.handleRefreshError(this.error);
		this.storeTokenResponse(this.response);
		return this.accessToken;
	}
}

describe("BaseOAuthTokenManager", () => {
	it("throws the provider-specific message when there are no tokens at all", async () => {
		const m = new TestTokenManager();
		await expect(m.getAccessToken()).rejects.toThrow("not authed (test)");
		await expect(m.getAccessToken()).rejects.toBeInstanceOf(AuthError);
	});

	it("serves a still-valid access token even without a refresh token", async () => {
		const m = new TestTokenManager();
		// Access-only: no refresh token, but a fresh access token is present.
		m.setTokens("", "access-only", Date.now() + 3_600_000);
		expect(await m.getAccessToken()).toBe("access-only");
		expect(m.refreshCount).toBe(0);
	});

	it("throws the session-expired message when a refresh is needed but no refresh token exists", async () => {
		const m = new TestTokenManager();
		m.setTokens("", "stale", 0); // access-only and expired → cannot refresh
		await expect(m.getAccessToken()).rejects.toThrow("session expired (test)");
		expect(m.refreshCount).toBe(0);
	});

	it("returns the cached access token within the expiry-skew window (no refresh)", async () => {
		const m = new TestTokenManager();
		m.setTokens("RT", "cached", Date.now() + 3_600_000);
		const token = await m.getAccessToken();
		expect(token).toBe("cached");
		expect(m.refreshCount).toBe(0);
	});

	it("refreshes when the access token is expired", async () => {
		const m = new TestTokenManager();
		m.setTokens("RT", "stale", 0);
		m.response = { access_token: "fresh", expires_in: 3600 };
		expect(await m.getAccessToken()).toBe("fresh");
		expect(m.refreshCount).toBe(1);
	});

	it("deduplicates concurrent refreshes", async () => {
		const m = new TestTokenManager();
		m.setTokens("RT", "", 0);
		const [a, b, c] = await Promise.all([
			m.getAccessToken(),
			m.getAccessToken(),
			m.getAccessToken(),
		]);
		expect([a, b, c]).toEqual(["AT", "AT", "AT"]);
		expect(m.refreshCount).toBe(1);
	});

	it("short-circuits within the cooldown after a 400, then retries once it elapses", async () => {
		const m = new TestTokenManager();
		m.setTokens("RT", "", 0);
		m.error = Object.assign(new Error("bad"), { status: 400 });

		const now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

		await expect(m.getAccessToken()).rejects.toThrow(/Token refresh failed/);
		expect(m.refreshCount).toBe(1);

		dateNow.mockReturnValue(now + 30_000); // within cooldown
		await expect(m.getAccessToken()).rejects.toThrow(/Authentication expired/);
		expect(m.refreshCount).toBe(1);

		dateNow.mockReturnValue(now + 60_001); // cooldown elapsed
		m.error = null;
		m.response = { access_token: "recovered", expires_in: 3600 };
		expect(await m.getAccessToken()).toBe("recovered");
		expect(m.refreshCount).toBe(2);

		dateNow.mockRestore();
	});

	it("fires the rotation hook only when the refresh token actually changes", async () => {
		const rotated: string[] = [];
		const m = new TestTokenManager();
		m.setRefreshTokenRotatedHook((rt) => rotated.push(rt));
		m.setTokens("RT", "", 0);

		// Same refresh token returned → no rotation.
		m.response = { access_token: "AT1", refresh_token: "RT", expires_in: 3600 };
		await m.getAccessToken(true);
		expect(rotated).toEqual([]);

		// Different refresh token → rotation fires once with the new value.
		m.response = { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 };
		await m.getAccessToken(true);
		expect(rotated).toEqual(["RT2"]);
		expect(m.getTokenState().refreshToken).toBe("RT2");
	});
});
