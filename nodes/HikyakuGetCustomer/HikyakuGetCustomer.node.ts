import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

interface HikyakuOAuth2Credentials {
	supabaseUrl: string;
	anonKey: string;
}

interface CustomerRow {
	customer_name: string | null;
	customer_phone: string | null;
	customer_email: string | null;
}

export class HikyakuGetCustomer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hikyaku Get Customer',
		name: 'hikyakuGetCustomer',
		icon: {
			light: 'file:icons/hikyakuGetCustomer.light.svg',
			dark: 'file:icons/hikyakuGetCustomer.dark.svg',
		},
		group: ['transform'],
		version: 1,
		description: 'Looks up a Hikyaku customer by ID and adds their name, phone, and email to the item',
		subtitle: '',
		defaults: {
			name: 'Get Customer',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'hikyakuOAuth2Api',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Customer ID',
				name: 'customerId',
				type: 'string',
				default: '={{$json["from_customer"]}}',
				required: true,
				description: 'The customer UUID to look up, e.g. the from_customer or to_customer field from the Delivery Status Trigger',
			},
			{
				displayName: 'Output Field Prefix',
				name: 'outputPrefix',
				type: 'string',
				default: 'customer',
				required: true,
				description: 'Results are added as "&lt;prefix&gt;_name", "&lt;prefix&gt;_phone_number" and "&lt;prefix&gt;_email" — use e.g. "from_customer" and add this node twice to enrich both sides of a delivery',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials<HikyakuOAuth2Credentials>('hikyakuOAuth2Api');

		for (let i = 0; i < items.length; i++) {
			const customerId = this.getNodeParameter('customerId', i) as string;
			const outputPrefix = this.getNodeParameter('outputPrefix', i) as string;

			try {
				let customer: CustomerRow | undefined;

				if (customerId) {
					const options: IHttpRequestOptions = {
						method: 'GET',
						url: `${credentials.supabaseUrl}/rest/v1/customer`,
						headers: { apikey: credentials.anonKey },
						qs: {
							select: 'customer_name,customer_phone,customer_email',
							id: `eq.${customerId}`,
						},
						json: true,
					};
					const rows = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'hikyakuOAuth2Api',
						options,
					)) as CustomerRow[];
					customer = rows[0];
				}

				returnData.push({
					json: {
						...items[i].json,
						[`${outputPrefix}_name`]: customer?.customer_name ?? null,
						[`${outputPrefix}_phone_number`]: customer?.customer_phone ?? null,
						[`${outputPrefix}_email`]: customer?.customer_email ?? null,
					} as IDataObject,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { ...items[i].json, error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
