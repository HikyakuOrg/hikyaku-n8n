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

interface PackageDimensionsRow {
	weight_kg: number | null;
	height_cm: number | null;
	length_cm: number | null;
}

interface PackageRow {
	tracking_number: string | null;
	package_dimensions: PackageDimensionsRow | null;
}

interface PackageStatusRow {
	current_status: string | null;
}

export class HikyakuGetPackage implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hikyaku Get Package',
		name: 'hikyakuGetPackage',
		icon: {
			light: 'file:icons/hikyakuGetPackage.light.svg',
			dark: 'file:icons/hikyakuGetPackage.dark.svg',
		},
		group: ['transform'],
		version: 1,
		description: 'Looks up a Hikyaku package by ID and adds its dimensions, tracking number, and status to the item',
		subtitle: '',
		defaults: {
			name: 'Get Package',
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
				displayName: 'Package ID',
				name: 'packageId',
				type: 'string',
				default: '={{$json["id"]}}',
				required: true,
				description: 'The package UUID to look up, e.g. the ID field from the Delivery Status Trigger',
			},
			{
				displayName: 'Output Field Prefix',
				name: 'outputPrefix',
				type: 'string',
				default: 'package',
				required: true,
				description: 'Results are added as "&lt;prefix&gt;_weight_kg", "&lt;prefix&gt;_height_cm", "&lt;prefix&gt;_length_cm", "&lt;prefix&gt;_tracking_number" and "&lt;prefix&gt;_status"',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials<HikyakuOAuth2Credentials>('hikyakuOAuth2Api');

		for (let i = 0; i < items.length; i++) {
			const packageId = this.getNodeParameter('packageId', i) as string;
			const outputPrefix = this.getNodeParameter('outputPrefix', i) as string;

			try {
				let pkg: PackageRow | undefined;
				let status: PackageStatusRow | undefined;

				if (packageId) {
					const packageOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `${credentials.supabaseUrl}/rest/v1/packages`,
						headers: { apikey: credentials.anonKey },
						qs: {
							select: 'tracking_number,package_dimensions(weight_kg,height_cm,length_cm)',
							id: `eq.${packageId}`,
						},
						json: true,
					};
					const statusOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `${credentials.supabaseUrl}/rest/v1/packages_with_latest_status`,
						headers: { apikey: credentials.anonKey },
						qs: {
							select: 'current_status',
							id: `eq.${packageId}`,
						},
						json: true,
					};

					const [packageRows, statusRows] = (await Promise.all([
						this.helpers.httpRequestWithAuthentication.call(
							this,
							'hikyakuOAuth2Api',
							packageOptions,
						),
						this.helpers.httpRequestWithAuthentication.call(
							this,
							'hikyakuOAuth2Api',
							statusOptions,
						),
					])) as [PackageRow[], PackageStatusRow[]];

					pkg = packageRows[0];
					status = statusRows[0];
				}

				returnData.push({
					json: {
						...items[i].json,
						[`${outputPrefix}_weight_kg`]: pkg?.package_dimensions?.weight_kg ?? null,
						[`${outputPrefix}_height_cm`]: pkg?.package_dimensions?.height_cm ?? null,
						[`${outputPrefix}_length_cm`]: pkg?.package_dimensions?.length_cm ?? null,
						[`${outputPrefix}_tracking_number`]: pkg?.tracking_number ?? null,
						[`${outputPrefix}_status`]: status?.current_status ?? null,
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
