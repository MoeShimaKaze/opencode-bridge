import { describe, expect, it } from 'vitest';
import { V2Transport } from '../src/opencode/v2-transport.js';

const baseUrl = 'http://native.fixture';
const time = 1792976400000;
let sequence = 0;
const event = (type: string, data: Record<string, unknown> = {}, created = time + ++sequence) => ({ id: `evt_reconnect_${++sequence}`, created, type, data });
const ref = { sessionID: 'ses_shared', assistantMessageID: 'msg_shared' };
const frames = (events: unknown[]) => events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
const sse = (events: unknown[]) => new Response(frames(events), { headers: { 'content-type': 'text/event-stream' } });
const decode = async (response: Response): Promise<any[]> => (await response.text()).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
const messages = [
  { id: 'msg_old_user', type: 'user', text: 'Earlier synthetic prompt', time: { created: time - 20 } },
  { id: 'msg_old', type: 'assistant', content: [{ type: 'text', text: 'Earlier synthetic answer' }], time: { created: time - 19, completed: time - 18 } },
  { id: 'msg_old_idle', type: 'idle', outcome: 'succeeded', time: { created: time - 17 } },
  { id: 'msg_user', type: 'user', text: 'Synthetic prompt', time: { created: time } },
  { id: 'msg_shared', type: 'assistant', content: [{ type: 'text', text: 'Hello complete world' }, { type: 'reasoning', text: 'Complete reasoning' }], time: { created: time + 1, completed: time + 30 } },
  { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: time + 31 } },
];

