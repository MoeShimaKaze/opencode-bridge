import { legacyError, legacyPart, milliseconds, object, readableError } from './v2-records.js';

type LegacyEvent = { type: string; properties: Record<string, any> };
interface MessageState {
  info: Record<string, any>;
  parts: Map<string, Record<string, any>>;
}

const emit = (type: string, properties: Record<string, any>): LegacyEvent => ({ type, properties });

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

/** One mapper is retained across reconnects; native IDs suppress replayed durable events. */
export class V2EventMapper {
  private readonly seen = new Map<string, boolean>();
  private readonly messages = new Map<string, MessageState>();
  private readonly forms = new Map<string, Record<string, any>>();
  private readonly settled = new Map<string, number>();

  getForm(id: string): any { return this.forms.get(id); }
  forgetForm(id: string): void { this.forms.delete(id); }

  /** Reconcile only a confirmed inactive execution, before consuming buffered live events. */
  restoreSession(sessionID: string, messages: Array<{ info: any; parts: any[] }>, outcome: unknown, idle: number): LegacyEvent[] {
    const events: LegacyEvent[] = [];
    let error: unknown;
    for (const { info, parts } of messages) {
      if (info.role !== 'assistant' || typeof info.id !== 'string') continue;
      const [message] = this.message(sessionID, info.id, info.time?.created ?? idle);
      const complete = { ...info, time: { ...info.time, completed: info.time?.completed ?? idle } };
      // Establish role first, then deliver corrected parts before the completed message boundary.
      const initial = { ...complete, time: { created: complete.time.created } };
      delete initial.error;
      events.push(emit('message.updated', { info: initial }));
      for (const part of parts) {
        if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
          const ordinal = part.id.slice(`${info.id}:${part.type}:`.length);
          remember(message.parts, `${part.type}:${ordinal}`, { ended: true }, 2048);
          events.push(emit('message.part.updated', { part, replace: true }));
        } else if (part.type === 'tool') {
          remember(message.parts, `tool:${part.callID}`, { state: { status: part.state.status } }, 2048);
          events.push(emit('message.part.updated', { part }));
        }
      }
      message.info = complete;
      if (complete.error) error = complete.error;
      events.push(emit('message.updated', { info: complete }));
    }
    remember(this.settled, sessionID, idle, 256);
    if (outcome === 'failed') events.push(emit('session.error', { sessionID, error: legacyError(error ?? 'Native execution failed while disconnected') }));
    events.push(emit('session.status', { sessionID, status: { type: 'idle' } }), emit('session.idle', { sessionID }));
    return events;
  }

  map(value: unknown): LegacyEvent[] {
    const event = object(value);
    const data = object(event?.data);
    if (!event || typeof event.type !== 'string' || !data) return [];
    if (typeof event.id === 'string') {
      if (this.seen.has(event.id)) return [];
      remember(this.seen, event.id, true, 4096);
    }
    const type: string = event.type;
    const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined;
    const timestamp = milliseconds(event.created) ?? Date.now();
    if (sessionID && type.startsWith('session.execution.') && timestamp <= (this.settled.get(sessionID) ?? -Infinity)) return [];

    if (type === 'form.created') return this.form(data.form);
    if (type === 'form.replied' || type === 'form.cancelled') {
      if (typeof data.id === 'string') this.forgetForm(data.id);
      return typeof data.id === 'string' && sessionID ? [emit(type==='form.replied'?'question.replied':'question.rejected',{id:data.id,sessionID})] : [];
    }
    if (!sessionID) return [];
    if (type === 'permission.asked') {
      if (typeof data.id !== 'string' || typeof data.action !== 'string' || !Array.isArray(data.resources)) return [];
      const source = object(data.source);
      return [emit(type, { ...data, permission: data.action, patterns: data.resources.filter(v => typeof v === 'string'),
        description: typeof data.message === 'string' ? data.message : data.resources.join(', '),
        ...(source?.type === 'tool' && typeof source.messageID === 'string' && typeof source.id === 'string'
          ? { tool: { messageID: source.messageID, callID: source.id } } : {}) })];
    }
    if (type === 'session.execution.started') return [emit('session.status', { sessionID, status: { type: 'busy' } })];
    if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(type)) {
      return [
        ...(type === 'session.execution.failed' ? [emit('session.error', { sessionID, error: legacyError(data.error) })] : []),
        emit('session.status', { sessionID, status: { type: 'idle' } }), emit('session.idle', { sessionID }),
      ];
    }
    if (type === 'session.retry.scheduled') {
      return [emit('session.status', { sessionID, status: { type: 'retry', attempt: data.attempt, next: data.at, message: readableError(data.error) } })];
    }

    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    if (!messageID) return [];
    if (type.startsWith('session.text.') || type.startsWith('session.reasoning.')) {
      if (!Number.isInteger(data.ordinal) || data.ordinal < 0) return [];
      const kind = type.startsWith('session.text.') ? 'text' : 'reasoning';
      const phase = type.split('.').at(-1);
      if (!['started', 'delta', 'ended'].includes(phase!)) return [];
      if ((phase === 'delta' && typeof data.delta !== 'string') || (phase === 'ended' && typeof data.text !== 'string')) return [];
      const [message, initial] = this.message(sessionID, messageID, timestamp);
      const key = `${kind}:${data.ordinal}`;
      const previous = message.parts.get(key);
      if (previous?.ended) return initial;
      const text = phase === 'ended' ? data.text : `${previous?.text ?? ''}${phase === 'delta' ? data.delta : ''}`;
      const replace = phase === 'ended' && !text.startsWith(previous?.text ?? '');
      const delta = replace ? '' : text.slice((previous?.text ?? '').length);
      // Terminal parts need only a replay tombstone, not another retained copy of the transcript.
      remember(message.parts, key, phase === 'ended' ? { ended: true } : { text }, 2048);
      if (!delta && !replace && phase !== 'started') return initial;
      return [...initial, emit('message.part.updated', {
        part: { id: `${messageID}:${kind}:${data.ordinal}`, sessionID, messageID, type: kind, text },
        ...(replace ? { replace: true } : delta ? { delta } : {}),
      })];
    }

    if (type.startsWith('session.tool.')) {
      const phase = type.slice('session.tool.'.length);
      if (typeof data.id !== 'string' || !['input.started', 'input.delta', 'input.ended', 'called', 'progress', 'success', 'failed'].includes(phase)) return [];
      if ((phase === 'input.started' && typeof data.name !== 'string') || (phase === 'input.delta' && typeof data.delta !== 'string') || (phase === 'input.ended' && typeof data.text !== 'string')) return [];
      const [message, initial] = this.message(sessionID, messageID, timestamp);
      const key = `tool:${data.id}`;
      const previous = message.parts.get(key);
      if (previous?.state?.status === 'completed' || previous?.state?.status === 'error') return initial;
      const tool = previous ? { ...previous, state: { ...previous.state }, time: { ...previous.time } }
        : { type: 'tool', id: data.id, name: typeof data.name === 'string' ? data.name : data.id,
          state: { status: 'streaming', input: '' }, time: { created: timestamp } };
      if (phase === 'input.started') tool.name = data.name;
      if (phase === 'input.delta') tool.state.input = `${typeof tool.state.input === 'string' ? tool.state.input : ''}${data.delta}`;
      if (phase === 'input.ended') tool.state.input = data.text;
      if (phase === 'called') {
        if (!object(data.input)) return initial;
        tool.state = { status: 'running', input: data.input, metadata: {} };
        tool.time.ran = timestamp;
      }
      if (phase === 'progress') tool.state = { ...tool.state, status: 'running', input: object(tool.state.input) ?? {}, metadata: object(data.metadata) ?? {} };
      if (phase === 'success' || phase === 'failed') {
        tool.state = { ...tool.state, status: phase === 'success' ? 'completed' : 'error', input: object(tool.state.input) ?? {},
          content: Array.isArray(data.content) ? data.content : [], metadata: object(data.metadata) ?? tool.state.metadata,
          ...(phase === 'failed' ? { error: data.error } : {}) };
        tool.time.completed = timestamp;
      }
      remember(message.parts, key, phase === 'success' || phase === 'failed'
        ? { state: { status: tool.state.status } } : tool, 2048);
      return [...initial, emit('message.part.updated', { part: legacyPart(sessionID, messageID, tool, 0)! })];
    }

    if (!['session.step.started', 'session.step.ended', 'session.step.failed'].includes(type)) return [];
    const [message] = this.message(sessionID, messageID, timestamp);
    if (message.info.time?.completed) return [];
    if (type === 'session.step.started') {
      const model = object(data.model);
      message.info = { ...message.info, mode: data.agent, agent: data.agent, providerID: model?.providerID, modelID: model?.id,
        time: { created: milliseconds(data.started) ?? timestamp } };
    } else {
      message.info = { ...message.info, finish: data.finish, cost: data.cost, tokens: data.tokens,
        ...(type === 'session.step.failed' ? { error: legacyError(data.error) } : {}),
        time: { ...message.info.time, completed: timestamp } };
    }
    return [emit('message.updated', { info: { ...message.info } })];
  }

  private message(sessionID: string, id: string, created: number): [MessageState, LegacyEvent[]] {
    const key = `${sessionID}:${id}`;
    const previous = this.messages.get(key);
    if (previous) {
      remember(this.messages, key, previous, 256);
      return [previous, []];
    }
    const state: MessageState = { info: { id, sessionID, role: 'assistant', time: { created } }, parts: new Map() };
    remember(this.messages, key, state, 256);
    return [state, [emit('message.updated', { info: { ...state.info } })]];
  }

  private form(value: unknown): LegacyEvent[] {
    const form = object(value);
    if (!form || typeof form.id !== 'string' || typeof form.sessionID !== 'string' || !Array.isArray(form.fields) || form.fields.length === 0) return [];
    const questions: Record<string, any>[] = [];
    for (const rawField of form.fields) {
      const field = object(rawField);
      if (!field || typeof field.key !== 'string' || !['string', 'number', 'integer', 'boolean', 'multiselect'].includes(field.type)
        || field.hidden === true || (Array.isArray(field.when) && field.when.length > 0)) {
        return [emit('session.error', { sessionID: form.sessionID, error: legacyError('Unsupported native form fields; answer this form in OpenCode.') })];
      }
      const options = field.type === 'boolean' ? [{ label: 'Yes', description: '', value: true }, { label: 'No', description: '', value: false }]
        : (Array.isArray(field.options) ? field.options : []).flatMap(rawOption => {
          const option = object(rawOption);
          return option && typeof option.label === 'string' && typeof option.value === 'string'
            ? [{ label: option.label, description: typeof option.description === 'string' ? option.description : '', value: option.value }] : [];
        });
      questions.push({ key: field.key, header: field.title ?? field.key, question: field.description ?? field.title ?? form.title ?? field.key,
        options, multiple: field.type === 'multiselect', custom: options.length === 0 || field.custom === true });
    }
    remember(this.forms, form.id, form, 256);
    const tool=object(object(form.metadata)?.tool);
    return [emit('question.asked', { id: form.id, sessionID: form.sessionID, questions,
      ...(typeof tool?.messageID==='string' && typeof tool?.id==='string'?{tool:{messageID:tool.messageID,callID:tool.id}}:{}) })];
  }
}
