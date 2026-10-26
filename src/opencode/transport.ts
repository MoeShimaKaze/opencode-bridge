import { V2Transport, type TransportOptions } from './v2-transport.js';

/** One version decision per connection, shared by SDK calls and explicit HTTP calls. */
export class OpenCodeTransport {
  protocol: 'v1' | 'v2' | undefined;
  private detection?: Promise<void>;
  private readonly native: V2Transport;
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string;

  constructor(private readonly options: TransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.origin = new URL(options.baseUrl).origin;
    this.native = new V2Transport(options);
  }

  private async detect(headers: Headers, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(new URL('/api/info', this.options.baseUrl), {headers, signal});
    if (response.status === 401 || response.status === 403) throw new Error(`OpenCode authentication failed (HTTP ${response.status})`);
    if (response.status === 404 || response.status === 405 || (response.ok && !(response.headers.get('content-type') ?? '').includes('application/json'))) {
      this.protocol = 'v1'; return;
    }
    if (!response.ok) throw new Error(`OpenCode protocol detection failed (HTTP ${response.status})`);
    const info = await response.json() as {version?: unknown};
    if (typeof info.version !== 'string') throw new Error('OpenCode /api/info returned no version');
    if (info.version.startsWith('2.')) this.protocol = 'v2';
    else if (info.version.startsWith('1.')) this.protocol = 'v1';
    else throw new Error(`Unsupported OpenCode API version: ${info.version}`);
  }

  fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== this.origin) throw new Error('OpenCode transport refuses a different origin');
    const headers = new Headers(this.options.headers);
    request.headers.forEach((value, key) => headers.set(key, value));
    if (!this.detection) {
      this.detection = this.detect(headers, request.signal).catch(error => {this.detection = undefined; throw error;});
    }
    await this.detection;
    const authenticated = new Request(request, {headers});
    return this.protocol === 'v2' ? this.native.fetch(authenticated) : this.fetchImpl(authenticated);
  };
}
