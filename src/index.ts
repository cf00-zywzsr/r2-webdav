/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { DOMParser } from '@xmldom/xmldom';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
	SESSION_SECRET?: string;
	SESSION_MAX_AGE?: string;
}

async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			yield object;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

type LockDetails = {
	token: string;
	owner: string | undefined;
	scope: 'exclusive' | 'shared';
	depth: '0' | 'infinity';
	timeout: string;
	expiresAt: number;
	root: string;
};

type DeadProperty = {
	namespaceURI: string;
	localName: string;
	prefix: string | null;
	valueXml: string;
};

type PropfindRequest =
	| {
			mode: 'allprop';
	  }
	| {
			mode: 'propname';
	  }
	| {
			mode: 'prop';
			properties: DeadProperty[];
	  };

type ProppatchOperation = {
	action: 'set' | 'remove';
	property: DeadProperty;
};

const DEFAULT_LOCK_TIMEOUT = 3600;
const MAX_LOCK_TIMEOUT = 365 * 24 * 60 * 60;
const VALID_LOCK_DEPTHS = ['0', 'infinity'] as const;
const LOCK_METADATA_KEYS = [
	'lock_token',
	'lock_owner',
	'lock_scope',
	'lock_depth',
	'lock_timeout',
	'lock_expires_at',
	'lock_root',
	'lock_records',
];
const INTERNAL_DELETE_FORWARD_HEADERS = ['If', 'Lock-Token'] as const;
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
const DAV_NAMESPACE = 'DAV:';
const DEAD_PROPERTY_PREFIX = 'dead_property:';
const LOCK_RECORDS_METADATA_KEY = 'lock_records';
const LOGIN_PATH = '/__login';
const LOGOUT_PATH = '/__logout';
const ACTION_PREFIX = '/__actions';
const MKDIR_ACTION_PATH = `${ACTION_PREFIX}/mkdir`;
const DELETE_ACTION_PATH = `${ACTION_PREFIX}/delete`;
const RENAME_ACTION_PATH = `${ACTION_PREFIX}/rename`;
const AUTH_COOKIE_NAME = 'r2_webdav_session';
const AUTH_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const RESERVED_PATHS = new Set(['__login', '__logout', '__actions']);
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const loginAttempts = new Map<string, { failures: number; windowStartedAt: number; lockedUntil: number }>();

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function isReservedResourcePath(resourcePath: string): boolean {
	let firstSegment = resourcePath.split('/')[0];
	return RESERVED_PATHS.has(firstSegment);
}

function getResourceHref(key: string, isCollection: boolean): string {
	const encodeHrefPath = (href: string): string => {
		if (href === '/') {
			return '/';
		}
		return href
			.split('/')
			.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
			.join('/');
	};

	if (key === '') {
		return '/';
	}
	return encodeHrefPath(`/${key + (isCollection ? '/' : '')}`);
}

function decodeResourcePath(pathname: string): string {
	let resourcePath = pathname.slice(1);
	resourcePath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	if (resourcePath === '') {
		return '';
	}
	return resourcePath
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

function getParentPath(resourcePath: string): string {
	let normalizedPath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	return normalizedPath.split('/').slice(0, -1).join('/');
}

async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	return resource?.customMetadata?.resourcetype === '<collection />';
}

function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

function createdResponse(
	resourcePath: string,
	isCollection: boolean,
	body: BodyInit | null = '',
	headers: HeadersInit = {},
): Response {
	let responseHeaders = new Headers(headers);
	responseHeaders.set('Location', getResourceHref(resourcePath, isCollection));
	return new Response(body, {
		status: 201,
		headers: responseHeaders,
	});
}

function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	if (value === undefined) {
		return null;
	}
	return JSON.parse(value) as DeadProperty;
}

function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	if (metadata === undefined) {
		return [];
	}
	return Object.entries(metadata)
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.map(([, value]) => JSON.parse(value) as DeadProperty);
}

function renderPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration}>${property.valueXml}</${qualifiedName}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration} />`;
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	if (errors.length > 0) {
		return null;
	}
	return document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propfind') {
		return null;
	}
	let propfindChildren = getChildElements(document.documentElement);
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'propname')) {
		return { mode: 'propname' };
	}
	let propElement = propfindChildren.find((child) => child.localName.toLowerCase() === 'prop');
	if (propElement !== undefined) {
		let properties = getChildElements(propElement).map(getElementProperty);
		if (properties.some((property) => property === null)) {
			return null;
		}
		return {
			mode: 'prop',
			properties: properties as DeadProperty[],
		};
	}
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'allprop')) {
		return { mode: 'allprop' };
	}
	return null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propertyupdate') {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase();
		if (action !== 'set' && action !== 'remove') {
			continue;
		}
		let propElement = getChildElements(actionElement).find((child) => child.localName.toLowerCase() === 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

function getSupportedLock(): string {
	return [
		'<lockentry><lockscope><exclusive /></lockscope><locktype><write /></locktype></lockentry>',
		'<lockentry><lockscope><shared /></lockscope><locktype><write /></locktype></lockentry>',
	].join('');
}

function determineLockDepth(
	resourceType: string | undefined,
	depthHeader: (typeof VALID_LOCK_DEPTHS)[number] | null,
): '0' | 'infinity' {
	if (resourceType === '<collection />') {
		return depthHeader ?? 'infinity';
	}
	return depthHeader === 'infinity' ? 'infinity' : '0';
}

function normalizeLockToken(lockToken: string): string {
	return lockToken
		.trim()
		.replace(/^<|>$/g, '')
		.replace(/^(?:urn:uuid:|opaquelocktoken:)/, '');
}

function normalizeLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails | null {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = Date.now() + DEFAULT_LOCK_TIMEOUT * 1000;
	}
	if (expiresAt <= Date.now()) {
		return null;
	}

	return {
		token: lockDetails.token,
		owner: lockDetails.owner,
		scope: lockDetails.scope === 'shared' ? 'shared' : 'exclusive',
		depth: lockDetails.depth === 'infinity' ? 'infinity' : '0',
		timeout: lockDetails.timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt,
		root: lockDetails.root ?? '/',
	};
}

function getLockDetails(customMetadata: Record<string, string> | undefined): LockDetails[] {
	let records = customMetadata?.[LOCK_RECORDS_METADATA_KEY];
	if (records !== undefined) {
		try {
			let parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) => {
					if (lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string') {
						let normalized = normalizeLockDetails(lockDetails as Partial<LockDetails> & Pick<LockDetails, 'token'>);
						return normalized === null ? [] : [normalized];
					}
					return [];
				});
			}
		} catch {}
	}

	let token = customMetadata?.lock_token;
	if (token === undefined) {
		return [];
	}

	let normalized = normalizeLockDetails({
		token,
		owner: customMetadata?.lock_owner,
		scope: customMetadata?.lock_scope === 'shared' ? 'shared' : 'exclusive',
		depth: customMetadata?.lock_depth === 'infinity' ? 'infinity' : '0',
		timeout: customMetadata?.lock_timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Number(customMetadata?.lock_expires_at ?? 0),
		root: customMetadata?.lock_root ?? '/',
	});
	return normalized === null ? [] : [normalized];
}

function getLockDiscovery(lockDetails: LockDetails | LockDetails[]): string {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	return lockDetailList
		.map(
			(lockDetail) =>
				`<activelock><locktype><write /></locktype><lockscope><${lockDetail.scope} /></lockscope><depth>${lockDetail.depth}</depth>${lockDetail.owner ? `<owner>${escapeXml(lockDetail.owner)}</owner>` : ''}<timeout>${escapeXml(lockDetail.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lockDetail.token)}</href></locktoken><lockroot><href>${escapeXml(lockDetail.root)}</href></lockroot></activelock>`,
		)
		.join('');
}

function stripLockMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = customMetadata ? { ...customMetadata } : {};
	for (const key of LOCK_METADATA_KEYS) {
		delete metadata[key];
	}
	return metadata;
}

function withLockMetadata(
	customMetadata: Record<string, string> | undefined,
	lockDetails: LockDetails | LockDetails[],
): Record<string, string> {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	if (lockDetailList.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return {
		...stripLockMetadata(customMetadata),
		[LOCK_RECORDS_METADATA_KEY]: JSON.stringify(lockDetailList),
	};
}

function getPreservedCustomMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let lockDetails = getLockDetails(customMetadata);
	if (lockDetails.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return withLockMetadata(customMetadata, lockDetails);
}

function isProtectedProperty(propName: string | DeadProperty): boolean {
	let localPropName = typeof propName === 'string' ? (propName.split(':').pop() ?? propName) : propName.localName;
	return (
		LOCK_METADATA_KEYS.includes(localPropName) || localPropName === 'supportedlock' || localPropName === 'lockdiscovery'
	);
}

function isValidXmlTagName(propName: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9._:-]*$/.test(propName);
}

function parseTimeout(timeoutHeader: string | null): { timeout: string; expiresAt: number } {
	if (timeoutHeader === null) {
		return {
			timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
			expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
		};
	}

	for (const item of timeoutHeader.split(',').map((value) => value.trim())) {
		if (item.toLowerCase() === 'infinite') {
			return {
				timeout: 'Infinite',
				expiresAt: Date.now() + MAX_LOCK_TIMEOUT * 1000,
			};
		}

		let seconds = Number(item.match(/^Second-(\d+)$/i)?.[1] ?? NaN);
		if (Number.isFinite(seconds) && seconds > 0) {
			seconds = Math.min(seconds, MAX_LOCK_TIMEOUT);
			return {
				timeout: `Second-${seconds}`,
				expiresAt: Date.now() + seconds * 1000,
			};
		}
	}

	return {
		timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
	};
}

function getRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}

	let ifHeader = request.headers.get('If');
	if (ifHeader) {
		for (const match of ifHeader.matchAll(/<([^>]+)>/g)) {
			let token = normalizeLockToken(match[1]);
			if (token !== '') {
				lockTokens.push(token);
			}
		}
	}

	return [...new Set(lockTokens)];
}

function hasAlwaysFalseIfCondition(request: Request): boolean {
	let ifHeader = request.headers.get('If') ?? '';
	return ifHeader.includes('<DAV:no-lock>') && !ifHeader.includes('Not <DAV:no-lock>');
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

function getCookieValue(cookieHeader: string | null, name: string): string | null {
	if (cookieHeader === null) {
		return null;
	}
	for (const cookie of cookieHeader.split(';')) {
		let [cookieName, ...valueParts] = cookie.trim().split('=');
		if (cookieName === name) {
			try {
				return decodeURIComponent(valueParts.join('='));
			} catch {
				return null;
			}
		}
	}
	return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function getSessionSecret(env: Env): string {
	return env.SESSION_SECRET ?? env.PASSWORD;
}

function getSessionMaxAgeSeconds(env: Env): number {
	let configuredMaxAge = Number(env.SESSION_MAX_AGE);
	if (!Number.isFinite(configuredMaxAge) || configuredMaxAge <= 0) {
		return AUTH_SESSION_MAX_AGE_SECONDS;
	}
	return Math.min(Math.floor(configuredMaxAge), 30 * 24 * 60 * 60);
}

async function signSessionToken(username: string, sessionSecret: string, issuedAt: number): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(sessionSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${username}:${issuedAt}`));
	return `${issuedAt}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function createSessionCookie(
	username: string,
	sessionSecret: string,
	sessionMaxAgeSeconds: number,
	requestUrl: string,
): Promise<string> {
	let token = await signSessionToken(username, sessionSecret, Date.now());
	let secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
	return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secure}`;
}

