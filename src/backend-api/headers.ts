export type HeaderBag = Headers | Record<string, string> | null | undefined;

function isHeaders(headers: HeaderBag): headers is Headers {
	return !!headers && typeof headers === "object" && "get" in headers && typeof (headers as { get: unknown }).get === "function";
}

/** backend/runtime の header key casing に依存せず response header を読む。 */
export function getHeader(headers: HeaderBag, name: string): string | null {
	if (!headers) return null;
	if (isHeaders(headers)) return headers.get(name);

	const target = name.toLowerCase();
	const pairs: Array<[string, string]> = [];
	for (const key of Object.keys(headers)) {
		const value = headers[key];
		if (typeof value === "string") pairs.push([key, value]);
	}
	for (const [key, value] of pairs) {
		if (key.toLowerCase() === target) return value;
	}
	return null;
}

/** 診断用に、runtime が返した casing のまま response header 名を返す。 */
export function headerKeys(headers: HeaderBag): string[] {
	if (!headers) return [];
	if (isHeaders(headers)) {
		const keys: string[] = [];
		headers.forEach((_, key) => keys.push(key));
		return keys.sort();
	}
	return Object.keys(headers).sort();
}
