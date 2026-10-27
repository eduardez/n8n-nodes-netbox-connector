import type { INodeProperties } from 'n8n-workflow';

const operationDisplay = { show: { resource: ['helpers'] } };

function helperField(
	displayName: string,
	name: string,
	type: INodeProperties['type'],
	operation: string,
	options: Partial<INodeProperties> = {},
): INodeProperties {
	return {
		displayName,
		name,
		type,
		default: '',
		displayOptions: { show: { resource: ['helpers'], operation: [operation] } },
		...options,
	};
}

export function buildHelperProperties(): INodeProperties[] {
	const operations = [
		{ name: 'Get Available IPs', value: 'availableIps' },
		{ name: 'Allocate IP', value: 'allocateIp' },
		{ name: 'Get Available Prefixes', value: 'availablePrefixes' },
		{ name: 'Allocate Prefix', value: 'allocatePrefix' },
		{ name: 'Assign IP to Interface', value: 'assignIpToInterface' },
	];
	const properties: INodeProperties[] = [
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: operations,
			default: 'availableIps',
			displayOptions: operationDisplay,
		},
	];

	const parentOperations = ['availableIps', 'allocateIp'];
	properties.push(
		{
			...helperField('Parent Type', 'parentType', 'options', 'availableIps', {
				options: [{ name: 'Prefix', value: 'prefix' }, { name: 'IP Range', value: 'ipRange' }],
				required: true,
			}),
		},
		{
			...helperField('Parent Type', 'parentType', 'options', 'allocateIp', {
				options: [{ name: 'Prefix', value: 'prefix' }, { name: 'IP Range', value: 'ipRange' }],
				required: true,
			}),
		},
	);
	for (const operation of parentOperations) {
		properties.push(helperField('Parent ID', 'parentId', 'number', operation, { required: true, typeOptions: { minValue: 1 } }));
	}
	properties.push(
		helperField('Prefix ID', 'prefixId', 'number', 'availablePrefixes', { required: true, typeOptions: { minValue: 1 } }),
		helperField('Prefix ID', 'prefixId', 'number', 'allocatePrefix', { required: true, typeOptions: { minValue: 1 } }),
		helperField('Request Body', 'requestBody', 'json', 'allocateIp', {
			default: [],
			description: 'JSON array of available-IP request objects. Each entry may include prefix_length.',
		}),
		helperField('Request Body', 'requestBody', 'json', 'allocatePrefix', {
			default: [],
			required: true,
			description: 'JSON array of prefix request objects; each entry requires a safe-integer prefix_length.',
		}),
		helperField('IP ID', 'ipId', 'number', 'assignIpToInterface', { required: true, typeOptions: { minValue: 1 } }),
		helperField('Interface ID', 'interfaceId', 'number', 'assignIpToInterface', { required: true, typeOptions: { minValue: 1 } }),
	);
	for (const operation of operations) {
		properties.push(helperField('Timeout', 'timeout', 'number', operation.value, {
			default: 30000,
			typeOptions: { minValue: 1 },
			description: 'Request timeout in milliseconds.',
		}));
		properties.push(helperField('Include Response Metadata', 'includeResponseMetadata', 'boolean', operation.value, {
			default: false,
			description: 'Return one item containing the raw response body, status code, and headers.',
		}));
	}
	return properties;
}
