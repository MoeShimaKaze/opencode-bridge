import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ command: vi.fn(), getAdapter: vi.fn(), bound: { sessionId: 'ses_question', resolvedDirectory: 'C:/synthetic/project', defaultDirectory: 'C:/wrong-default' } }));
vi.mock('../src/opencode/client.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { opencodeClient: Object.assign(new EventEmitter(), { sendMessage: vi.fn(), replyQuestion: vi.fn(), listPendingQuestions: vi.fn(), createSession: vi.fn() }) };
});
vi.mock('../src/config.js', () => ({ outputConfig: { updateInterval: 3000 } }));
vi.mock('../src/store/config-store.js', () => ({ configStore: {} }));
vi.mock('../src/feishu/client.js', () => ({ feishuClient: {} }));
vi.mock('../src/platform/registry.js', () => ({ get: mocks.getAdapter }));
vi.mock('../src/store/chat-session.js', () => ({ chatSessionStore: {
  getSessionIdByConversation: () => mocks.bound.sessionId,
  getSessionByConversation: () => mocks.bound,
  getKnownDirectories: () => [],
  getChatId: () => 'dingtalk::test::conversation',
  getConversationBySessionId: () => ({ platform: 'dingtalk', conversationId: 'dingtalk::test::conversation' }),
} }));
vi.mock('../src/permissions/handler.js', () => ({ permissionHandler: { peekForChat: () => undefined } }));
vi.mock('../src/handlers/platform-command.handler.js', () => ({ PlatformCommandHandler: class { handle = mocks.command; } }));
vi.mock('../src/utils/group-mention.js', () => ({ shouldSkipGroupMessage: () => false }));
import { DingtalkHandler } from '../src/handlers/dingtalk.js';
import { questionHandler, type QuestionRequest } from '../src/opencode/question-handler.js';
import { opencodeClient } from '../src/opencode/client.js';
import { OpenCodeEventHub, type OpenCodeEventContext } from '../src/router/opencode-event-hub.js';
import { outputBuffer } from '../src/opencode/output-buffer.js';
import type { PlatformMessageEvent, PlatformSender } from '../src/platform/types.js';

const chat = 'dingtalk::test::conversation';
const buffer = `chat:dingtalk:${chat}`;
const request = (questions?: QuestionRequest['questions']): QuestionRequest => ({ id: 'que_synthetic', sessionID: 'ses_question', questions: questions ?? [{ header: 'Choose method', question: 'How should the synthetic job continue?', options: [{ label: 'Login', description: 'Use the sample login' }, { label: 'Skip login', description: '' }], custom: false }] });
const makeEvent = (content: string): PlatformMessageEvent => ({ platform: 'dingtalk', conversationId: chat, messageId: 'synthetic_message', senderId: 'synthetic_sender', senderType: 'user', content, msgType: 'text', chatType: 'p2p', rawEvent: {} });
const makeSender = (): PlatformSender => ({ sendText: vi.fn(async () => 'sent'), sendCard: vi.fn(async () => 'card'), updateCard: vi.fn(async () => true), deleteMessage: vi.fn(async () => true), reply: vi.fn(async () => 'reply'), replyCard: vi.fn(async () => 'reply-card') });
const register = (value = request()) => questionHandler.register(value, buffer, chat);

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(opencodeClient.replyQuestion).mockResolvedValue({ ok: true });
  vi.mocked((opencodeClient as any).listPendingQuestions).mockResolvedValue([]);
  vi.mocked(opencodeClient.sendMessage).mockResolvedValue(undefined as any);
  mocks.bound.sessionId = 'ses_question';
});
afterEach(() => {
  for (const pending of questionHandler.getAll()) questionHandler.remove(pending.request.id);
  opencodeClient.removeAllListeners(); outputBuffer.clearAll(); vi.useRealTimers();
});

