/**
 * 钉钉消息发送器
 *
 * 实现消息发送功能：
 * - 使用 sessionWebhook 回复消息（无需 access_token）
 * - 支持文本、Markdown 消息
 * - 支持 AI Card 流式响应
 */

import type { DingtalkConfig, DingtalkSendResult, DingtalkAICardInstance, DingtalkAICardTarget } from './dingtalk-types.js';
import { DINGTALK_API } from './dingtalk-types.js';
import { configStore } from '../../../store/config-store.js';
import { encodeDingtalkChatId, decodeDingtalkChatId, isDingtalkGroupChat } from './dingtalk-ids.js';
import { createAICard, streamAICard, finishAICard, errorAICard } from './dingtalk-card.js';

// ──────────────────────────────────────────────
// HTTP 客户端
// ──────────────────────────────────────────────

import axios from 'axios';

const httpClient = axios.create({
  timeout: 30_000,
});

// ──────────────────────────────────────────────
// Access Token 缓存
// ──────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiredAt: number }>();

async function getAccessToken(config: DingtalkConfig): Promise<string> {
  const cacheKey = config.clientId;
  const cached = tokenCache.get(cacheKey);

  // 提前 5 分钟刷新
  if (cached && cached.expiredAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  // 获取新 token
  const resp = await httpClient.post(
    `${DINGTALK_API}/v1.0/oauth2/accessToken`,
    {
      appKey: config.clientId,
      appSecret: config.clientSecret,
    }
  );

  if (!resp.data?.accessToken) {
    throw new Error('获取 access_token 失败');
  }

  tokenCache.set(cacheKey, {
    token: resp.data.accessToken,
    expiredAt: resp.data.expireIn * 1000 + Date.now(),
  });

  return resp.data.accessToken;
}

// ──────────────────────────────────────────────
// 消息发送
// ──────────────────────────────────────────────

/**
 * 使用 sessionWebhook 发送消息（回复消息）
 */
async function sendViaSessionWebhook(
  sessionWebhook: string,
  msgType: 'text' | 'markdown',
  content: string,
  title?: string,
): Promise<DingtalkSendResult> {
  try {
    const body: Record<string, unknown> = {
      msgtype: msgType,
    };

    if (msgType === 'markdown') {
      body.markdown = {
        title: title || content.split('\n')[0].replace(/^[#*\s\->]+/, '').slice(0, 20) || '消息',
        text: content,
      };
    } else {
      body.text = { content };
    }

    const resp = await httpClient.post(sessionWebhook, body, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    return {
      ok: true,
      processQueryKey: resp.data?.processQueryKey,
    };
  } catch (error: any) {
    console.error('[钉钉] 通过 sessionWebhook 发送失败:', error.message);
    return {
      ok: false,
      error: error.message,
    };
  }
}

/**
 * 主动发送单聊消息
 */
async function sendToUser(
  config: DingtalkConfig,
  userId: string,
  content: string,
  msgType: 'text' | 'markdown' = 'text',
): Promise<DingtalkSendResult> {
  try {
    const token = await getAccessToken(config);

    const payload = msgType === 'markdown'
      ? {
          msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({
            title: content.split('\n')[0].replace(/^[#*\s\->]+/, '').slice(0, 20) || '消息',
            text: content,
          }),
        }
      : {
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        };

    const body = {
      robotCode: config.clientId,
      userIds: [userId],
      ...payload,
    };

    const resp = await httpClient.post(
      `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`,
      body,
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    return {
      ok: true,
      processQueryKey: resp.data?.processQueryKey,
    };
  } catch (error: any) {
    console.error('[钉钉] 发送单聊消息失败:', error.message);
    return {
      ok: false,
      error: error.message,
    };
  }
}

/**
 * 主动发送群聊消息
 */
async function sendToGroup(
  config: DingtalkConfig,
  openConversationId: string,
  content: string,
  msgType: 'text' | 'markdown' = 'text',
): Promise<DingtalkSendResult> {
  try {
    const token = await getAccessToken(config);

    const payload = msgType === 'markdown'
      ? {
          msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({
            title: content.split('\n')[0].replace(/^[#*\s\->]+/, '').slice(0, 20) || '消息',
            text: content,
          }),
        }
      : {
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        };

    const body = {
      robotCode: config.clientId,
      openConversationId,
      ...payload,
    };

    const resp = await httpClient.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      body,
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    return {
      ok: true,
      processQueryKey: resp.data?.processQueryKey,
    };
  } catch (error: any) {
    console.error('[钉钉] 发送群聊消息失败:', error.message);
    return {
      ok: false,
      error: error.message,
    };
  }
}

// ──────────────────────────────────────────────
// DingtalkSender 类
// ──────────────────────────────────────────────

export class DingtalkSender {
  private readonly sessionWebhooks = new Map<string, string>();
  private readonly aiCards = new Map<string, DingtalkAICardInstance>();
  private readonly streamIds = new Map<string, unknown>();
  private readonly streamContents = new Map<string, string>();
  private readonly fallbackCards = new Map<string, { id: string }>();
  private fallbackSequence = 0;

  /**
   * 缓存 sessionWebhook
   */
  cacheSessionWebhook(conversationId: string, webhook: string): void {
    this.sessionWebhooks.set(conversationId, webhook);
  }

  /**
   * 发送文本消息
   */
  async sendText(conversationId: string, text: string): Promise<string | null> {
    const decoded = decodeDingtalkChatId(conversationId);
    if (!decoded) {
      console.warn('[钉钉] 无效的 chatId 格式');
      return null;
    }

    const { accountId, conversationId: rawConversationId } = decoded;
    const account = configStore.getDingtalkAccount(accountId);
    if (!account) {
      console.warn(`[钉钉] 找不到账号 ${accountId}`);
      return null;
    }

    const config: DingtalkConfig = {
      clientId: account.client_id,
      clientSecret: account.client_secret,
      endpoint: account.endpoint,
    };

    // 处理文本格式（去除 Markdown）
    let content = text;
    content = content.replace(/<[^>]+>/g, ''); // HTML
    content = content
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // 尝试使用缓存的 sessionWebhook
    const sessionWebhook = this.sessionWebhooks.get(rawConversationId);

    let result: DingtalkSendResult;

    if (sessionWebhook) {
      // 使用 sessionWebhook 发送
      result = await sendViaSessionWebhook(sessionWebhook, 'text', content);
    } else {
      // 主动发送
      const isGroup = isDingtalkGroupChat(rawConversationId);
      if (isGroup) {
        result = await sendToGroup(config, rawConversationId, content);
      } else {
        result = await sendToUser(config, rawConversationId, content);
      }
    }

    return result.ok ? result.processQueryKey || 'sent' : null;
  }

  /**
   * 发送卡片消息（支持 AI Card 流式响应）
   */
  async sendCard(conversationId: string, card: object): Promise<string | null> {
    const payload = card as { text?: string; markdown?: string; status?: string; streamId?: unknown };
    const content = payload.markdown || payload.text || JSON.stringify(card, null, 2);

    const decoded = decodeDingtalkChatId(conversationId);
    if (!decoded) {
      console.warn('[钉钉] 无效的 chatId 格式');
      return null;
    }

    const { accountId, conversationId: rawConversationId } = decoded;
    const account = configStore.getDingtalkAccount(accountId);
    if (!account) {
      console.warn(`[钉钉] 找不到账号 ${accountId}`);
      return null;
    }

    if (['processing', 'completed', 'failed'].includes(payload.status ?? '')) {
      if (this.streamIds.has(conversationId) && this.streamIds.get(conversationId) !== payload.streamId) {
        const previous=this.aiCards.get(conversationId);
        if(previous)await finishAICard({clientId:account.client_id,clientSecret:account.client_secret,endpoint:account.endpoint},previous,
          (this.streamContents.get(conversationId) ?? '')+'\n\n_此轮已停止更新。_');
        this.clearAICard(conversationId);
      }
      this.streamIds.set(conversationId, payload.streamId);
      let aiCard = this.aiCards.get(conversationId);
      let fallback = this.fallbackCards.get(conversationId);
      if (!aiCard && !fallback) {
        aiCard = await this.createAICardForConversation(conversationId, isDingtalkGroupChat(rawConversationId)
          ? { type: 'group', openConversationId: rawConversationId }
          : { type: 'user', userId: rawConversationId }) ?? undefined;
        if (!aiCard) {
          fallback = { id: `dingtalk_fallback_${++this.fallbackSequence}` };
          this.fallbackCards.set(conversationId, fallback);
          if (payload.status === 'processing') await this.sendText(conversationId, '正在处理，完成后发送回复。');
        }
      }
      const id = aiCard?.cardInstanceId ?? fallback!.id;
      return await this.updateCard(id, payload) ? id : null;
    }

    // Standalone commands/questions must not replace an in-progress reply card.
    return this.sendMarkdown(conversationId, content);
  }

  /**
   * 更新卡片消息
   */
  async updateCard(messageId: string, card: object): Promise<boolean> {
    const payload = card as { text?: string; markdown?: string; status?: string };
    const content = payload.markdown || payload.text || '';

    for (const [conversationId, fallback] of this.fallbackCards) {
      if (fallback.id !== messageId) continue;
      if (payload.status !== 'completed' && payload.status !== 'failed') return true;
      // No repeated partial markdown: a denied AI card gets only one final answer.
      const sent = await this.sendMarkdown(conversationId, content);
      if(sent !== null)this.clearAICard(conversationId);
      return sent !== null;
    }

    // 查找对应的 AI Card 实例
    for (const [conversationId, aiCard] of this.aiCards) {
      if (aiCard.cardInstanceId === messageId) {
        this.streamContents.set(conversationId,content);
        const decoded = decodeDingtalkChatId(conversationId);
        if (!decoded) continue;

        const account = configStore.getDingtalkAccount(decoded.accountId);
        if (!account) continue;

        const config: DingtalkConfig = {
          clientId: account.client_id,
          clientSecret: account.client_secret,
          endpoint: account.endpoint,
        };

        // 根据状态决定操作
        const isFinished = payload.status === 'completed' || payload.status === 'failed';

        if (isFinished) {
          const updated = payload.status === 'failed'
            ? await errorAICard(config, aiCard, content)
            : await finishAICard(config, aiCard, content);
          const delivered = updated || await this.sendMarkdown(conversationId, content) !== null;
          if(delivered)this.clearAICard(conversationId);
          return delivered;
        } else {
          return await streamAICard(config, aiCard, content);
        }
      }
    }

    // 未找到 AI Card，无法更新
    return false;
  }

  private async sendMarkdown(conversationId: string, content: string): Promise<string | null> {
    const decoded = decodeDingtalkChatId(conversationId);
    if (!decoded) return null;
    const account = configStore.getDingtalkAccount(decoded.accountId);
    if (!account) return null;
    const webhook = this.sessionWebhooks.get(decoded.conversationId);
    const config = { clientId: account.client_id, clientSecret: account.client_secret, endpoint: account.endpoint };
    const result = webhook
      ? await sendViaSessionWebhook(webhook, 'markdown', content)
      : isDingtalkGroupChat(decoded.conversationId)
        ? await sendToGroup(config, decoded.conversationId, content, 'markdown')
        : await sendToUser(config, decoded.conversationId, content, 'markdown');
    return result.ok ? result.processQueryKey || 'sent' : null;
  }

  /**
   * 撤回消息
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    try {
      // 遍历所有 AI Card 实例，查找对应的会话
      for (const [conversationId, aiCard] of this.aiCards) {
        if (aiCard.cardInstanceId === messageId) {
          const decoded = decodeDingtalkChatId(conversationId);
          if (!decoded) continue;

          const account = configStore.getDingtalkAccount(decoded.accountId);
          if (!account) continue;

          const config: DingtalkConfig = {
            clientId: account.client_id,
            clientSecret: account.client_secret,
            endpoint: account.endpoint,
          };

          // 获取 access_token
          const token = await getAccessToken(config);

          // 判断是单聊还是群聊
          const isGroup = isDingtalkGroupChat(decoded.conversationId);

          const body = {
            robotCode: config.clientId,
            msgId: messageId,
          };

          // 群聊需要 openConversationId
          if (isGroup) {
            (body as Record<string, unknown>).openConversationId = decoded.conversationId;
          }

          const endpoint = isGroup
            ? `${DINGTALK_API}/v1.0/robot/groupMessages/recall`
            : `${DINGTALK_API}/v1.0/robot/oToMessages/recall`;

          const resp = await httpClient.post(endpoint, body, {
            headers: {
              'x-acs-dingtalk-access-token': token,
              'Content-Type': 'application/json',
            },
          });

          // 清理 AI Card 实例
          this.aiCards.delete(conversationId);

          return resp.status === 200;
        }
      }

      console.warn('[钉钉] 未找到要撤回的消息:', messageId);
      return false;
    } catch (error: any) {
      console.error('[钉钉] 撤回消息失败:', error.message);
      return false;
    }
  }

  /**
   * 创建 AI Card（用于流式响应）
   */
  async createAICardForConversation(
    conversationId: string,
    target: DingtalkAICardTarget,
  ): Promise<DingtalkAICardInstance | null> {
    const decoded = decodeDingtalkChatId(conversationId);
    if (!decoded) {
      console.warn('[钉钉] 无效的 chatId 格式');
      return null;
    }

    const account = configStore.getDingtalkAccount(decoded.accountId);
    if (!account) {
      console.warn(`[钉钉] 找不到账号 ${decoded.accountId}`);
      return null;
    }

    const config: DingtalkConfig = {
      clientId: account.client_id,
      clientSecret: account.client_secret,
      endpoint: account.endpoint,
    };

    const card = await createAICard(config, target, conversationId);
    if (card) {
      this.aiCards.set(conversationId, card);
    }

    return card;
  }

  /**
   * 清理 AI Card 实例
   */
  clearAICard(conversationId: string): void {
    this.aiCards.delete(conversationId);
    this.fallbackCards.delete(conversationId);
    this.streamIds.delete(conversationId);
    this.streamContents.delete(conversationId);
  }
}
