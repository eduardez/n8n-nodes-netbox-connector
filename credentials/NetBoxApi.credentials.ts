import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class NetBoxApi implements ICredentialType {
	name = 'netBoxApi';

	displayName = 'NetBox API';

	icon: Icon = 'file:netbox-logo.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://netbox.example.com',
			description: 'NetBox deployment root, optionally including a reverse-proxy subpath. Do not append /api or /graphql.',
		},
		{
			displayName: 'Token Type',
			name: 'tokenType',
			type: 'options',
			options: [
				{ name: 'Version 2 (Bearer)', value: 'v2' },
				{ name: 'Version 1 (Token)', value: 'v1' },
			],
			default: 'v2',
			description: 'Version 2 tokens use the full nbt_<key>.<token> value. Version 1 is deprecated in NetBox 4.6 and later.',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Full v2 token (including nbt_ and key), or the plaintext v1 token.',
		},
		{
			displayName: 'Allow Unauthorized Certificates',
			name: 'allowUnauthorizedCerts',
			type: 'boolean',
			default: false,
			description: 'Skip TLS certificate validation only for trusted self-signed NetBox instances.',
		},
	];
}
