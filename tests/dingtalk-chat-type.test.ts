/**
 * 钉钉会话类型判定回归测试
 *
 * 背景：内测群/老群的 conversationId 是纯数字（如 393167066326541834），
 * 仅靠前缀无法判断单聊/群聊；必须以消息回调里的 conversationType 为准，
 * 否则 AI Card 会走 IM_GROUP 投递并被钉钉拒绝（spaceId is illegal）。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/store/config-store.js', () => ({
  configStore: { getDingtalkAccount: () => null },
}));

import { DingtalkSender } from '../src/platform/adapters/dingtalk/dingtalk-sender.js';
import { isDingtalkGroupChat } from '../src/platform/adapters/dingtalk/dingtalk-ids.js';

describe('钉钉会话类型判定', () => {
  it('conversationId 前缀规则仍可用', () => {
    expect(isDingtalkGroupChat('cidABC123')).toBe(true);
    expect(isDingtalkGroupChat('manager1234')).toBe(false);
  });

  it('未声明类型时按 conversationId 推断', () => {
    const sender = new DingtalkSender();
    expect(sender.isGroupConversation('cidABC123')).toBe(true);
  });

  it('回调声明的单聊类型优先于数字 conversationId 推断', () => {
    const sender = new DingtalkSender();
    sender.setChatType('393167066326541834', 'p2p');
    expect(sender.isGroupConversation('393167066326541834')).toBe(false);
  });

  it('回调声明的群聊类型优先于 conversationId 推断', () => {
    const sender = new DingtalkSender();
    sender.setChatType('manager1234', 'group');
    expect(sender.isGroupConversation('manager1234')).toBe(true);
  });
});
