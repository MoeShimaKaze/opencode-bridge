import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2EventMapper } from '../src/opencode/v2-events.js';
import { ChatEventBus } from '../src/admin/chat/event-bus.js';
import { ChatEventNormalizer } from '../src/admin/chat/event-normalizer.js';
import { EventStreamManager } from '../src/opencode/event-stream.js';
import { opencodeClient } from '../src/opencode/client.js';
import { StreamAccumulator, type StreamAccumulatorDeps } from '../src/router/stream-accumulator.js';
import { UserMessageIdCache } from '../src/router/user-message-cache.js';
import { StreamStateManager } from '../src/store/stream-state.js';
import { outputBuffer, applyBufferedContent } from '../src/opencode/output-buffer.js';
import { applyChatEvent, mergeChatMessages, normalizeHistoryMessage, type ChatMessageVm } from '../web/src/composables/chat-model.ts';

let sequence = 0;
const ref = { sessionID: 'ses_shared', assistantMessageID: 'msg_shared' };
const native = (type: string, data: Record<string, unknown>) => ({ type, id: `evt_recovery_${++sequence}`, created: 1792976400000 + sequence, data: { ...ref, ...data } });
const normalizers: ChatEventNormalizer[] = [];
afterEach(() => { normalizers.splice(0).forEach(normalizer => normalizer.uninstall()); outputBuffer.clearAll(); vi.useRealTimers(); });

describe('authoritative native snapshot recovery', () => {
  it.each(['text', 'reasoning'] as const)('replaces missing-middle %s fragments through mapper, normalizer and frontend reducer without losing other ordinals', kind => {
    const mapper = new V2EventMapper();
    const bus = new ChatEventBus();
    const normalizer = new ChatEventNormalizer(bus);
    normalizers.push(normalizer);
    normalizer.install();
    const view: ChatMessageVm[] = [];
    bus.subscribe('ses_shared', ({ event }) => applyChatEvent(view, event));
    const stream = new EventStreamManager({ getClient: () => null, emitEvent: (type, payload) => { opencodeClient.emit(type, payload); } });
    const send = (type: string, data: Record<string, unknown>) => {
      const events = mapper.map(native(type, data));
      events.forEach(event => stream.handleEvent(event));
      return events;
    };
    send(`session.${kind}.delta`, { ordinal: 0, delta: 'Hello ' });
    send(`session.${kind}.delta`, { ordinal: 0, delta: 'world' }); // middle fragment lost during disconnection
    send(`session.${kind}.delta`, { ordinal: 1, delta: '!' });
    const corrective = send(`session.${kind}.ended`, { ordinal: 0, text: 'Hello middle world' });
    expect(corrective.find(event => event.type === 'message.part.updated')?.properties).toMatchObject({ replace: true, part: { text: 'Hello middle world' } });
    expect(view[0][kind]).toBe('Hello middle world!');
    expect(bus.snapshot('ses_shared').at(-1)?.event).toMatchObject({ type: `${kind}_snapshot`, text: 'Hello middle world!' });
  });

  it.each(['text', 'reasoning'] as const)('allows a shorter or empty %s snapshot and subsequent ordinal deltas', kind => {
    const bus = new ChatEventBus();
    const normalizer = new ChatEventNormalizer(bus);
    normalizers.push(normalizer);
    normalizer.install();
    const view: ChatMessageVm[] = [];
    bus.subscribe('ses_shared', ({ event }) => applyChatEvent(view, event));
    const stream = new EventStreamManager({ getClient: () => null, emitEvent: (type, payload) => { opencodeClient.emit(type, payload); } });
    const mapper = new V2EventMapper();
    const send = (type: string, data: Record<string, unknown>) => mapper.map(native(type, data)).forEach(event => stream.handleEvent(event));
    send(`session.${kind}.delta`, { ordinal: 0, delta: 'discard' });
    send(`session.${kind}.delta`, { ordinal: 1, delta: 'keep' });
    send(`session.${kind}.ended`, { ordinal: 0, text: '' });
    send(`session.${kind}.delta`, { ordinal: 1, delta: '!' });
    expect(view[0][kind]).toBe('keep!');
  });

  it.each(['text', 'reasoning'] as const)('replaces %s in routed output after earlier fragments have already flushed', kind => {
    vi.useFakeTimers();
    const mapper = new V2EventMapper();
    const states = new StreamStateManager();
    const timeline = (buffer: string, key: string, type: 'text' | 'reasoning', text: string) => states.upsertTimelineSegment(buffer, key, { type, text });
    const accumulator = new StreamAccumulator(() => ({
      toSessionId: value => typeof value === 'string' ? value : '',
      chatSessionStore: { getChatId: () => 'chat_test', rememberSessionAlias: () => undefined },
      outputBuffer, streamStateManager: states, userMessageIdCache: new UserMessageIdCache(),
      resolveConversationRoute: () => ({ platform: 'test', conversationId: 'chat_test', bufferKey: 'test_buffer', permissionChatKey: 'test_buffer' }),
      setTimelineText: timeline,
    } as unknown as StreamAccumulatorDeps));
    let rendered = { text: '', thinking: '' };
    const flush = () => { rendered = applyBufferedContent(rendered, outputBuffer.getAndClear('test_buffer')); };
    const send = (type: string, data: Record<string, unknown>) => mapper.map(native(type, data))
      .filter(event => event.type === 'message.part.updated').forEach(event => accumulator.handleMessagePartUpdated(event.properties));
    const otherKind = kind === 'text' ? 'reasoning' : 'text';
    send(`session.${otherKind}.delta`, { ordinal: 0, delta: 'untouched' });
    send(`session.${kind}.delta`, { ordinal: 0, delta: 'Hello ' });
    flush();
    send(`session.${kind}.delta`, { ordinal: 0, delta: 'world' });
    send(`session.${kind}.delta`, { ordinal: 1, delta: '!' });
    flush();
    send(`session.${kind}.ended`, { ordinal: 0, text: 'Hello middle world' });
    send(`session.${kind}.delta`, { ordinal: 1, delta: '?' });
    flush();
    expect(rendered[kind === 'text' ? 'text' : 'thinking']).toBe('Hello middle world!?');
    expect(rendered[kind === 'text' ? 'thinking' : 'text']).toBe('untouched');
    const segments = states.getTimeline('test_buffer')!;
    expect(segments.order.map(key => segments.segments.get(key)).filter(segment => segment?.type === kind)).toMatchObject([
      { text: 'Hello middle world' }, { text: '!?' },
    ]);
  });

  it.each(['text', 'reasoning'] as const)('keeps shorter authoritative %s when older history is merged', kind => {
    const history = normalizeHistoryMessage({ info: { id: 'msg_shared', role: 'assistant', time: { created: 1792976400000 } },
      parts: [{ id: 'part_old', type: kind, text: 'older inaccurate long value' }] } as any);
    const current: ChatMessageVm[] = [{ ...history }];
    applyChatEvent(current, { type: `${kind}_snapshot`, msgId: 'msg_shared', text: 'correct' });
    expect(mergeChatMessages([history], current)[0][kind]).toBe('correct');
  });

  it.each([[1792976400000, 1792976400000], [1792976400, 1792976400000]])('normalizes history milliseconds and legacy seconds (%s)', (created, expected) => {
    expect(normalizeHistoryMessage({ info: { id: 'msg_shared', role: 'assistant', time: { created } }, parts: [] } as any).createdAt).toBe(expected);
  });
});