function fixture(options: { streams: unknown[][]; active?: boolean; outcome?: 'succeeded' | 'failed'; deleted?: boolean }) {
  const calls: URL[] = [];
  let connections = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.pathname === '/api/event') return sse(options.streams[connections++] ?? [event('server.connected')]);
    if (url.pathname === '/api/session/ses_shared/prompt') return Response.json({ data: { id: 'msg_user' } });
    if (url.pathname === '/api/session/active') return Response.json({ data: options.active ? { ses_shared: { type: 'running' } } : {} });
    if (url.pathname === '/api/session/ses_shared') return options.deleted ? Response.json({ message: 'Synthetic session deleted' }, { status: 404 }) : Response.json({ data: { id: 'ses_shared', location: { directory: 'C:/synthetic' }, outcome: options.outcome ?? 'succeeded', time: { created: time, updated: time + 31, idle: time + 31 } } });
    if (url.pathname === '/api/session/ses_shared/message') return Response.json({ data: messages.map(message => message.type === 'idle' && message.id === 'msg_idle' ? { ...message, outcome: options.outcome ?? 'succeeded' } : message), cursor: {} });
    if (url.pathname === '/api/permission/request') {
      expect(url.searchParams.get('location[directory]')).toBe('C:/synthetic');
      return Response.json({ location: { directory: 'C:/synthetic' }, data: options.active ? [
        { id: 'per_shared', sessionID: 'ses_shared', action: 'read', resources: ['sample.txt'], source: { type: 'tool', messageID: 'msg_shared', id: 'call_shared' } },
        { id: 'per_other', sessionID: 'ses_other', action: 'read', resources: [] },
      ] : [] });
    }
    if (url.pathname === '/api/form') {
      expect(url.searchParams.get('location[directory]')).toBe('C:/synthetic');
      return Response.json({ location: { directory: 'C:/synthetic' }, data: options.active ? [
        { id: 'frm_shared', sessionID: 'ses_shared', title: 'Synthetic choice', fields: [{ key: 'enabled', type: 'boolean' }] },
      ] : [] });
    }
    if (url.pathname === '/api/session/ses_shared/form/frm_shared/reply') {
      expect(JSON.parse(String(init?.body))).toEqual({ answer: { enabled: true } });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected native fixture request: ${url.pathname}`);
  };
  const transport = new V2Transport({ baseUrl, fetch: fetcher, defaultDirectory: 'C:/wrong-default' });
  const stream = () => transport.fetch(new Request(`${baseUrl}/event`)).then(decode);
  return { transport, stream, calls };
}

describe('native reconnect reconciliation', () => {
  it('forgets sessions deleted while disconnected without breaking the global stream', async () => {
    const setup = fixture({ deleted: true, streams: [
      [event('session.execution.started', { sessionID: 'ses_shared' }, time)],
      [event('server.connected'), event('session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'msg_other', ordinal: 0, delta: 'Still streaming' })],
    ] });
    await setup.stream();
    expect(await setup.stream()).toContainEqual(expect.objectContaining({ type: 'message.part.updated', properties: expect.objectContaining({ delta: 'Still streaming' }) }));
    await setup.stream();
    expect(setup.calls.filter(url => url.pathname === '/api/session/ses_shared')).toHaveLength(1);
  });
  it.each(['succeeded', 'failed'] as const)('recovers a lost %s terminal event and suppresses buffered old parts', async outcome => {
    const setup = fixture({ outcome, streams: [
      [event('session.execution.started', { sessionID: 'ses_shared' }, time), event('session.text.delta', { ...ref, ordinal: 0, delta: 'Hello ' }, time + 2)],
      [event('server.connected'), event('session.text.delta', { ...ref, ordinal: 0, delta: 'stale buffered fragment' }, time + 3)],
    ] });
    await setup.stream();
    const recovered = await setup.stream();
    expect(recovered.filter(value => value.type === 'message.part.updated').map(value => value.properties)).toMatchObject([
      { replace: true, part: { id: 'msg_shared:text:0', text: 'Hello complete world' } },
      { replace: true, part: { id: 'msg_shared:reasoning:0', text: 'Complete reasoning' } },
    ]);
    expect(recovered.some(value => value.properties.part?.messageID === 'msg_old')).toBe(false);
    expect(recovered.some(value => value.properties.delta?.includes('stale buffered fragment'))).toBe(false);
    expect(recovered).toContainEqual(expect.objectContaining({ type: 'session.idle', properties: { sessionID: 'ses_shared' } }));
    expect(recovered.some(value => value.type === 'session.error')).toBe(outcome === 'failed');
    expect(recovered.some(value => value.type === 'message.updated' && value.properties.info.id === 'msg_shared' && value.properties.info.time.completed === time + 30)).toBe(true);
    const reads = setup.calls.filter(url => url.pathname.endsWith('/message')).length;
    await setup.stream();
    expect(setup.calls.filter(url => url.pathname.endsWith('/message'))).toHaveLength(reads);
  });

  it('tracks an accepted prompt even when every execution event was missed', async () => {
    const setup = fixture({ streams: [[event('server.connected')]] });
    expect((await setup.transport.fetch(new Request(`${baseUrl}/session/ses_shared/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'Synthetic prompt' }] }) }))).status).toBe(204);
    expect(await setup.stream()).toContainEqual({ type: 'session.idle', properties: { sessionID: 'ses_shared' } });
  });

  it('leaves active executions streaming while restoring location-scoped permissions and forms', async () => {
    const setup = fixture({ active: true, streams: [
      [event('session.execution.started', { sessionID: 'ses_shared' }, time), event('session.text.delta', { ...ref, ordinal: 0, delta: 'Hello ' }, time + 2)],
      [event('server.connected'), event('session.text.delta', { ...ref, ordinal: 0, delta: 'world' }, time + 3)],
    ] });
    await setup.stream();
    const recovered = await setup.stream();
    expect(recovered.some(value => value.type === 'session.idle' || value.properties.replace)).toBe(false);
    expect(setup.calls.some(url => url.pathname.endsWith('/message'))).toBe(false);
    expect(recovered).toContainEqual(expect.objectContaining({ type: 'permission.asked', properties: expect.objectContaining({ id: 'per_shared', permission: 'read', tool: { messageID: 'msg_shared', callID: 'call_shared' } }) }));
    expect(recovered.some(value => value.properties.id === 'per_other')).toBe(false);
    expect(recovered).toContainEqual(expect.objectContaining({ type: 'question.asked', properties: expect.objectContaining({ id: 'frm_shared' }) }));
    expect(recovered).toContainEqual(expect.objectContaining({ type: 'message.part.updated', properties: expect.objectContaining({ delta: 'world', part: expect.objectContaining({ text: 'Hello world' }) }) }));
    expect((await setup.transport.fetch(new Request(`${baseUrl}/question/frm_shared/reply`, { method: 'POST', body: JSON.stringify({ answers: [['Yes']] }) }))).status).toBe(200);
  });

  it.each(['reader', 'request'] as const)('cancels reconciliation and the native stream when the %s is canceled', async mode => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let nativeCanceled = false;
    let recoveryAborted = false;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/prompt')) return Response.json({ data: { id: 'msg_user' } });
      if (path === '/api/event') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames([event('server.connected')]))); }, cancel() { nativeCanceled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path === '/api/session/active') return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { recoveryAborted = true; reject(init!.signal!.reason); }, { once: true }); enter();
      });
      throw new Error(`Unexpected fixture request ${path}`);
    };
    const transport = new V2Transport({ baseUrl, fetch: fetcher });
    await transport.fetch(new Request(`${baseUrl}/session/ses_shared/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [] }) }));
    const abort = new AbortController();
    const response = await transport.fetch(new Request(`${baseUrl}/event`, { signal: abort.signal }));
    const reader = response.body!.getReader();
    const pending = reader.read();
    await entered;
    if (mode === 'reader') { await reader.cancel('Synthetic cancellation'); expect(await pending).toMatchObject({ done: true }); }
    else { const rejection = expect(pending).rejects.toBeDefined(); abort.abort(new Error('Synthetic cancellation')); await rejection; }
    expect(recoveryAborted).toBe(true);
    expect(nativeCanceled).toBe(true);
  }, 2000);
});