describe('DingTalk question ownership', () => {
  it.each(['1', 'Login'])('submits %s to the question instead of the native prompt inbox', async answer => {
    register();
    await new DingtalkHandler().handleMessage(makeEvent(answer), makeSender());
    expect(opencodeClient.replyQuestion).toHaveBeenCalledWith('que_synthetic', [['Login']]);
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
    expect(questionHandler.get('que_synthetic')).toBeUndefined();
  });

  it('rejects arbitrary text for custom:false and repeats the current question', async () => {
    register(); const sender = makeSender();
    await new DingtalkHandler().handleMessage(makeEvent('not a valid option'), sender);
    expect(opencodeClient.replyQuestion).not.toHaveBeenCalled();
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(sender.sendText).mock.calls[0][1]).toContain('Login');
    expect(questionHandler.get('que_synthetic')).toBeDefined();
  });

  it('treats an exact option label beginning with 跳过 as that option', async () => {
    register(request([{ header: 'Method', question: 'Choose a synthetic method', options: [{ label: '跳过登录', description: '' }], custom: false }]));
    await new DingtalkHandler().handleMessage(makeEvent('跳过登录'), makeSender());
    expect(opencodeClient.replyQuestion).toHaveBeenCalledWith('que_synthetic', [['跳过登录']]);
  });

  it('keeps rapid repeated replies from submitting the same question concurrently', async () => {
    register();
    let finish!: (result: { ok: boolean }) => void;
    const gate = new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
    vi.mocked(opencodeClient.replyQuestion).mockImplementation(() => gate);
    const handler = new DingtalkHandler(); const sender = makeSender();
    const first = handler.handleMessage(makeEvent('1'), sender);
    await Promise.resolve(); await Promise.resolve();
    const second = handler.handleMessage(makeEvent('1'), sender);
    await Promise.resolve(); await Promise.resolve();
    finish({ ok: true });
    await Promise.all([first, second]);
    expect(opencodeClient.replyQuestion).toHaveBeenCalledTimes(1);
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
  });

  it('collects multi-select, custom and skipped answers across questions', async () => {
    register(request([
      { header: 'First', question: 'Select samples', options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }], multiple: true, custom: false },
      { header: 'Second', question: 'Enter a sample note', options: [], custom: true },
      { header: 'Third', question: 'Optional note', options: [], custom: true },
    ]));
    const handler = new DingtalkHandler(); const sender = makeSender();
    await handler.handleMessage(makeEvent('1, 2'), sender);
    expect(opencodeClient.replyQuestion).not.toHaveBeenCalled();
    expect(vi.mocked(sender.sendText).mock.calls.at(-1)?.[1]).toContain('Enter a sample note');
    await handler.handleMessage(makeEvent('a synthetic note'), sender);
    await handler.handleMessage(makeEvent('跳过'), sender);
    expect(opencodeClient.replyQuestion).toHaveBeenCalledWith('que_synthetic', [['Alpha', 'Beta'], ['a synthetic note'], []]);
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains completed drafts on %s exception/failure and retries without replacing the final answer', async exception => {
    register(request([{ header: 'Note', question: 'Sample note?', options: [], custom: true }]));
    if (exception) vi.mocked(opencodeClient.replyQuestion).mockRejectedValueOnce(new Error('Synthetic offline'));
    else vi.mocked(opencodeClient.replyQuestion).mockResolvedValueOnce({ ok: false });
    const handler = new DingtalkHandler(); const sender = makeSender();
    await handler.handleMessage(makeEvent('retain this sample'), sender);
    expect(questionHandler.get('que_synthetic')?.draftCustomAnswers).toEqual(['retain this sample']);
    await handler.handleMessage(makeEvent('重试'), sender);
    expect(opencodeClient.replyQuestion).toHaveBeenLastCalledWith('que_synthetic', [['retain this sample']]);
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['/stop', '/session switch ses_other'])('lets explicit %s commands bypass pending questions', async command => {
    register();
    await new DingtalkHandler().handleMessage(makeEvent(command), makeSender());
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(opencodeClient.replyQuestion).not.toHaveBeenCalled();
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
  });

  it('recovers missing state only for the bound session and its resolved directory', async () => {
    vi.mocked((opencodeClient as any).listPendingQuestions).mockResolvedValue([{ ...request(), id: 'que_other', sessionID: 'ses_other' }, request()]);
    await new DingtalkHandler().handleMessage(makeEvent('1'), makeSender());
    expect((opencodeClient as any).listPendingQuestions).toHaveBeenCalledWith({ sessionId: 'ses_question', directory: 'C:/synthetic/project' });
    expect(opencodeClient.replyQuestion).toHaveBeenCalledWith('que_synthetic', [['Login']]);
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps an unverified reply out of the inbox when question recovery is offline', async () => {
    vi.mocked((opencodeClient as any).listPendingQuestions).mockRejectedValue(new Error('Synthetic recovery offline'));
    const sender = makeSender();
    await new DingtalkHandler().handleMessage(makeEvent('Login'), sender);
    expect(opencodeClient.sendMessage).not.toHaveBeenCalled();
    expect(sender.sendText).toHaveBeenCalled();
  });

  it('leaves ordinary prompts available after a confirmed empty pending list', async () => {
    await new DingtalkHandler().handleMessage(makeEvent('A new synthetic prompt'), makeSender());
    expect(opencodeClient.sendMessage).toHaveBeenCalledWith('ses_question', 'A new synthetic prompt', { directory: 'C:/synthetic/project' });
  });

  it('preserves drafts and current question when the same request is registered again', () => {
    const value = request([request().questions[0], { header: 'Next', question: 'A synthetic note?', options: [], custom: true }]);
    register(value); questionHandler.setDraftAnswer('que_synthetic', 0, ['Login']); questionHandler.setCurrentQuestionIndex('que_synthetic', 1);
    register(value);
    expect(questionHandler.get('que_synthetic')?.draftAnswers).toEqual([['Login'], []]);
    expect(questionHandler.get('que_synthetic')?.currentQuestionIndex).toBe(1);
  });

  it('does not unindex a newer question when an older reply resolves', () => {
    register(); register({ ...request(), id: 'que_newer' });
    questionHandler.remove('que_synthetic');
    expect(questionHandler.getBySession('ses_question')?.request.id).toBe('que_newer');
  });

  it.each(['answered', 'cancelled'])('sends DingTalk text instructions and clears %s questions through the event hub', async status => {
    const sender = makeSender(); mocks.getAdapter.mockReturnValue({ getSender: () => sender });
    const note = vi.fn(); const hub = new OpenCodeEventHub();
    hub.setContext({ upsertTimelineNote: note } as unknown as OpenCodeEventContext); hub.register();
    opencodeClient.emit('questionAsked', request());
    await Promise.resolve();
    expect(vi.mocked(sender.sendText).mock.calls[0]?.[1]).toContain('1. Login');
    expect(vi.mocked(sender.sendText).mock.calls[0]?.[1]).toContain('选项');
    expect(vi.mocked(sender.sendText).mock.calls[0]?.[1]).not.toContain('流式卡片');
    expect(note.mock.calls[0]?.[2]).not.toContain('流式卡片');
    outputBuffer.get(buffer)!.dirty = false;
    opencodeClient.emit('questionResolved', { sessionID: 'ses_other', id: 'que_synthetic', status: 'answered' });
    expect(questionHandler.get('que_synthetic')).toBeDefined();
    opencodeClient.emit('questionResolved', { sessionID: 'ses_question', id: 'que_synthetic', status });
    expect(questionHandler.get('que_synthetic')).toBeUndefined();
    expect(outputBuffer.get(buffer)?.dirty).toBe(true);
  });
});
