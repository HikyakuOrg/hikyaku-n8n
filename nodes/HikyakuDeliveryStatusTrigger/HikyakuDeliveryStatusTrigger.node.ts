import type {
	Cron,
	CronExpression,
	IDataObject,
	IHttpRequestOptions,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { SupabaseRealtimeClient, type PackageTimelineInsert } from './SupabaseRealtime';

interface HikyakuOAuth2Credentials {
	supabaseUrl: string;
	anonKey: string;
}

async function hikyakuApiRequest(
	this: ITriggerFunctions,
	path: string,
	qs: IDataObject,
): Promise<IDataObject[]> {
	const credentials = await this.getCredentials<HikyakuOAuth2Credentials>('hikyakuOAuth2Api');

	const options: IHttpRequestOptions = {
		method: 'GET',
		url: `${credentials.supabaseUrl}/rest/v1/${path}`,
		headers: { apikey: credentials.anonKey },
		qs,
		json: true,
	};

	return (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'hikyakuOAuth2Api',
		options,
	)) as IDataObject[];
}

/**
 * Returns the current (and, if necessary, freshly refreshed) OAuth2 access token.
 *
 * There's no API for "refresh this credential now" — the way n8n's OAuth2 credential type
 * actually refreshes an expired token is by noticing expiry on the way into an
 * authenticated request. So: fire the cheapest authenticated request we have (the same
 * `package_timeline` read the rest of this node already uses), then re-read the
 * credential — if it needed refreshing, it now has. This is the exact mechanism the old
 * poll() relied on every cycle; reusing it here means the realtime path is refreshing
 * tokens the same proven way, just off a timer instead of a poll interval.
 */
async function getFreshAccessToken(this: ITriggerFunctions): Promise<string> {
	await hikyakuApiRequest.call(this, 'package_timeline', { select: 'id', limit: '1' });
	const credentials = await this.getCredentials<
		HikyakuOAuth2Credentials & { oauthTokenData?: { access_token?: string }; accessToken?: string }
	>('hikyakuOAuth2Api');
	const token = credentials.oauthTokenData?.access_token ?? credentials.accessToken;
	if (!token) {
		throw new NodeOperationError(this.getNode(), 'No OAuth2 access token available on credentials');
	}
	return token;
}

export class HikyakuDeliveryStatusTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hikyaku Delivery Status Trigger',
		name: 'hikyakuDeliveryStatusTrigger',
		icon: {
			light: 'file:icons/hikyakuDeliveryStatusTrigger.light.svg',
			dark: 'file:icons/hikyakuDeliveryStatusTrigger.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		description: "Starts the workflow the moment a package's delivery status changes",
		subtitle: '',
		defaults: {
			name: 'Delivery Status Trigger',
		},
		usableAsTool: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'hikyakuOAuth2Api',
				required: true,
			},
		],
		properties: [],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		if (typeof WebSocket !== 'function') {
			throw new NodeOperationError(this.getNode(), 'Requires Node.js 22 or newer', {
				description:
					'The realtime delivery status trigger uses the WebSocket client built into Node.js, ' +
					'available from Node 22.5 onward. Upgrade the n8n host to Node 22 or later.',
			});
		}

		const credentials = await this.getCredentials<HikyakuOAuth2Credentials>('hikyakuOAuth2Api');

		// package_timeline is an append-only audit log (see insert_package_timeline()) — new
		// rows are what "delivery status changed" means here; current_status on
		// packages_with_latest_status is derived from it, not stored directly.
		const emitRow = async (row: PackageTimelineInsert) => {
			const staticData = this.getWorkflowStaticData('node') as { lastId?: number };
			if (row.id <= (staticData.lastId ?? 0)) return; // already seen, via live event or replay
			staticData.lastId = row.id;

			try {
				// packages_with_latest_status carries current_status plus the customer/warehouse
				// context the timeline row alone doesn't have. RLS (is_org_member) scopes this
				// request to the authenticated tenant the same way it scopes the frontend.
				const [packageRow] = await hikyakuApiRequest.call(this, 'packages_with_latest_status', {
					select: 'id, from_customer, to_customer, warehouse_id, current_status',
					id: `eq.${row.package_id}`,
				});
				if (packageRow) {
					this.emit([[{ json: packageRow }]], undefined, undefined, `package_timeline:${row.id}`);
				}
			} catch (error) {
				// The realtime connection is still healthy — only this one row's enrichment
				// failed — so record it and keep listening rather than tearing the socket down.
				this.saveFailedExecution(new NodeOperationError(this.getNode(), error as Error));
			}
		};

		// Runs after every successful (re)subscription — the very first one and every
		// rejoin after a reconnect. Realtime is fire-and-forget: anything that happened
		// while the socket was down is gone unless we replay it from the cursor here.
		const catchUp = async () => {
			const staticData = this.getWorkflowStaticData('node') as { lastId?: number };
			if (staticData.lastId === undefined) {
				// First-ever activation: baseline on the newest row without emitting — a
				// freshly activated trigger should only fire on changes, not replay history.
				const [newest] = await hikyakuApiRequest.call(this, 'package_timeline', {
					select: 'id',
					order: 'id.desc',
					limit: '1',
				});
				staticData.lastId = (newest?.id as number) ?? 0;
				return;
			}
			const missed = await hikyakuApiRequest.call(this, 'package_timeline', {
				select: 'id, package_id',
				id: `gt.${staticData.lastId}`,
				order: 'id.asc',
				limit: '50',
			});
			for (const row of missed as unknown as PackageTimelineInsert[]) {
				await emitRow(row);
			}
		};

		const client = new SupabaseRealtimeClient({
			supabaseUrl: credentials.supabaseUrl,
			apikey: credentials.anonKey,
			schema: 'public',
			table: 'package_timeline',
			getAccessToken: () => getFreshAccessToken.call(this),
			onInsert: (row) => {
				void emitRow(row);
			},
			onSubscribed: () => {
				void catchUp();
			},
			onChannelError: (error) => {
				this.logger.warn(`Hikyaku Delivery Status Trigger: ${error.message}`);
			},
			onFatal: (error) => {
				this.emitError(error);
			},
			log: (message) => this.logger.debug(message),
		});

		// n8n's Cloud sandbox forbids bare setInterval/setTimeout in community nodes, so
		// SupabaseRealtimeClient starts no timers of its own — heartbeat keepalive and
		// reconnect backoff are both driven by calling its tick() on a recurring cron
		// instead. This has to be registered *before* connect() below: if the very first
		// connection attempt fails, the client's internal retries are driven by this same
		// tick, so without it registered first, connect() would never resolve or reject.
		const tickCron: Cron = { expression: '*/2 * * * * *' as CronExpression };
		this.helpers.registerCron(tickCron, () => client.tick());

		// Every ~4 minutes, force a token check-and-refresh-if-needed and push the result
		// over the live channel. Supabase access tokens run 5min–1hr, so this comfortably
		// covers even the shortest TTL before Realtime would reject the channel with
		// InvalidJWTExpiration. If a join or heartbeat ever does hit that error anyway (e.g.
		// a longer gap while reconnecting), the client's own rejoin already fetches a fresh
		// token, so the channel self-heals regardless of this timer.
		const tokenRefreshCron: Cron = { expression: '0 */4 * * * *' as CronExpression };
		this.helpers.registerCron(tokenRefreshCron, () => {
			client.refreshAccessToken().catch((error: Error) => {
				this.logger.warn(`Hikyaku Delivery Status Trigger: token refresh failed: ${error.message}`);
			});
		});

		await client.connect();

		async function closeFunction() {
			client.close();
		}

		async function manualTriggerFunction() {
			// The connection above is already live and listening — nothing further to do.
			// n8n's editor will show "Waiting for trigger event" until a real delivery
			// status change comes through, same as any other listening trigger.
		}

		return {
			closeFunction,
			manualTriggerFunction,
		};
	}
}
