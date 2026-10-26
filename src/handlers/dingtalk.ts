/**
 * 钉钉 (DingTalk) 消息处理器
 *
 * 处理钉钉消息：权限请求、问题回答、命令处理
 */

import type { PlatformMessageEvent, PlatformSender } from '../platform/types.js';
import { decodeDingtalkChatId } from '../platform/adapters/dingtalk/dingtalk-ids.js';
import { configStore } from '../store/config-store.js';
import { opencodeClient } from '../opencode/client.js';
import { outputBuffer } from '../opencode/output-buffer.js';
import { chatSessionStore } from '../store/chat-session.js';
import { parseCommand, type ParsedCommand } from '../commands/parser.js';
import { normalizeEffortLevel, type EffortLevel } from '../commands/effort.js';
import { DirectoryPolicy } from '../utils/directory-policy.js';
import { buildSessionTimestamp } from '../utils/session-title.js';
import { shouldSkipGroupMessage } from '../utils/group-mention.js';
import { permissionHandler } from '../permissions/handler.js';
import { PlatformCommandHandler } from './platform-command.handler.js';
import type { PermissionDecision } from './dingtalk-types.js';
import { parsePermissionDecision } from './dingtalk-utils.js';
import { questionHandler, type PendingQuestion } from '../opencode/question-handler.js';
import { parseQuestionAnswerText } from '../opencode/question-parser.js';

export class DingtalkHandler {
  private readonly commandHandler = new PlatformCommandHandler('dingtalk');

  private ensureStreamingBuffer(chatId: string, sessionId: string): void {
    const key = `chat:dingtalk:${chatId}`;
    const current = outputBuffer.get(key);
    if (current && current.status !== 'running') {
      outputBuffer.clear(key);
    }

    if (!outputBuffer.get(key)) {
      outputBuffer.getOrCreate(key, chatId, sessionId, null);
    }
  }

  private getPermissionQueueKey(conversationId: string): string {
    return `dingtalk:${conversationId}`;
  }

  private resolvePermissionDirectoryOptions(
    sessionId: string,
    conversationId: string
  ): { directory?: string; fallbackDirectories?: string[] } {
    const boundSession = chatSessionStore.getSessionByConversation('dingtalk', conversationId);
    const directory = boundSession?.resolvedDirectory || boundSession?.defaultDirectory;

    const fallbackDirectories = Array.from(
      new Set(
        [
          boundSession?.resolvedDirectory,
          boundSession?.defaultDirectory,
          ...chatSessionStore.getKnownDirectories(),
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      )
    );

    return {
      ...(directory ? { directory } : {}),
      ...(fallbackDirectories.length > 0 ? { fallbackDirectories } : {}),
    };
  }

  private formatDispatchError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    if (normalized.includes('fetch failed') || normalized.includes('networkerror')) {
      return '与 OpenCode 的连接失败，请检查服务是否在线或网络是否超时';
    }

    if (normalized.includes('timed out') || normalized.includes('timeout')) {
      return '请求 OpenCode 超时，请稍后重试';
    }

    return `请求失败：${message}`;
  }

