/** Small guards shared by the native HTTP and event conversion boundaries. */
export function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

export function milliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function legacyTime(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(object(value) ?? {})) {
    const time = milliseconds(raw);
    if (time !== undefined) result[key] = time;
  }
  return result;
}

export function readableError(value: unknown): string {
  if (typeof value === 'string') return value;
  const error = object(value);
  if (!error) return 'Unknown OpenCode error';
  for (const candidate of [error.message, object(error.data)?.message, error.name, error.type, error._tag]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return JSON.stringify(error);
}

export function legacyError(value: unknown): Record<string, any> {
  const error = object(value);
  const status = typeof error?.status === 'number' && Number.isInteger(error.status) ? error.status : undefined;
  return { ...error, name: status !== undefined ? 'APIError' : error?.name ?? error?.type ?? error?._tag ?? 'OpenCodeError',
    data: { ...object(error?.data), message: readableError(value),
      ...(status !== undefined ? { statusCode: status, isRetryable: status === 408 || status === 429 || status >= 500 } : {}),
      ...(typeof object(error?.response)?.body === 'string' ? { responseBody: error!.response.body } : {}) } };
}

export function readableContent(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value.flatMap(item => {
    const part = object(item);
    if (!part) return [];
    if (typeof part.text === 'string') return [part.text];
    // Binary tool results should remain recognizable without dumping base64 into chat.
    if (part.type === 'image' || part.type === 'file' || part.type === 'audio') {
      const uri = typeof part.uri === 'string' && !part.uri.startsWith('data:') ? ` ${part.uri}` : '';
      return [`[${part.type}${typeof part.name === 'string' ? `: ${part.name}` : ''}${typeof part.mime === 'string' ? ` (${part.mime})` : ''}]${uri}`];
    }
    if (typeof part.uri === 'string') return [part.uri];
    return [JSON.stringify(part)];
  }).join('\n');
}

export function toLegacySession(value: unknown): Record<string, any> {
  const session = object(value);
  if (!session || typeof session.id !== 'string' || !session.id) throw new Error('Invalid native OpenCode session');
  return { ...session, directory: object(session.location)?.directory ?? session.directory ?? '', time: legacyTime(session.time) };
}

/** Native text and reasoning each have their own ordinal sequence. */
export function legacyPart(sessionID: string, messageID: string, value: unknown, ordinal: number): Record<string, any> | undefined {
  const content = object(value);
  if (!content) return undefined;
  const base = { sessionID, messageID };
  if ((content.type === 'text' || content.type === 'reasoning') && typeof content.text === 'string') {
    return { ...base, id: `${messageID}:${content.type}:${ordinal}`, type: content.type, text: content.text,
      ...(content.time ? { time: legacyTime(content.time) } : {}) };
  }
  if (content.type !== 'tool' || typeof content.id !== 'string' || typeof content.name !== 'string') return undefined;
  const state = object(content.state);
  if (!state || !['streaming', 'running', 'completed', 'error'].includes(state.status)) return undefined;
  const time = legacyTime(content.time);
  const metadata = object(state.metadata) ?? {};
  const legacyState: Record<string, any> = {
    status: state.status === 'streaming' ? 'pending' : state.status,
    input: object(state.input) ?? {},
    metadata,
    time: { start: time.ran ?? time.created ?? 0, ...(time.completed !== undefined ? { end: time.completed } : {}) },
  };
  if (typeof metadata.title === 'string') legacyState.title = metadata.title;
  if (state.status === 'streaming') legacyState.raw = typeof state.input === 'string' ? state.input : '';
  if (state.status === 'completed' || state.status === 'error') legacyState.output = readableContent(state.content);
  if (state.status === 'error') legacyState.error = readableError(state.error);
  return { ...base, id: `${messageID}:tool:${content.id}`, type: 'tool', callID: content.id, tool: content.name, state: legacyState };
}

export function toLegacyMessages(sessionId: string, values: unknown[]): Array<{ info: any; parts: any[] }> {
  const messages: Array<{ info: any; parts: any[] }> = [];
  let parentID: string | undefined;
  for (const value of values) {
    const message = object(value);
    if (!message || typeof message.id !== 'string' || !['user', 'assistant', 'synthetic', 'system', 'skill'].includes(message.type)) continue;
    const role = message.type === 'assistant' ? 'assistant' : 'user';
    const info: Record<string, any> = { ...message, id: message.id, sessionID: sessionId, role, time: legacyTime(message.time) };
    delete info.content;
    delete info.files;
    delete info.text;
    if (role === 'assistant') {
      const model = object(message.model);
      Object.assign(info, { mode: message.agent, agent: message.agent, modelID: model?.id, providerID: model?.providerID,
        ...(parentID ? { parentID } : {}), ...(message.error ? { error: legacyError(message.error) } : {}) });
      const ordinals = { text: 0, reasoning: 0 };
      const parts = (Array.isArray(message.content) ? message.content : []).flatMap(part => {
        const raw = object(part);
        const kind = raw?.type === 'text' ? 'text' : raw?.type === 'reasoning' ? 'reasoning' : undefined;
        return legacyPart(sessionId, message.id, part, kind ? ordinals[kind]++ : 0) ?? [];
      });
      messages.push({ info, parts });
      continue;
    }
    parentID = message.id;
    const parts: any[] = typeof message.text === 'string'
      ? [{ id: `${message.id}:text:0`, type: 'text', sessionID: sessionId, messageID: message.id, text: message.text }] : [];
    for (const [index, rawFile] of (Array.isArray(message.files) ? message.files : []).entries()) {
      const file = object(rawFile);
      const source = object(file?.source);
      if (!file || typeof file.mime !== 'string' || !source) continue;
      const url = source.type === 'uri' && typeof source.uri === 'string' ? source.uri
        : source.type === 'inline' && typeof file.data === 'string' ? `data:${file.mime};base64,${file.data}` : undefined;
      if (url !== undefined) parts.push({ id: `${message.id}:file:${index}`, type: 'file', sessionID: sessionId, messageID: message.id, mime: file.mime, filename: file.name, url });
    }
    messages.push({ info, parts });
  }
  return messages;
}

export function toLegacyProviders(providers: unknown[], models: unknown[]): { providers: any[]; default: Record<string, string> } {
  const defaults: Record<string, string> = Object.create(null);
  const converted = providers.flatMap(rawProvider => {
    const provider = object(rawProvider);
    if (!provider || typeof provider.id !== 'string' || provider.activation === 'disabled') return [];
    const entries: Record<string, any>[] = models.flatMap(rawModel => {
      const model = object(rawModel);
      if (!model || model.providerID !== provider.id || typeof model.id !== 'string' || model.enabled === false) return [];
      const caps = object(model.capabilities) ?? {};
      const input = Object.fromEntries((Array.isArray(caps.input) ? caps.input : []).filter(v => typeof v === 'string').map(v => [v, true]));
      const output = Object.fromEntries((Array.isArray(caps.output) ? caps.output : []).filter(v => typeof v === 'string').map(v => [v, true]));
      const variants = Object.fromEntries((Array.isArray(model.variants) ? model.variants : []).flatMap(rawVariant => {
        const variant = object(rawVariant);
        return variant && typeof variant.id === 'string' ? [[variant.id, object(variant.settings) ?? {}]] : [];
      }));
      return [{ ...model, capabilities: { ...caps, input, output, attachment: Object.keys(input).some(k => k !== 'text'), toolcall: caps.tools === true }, variants }];
    });
    if (entries[0]) defaults[provider.id] = entries[0].id;
    return [{ ...provider, models: entries }];
  });
  return { providers: converted, default: defaults };
}
