// Minimal, dependency-free client for Supabase Realtime's Phoenix-channel protocol
// (https://supabase.com/docs/guides/realtime/protocol), scoped to exactly what this node
// needs: subscribe to INSERTs on one table via "postgres_changes". Deliberately has no
// n8n types in it so it can be exercised on its own.
//
// Built on the `WebSocket` global Node.js provides from v22.5 onward (declared in
// ./global.d.ts, since @types/node doesn't expose it ambiently) — n8n's
// community-node lint forbids both npm dependencies and importing built-ins like
// `node:http`, so the class is used purely as an ambient global here, no import at all.
//
// This class starts no timers of its own — n8n's Cloud sandbox also forbids bare
// `setInterval`/`setTimeout` in community nodes, since the only sanctioned scheduling
// primitive for a trigger node is `ITriggerFunctions.helpers.registerCron`. So heartbeat
// keepalive and reconnect backoff are both driven externally: the node registers one
// recurring cron and calls `tick()` on every firing: this class just compares
// timestamps against `Date.now()` to decide whether a heartbeat or a reconnect attempt is
// due.

const PROTOCOL_VERSION = '1.0.0';
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_MISSED_HEARTBEATS = 2;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface PackageTimelineInsert {
	id: number;
	package_id: string;
	[key: string]: unknown;
}

type PhoenixPayload = Record<string, unknown>;

interface PhoenixMessage {
	topic: string;
	event: string;
	payload: PhoenixPayload;
	ref: string | null;
	join_ref?: string | null;
}

export interface SupabaseRealtimeOptions {
	/** e.g. https://xxxxxxxxxxxx.supabase.co */
	supabaseUrl: string;
	/** Supabase publishable/anon key, sent as the `apikey` query param. */
	apikey: string;
	schema: string;
	table: string;
	/**
	 * A postgres_changes filter expression, PostgREST-style (e.g. `package_status=in.(1,2)`).
	 * Evaluated server-side by Realtime against the new row's columns — matching rows never
	 * leave the database, so an unmatched status change costs nothing on this connection.
	 * Omit for no filter (every INSERT on `table` is delivered).
	 */
	filter?: string;
	/**
	 * Returns a valid access token for the `phx_join` / `access_token` frames. Called
	 * before every (re)join and whenever a proactive refresh is requested. Whether the
	 * token needed refreshing first is this function's concern, not the client's.
	 */
	getAccessToken: () => Promise<string>;
	/** A new row was inserted into `table` and the channel has already deduplicated nothing — caller's job. */
	onInsert: (row: PackageTimelineInsert) => void;
	/** Fired every time the postgres_changes subscription becomes live — first join and every rejoin. */
	onSubscribed: () => void;
	/** Non-fatal: a join/heartbeat/channel error happened and a reconnect has been scheduled. */
	onChannelError?: (error: Error) => void;
	/** The reconnect ladder was exhausted; the caller should treat the listener as dead. */
	onFatal: (error: Error) => void;
	log?: (message: string) => void;
}

/**
 * One Phoenix channel over one WebSocket connection, with heartbeat keepalive and
 * automatic reconnect-with-backoff. `connect()` resolves once the *first* subscription
 * succeeds (or rejects once the reconnect ladder is exhausted before that ever happens);
 * every subsequent reconnect is handled internally (driven by `tick()`) and reported via
 * the callbacks instead.
 */
export class SupabaseRealtimeClient {
	private readonly topic: string;

	private ws: WebSocket | null = null;

	private refCounter = 0;

	private pendingJoinRef: string | null = null;

	private pendingHeartbeatRef: string | null = null;

	private missedHeartbeats = 0;

	private lastHeartbeatSentAt = 0;

	/** ms epoch at which the next reconnect attempt is due; null when not waiting to reconnect. */
	private nextReconnectAt: number | null = null;

	private reconnectAttempts = 0;

	private joined = false;

	private closedIntentionally = false;

