import { beforeEach, describe, expect, it, vi } from 'vitest';
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => http } }));
vi.mock('../src/store/config-store.js', () => ({ configStore: {
  getDingtalkAccount: () => ({ client_id: 'synthetic-app', client_secret: 'fixture-only' }),
} }));
import { DingtalkSender } from '../src/platform/adapters/dingtalk/dingtalk-sender.js';

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockResolvedValue({ data: { accessToken: 'synthetic-token', expireIn: 7200 } });
  http.post.mockResolvedValue({ status: 200, data: { processQueryKey: 'synthetic-markdown' } });
  http.put.mockResolvedValue({ status: 200, data: {} });
});
const creates = () => http.post.mock.calls.filter(([url]) => url.endsWith('/card/instances'));
const deliveries = () => http.post.mock.calls.filter(([url]) => url.endsWith('/instances/deliver'));

describe('DingTalk streaming reply lifecycle', () => {
  it('obtains the AI card access token with the official POST JSON contract', async () => {
    http.get.mockRejectedValue(new Error('Synthetic server rejects GET token requests'));
    http.post.mockImplementation(async url => url.endsWith('/oauth2/accessToken')
      ? { data: { accessToken: 'synthetic-token', expireIn: 7200 } }
      : { status: 200, data: { processQueryKey: 'synthetic-message' } });
    const sender = new DingtalkSender();
    const id = await sender.sendCard('dingtalk::default::user_fixture', { markdown: 'Answer', status: 'processing', streamId: 1 });
    expect(id).toMatch(/^card_/);
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining('/oauth2/accessToken'),
      { appKey: 'synthetic-app', appSecret: 'fixture-only' });
    expect(http.get).not.toHaveBeenCalled();
  });

  it.each(['user_fixture', 'cid_fixture'])('creates one AI card and updates it in place for %s, then uses a new card next turn', async raw => {
    const sender = new DingtalkSender();
    const chat = `dingtalk::default::${raw}`;
    const first = await sender.sendCard(chat, { markdown: 'First fragment', status: 'processing', streamId: 1 });
    expect(creates()).toHaveLength(1);
    expect(creates()[0][1].cardData.cardParamMap.flowStatus).toBe('1');
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0][1].openSpaceId).toBe(raw.startsWith('cid') ? 'dtv1.card//IM_GROUP.cid_fixture' : 'dtv1.card//IM_ROBOT.user_fixture');
    expect(await sender.updateCard(first!, { markdown: 'First fragment plus more', status: 'processing', streamId: 1 })).toBe(true);
    expect(await sender.updateCard(first!, { markdown: 'Final answer', status: 'completed', streamId: 1 })).toBe(true);
    expect(creates()).toHaveLength(1);
    const streams = http.put.mock.calls.filter(([url]) => url.endsWith('/card/streaming'));
    expect(streams.map(([, body]) => body.outTrackId)).toEqual([first, first, first]);
    expect(streams.at(-1)![1]).toMatchObject({ content: 'Final answer', isFull: true, isFinalize: true });
    const next = await sender.sendCard(chat, { markdown: 'New answer', status: 'processing', streamId: 2 });
    expect(creates()).toHaveLength(2);
    expect(next).not.toBe(first);
  });

  it('clears a failed AI card so the next reply cannot inherit its error', async () => {
    const sender = new DingtalkSender();
    const chat = 'dingtalk::default::user_fixture';
    const first = await sender.sendCard(chat, { markdown: 'Working', status: 'processing', streamId: 1 });
    expect(await sender.updateCard(first!, { markdown: 'Synthetic 403', status: 'failed', streamId: 1 })).toBe(true);
    const next = await sender.sendCard(chat, { markdown: 'Success', status: 'processing', streamId: 2 });
    expect(next).not.toBe(first);
    expect(creates()).toHaveLength(2);
  });

  it('shows one fallback notice and sends only the final markdown when AI card creation is denied', async () => {
    http.post.mockImplementation(async url => {
      if (url.endsWith('/card/instances')) throw new Error('Synthetic AI card denied');
      return { data: { processQueryKey: 'fallback-notice' } };
    });
    const sender = new DingtalkSender();
    const chat = 'dingtalk::default::user_fixture';
    sender.cacheSessionWebhook('user_fixture', 'https://synthetic.invalid/webhook');
    const id = await sender.sendCard(chat, { markdown: 'Partial one', status: 'processing', streamId: 1 });
    expect(id).toBeTruthy();
    await sender.updateCard(id!, { markdown: 'Partial two', status: 'processing', streamId: 1 });
    await sender.updateCard(id!, { markdown: 'Partial three', status: 'processing', streamId: 1 });
    const messages = () => http.post.mock.calls.filter(([url]) => url === 'https://synthetic.invalid/webhook');
    expect(messages()).toHaveLength(1);
    expect(JSON.stringify(messages()[0][1])).not.toContain('Partial');
    expect(await sender.updateCard(id!, { markdown: 'Complete answer', status: 'completed', streamId: 1 })).toBe(true);
    expect(messages()).toHaveLength(2);
    expect(messages()[1][1]).toMatchObject({ msgtype: 'markdown', markdown: { text: 'Complete answer' } });
    expect(creates()).toHaveLength(1);
  });

  it('keeps a standalone question or command card separate from an active streamed reply', async () => {
    const sender = new DingtalkSender();
    const chat = 'dingtalk::default::user_fixture';
    sender.cacheSessionWebhook('user_fixture', 'https://synthetic.invalid/webhook');
    const reply = await sender.sendCard(chat, { markdown: 'Reply in progress', status: 'processing', streamId: 1 });
    await sender.sendCard(chat, { markdown: 'Separate question' });
    expect(http.post.mock.calls.filter(([url]) => url === 'https://synthetic.invalid/webhook')).toHaveLength(1);
    expect(http.put.mock.calls.filter(([url]) => url.endsWith('/card/streaming'))).toHaveLength(1);
    expect(await sender.updateCard(reply!, { markdown: 'Reply finished', status: 'completed', streamId: 1 })).toBe(true);
  });

  it('sends a terminal fallback exactly once without a processing notice when creation already fails at completion', async () => {
    http.post.mockImplementation(async url => {
      if (url.endsWith('/card/instances')) throw new Error('Synthetic AI card denied');
      return { data: { processQueryKey: 'final-markdown' } };
    });
    const sender = new DingtalkSender();
    sender.cacheSessionWebhook('user_fixture', 'https://synthetic.invalid/webhook');
    await sender.sendCard('dingtalk::default::user_fixture', { markdown: 'Complete answer', status: 'completed', streamId: 1 });
    const messages = http.post.mock.calls.filter(([url]) => url === 'https://synthetic.invalid/webhook');
    expect(messages).toHaveLength(1);
    expect(messages[0][1]).toMatchObject({ msgtype: 'markdown', markdown: { text: 'Complete answer' } });
  });
  it('retains the same terminal card for retry when finalization and markdown delivery both fail', async () => {
    http.post.mockImplementation(async url => url.endsWith('/oauth2/accessToken')
      ? { data: { accessToken: 'synthetic-token', expireIn: 7200 } }
      : { status: 200, data: { processQueryKey: 'synthetic-message' } });
    const sender = new DingtalkSender();
    const chat = 'dingtalk::default::user_terminal_retry_fixture';
    sender.cacheSessionWebhook('user_terminal_retry_fixture', 'https://synthetic.invalid/terminal-retry');
    const id = await sender.sendCard(chat, { markdown: 'Partial answer', status: 'processing', streamId: 101 });
    expect(id).toMatch(/^card_/);
    http.put.mockRejectedValue(new Error('Synthetic temporary card outage'));
    http.post.mockRejectedValue(new Error('Synthetic temporary markdown outage'));
    expect(await sender.updateCard(id!, { markdown: 'Complete answer', status: 'completed', streamId: 101 })).toBe(false);
    http.put.mockResolvedValue({ status: 200, data: {} });
    http.post.mockResolvedValue({ status: 200, data: { processQueryKey: 'synthetic-recovered' } });
    expect(await sender.updateCard(id!, { markdown: 'Complete answer', status: 'completed', streamId: 101 })).toBe(true);
    expect(creates()).toHaveLength(1);
  });

  it('finishes a superseded stream card before replacing its conversation mapping', async () => {
    http.post.mockImplementation(async url => url.endsWith('/oauth2/accessToken')
      ? { data: { accessToken: 'synthetic-token', expireIn: 7200 } }
      : { status: 200, data: { processQueryKey: 'synthetic-message' } });
    const sender = new DingtalkSender();
    const chat = 'dingtalk::default::user_superseded_fixture';
    const previous = await sender.sendCard(chat, { markdown: 'Previous partial answer', status: 'processing', streamId: 201 });
    await sender.sendCard(chat, { markdown: 'New turn answer', status: 'processing', streamId: 202 });
    const finishedOldCard = http.put.mock.calls.some(([url, body]) =>
      body.outTrackId === previous &&
      ((url.endsWith('/card/streaming') && body.isFinalize === true) ||
        (url.endsWith('/card/instances') && ['3', '5'].includes(body.cardData?.cardParamMap?.flowStatus))));
    expect(finishedOldCard).toBe(true);
  });

});