function clearSessionCookie(requestUrl: string): string {
	let secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
	return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function isCredentialPairAuthorized(
	username: string,
	password: string,
	expectedUsername: string,
	expectedPassword: string,
): boolean {
	const encoder = new TextEncoder();
	return timingSafeEqual(
		encoder.encode(`${username}:${password}`),
		encoder.encode(`${expectedUsername}:${expectedPassword}`),
	);
}

async function isValidSessionCookie(
	cookieHeader: string | null,
	username: string,
	sessionSecret: string,
	sessionMaxAgeSeconds: number,
): Promise<boolean> {
	let token = getCookieValue(cookieHeader, AUTH_COOKIE_NAME);
	if (token === null) {
		return false;
	}

	let tokenParts = token.split('.');
	if (tokenParts.length !== 2) {
		return false;
	}

	let [issuedAtText] = tokenParts;
	let issuedAt = Number(issuedAtText);
	if (!Number.isFinite(issuedAt)) {
		return false;
	}

	let now = Date.now();
	if (issuedAt > now || now - issuedAt > sessionMaxAgeSeconds * 1000) {
		return false;
	}

	let expected = await signSessionToken(username, sessionSecret, issuedAt);
	return timingSafeEqual(new TextEncoder().encode(token), new TextEncoder().encode(expected));
}

function getSafeNextPath(request: Request): string {
	let url = new URL(request.url);
	let next = url.searchParams.get('next') ?? '/';
	try {
		let nextUrl = new URL(next, url.origin);
		if (nextUrl.origin !== url.origin || nextUrl.pathname === LOGIN_PATH) {
			return '/';
		}
		return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}` || '/';
	} catch {
		return '/';
	}
}

function getCurrentPathWithSearch(request: Request): string {
	let url = new URL(request.url);
	return `${url.pathname}${url.search}${url.hash}` || '/';
}

function redirectResponse(location: string, status: 302 | 303 = 302, headers: HeadersInit = {}): Response {
	return new Response(null, {
		status,
		headers: {
			Location: location,
			'Cache-Control': 'no-store',
			...headers,
		},
	});
}

function applySecurityHeaders(response: Response, options: { contentSecurityPolicy?: boolean } = {}): Response {
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Frame-Options', 'DENY');
	if (options.contentSecurityPolicy) {
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
	}
	return response;
}

function isSameOriginFormPost(request: Request): boolean {
	let requestUrl = new URL(request.url);
	let origin = request.headers.get('Origin');
	if (origin !== null) {
		return origin === requestUrl.origin;
	}

	let referer = request.headers.get('Referer');
	if (referer !== null) {
		try {
			return new URL(referer).origin === requestUrl.origin;
		} catch {
			return false;
		}
	}

	return true;
}

function shouldUseLoginPage(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return false;
	}
	let accept = request.headers.get('Accept') ?? '';
	let userAgent = request.headers.get('User-Agent') ?? '';
	return accept.includes('text/html') || userAgent.toLowerCase().includes('mozilla');
}

function getLoginClientId(request: Request): string {
	return (
		request.headers.get('CF-Connecting-IP') ??
		request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
		'unknown'
	);
}

function isLoginRateLimited(request: Request): boolean {
	let clientId = getLoginClientId(request);
	let attempt = loginAttempts.get(clientId);
	if (attempt === undefined) {
		return false;
	}
	let now = Date.now();
	if (attempt.lockedUntil > now) {
		return true;
	}
	if (now - attempt.windowStartedAt > LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000) {
		loginAttempts.delete(clientId);
	}
	return false;
}

function recordLoginFailure(request: Request): void {
	let clientId = getLoginClientId(request);
	let now = Date.now();
	let attempt = loginAttempts.get(clientId);
	if (attempt === undefined || now - attempt.windowStartedAt > LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000) {
		attempt = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
	}
	attempt.failures += 1;
	if (attempt.failures >= LOGIN_RATE_LIMIT_MAX_FAILURES) {
		attempt.lockedUntil = now + LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
	}
	loginAttempts.set(clientId, attempt);
}

function clearLoginFailures(request: Request): void {
	loginAttempts.delete(getLoginClientId(request));
}

function renderLoginPage(nextPath: string, errorMessage: string | null = null, status: number | null = null): Response {
	let error = errorMessage ? `<div class="error" role="alert">${escapeXml(errorMessage)}</div>` : '';
	let page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width,initial-scale=1.0">
	<title>登录 R2 Storage</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		body {
			min-height: 100vh;
			margin: 0;
			display: grid;
			place-items: center;
			background: linear-gradient(135deg, #0f172a, #1e3a8a 45%, #0f766e);
			font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
			color: #0f172a;
			padding: 24px;
		}
		.card {
			width: min(100%, 420px);
			padding: 32px;
			border-radius: 24px;
			background: rgba(255, 255, 255, 0.94);
			box-shadow: 0 24px 70px rgba(15, 23, 42, 0.35);
			backdrop-filter: blur(16px);
		}
		h1 { margin: 0 0 8px; font-size: 28px; }
		p { margin: 0 0 24px; color: #64748b; line-height: 1.6; }
		label { display: block; margin: 18px 0 8px; font-weight: 700; }
		input {
			width: 100%;
			padding: 13px 14px;
			border: 1px solid #cbd5e1;
			border-radius: 12px;
			font: inherit;
			background: #fff;
			color: #0f172a;
			outline: none;
		}
		input:focus {
			border-color: #2563eb;
			box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16);
		}
		button {
			width: 100%;
			margin-top: 24px;
			border: 0;
			border-radius: 12px;
			padding: 14px 16px;
			font: inherit;
			font-weight: 800;
			color: #fff;
			background: linear-gradient(135deg, #2563eb, #0f766e);
			cursor: pointer;
		}
		button:hover { filter: brightness(1.05); }
		.error {
			margin: 0 0 18px;
			padding: 12px 14px;
			border-radius: 12px;
			background: #fee2e2;
			color: #991b1b;
			font-weight: 700;
		}
		.hint { margin-top: 18px; font-size: 13px; color: #64748b; text-align: center; }
	</style>
</head>
<body>
	<main class="card">
		<h1>登录 R2 Storage</h1>
		<p>请输入 WebDAV 用户名和密码，登录后会回到原访问路径。</p>
		${error}
		<form method="post" action="${LOGIN_PATH}?next=${encodeURIComponent(nextPath)}" autocomplete="on">
			<label for="username">用户名</label>
			<input id="username" name="username" type="text" autocomplete="username" required autofocus>
			<label for="password">密码</label>
			<input id="password" name="password" type="password" autocomplete="current-password" required>
			<button type="submit">登录</button>
		</form>
		<div class="hint">WebDAV 客户端仍可继续使用 Basic Auth。</div>
	</main>
</body>
</html>`;
	return new Response(page, {
		status: status ?? (errorMessage === null ? 200 : 401),
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

async function handleLoginRoute(
	request: Request,
	username: string,
	password: string,
	sessionSecret: string,
	sessionMaxAgeSeconds: number,
): Promise<Response> {
	if (request.method === 'GET' || request.method === 'HEAD') {
		return renderLoginPage(getSafeNextPath(request));
	}

	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { Allow: 'GET, HEAD, POST' },
		});
	}
	if (!isSameOriginFormPost(request)) {
		return new Response('Forbidden', { status: 403 });
	}
	if (isLoginRateLimited(request)) {
		return renderLoginPage(getSafeNextPath(request), '登录失败次数过多，请稍后再试。', 429);
	}

	let nextPath = getSafeNextPath(request);
	let form = await request.formData();
	let submittedUsername = String(form.get('username') ?? '');
	let submittedPassword = String(form.get('password') ?? '');

	if (!isCredentialPairAuthorized(submittedUsername, submittedPassword, username, password)) {
		recordLoginFailure(request);
		return renderLoginPage(nextPath, '用户名或密码不正确，请重试。');
	}
	clearLoginFailures(request);

	return redirectResponse(nextPath, 303, {
		'Set-Cookie': await createSessionCookie(username, sessionSecret, sessionMaxAgeSeconds, request.url),
	});
}

function handleLogoutRoute(request: Request): Response {
	if (!isSameOriginFormPost(request)) {
		return new Response('Forbidden', { status: 403 });
	}
	return redirectResponse(`${LOGIN_PATH}?next=/`, 303, {
		'Set-Cookie': clearSessionCookie(request.url),
	});
}

function getFormValue(form: FormData, name: string): string {
	let value = form.get(name);
	return typeof value === 'string' ? value : '';
}

function normalizeFormResourcePath(value: string): string {
	return value.replace(/^\/+|\/+$/g, '');
}

function normalizeEntryName(value: string): string | null {
	let name = value.trim();
	if (
		name === '' ||
		name === '.' ||
		name === '..' ||
		name.includes('/') ||
		name.includes('\\') ||
		name.includes('\0')
	) {
		return null;
	}
	return name;
}

function joinResourcePath(parentPath: string, name: string): string {
	return parentPath === '' ? name : `${parentPath}/${name}`;
}

function getRequestOrigin(request: Request): string {
	return new URL(request.url).origin;
}

function getResourceUrl(request: Request, resourcePath: string, isCollection: boolean): string {
	return new URL(getResourceHref(resourcePath, isCollection), getRequestOrigin(request)).toString();
}

function redirectToCollection(request: Request, resourcePath: string, params: Record<string, string>): Response {
	let url = new URL(getResourceHref(resourcePath, true), getRequestOrigin(request));
	for (const [name, value] of Object.entries(params)) {
		url.searchParams.set(name, value);
	}
	return redirectResponse(`${url.pathname}${url.search}`, 303);
}

function badManagementRequest(request: Request, parentPath: string, message: string): Response {
	return redirectToCollection(request, parentPath, { error: message });
}

async function handleMkdirAction(request: Request, bucket: R2Bucket): Promise<Response> {
	let form = await request.formData();
	let parentPath = normalizeFormResourcePath(getFormValue(form, 'parent'));
	let name = normalizeEntryName(getFormValue(form, 'name'));
	if (name === null) {
		return badManagementRequest(request, parentPath, '文件夹名称无效');
	}

	let targetPath = joinResourcePath(parentPath, name);
	if (isReservedResourcePath(targetPath)) {
		return badManagementRequest(request, parentPath, '该名称为系统保留路径');
	}
	if (await bucket.head(targetPath)) {
		return badManagementRequest(request, parentPath, '目标已存在');
	}

	let response = await handle_mkcol(
		new Request(getResourceUrl(request, targetPath, true), {
			method: 'MKCOL',
			headers: request.headers,
		}),
		bucket,
	);
	if (!response.ok) {
		return badManagementRequest(request, parentPath, `创建失败：${response.status}`);
	}
	return redirectToCollection(request, parentPath, { notice: '文件夹已创建' });
}

async function handleDeleteAction(request: Request, bucket: R2Bucket): Promise<Response> {
	let form = await request.formData();
	let targetPath = normalizeFormResourcePath(getFormValue(form, 'target'));
	if (targetPath === '' || isReservedResourcePath(targetPath)) {
		return badManagementRequest(request, getParentPath(targetPath), '删除目标无效');
	}

	let target = await bucket.head(targetPath);
	if (target === null) {
		return badManagementRequest(request, getParentPath(targetPath), '目标不存在');
	}

	let isCollection = target.customMetadata?.resourcetype === '<collection />';
	let response = await handle_delete(
		new Request(getResourceUrl(request, targetPath, isCollection), {
			method: 'DELETE',
			headers: request.headers,
		}),
		bucket,
	);
	if (!response.ok) {
		return badManagementRequest(request, getParentPath(targetPath), `删除失败：${response.status}`);
	}
	return redirectToCollection(request, getParentPath(targetPath), { notice: '已删除' });
}

async function handleRenameAction(request: Request, bucket: R2Bucket): Promise<Response> {
	let form = await request.formData();
	let targetPath = normalizeFormResourcePath(getFormValue(form, 'target'));
	let parentPath = getParentPath(targetPath);
	let name = normalizeEntryName(getFormValue(form, 'name'));
	if (targetPath === '' || name === null) {
		return badManagementRequest(request, parentPath, '重命名目标无效');
	}
	if (isReservedResourcePath(targetPath)) {
		return badManagementRequest(request, parentPath, '系统保留路径不能重命名');
	}

	let destinationPath = joinResourcePath(parentPath, name);
	if (isReservedResourcePath(destinationPath)) {
		return badManagementRequest(request, parentPath, '该名称为系统保留路径');
	}
	if (destinationPath === targetPath) {
		return redirectToCollection(request, parentPath, { notice: '名称未变化' });
	}
	if (await bucket.head(destinationPath)) {
		return badManagementRequest(request, parentPath, '目标名称已存在');
	}

	let target = await bucket.head(targetPath);
	if (target === null) {
		return badManagementRequest(request, parentPath, '目标不存在');
	}

	let isCollection = target.customMetadata?.resourcetype === '<collection />';
	let headers = new Headers(request.headers);
	headers.set('Destination', getResourceUrl(request, destinationPath, isCollection));
	headers.set('Overwrite', 'F');
	let response = await handle_move(
		new Request(getResourceUrl(request, targetPath, isCollection), {
			method: 'MOVE',
			headers,
		}),
		bucket,
	);
	if (!response.ok) {
		return badManagementRequest(request, parentPath, `重命名失败：${response.status}`);
	}
	return redirectToCollection(request, parentPath, { notice: '已重命名' });
}

async function handleActionRoute(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { Allow: 'POST' },
		});
	}
	if (!isSameOriginFormPost(request)) {
		return new Response('Forbidden', { status: 403 });
	}

	let pathname = new URL(request.url).pathname;
	switch (pathname) {
		case MKDIR_ACTION_PATH:
			return await handleMkdirAction(request, bucket);
		case DELETE_ACTION_PATH:
			return await handleDeleteAction(request, bucket);
		case RENAME_ACTION_PATH:
			return await handleRenameAction(request, bucket);
		default:
			return new Response('Not Found', { status: 404 });
	}
}