	/** Settled once — by the first onSubscribed or the first exhausted-ladder onFatal. */
	private ready: { resolve: () => void; reject: (error: Error) => void } | null = null;

	constructor(private readonly options: SupabaseRealtimeOptions) {
		this.topic = `realtime:hikyaku:${options.schema}:${options.table}`;
	}

	async connect(): Promise<void> {
		return await new Promise<void>((resolve, reject) => {
			this.ready = { resolve, reject };
			this.openSocket();
		});
	}

	close(): void {
		this.closedIntentionally = true;
		this.nextReconnectAt = null;
		this.joined = false;
		if (this.ws) {
			try {
				this.ws.close(1000, 'closed by client');
			} catch {
				// socket may already be closed/closing — nothing to do
			}
			this.ws = null;
		}
	}

	/**
	 * Drives everything that would otherwise need a timer: heartbeat keepalive and
	 * reconnect backoff. Call this from a host-owned recurring scheduler (this node uses
	 * `registerCron` on a ~2s cadence) — the exact calling interval only affects how much
	 * slack is added on top of the intended delays, not correctness.
	 */
	tick(now: number = Date.now()): void {
		if (this.ws && this.joined && now - this.lastHeartbeatSentAt >= HEARTBEAT_INTERVAL_MS) {
			this.sendHeartbeat(now);
		}
		if (this.nextReconnectAt !== null && now >= this.nextReconnectAt && !this.ws) {
			this.nextReconnectAt = null;
			this.openSocket();
		}
	}

	/** Push a freshly-fetched token over an already-live channel, without a full rejoin. */
	async refreshAccessToken(): Promise<void> {
		if (!this.joined || !this.ws) return;
		const token = await this.options.getAccessToken();
		this.send({
			topic: this.topic,
			event: 'access_token',
			payload: { access_token: token },
			ref: this.nextRef(),
		});
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private nextRef(): string {
		this.refCounter += 1;
		return String(this.refCounter);
	}

	private wsUrl(): string {
		const base = this.options.supabaseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
		const params = new URLSearchParams({ apikey: this.options.apikey, vsn: PROTOCOL_VERSION });
		return `${base}/realtime/v1/websocket?${params.toString()}`;
	}

	private openSocket(): void {
		this.joined = false;
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.wsUrl());
		} catch (error) {
			this.handleUnrecoverableOpenFailure(error as Error);
			return;
		}
		this.ws = socket;

		socket.onopen = () => {
			this.log('Supabase Realtime: socket open, joining channel');
			void this.join();
		};

		socket.onmessage = (event) => {
			this.handleRawMessage(event.data);
		};

		socket.onerror = () => {
			// The WebSocket spec doesn't guarantee a usable Error on this event; the
			// close event that immediately follows is what actually drives reconnect.
			this.options.onChannelError?.(new Error('Supabase Realtime socket error'));
		};

