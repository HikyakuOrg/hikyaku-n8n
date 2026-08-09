import type {
	IDataObject,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

interface HikyakuOAuth2Credentials {
	supabaseUrl: string;
	anonKey: string;
}

interface PackageTimelineRow {
	id: number;
	package_id: string;
}

async function hikyakuApiRequest(
	this: IPollFunctions,
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
		description: "Starts the workflow when a package's delivery status changes",
		subtitle: '',
		defaults: {
			name: 'Delivery Status Trigger',
		},
		polling: true,
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

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const staticData = this.getWorkflowStaticData('node') as { lastId?: number };
		const isManual = this.getMode() === 'manual';
		const isFirstPoll = !isManual && staticData.lastId === undefined;

		const qs: IDataObject = { select: 'id, package_id' };
		if (isManual || isFirstPoll) {
			// Manual test run, or the very first scheduled poll: there's no cursor yet, so
			// fetch just the single most recent row instead of the entire history.
			qs.order = 'id.desc';
			qs.limit = '1';
		} else {
			qs.id = `gt.${staticData.lastId}`;
			qs.order = 'id.asc';
			qs.limit = '50';
		}

		// package_timeline is an append-only audit log (see insert_package_timeline()) — new
		// rows are what "delivery status changed" means here; current_status on
		// packages_with_latest_status is derived from it, not stored directly.
		const timelineRows = (await hikyakuApiRequest.call(
			this,
			'package_timeline',
			qs,
		)) as unknown as PackageTimelineRow[];

		if (isFirstPoll) {
			// Establish a baseline without emitting — a freshly activated trigger should only
			// fire on changes and not replay existing history.
			staticData.lastId = timelineRows[0]?.id ?? 0;
			return null;
		}

		if (!isManual) {
			staticData.lastId = timelineRows.reduce(
				(max, row) => Math.max(max, row.id),
				staticData.lastId ?? 0,
			);
		}

		if (timelineRows.length === 0) return null;

		const returnData: INodeExecutionData[] = [];
		for (const row of timelineRows) {
			// packages_with_latest_status carries current_status plus the customer/warehouse
			// context the timeline row alone doesn't have. RLS (is_org_member) scopes this
			// request to the authenticated tenant the same way it scopes the frontend.
			const [packageRow] = await hikyakuApiRequest.call(this, 'packages_with_latest_status', {
				select: 'id, from_customer, to_customer, warehouse_id, current_status',
				id: `eq.${row.package_id}`,
			});
			if (packageRow) {
				returnData.push({ json: packageRow });
			}
		}

		return returnData.length ? [returnData] : null;
	}
}