function extractLockOwner(body: string): string | undefined {
	let owner = body.match(/<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i)?.[1];
	if (owner === undefined) {
		return undefined;
	}

	owner = owner.trim();
	return owner === '' ? undefined : owner;
}

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: '<collection />',
			supportedlock: getSupportedLock(),
			lockdiscovery: '',
		};
	}

	let isCollection = object.customMetadata?.resourcetype === '<collection />';
	let lockDetails = getLockDetails(object.customMetadata);
	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
		supportedlock: getSupportedLock(),
		lockdiscovery:
			lockDetails.length === 0
				? ''
				: getLockDiscovery(
						lockDetails.map((lockDetail) => ({
							...lockDetail,
							root: getResourceHref(object.key, isCollection),
						})),
					),
	};
}

function getLivePropertyValue(object: R2Object | null, property: DeadProperty): string | undefined {
	if (property.namespaceURI !== DAV_NAMESPACE) {
		return undefined;
	}
	return fromR2Object(object)[property.localName as keyof DavProperties];
}

function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}

function make_resource_path(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

async function assertLockPermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): Promise<Response | null> {
	if (hasAlwaysFalseIfCondition(request)) {
		return new Response('Precondition Failed', { status: 412 });
	}
	let lockTokens = getRequestLockTokens(request);
	let candidates: string[] = [];

	for (let current = resourcePath; current !== ''; current = current.split('/').slice(0, -1).join('/')) {
		candidates.push(current);
	}

	for (const candidate of candidates) {
		let object = await bucket.head(candidate);
		let lockDetails = getLockDetails(object?.customMetadata).filter(
			(lockDetail) =>
				(candidate === resourcePath || lockDetail.depth === 'infinity') &&
				!(options.ignoreSharedLocksOnTarget && candidate === resourcePath && lockDetail.scope === 'shared'),
		);
		if (lockDetails.length === 0) {
			continue;
		}

		if (!lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function assertRecursiveDeletePermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<Response | null> {
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockTokens = getRequestLockTokens(request);
	let prefix = resourcePath === '' ? '' : resourcePath + '/';
	for await (let descendant of listAll(bucket, prefix, true)) {
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length > 0 && !lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function findMatchingLock(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<{ resource: R2Object; lockDetails: LockDetails } | null> {
	let lockTokens = getRequestLockTokens(request);
	for (let current = resourcePath; ; current = current.split('/').slice(0, -1).join('/')) {
		let resource = await bucket.head(current);
		let lockDetails = getLockDetails(resource?.customMetadata).find(
			(lockDetail) =>
				lockTokens.includes(lockDetail.token) && (current === resourcePath || lockDetail.depth === 'infinity'),
		);
		if (resource !== null && lockDetails !== undefined) {
			return { resource, lockDetails };
		}
		if (current === '') {
			break;
		}
	}
	return null;
}

function renderDirectoryMessage(request: Request): string {
	let url = new URL(request.url);
	let notice = url.searchParams.get('notice');
	let error = url.searchParams.get('error');
	if (error !== null) {
		return `<div class="message error" role="alert">${escapeXml(error)}</div>`;
	}
	if (notice !== null) {
		return `<div class="message notice" role="status">${escapeXml(notice)}</div>`;
	}
	return '';
}

function getResourceBasename(resourcePath: string): string {
	return resourcePath.split('/').pop() ?? resourcePath;
}

function renderDirectoryEntry(object: R2Object, prefix: string): string {
	let isCollection = object.customMetadata?.resourcetype === '<collection />';
	let href = getResourceHref(object.key, isCollection);
	let displayName = object.httpMetadata?.contentDisposition ?? object.key.slice(prefix.length);
	let defaultRenameValue = getResourceBasename(object.key);
	let disabled = isReservedResourcePath(object.key) ? ' disabled title="系统保留路径不能在 Web 界面管理"' : '';

	return `<div class="entry">
	<a class="entry-link" href="${escapeXml(href)}">${escapeXml(displayName)}</a>
	<div class="entry-actions">
		<form method="post" action="${RENAME_ACTION_PATH}" class="rename-form">
			<input type="hidden" name="target" value="${escapeXml(object.key)}">
			<input name="name" value="${escapeXml(defaultRenameValue)}" aria-label="新名称">
			<button type="submit"${disabled}>重命名</button>
		</form>
		<form method="post" action="${DELETE_ACTION_PATH}">
			<input type="hidden" name="target" value="${escapeXml(object.key)}">
			<button class="danger" type="submit"${disabled}>删除</button>
		</form>
	</div>
</div>`;
}

function renderDirectoryPage(request: Request, resourcePath: string, entries: string): string {
	let parentLink = resourcePath === '' ? '' : `<a class="parent-link" href="../">..</a>`;
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width,initial-scale=1.0">
	<title>R2 Storage</title>
	<style>
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 24px;
			background: #f8fafc;
			color: #0f172a;
			font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
		}
		header, .toolbar, .entry, .entry-actions, form {
			display: flex;
			align-items: center;
			gap: 10px;
		}
		header {
			justify-content: space-between;
			margin-bottom: 18px;
		}
		h1 { margin: 0; font-size: 28px; }
		.toolbar {
			flex-wrap: wrap;
			margin-bottom: 16px;
			padding: 14px;
			border: 1px solid #e2e8f0;
			border-radius: 14px;
			background: #fff;
		}
		input {
			min-width: 160px;
			border: 1px solid #cbd5e1;
			border-radius: 8px;
			padding: 8px 10px;
			font: inherit;
		}
		button {
			border: 0;
			border-radius: 8px;
			background: #2563eb;
			color: #fff;
			padding: 8px 12px;
			cursor: pointer;
			font: inherit;
			white-space: nowrap;
		}
		button:hover { filter: brightness(1.05); }
		button:disabled { cursor: not-allowed; opacity: .45; }
		button.danger { background: #dc2626; }
		button.secondary { background: #e2e8f0; color: #0f172a; }
		.message {
			margin-bottom: 16px;
			padding: 12px 14px;
			border-radius: 12px;
			font-weight: 700;
		}
		.notice { background: #dcfce7; color: #166534; }
		.error { background: #fee2e2; color: #991b1b; }
		.parent-link, .entry {
			width: 100%;
			margin-bottom: 8px;
			border-radius: 12px;
			background: #fff;
			color: #0f172a;
			text-decoration: none;
			box-shadow: 0 1px 3px rgba(15, 23, 42, .08);
		}
		.parent-link {
			display: block;
			padding: 12px 14px;
			background: #e2e8f0;
		}
		.entry {
			justify-content: space-between;
			padding: 10px;
		}
		.entry-link {
			flex: 1;
			min-width: 180px;
			color: #0f172a;
			text-decoration: none;
			padding: 8px 10px;
			border-radius: 8px;
			overflow-wrap: anywhere;
		}
		.entry-link:hover { background: #ecfdf5; color: #047857; }
		.entry-actions { flex-wrap: wrap; justify-content: flex-end; }
		.rename-form input { width: 180px; }
		@media (max-width: 760px) {
			body { padding: 14px; }
			header, .entry { align-items: stretch; flex-direction: column; }
			.entry-actions, form { width: 100%; }
			input, button, .rename-form input { width: 100%; }
		}
	</style>
</head>
<body>
	<header>
		<h1>R2 Storage</h1>
		<form method="post" action="${LOGOUT_PATH}"><button class="secondary" type="submit">退出登录</button></form>
	</header>
	${renderDirectoryMessage(request)}
	<section class="toolbar" aria-label="文件管理">
		<form method="post" action="${MKDIR_ACTION_PATH}">
			<input type="hidden" name="parent" value="${escapeXml(resourcePath)}">
			<input name="name" placeholder="新文件夹名称" aria-label="新文件夹名称" required>
			<button type="submit">创建文件夹</button>
		</form>
	</section>
	<nav>${parentLink}${entries || '<p>当前目录为空。</p>'}</nav>
</body>
</html>`;
}

async function handle_head(request: Request, bucket: R2Bucket): Promise<Response> {
	let response = await handle_get(request, bucket);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function handle_get(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (request.url.endsWith('/')) {
		if (resource_path !== '') {
			let resource = await bucket.head(resource_path);
			if (resource === null || resource.customMetadata?.resourcetype !== '<collection />') {
				return new Response('Not Found', { status: 404 });
			}
		}

		let page = '',
			prefix = resource_path === '' ? '' : `${resource_path}/`;

		for await (const object of listAll(bucket, prefix)) {
			if (object.key === resource_path) {
				continue;
			}
			page += renderDirectoryEntry(object, prefix);
		}
		let pageSource = renderDirectoryPage(request, resource_path, page);

		return new Response(pageSource, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} else {
		let object = await bucket.get(resource_path, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			const rangeRequested = request.headers.has('Range') && object.range !== undefined;
			return new Response(object.body, {
				status: rangeRequested ? 206 : 200,
				headers: {
					'Accept-Ranges': 'bytes',
					'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
					'Content-Length': contentLength.toString(),
					...(rangeRequested ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
					...(object.httpMetadata?.contentDisposition
						? {
								'Content-Disposition': object.httpMetadata.contentDisposition,
							}
						: {}),
					...(object.httpMetadata?.contentEncoding
						? {
								'Content-Encoding': object.httpMetadata.contentEncoding,
							}
						: {}),
					...(object.httpMetadata?.contentLanguage
						? {
								'Content-Language': object.httpMetadata.contentLanguage,
							}
						: {}),
					...(object.httpMetadata?.cacheControl
						? {
								'Cache-Control': object.httpMetadata.cacheControl,
							}
						: {}),
					...(object.httpMetadata?.cacheExpiry
						? {
								'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
							}
						: {}),
				},
			});
		}
	}
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handle_put(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}
	let existing = await bucket.head(resource_path);

	// Check if the parent directory exists
	let dirpath = getParentPath(resource_path);
	if (dirpath !== '') {
		let dir = await bucket.head(dirpath);
		if (!(dir && dir.customMetadata?.resourcetype === '<collection />')) {
			return new Response('Conflict', { status: 409 });
		}
	}

	let body = await request.arrayBuffer();
	await bucket.put(resource_path, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
		customMetadata: getPreservedCustomMetadata(existing?.customMetadata),
	});
	return existing === null ? new Response('', { status: 201 }) : new Response(null, { status: 204 });
}

async function handle_delete(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let lockResponse = await assertRecursiveDeletePermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	if (resource_path === '') {
		let r2_objects,
			cursor: string | undefined = undefined;
		do {
			r2_objects = await bucket.list({ cursor: cursor });
			let keys = r2_objects.objects.map((object) => object.key);
			if (keys.length > 0) {
				await bucket.delete(keys);
			}

			if (r2_objects.truncated) {
				cursor = r2_objects.cursor;
			}
		} while (r2_objects.truncated);

		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		await bucket.delete(resource_path);
		return new Response(null, { status: 204 });
	}

	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: resource_path + '/',
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);

	await bucket.delete(resource_path);
	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: R2Bucket): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the resource already exists
	let resource = await bucket.head(resource_path);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = getParentPath(resource_path);
	if (!(await hasCollectionResource(bucket, parent_dir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

function generate_propfind_response(object: R2Object | null, propfindRequest: PropfindRequest): string {
	let href =
		object === null ? '/' : getResourceHref(object.key, object.customMetadata?.resourcetype === '<collection />');
	let deadProperties = getDeadProperties(object?.customMetadata);
	let liveProperties = Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
		value === undefined ? [] : [renderDavProperty(key, value)],
	);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop': {
			okProperties = [...liveProperties, ...deadProperties.map(renderPropertyElement)];
			break;
		}
		case 'propname': {
			okProperties = [
				...Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
					value === undefined ? [] : [renderDavProperty(key, '')],
				),
				...deadProperties.map((property) => renderEmptyPropertyElement({ ...property, valueXml: '' })),
			];
			break;
		}
		case 'prop': {
			for (const property of propfindRequest.properties) {
				let liveValue = getLivePropertyValue(object, property);
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}
				let deadProperty = getDeadProperty(object?.customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
				}
			}
			break;
		}
	}

	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}

	let is_collection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null, propfindRequest);
		is_collection = true;
	} else {
		let object = await bucket.head(resource_path);
		if (object === null) {
			return new Response('Not Found', { status: 404 });
		}
		is_collection = object.customMetadata?.resourcetype === '<collection />';
		page += generate_propfind_response(object, propfindRequest);
	}

	if (is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix)) {
						page += generate_propfind_response(object, propfindRequest);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix, true)) {
						page += generate_propfind_response(object, propfindRequest);
					}
				}
				break;
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_proppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// 检查资源是否存在
	let object = await bucket.head(resource_path);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	const body = await request.text();
	let parsedRequest = parseProppatchRequest(body);
	if (parsedRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}
	const { operations } = parsedRequest;

	// 复制原有的自定义元数据
	const customMetadata = getPreservedCustomMetadata(object.customMetadata);
	const successfulSetProperties: DeadProperty[] = [];
	const failedSetProperties: DeadProperty[] = [];
	const successfulRemoveProperties: DeadProperty[] = [];
	const failedRemoveProperties: DeadProperty[] = [];

	// 更新元数据
	for (const operation of operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}
		if (operation.action === 'set') {
			customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)] =
				JSON.stringify(operation.property);
			successfulSetProperties.push(operation.property);
		} else {
			delete customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)];
			successfulRemoveProperties.push(operation.property);
		}
	}

	const hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	if (!hasFailures) {
		// 更新对象的元数据
		const src = await bucket.get(object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}

		await bucket.put(object.key, src.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: customMetadata,
		});
	}

	// 构造响应
	let propstats = new Map<string, string[]>();
	const appendPropstat = (property: DeadProperty, status: string) => {
		let props = propstats.get(status) ?? [];
		props.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
		propstats.set(status, props);
	};
	const successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';

	for (const property of successfulSetProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of successfulRemoveProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of failedSetProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	for (const property of failedRemoveProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	let responseXML = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${escapeXml(getResourceHref(object.key, object.customMetadata?.resourcetype === '<collection />'))}</href>`;
	for (const [status, propNames] of propstats) {
		responseXML += `\n\t\t<propstat>\n\t\t\t<prop>\n${propNames.map((propName) => `\t\t\t\t${propName}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`;
	}
	responseXML += '\n\t</response>\n</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_copy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const copy = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: stripLockMetadata(object.customMetadata),
						});
					}
				};
				let promise_array = [copy(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(copy(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: stripLockMetadata(object.customMetadata),
				});
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: stripLockMetadata(src.customMetadata),
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_move(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let sourceLockResponse = await assertLockPermission(request, bucket, resource_path);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.key === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destination_exists) {
		// Delete the destination first
		let deleteHeaders = new Headers();
		for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
			let headerValue = request.headers.get(headerName);
			if (headerValue !== null) {
				deleteHeaders.set(headerName, headerValue);
			}
		}
		let deleteResponse = await handle_delete(
			new Request(new URL(destination_header), {
				method: 'DELETE',
				headers: deleteHeaders,
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const move = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: getPreservedCustomMetadata(object.customMetadata),
						});
						await bucket.delete(object.key);
					}
				};
				let promise_array = [move(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(move(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: getPreservedCustomMetadata(src.customMetadata),
		});
		await bucket.delete(resource.key);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_lock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return new Response('Bad Request', { status: 400 });
	}
	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	// Per WebDAV, an empty LOCK request body indicates a lock refresh operation.
	let requestedScope: LockDetails['scope'] = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
	let requestLockTokens = getRequestLockTokens(request);
	if (body !== '' && !/<write\b/i.test(body)) {
		return new Response('Bad Request', { status: 400 });
	}
	let owner = extractLockOwner(body);
	let lockResponse = await assertLockPermission(request, bucket, resource_path, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = body === '' ? await findMatchingLock(request, bucket, resource_path) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resource_path));
	let currentLocks = getLockDetails(resource?.customMetadata);
	let existingLock = refreshTarget?.lockDetails;
	if (
		refreshTarget === null &&
		body === '' &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.includes(currentLock.token))
	) {
		return new Response('Locked', { status: 423 });
	}
	if (resource === null) {
		if (body === '') {
			return new Response('Bad Request', { status: 400 });
		}
		if (!(await hasCollectionResource(bucket, getParentPath(resource_path)))) {
			return new Response('Conflict', { status: 409 });
		}
		if (request.url.endsWith('/')) {
			return new Response('Conflict', { status: 409 });
		}

		await bucket.put(resource_path, new Uint8Array(), {
			customMetadata: {},
		});
		resource = await bucket.head(resource_path);
		currentLocks = [];
	}

	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (existingLock === undefined) {
		if (requestedScope === 'exclusive' && currentLocks.length > 0) {
			return new Response('Locked', { status: 423 });
		}
		if (requestedScope === 'shared' && currentLocks.some((lockDetail) => lockDetail.scope === 'exclusive')) {
			return new Response('Locked', { status: 423 });
		}
	}
	let depth: (typeof VALID_LOCK_DEPTHS)[number];
	if (existingLock !== undefined && depthHeader === null && body === '') {
		// Refreshing an existing lock without an explicit Depth header:
		// preserve the original lock depth instead of broadening it.
		depth = existingLock.depth;
	} else {
		depth = determineLockDepth(
			resource.customMetadata?.resourcetype,
			depthHeader as (typeof VALID_LOCK_DEPTHS)[number] | null,
		);
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
	};
	let updatedLocks =
		existingLock === undefined
			? [...currentLocks, lockDetails]
			: currentLocks.map((currentLock) => (currentLock.token === existingLock.token ? lockDetails : currentLock));

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(resource.customMetadata, updatedLocks),
	});

	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		{
			status: existingLock ? 200 : 201,
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
				...(existingLock
					? {}
					: {
							Location: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
						}),
			},
		},
	);
}

async function handle_unlock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockDetails = getLockDetails(resource.customMetadata);
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return new Response('Conflict', { status: 409 });
	}

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(
			resource.customMetadata,
			lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken),
		),
	});

	return new Response(null, { status: 204 });
}

const DAV_CLASS = '1, 2';
const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];

async function dispatch_handler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 200,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
		case 'HEAD': {
			return await handle_head(request, bucket);
		}
		case 'GET': {
			return await handle_get(request, bucket);
		}
		case 'PUT': {
			return await handle_put(request, bucket);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket);
		}
		case 'COPY': {
			return await handle_copy(request, bucket);
		}
		case 'MOVE': {
			return await handle_move(request, bucket);
		}
		case 'LOCK': {
			return await handle_lock(request, bucket);
		}
		case 'UNLOCK': {
			return await handle_unlock(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}

function is_authorized(authorization_header: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorization_header);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return timingSafeEqual(header, expected);
}

async function isRequestAuthorized(
	request: Request,
	username: string,
	password: string,
	sessionSecret: string,
	sessionMaxAgeSeconds: number,
): Promise<boolean> {
	return (
		is_authorized(request.headers.get('Authorization') ?? '', username, password) ||
		(await isValidSessionCookie(request.headers.get('Cookie'), username, sessionSecret, sessionMaxAgeSeconds))
	);
}

function unauthorizedResponse(request: Request): Response {
	if (shouldUseLoginPage(request)) {
		return redirectResponse(`${LOGIN_PATH}?next=${encodeURIComponent(getCurrentPathWithSearch(request))}`);
	}
	return new Response('Unauthorized', {
		status: 401,
		headers: {
			'WWW-Authenticate': 'Basic realm="webdav"',
		},
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;
		const sessionSecret = getSessionSecret(env);
		const sessionMaxAgeSeconds = getSessionMaxAgeSeconds(env);
		const { pathname } = new URL(request.url);

		if (pathname === LOGIN_PATH) {
			return applySecurityHeaders(
				await handleLoginRoute(request, env.USERNAME, env.PASSWORD, sessionSecret, sessionMaxAgeSeconds),
				{ contentSecurityPolicy: true },
			);
		}
		if (pathname === LOGOUT_PATH) {
			return applySecurityHeaders(handleLogoutRoute(request), { contentSecurityPolicy: true });
		}

		if (
			request.method !== 'OPTIONS' &&
			!(await isRequestAuthorized(request, env.USERNAME, env.PASSWORD, sessionSecret, sessionMaxAgeSeconds))
		) {
			return applySecurityHeaders(unauthorizedResponse(request));
		}

		if (pathname.startsWith(`${ACTION_PREFIX}/`)) {
			return applySecurityHeaders(await handleActionRoute(request, bucket), { contentSecurityPolicy: true });
		}

		let response: Response = await dispatch_handler(request, bucket);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			[
				'authorization',
				'content-type',
				'depth',
				'overwrite',
				'destination',
				'range',
				'if',
				'lock-token',
				'timeout',
			].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			[
				'content-type',
				'content-length',
				'dav',
				'etag',
				'last-modified',
				'location',
				'date',
				'content-range',
				'lock-token',
			].join(', '),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return applySecurityHeaders(response, {
			contentSecurityPolicy: request.method === 'GET' && new URL(request.url).pathname.endsWith('/'),
		});
	},
};