		socket.onclose = (event) => {
			this.ws = null;
			this.joined = false;
			if (this.closedIntentionally) return;
			this.scheduleReconnect(new Error(`Supabase Realtime socket closed (code ${event.code})`));
		};
	}

	private handleUnrecoverableOpenFailure(error: Error): void {
		// `new WebSocket(url)` only throws on a malformed URL — retrying won't help.
		const ready = this.ready;
		this.ready = null;
		if (ready) ready.reject(error);
		else this.options.onFatal(error);
	}

	private async join(): Promise<void> {
		let token: string;
		try {
			token = await this.options.getAccessToken();
		} catch (error) {
			this.scheduleReconnect(error as Error);
			return;
		}
		const ref = this.nextRef();
		this.pendingJoinRef = ref;
		this.send({
			topic: this.topic,
			event: 'phx_join',
			ref,
			join_ref: ref,
			payload: {
				access_token: token,
				config: {
					postgres_changes: [
						{
							event: 'INSERT',
							schema: this.options.schema,
							table: this.options.table,
							...(this.options.filter ? { filter: this.options.filter } : {}),
						},
					],
				},
			},
		});
	}

	private send(message: PhoenixMessage): void {
		if (!this.ws) return;
		this.ws.send(JSON.stringify(message));
	}

	private handleRawMessage(data: unknown): void {
		let message: PhoenixMessage;
		try {
			message = JSON.parse(String(data)) as PhoenixMessage;
		} catch {
			this.log(`Supabase Realtime: received non-JSON frame, ignoring: ${String(data)}`);
			return;
		}

		switch (message.event) {
			case 'phx_reply':
				this.handleReply(message);
				break;
			case 'system':
				this.handleSystem(message);
				break;
			case 'postgres_changes':
				this.handlePostgresChanges(message);
				break;
			case 'phx_close':
			case 'phx_error':
				this.scheduleReconnect(new Error(`Supabase Realtime channel ${message.event}`));
				break;
			default:
				break;
		}
	}

	private handleReply(message: PhoenixMessage): void {
		if (message.ref !== null && message.ref === this.pendingHeartbeatRef) {
			this.pendingHeartbeatRef = null;
			this.missedHeartbeats = 0;
			return;
		}
		if (message.ref !== null && message.ref === this.pendingJoinRef) {
			const status = (message.payload as { status?: string }).status;
			if (status !== 'ok') {
				const reason =
					(message.payload as { response?: { reason?: string } }).response?.reason ??
					'unknown error';
				this.scheduleReconnect(new Error(`Supabase Realtime join rejected: ${reason}`));
			}
			// On success we don't call onSubscribed yet — we wait for the "system" event
			// below, which confirms the postgres_changes subscription (not just the
			// channel join) is actually live.
		}
	}

	private handleSystem(message: PhoenixMessage): void {
		const payload = message.payload as { extension?: string; status?: string; message?: string };
		if (payload.extension !== 'postgres_changes') return;
		if (payload.status === 'ok') {
			this.joined = true;
			this.reconnectAttempts = 0;
			this.missedHeartbeats = 0;
			this.pendingHeartbeatRef = null;
			this.lastHeartbeatSentAt = Date.now();
			const ready = this.ready;
			this.ready = null;
			if (ready) ready.resolve();
			this.options.onSubscribed();
		} else {
			this.scheduleReconnect(
				new Error(`Supabase Realtime subscription failed: ${payload.message ?? 'unknown error'}`),
			);
		}
	}

	private handlePostgresChanges(message: PhoenixMessage): void {
		const data = (message.payload as { data?: { record?: PackageTimelineInsert } }).data;
		if (data?.record) this.options.onInsert(data.record);
	}

	private sendHeartbeat(now: number): void {
		if (this.pendingHeartbeatRef !== null) {
			this.missedHeartbeats += 1;
			if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
				this.scheduleReconnect(new Error('Supabase Realtime heartbeat timed out'));
				return;
			}
		}
		const ref = this.nextRef();
		this.pendingHeartbeatRef = ref;
		this.lastHeartbeatSentAt = now;
		this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref });
	}

	private scheduleReconnect(cause: Error): void {
		if (this.closedIntentionally || this.nextReconnectAt !== null) return;
		this.joined = false;
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// already closing/closed
			}
			this.ws = null;
		}

		this.reconnectAttempts += 1;
		if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
			const error = new Error(
				`Supabase Realtime: giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts: ${cause.message}`,
			);
			const ready = this.ready;
			this.ready = null;
			if (ready) ready.reject(error);
			else this.options.onFatal(error);
			return;
		}

		this.options.onChannelError?.(cause);
		const delay = Math.min(
			RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
			RECONNECT_MAX_DELAY_MS,
		);
		const jitter = delay * (0.5 + Math.random() * 0.5);
		this.nextReconnectAt = Date.now() + jitter;
		this.log(
			`Supabase Realtime: reconnecting in ${Math.round(jitter)}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}): ${cause.message}`,
		);
	}
}
