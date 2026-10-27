export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type ApiParameterLocation = 'path' | 'query' | 'header' | 'cookie';
export type ApiParameterKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
export type ApiParameterStyle = 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';

export interface ApiParameter {
	name: string;
	location: ApiParameterLocation;
	kind: ApiParameterKind;
	required: boolean;
	description?: string;
	enumValues?: unknown[];
	defaultValue?: unknown;
	style?: ApiParameterStyle;
	explode?: boolean;
	deprecated?: boolean;
	schema?: unknown;
}

export interface ApiRequestMediaType {
	contentType: string;
	schema?: unknown;
	binaryFields: string[];
	requiredBinaryFields: string[];
}

export interface ApiRequestBody {
	required: boolean;
	contentTypes: ApiRequestMediaType[];
}

export interface ApiResponseVariant {
	statusCode: string;
	contentType: string;
	schema?: unknown;
}

export interface ApiOperation {
	id: string;
	resource: string;
	resourceLabel: string;
	summary: string;
	label: string;
	method: ApiMethod;
	path: string;
	pathParameters: ApiParameter[];
	queryParameters: ApiParameter[];
	headerParameters: ApiParameter[];
	requestBody?: ApiRequestBody;
	responses: ApiResponseVariant[];
	paginated: boolean;
	deprecated: boolean;
}

export interface ApiResource {
	value: string;
	label: string;
}
