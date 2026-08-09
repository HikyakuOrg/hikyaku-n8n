import type { ICredentialType, INodeProperties } from 'n8n-workflow';

// The developer deploying this node sets these here before building.
// Cloud's community-node sandbox doesn't allow reading from reading process.env/.env
const HIKYAKU_SUPABASE_URL = 'https://nwxhmbdcslrpgdsxckys.supabase.co';
const HIKYAKU_SUPABASE_PUBLISHABLE_ID = 'sb_publishable_lJYkyOx1k7XSi_vwokwe1g_XQtvLoDj';
const HIKYAKU_CLIENT_ID = 'd4161efe-7d13-40f4-9f8b-e21626441dce';

// Authenticates against Supabase's OAuth 2.1 Server (PKCE, no client secret) so each
// tenant authorizes with their own Hikyaku login. The resulting session is a normal
// Supabase JWT, so existing RLS (is_org_member) scopes every request to that tenant's
// organisation automatically
export class HikyakuOAuth2Api implements ICredentialType {
	name = 'hikyakuOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'Hikyaku OAuth2 API';

	icon = {
		light: 'file:icons/hikyakuOAuth2Api.light.svg',
		dark: 'file:icons/hikyakuOAuth2Api.dark.svg',
	} as const;

	documentationUrl = 'https://hikyaku.org';

	// Everything below is deployment config. The tenant's only
	// interaction with this credential is clicking "Connect my account" and logging into
	// Hikyaku. Supabase credentials are set once above by the developer
	// so they never show up as fields the tenant has to fill in.
	properties: INodeProperties[] = [
		{
			displayName: 'Supabase Project URL',
			name: 'supabaseUrl',
			type: 'hidden',
			default: HIKYAKU_SUPABASE_URL,
		},
		{
			displayName: 'Supabase Publishable Key',
			name: 'anonKey',
			type: 'hidden',
			default: HIKYAKU_SUPABASE_PUBLISHABLE_ID,
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: HIKYAKU_CLIENT_ID,
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: '={{$self["supabaseUrl"] + "/auth/v1/oauth/authorize"}}',
			required: true,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: '={{$self["supabaseUrl"] + "/auth/v1/oauth/token"}}',
			required: true,
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'hidden',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'openid',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
	];
}
