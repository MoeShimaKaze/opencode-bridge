import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sender = vi.hoisted(() => ({ sendCard: vi.fn(), updateCard: vi.fn(), deleteMessage: vi.fn() }));
vi.mock('../src/config.js', () => ({ outputConfig: { updateInterval: 10, showThinkingChain: true, showToolChain: true } }));
vi.mock('../src/platform/loader.js', () => ({ getSenderByPlatform: () => sender, getCachedAdapter: () => undefined }));
vi.mock('../src/store/chat-session.js', () => ({ chatSessionStore: { getSessionByConversation: () => undefined } }));
import { outputBuffer } from '../src/opencode/output-buffer.js';
import { streamStateManager } from '../src/store/stream-state.js';
import { registerBufferCallback } from '../src/lifecycle/buffer-callback.js';

const key = 'chat:dingtalk:synthetic';
function register() {
  registerBufferCallback({ getTimelineSegments: bufferKey => {
    const timeline = streamStateManager.getTimeline(bufferKey);
    return timeline ? timeline.order.map(id => timeline.segments.get(id)!) : [];
  }, resolveSessionConversation: () => ({ platform: 'dingtalk', conversationId: 'dingtalk::default::fixture' }),
  buildPermissionQueueKeyBySession: () => key, getPendingPermissionForChat: () => undefined,
  getPendingQuestionForBuffer: () => undefined, clearPartSnapshotsForSession: () => undefined,
  upsertLiveCardInteraction: () => undefined });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); outputBuffer.clearAll(); streamStateManager.clearAll();
  sender.sendCard.mockResolvedValue('card_fixture'); sender.updateCard.mockResolvedValue(true); sender.deleteMessage.mockResolvedValue(true);
  register();
});
afterEach(() => { outputBuffer.setUpdateCallback(async () => undefined); outputBuffer.clearAll(); streamStateManager.clearAll(); vi.useRealTimers(); });

describe('streamed reply turn isolation', () => {
  it('retains an aborted reply until its failed terminal update can be retried', async () => {
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'Partial answer');
    await vi.advanceTimersByTimeAsync(15);
    sender.updateCard.mockResolvedValue(false);
    outputBuffer.abort(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(outputBuffer.get(key)).toBeDefined();
    expect(streamStateManager.getContent(key)?.text).toBe('Partial answer');
    sender.updateCard.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(outputBuffer.get(key)).toBeUndefined();
    expect(sender.updateCard).toHaveBeenLastCalledWith('card_fixture', expect.objectContaining({ status: 'failed' }));
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
  });

  it('retains terminal answer content after a failed DingTalk delivery so it can retry the same card', async () => {
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'Partial answer');
    await vi.advanceTimersByTimeAsync(15);
    sender.updateCard.mockResolvedValue(false);
    outputBuffer.append(key, ' with final content');
    outputBuffer.setStatus(key, 'completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(outputBuffer.get(key)).toBeDefined();
    expect(streamStateManager.getContent(key)?.text).toBe('Partial answer with final content');
    sender.updateCard.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(outputBuffer.get(key)).toBeUndefined();
    expect(sender.updateCard).toHaveBeenLastCalledWith('card_fixture', expect.objectContaining({ status: 'completed', markdown: expect.stringContaining('Partial answer with final content') }));
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
  });

  it('bounds terminal retries and isolates a new turn from the failed buffer', async () => {
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'Previous answer');
    await vi.advanceTimersByTimeAsync(15);
    sender.updateCard.mockResolvedValue(false);
    outputBuffer.setStatus(key, 'completed');
    await vi.advanceTimersByTimeAsync(60000);
    const failedCalls=sender.updateCard.mock.calls.length;
    expect(failedCalls).toBeGreaterThan(1);
    expect(failedCalls).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sender.updateCard).toHaveBeenCalledTimes(failedCalls);
    outputBuffer.clear(key);
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'New answer');
    await vi.advanceTimersByTimeAsync(15);
    expect(sender.sendCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sender.sendCard.mock.calls.at(-1)![1])).not.toContain('Previous answer');
  });

  it('does not mix stale error text or timeline into a newly created buffer', async () => {
    streamStateManager.setContent(key, { text: 'Synthetic old 403', thinking: 'Old reasoning' });
    streamStateManager.upsertTimelineSegment(key, 'old', { type: 'note', text: 'Old error', variant: 'error' });
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'Successful new answer');
    await vi.advanceTimersByTimeAsync(15);
    const payload = sender.sendCard.mock.calls[0][1];
    expect(payload.markdown).toContain('Successful new answer');
    expect(JSON.stringify(payload)).not.toMatch(/Old|403/);
    expect(payload).toMatchObject({ status: 'processing', streamId: expect.any(Number) });
  });

  it('serializes flushes so terminal completion cannot race an in-flight card creation', async () => {
    let release!: (id: string) => void;
    sender.sendCard.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'First');
    await vi.advanceTimersByTimeAsync(15);
    outputBuffer.append(key, ' final');
    outputBuffer.setStatus(key, 'completed');
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    release('first_card');
    await vi.advanceTimersByTimeAsync(15);
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(sender.updateCard).toHaveBeenCalledWith('first_card', expect.objectContaining({ status: 'completed', markdown: expect.stringContaining('First final') }));
    expect(outputBuffer.get(key)).toBeUndefined();
  });

  it('an old asynchronous terminal flush cannot overwrite or clear a new turn with the same key', async () => {
    let release!: (id: string) => void;
    sender.sendCard.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const previous = outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'Synthetic old 403');
    outputBuffer.setStatus(key, 'failed');
    await vi.advanceTimersByTimeAsync(0);
    outputBuffer.clear(key);
    const current = outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'New success');
    release('old_card');
    await vi.advanceTimersByTimeAsync(15);
    expect(outputBuffer.get(key)).toBe(current);
    expect(current).not.toBe(previous);
    expect(streamStateManager.getContent(key)?.text).toBe('New success');
    const last = sender.sendCard.mock.calls.at(-1)![1];
    expect(last.markdown).toContain('New success');
    expect(last.markdown).not.toContain('403');
  });

  it('delivers an aborted terminal update before removing the reply buffer', async () => {
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'Partial answer');
    await vi.advanceTimersByTimeAsync(15);
    outputBuffer.abort(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.updateCard).toHaveBeenCalledWith('card_fixture', expect.objectContaining({ status: 'failed' }));
    expect(outputBuffer.get(key)).toBeUndefined();
  });

  it('keeps the existing DingTalk card on a transient streaming update failure', async () => {
    outputBuffer.getOrCreate(key, 'fixture', 'ses_shared', null);
    outputBuffer.append(key, 'First');
    await vi.advanceTimersByTimeAsync(15);
    sender.updateCard.mockResolvedValueOnce(false);
    outputBuffer.append(key, ' second');
    await vi.advanceTimersByTimeAsync(15);
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    outputBuffer.setStatus(key, 'completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.updateCard).toHaveBeenLastCalledWith('card_fixture', expect.objectContaining({ markdown: expect.stringContaining('First second'), status: 'completed' }));
  });
});