  /**
   * 处理钉钉消息
   */
  async handleMessage(
    event: PlatformMessageEvent,
    sender: PlatformSender
  ): Promise<void> {
    // 群聊 @ 提到检查
    if (shouldSkipGroupMessage(event)) {
      return;
    }

    const { conversationId, content, senderId, msgType, chatType } = event;
    const trimmed = content.trim();

    // 解码 ChatId 获取账号信息
    const decoded = decodeDingtalkChatId(conversationId);
    if (!decoded) {
      console.warn('[钉钉] 无效的 chatId 格式');
      return;
    }
    const { accountId } = decoded;

    // 忽略非文本消息
    if (msgType && msgType !== 'text') {
      console.log(`[钉钉] 忽略非文本消息: ${msgType}`);
      return;
    }

    if (!trimmed) {
      return;
    }

    const command = parseCommand(trimmed);
    // Explicit commands must remain available while an interactive tool is waiting.
    if (trimmed.startsWith('/') && command.type !== 'prompt') {
      await this.dispatchCommand(command, event, sender);
      return;
    }

    // 0. 检查是否有待处理的权限请求
    const permissionHandled = await this.tryHandlePendingPermission(conversationId, trimmed, sender);
    if (permissionHandled) {
      return;
    }

    if (await this.tryHandlePendingQuestion(conversationId, trimmed, sender)) return;

    // 2. 使用 PlatformCommandHandler 处理非 prompt 命令
    if (command.type !== 'prompt') {
      console.log(`[钉钉] 收到命令：${command.type}`);
      await this.dispatchCommand(command, event, sender);
      return;
    }

    // 3. 获取或创建会话
    let sessionId = chatSessionStore.getSessionIdByConversation('dingtalk', conversationId);
    if (!sessionId) {
      const title = `钉钉会话-${buildSessionTimestamp()}`;
      const chatDefault = chatSessionStore.getSessionByConversation('dingtalk', conversationId)?.defaultDirectory;
      const dirResult = DirectoryPolicy.resolve({ chatDefaultDirectory: chatDefault });
      const effectiveDir = dirResult.ok && dirResult.source !== 'server_default' ? dirResult.directory : undefined;
      const session = await opencodeClient.createSession(title, effectiveDir);
      if (session) {
        sessionId = session.id;
        chatSessionStore.setSessionByConversation('dingtalk', conversationId, sessionId, senderId, title, {
          chatType: event.chatType || 'p2p',
          resolvedDirectory: session.directory,
        });
      } else {
        await sender.sendText(conversationId, '无法创建 OpenCode 会话');
        return;
      }
    }

    // 4. 处理 Prompt
    const sessionConfig = chatSessionStore.getSessionByConversation('dingtalk', conversationId);
    const promptText = command.text ?? trimmed;
    await this.processPrompt(
      sessionId,
      promptText,
      conversationId,
      sessionConfig ?? undefined,
      command.promptEffort,
      sender
    );
  }

  private async dispatchCommand(command: ParsedCommand, event: PlatformMessageEvent, sender: PlatformSender): Promise<void> {
    await this.commandHandler.handle(command, { chatId: event.conversationId, senderId: event.senderId,
      chatType: event.chatType === 'group' ? 'group' : 'p2p' }, sender);
  }

  private async tryHandlePendingQuestion(chatId: string, text: string, sender: PlatformSender): Promise<boolean> {
    const sessionId = chatSessionStore.getSessionIdByConversation('dingtalk', chatId);
    if (!sessionId) return false;
    let pending = questionHandler.getBySession(sessionId);
    if (!pending || pending.chatId !== chatId) {
      const config = chatSessionStore.getSessionByConversation('dingtalk', chatId);
      const directory = config?.resolvedDirectory || config?.defaultDirectory;
      try {
        const requests = await opencodeClient.listPendingQuestions({ sessionId, ...(directory ? { directory } : {}) });
        if (chatSessionStore.getSessionIdByConversation('dingtalk', chatId) !== sessionId) {
          await sender.sendText(chatId, '当前会话已切换，请在新会话中重新发送。');
          return true;
        }
        const request = requests.find(value => value.sessionID === sessionId && value.questions.length > 0);
        if (!request) return false;
        questionHandler.register(request, `chat:dingtalk:${chatId}`, chatId);
        pending = questionHandler.get(request.id);
      } catch (error) {
        console.error('[钉钉] 恢复待回答问题失败:', error);
        await sender.sendText(chatId, '暂时无法确认待回答问题，请稍后重试；也可使用 /stop 中断任务。');
        return true;
      }
    }
    if (!pending || pending.request.questions.length === 0) return false;
    if (pending.submitting) {
      await sender.sendText(chatId, '正在提交问题回答，请稍候。');
      return true;
    }
    if (pending.submissionFailed && /^(重试|重新提交|提交|retry)$/i.test(text.trim())) {
      await this.submitQuestionAnswers(pending, sender);
      return true;
    }
    const index = Math.min(Math.max(pending.currentQuestionIndex, 0), pending.request.questions.length - 1);
    const question = pending.request.questions[index];
    const exactOption = question.options.find(option => option.label.toLowerCase() === text.trim().toLowerCase());
    const parsed = exactOption ? { type: 'selection' as const, values: [exactOption.label] } : parseQuestionAnswerText(text, question);
    if (!parsed || (parsed.type === 'custom' && question.custom === false)) {
      await this.sendQuestionPrompt(pending, sender);
      return true;
    }
    questionHandler.setDraftAnswer(pending.request.id, index, parsed.type === 'selection' ? parsed.values ?? [] : []);
    questionHandler.setDraftCustomAnswer(pending.request.id, index, parsed.type === 'custom' ? parsed.custom ?? text : '');
    pending.submissionFailed = false;
    if (index + 1 < pending.request.questions.length) {
      questionHandler.setCurrentQuestionIndex(pending.request.id, index + 1);
      if (outputBuffer.get(pending.conversationKey)) outputBuffer.touch(pending.conversationKey);
      await this.sendQuestionPrompt(pending, sender);
    } else await this.submitQuestionAnswers(pending, sender);
    return true;
  }

