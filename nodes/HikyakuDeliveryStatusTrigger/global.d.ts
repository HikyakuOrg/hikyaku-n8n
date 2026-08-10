// Node.js has provided a browser-compatible `WebSocket` as a true global (backed by
// undici) since v22.5 — but @types/node doesn't declare it as an ambient global, only as
// a named export inside `declare module "http"`. This package can't pull in the "dom"
// lib (it would bring in unrelated browser globals this code never runs against) or add
// a types package as a dependency, so the exact subset actually used is hand-declared
// here instead, ambiently, matching the runtime global by name.
export {};

declare global {
	class WebSocket {
		constructor(url: string | URL);
		onopen: (() => void) | null;
		onmessage: ((event: { data: unknown }) => void) | null;
		onerror: (() => void) | null;
		onclose: ((event: { code: number; reason: string }) => void) | null;
		send(data: string): void;
		close(code?: number, reason?: string): void;
	}
}