  private async sendQuestionPrompt(pending: PendingQuestion, sender: PlatformSender): Promise<void> {
    const index = pending.currentQuestionIndex;
    const question = pending.request.questions[index];
    const lines = [`🤝 ${question.header || 'AI 需要您回答问题'}（第 ${index + 1}/${pending.request.questions.length} 题）`, question.question];
    question.options.forEach((option, position) => lines.push(`${position + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`));
    if (question.options.length) lines.push(question.multiple ? '可多选，请回复选项编号或文字，多个答案用空格或逗号分隔。' : '请回复选项编号或选项文字。');
    if (question.custom !== false) lines.push('也可直接输入自定义答案。');
    lines.push('回复“跳过”可跳过当前题；/stop 可中断任务。');
    await sender.sendText(pending.chatId, lines.join('\n\n'));
  }

  private async submitQuestionAnswers(pending: PendingQuestion, sender: PlatformSender): Promise<void> {
    const answers = pending.request.questions.map((_question, index) => {
      const custom = pending.draftCustomAnswers[index]?.trim();
      return custom ? [custom] : pending.draftAnswers[index] ?? [];
    });
    pending.submitting = true;
    try {
      const result = await opencodeClient.replyQuestion(pending.request.id, answers);
      if (!result.ok) throw new Error(result.expired ? 'Question expired' : 'Question reply was not accepted');
    } catch (error) {
      pending.submissionFailed = true;
      console.error('[钉钉] 提交问题回答失败:', error);
      await sender.sendText(pending.chatId, '答案提交失败，已保留填写内容。回复“重试”重新提交，或重新回答当前题。');
      return;
    } finally {
      pending.submitting = false;
    }
    questionHandler.remove(pending.request.id);
    if (outputBuffer.get(pending.conversationKey)) outputBuffer.touch(pending.conversationKey);
    await sender.sendText(pending.chatId, '✅ 已提交问题回答，任务继续执行。');
  }

  /**
   * 尝试处理待处理的权限请求
   */
  private async tryHandlePendingPermission(
    conversationId: string,
    text: string,
    sender: PlatformSender
  ): Promise<boolean> {
    const queueKey = this.getPermissionQueueKey(conversationId);
    const pending = permissionHandler.peekForChat(queueKey);
    if (!pending) {
      return false;
    }

    const decision = parsePermissionDecision(text);
    if (!decision) {
      await sender.sendText(conversationId, '当前有待确认权限，请回复：允许 / 拒绝 / 始终允许（也支持 y / n / always）');
      return true;
    }

    const candidateSessionIds = Array.from(
      new Set(
        [pending.sessionId, pending.parentSessionId, pending.relatedSessionId]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      )
    );

    let responded = false;
    let expiredDetected = false;

    for (const candidateSessionId of candidateSessionIds) {
      const permissionDirectoryOptions = this.resolvePermissionDirectoryOptions(candidateSessionId, conversationId);
      try {
        const result = await opencodeClient.respondToPermission(
          candidateSessionId,
          pending.permissionId,
          decision.allow,
          decision.remember,
          permissionDirectoryOptions
        );
        if (result.ok) {
          responded = true;
          break;
        }
        if (result.expired) {
          expiredDetected = true;
        }
      } catch (error) {
        console.error(`[钉钉] 权限文本响应失败: session=${candidateSessionId}`, error);
      }
    }

    if (!responded) {
      if (expiredDetected) {
        await sender.sendText(conversationId, '操作已过期，请重新发起');
      } else {
        await sender.sendText(conversationId, '权限响应失败，请重试');
      }
      return true;
    }

    console.log(`[钉钉] 权限文本响应成功: allow=${decision.allow}`);

    const removed = permissionHandler.resolveForChat(queueKey, pending.permissionId);
    const toolName = removed?.tool || pending.tool || '工具';
    const resultText = decision.allow
      ? decision.remember ? `已允许并记住权限：${toolName}` : `已允许权限：${toolName}`
      : `已拒绝权限：${toolName}`;

    await sender.sendText(conversationId, resultText);
    return true;
  }

  /**
   * 处理 Prompt
   */
  private async processPrompt(
    sessionId: string,
    text: string,
    conversationId: string,
    sessionConfig: { resolvedDirectory?: string; defaultDirectory?: string; preferredModel?: string; preferredAgent?: string; preferredEffort?: string } | undefined,
    promptEffort: string | undefined,
    sender: PlatformSender
  ): Promise<void> {
    this.ensureStreamingBuffer(conversationId, sessionId);

    try {
      const dispatchOptions: {
        directory?: string;
        fallbackDirectories?: string[];
        variant?: string;
        providerId?: string;
        modelId?: string;
        agent?: string;
      } = {};

      const directory = sessionConfig?.resolvedDirectory || sessionConfig?.defaultDirectory;
      if (directory) {
        dispatchOptions.directory = directory;
      }

      const fallbackDirectories = chatSessionStore.getKnownDirectories();
      if (fallbackDirectories.length > 0) {
        dispatchOptions.fallbackDirectories = fallbackDirectories;
      }

      // 确定 effort（优先使用 promptEffort，其次是 sessionConfig.preferredEffort）
      let effectiveEffort = promptEffort || sessionConfig?.preferredEffort;
      const preferredModel=sessionConfig?.preferredModel ?? '';
      const separator=preferredModel.search(/[:/]/);
      const providerId=separator>0?preferredModel.slice(0,separator):undefined;
      const modelId=separator>0?preferredModel.slice(separator+1):undefined;

      // 验证 effort 是否与当前模型兼容
      if (effectiveEffort && sessionConfig?.preferredModel) {
        if (providerId && modelId) {
          try {
            const providersPayload = await opencodeClient.getProviders(directory ? {directory} : undefined);
            const providers = Array.isArray(providersPayload.providers) ? providersPayload.providers : [];
            const providerLower = providerId.toLowerCase();
            const modelLower = modelId.toLowerCase();

            for (const provider of providers) {
              if (!provider || typeof provider !== 'object') continue;
              const providerRecord = provider as Record<string, unknown>;
              const providerIdRaw = typeof providerRecord.id === 'string' ? providerRecord.id.trim() : '';
              if (!providerIdRaw || providerIdRaw.toLowerCase() !== providerLower) continue;

              const modelsRaw = providerRecord.models;
              const modelList = Array.isArray(modelsRaw)
                ? modelsRaw
                : (modelsRaw && typeof modelsRaw === 'object' ? Object.values(modelsRaw) : []);

              for (const modelItem of modelList) {
                if (!modelItem || typeof modelItem !== 'object') continue;
                const modelRecord = modelItem as Record<string, unknown>;
                const modelIdRaw = typeof modelRecord.id === 'string'
                  ? modelRecord.id.trim()
                  : (typeof modelRecord.modelID === 'string' ? modelRecord.modelID.trim() : '');
                if (!modelIdRaw || modelIdRaw.toLowerCase() !== modelLower) continue;

                // 解析模型支持的 variants
                const variants = modelRecord.variants;
                if (variants && typeof variants === 'object' && !Array.isArray(variants)) {
                  const supportedVariants: EffortLevel[] = [];
                  for (const key of Object.keys(variants as Record<string, unknown>)) {
                    const normalized = normalizeEffortLevel(key);
                    if (normalized && normalized !== 'none' && !supportedVariants.includes(normalized)) {
                      supportedVariants.push(normalized);
                    }
                  }
                  // 如果当前 effort 不在支持列表中，清除它
                  const normalizedEffort = normalizeEffortLevel(effectiveEffort);
                  if (normalizedEffort && supportedVariants.length > 0 && !supportedVariants.includes(normalizedEffort)) {
                    effectiveEffort = undefined;
                  }
                }
                break;
              }
              break;
            }
          } catch (error) {
            console.debug('[钉钉] 获取模型支持的 variants 失败，跳过验证:', error instanceof Error ? error.message : String(error));
          }
        }
      }

      if (effectiveEffort) {
        dispatchOptions.variant = effectiveEffort;
      }

      if (providerId && modelId) {
        dispatchOptions.providerId = providerId;
        dispatchOptions.modelId = modelId;
      }

      if (sessionConfig?.preferredAgent) {
        dispatchOptions.agent = sessionConfig.preferredAgent;
      }

      // 发送消息到 OpenCode
      await opencodeClient.sendMessage(sessionId, text, dispatchOptions);

    } catch (error) {
      console.error('[钉钉] Process prompt error:', error);
      await sender.sendText(conversationId, this.formatDispatchError(error));
    }
  }
}

export const dingtalkHandler = new DingtalkHandler();

// Re-exports for backward compatibility
export type { PermissionDecision } from './dingtalk-types.js';
export { parsePermissionDecision } from './dingtalk-utils.js';
