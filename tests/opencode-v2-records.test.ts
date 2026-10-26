import { describe, expect, it } from 'vitest';
import { toLegacyMessages, toLegacyProviders, toLegacySession } from '../src/opencode/v2-records.js';

const created = '2026-10-26T01:00:00.000Z';
const completed = '2026-10-26T01:00:02.000Z';

describe('native record conversion', () => {
  it('preserves native session identity, directory and defaults while converting timestamps', () => {
    expect(toLegacySession({ id: 'ses_shared', projectID: 'prj_test', title: 'Synthetic session',
      location: { directory: 'C:/synthetic' }, agent: 'build', model: { providerID: 'demo', id: 'model', variant: 'fast' },
      time: { created, updated: completed } })).toMatchObject({
      id: 'ses_shared', projectID: 'prj_test', directory: 'C:/synthetic', agent: 'build',
      model: { providerID: 'demo', id: 'model', variant: 'fast' },
      time: { created: 1792976400000, updated: 1792976402000 },
    });
    expect(() => toLegacySession(null)).toThrow(/session/i);
    expect(() => toLegacySession({ id: 42 })).toThrow(/session/i);
  });

  it('maps user text and inline or URI files without replacing message IDs', () => {
    const messages = toLegacyMessages('ses_shared', [{ id: 'msg_user', type: 'user', text: 'Inspect the sample', time: { created },
      files: [{ name: 'sample.txt', mime: 'text/plain', data: 'aGk=', source: { type: 'inline' } },
        { name: 'image.png', mime: 'image/png', data: '', source: { type: 'uri', uri: 'https://example.test/image.png' } }] }]);
    expect(messages[0].info).toMatchObject({ id: 'msg_user', sessionID: 'ses_shared', role: 'user', time: { created: 1792976400000 } });
    expect(messages[0].parts).toMatchObject([{ type: 'text', text: 'Inspect the sample' },
      { type: 'file', filename: 'sample.txt', mime: 'text/plain', url: 'data:text/plain;base64,aGk=' },
      { type: 'file', filename: 'image.png', url: 'https://example.test/image.png' }]);
    expect(messages[0].parts.every(p => p.messageID === 'msg_user' && p.sessionID === 'ses_shared')).toBe(true);
  });

  it('converts assistant ordinals, reasoning and terminal tool success/failure into readable legacy parts', () => {
    const [message] = toLegacyMessages('ses_shared', [{ id: 'msg_shared', type: 'assistant', agent: 'build',
      model: { providerID: 'demo', id: 'model' }, time: { created, completed }, finish: 'stop', cost: 0,
      content: [{ type: 'text', text: 'First' }, { type: 'reasoning', text: 'Consider sample' }, { type: 'text', text: 'Second' },
        { type: 'tool', id: 'call_ok', name: 'read', state: { status: 'completed', input: { path: 'sample' }, content: [{ type: 'text', text: 'hello sample' }] }, time: { created, ran: created, completed } },
        { type: 'tool', id: 'call_fail', name: 'run', state: { status: 'error', input: {}, error: { type: 'unknown', message: 'Synthetic failure' } }, time: { created, completed } }] }]);
    expect(message.info).toMatchObject({ id: 'msg_shared', role: 'assistant', sessionID: 'ses_shared', mode: 'build', providerID: 'demo', modelID: 'model', time: { created: 1792976400000, completed: 1792976402000 } });
    expect(message.parts.map(p => p.id)).toEqual(['msg_shared:text:0', 'msg_shared:reasoning:0', 'msg_shared:text:1', 'msg_shared:tool:call_ok', 'msg_shared:tool:call_fail']);
    expect(message.parts[3]).toMatchObject({ type: 'tool', tool: 'read', callID: 'call_ok', state: { status: 'completed', output: 'hello sample', time: { start: 1792976400000, end: 1792976402000 } } });
    expect(message.parts[4]).toMatchObject({ state: { status: 'error', error: 'Synthetic failure' } });
  });

  it('accepts native millisecond times and ignores malformed/non-chat records', () => {
    expect(toLegacyMessages('ses_shared', [null, [], { id: 'msg_idle', type: 'idle', time: { created } },
      { id: 1, type: 'assistant' }, { id: 'msg_shared', type: 'assistant', time: { created: 1234 }, content: [null, { type: 'text', text: 'valid' }] }]))
      .toMatchObject([{ info: { id: 'msg_shared', time: { created: 1234 } }, parts: [{ text: 'valid' }] }]);
  });

  it('preserves downloadable file URIs in native tool output', () => {
    const [message] = toLegacyMessages('ses_shared', [{ id: 'msg_shared', type: 'assistant', time: { created }, content: [
      { type: 'tool', id: 'call_file', name: 'export', time: { created, completed }, state: { status: 'completed', input: {}, content: [
        { type: 'text', text: 'Export ready' }, { type: 'file', uri: 'https://example.test/result.txt', mime: 'text/plain', name: 'result.txt' },
      ] } },
    ] }]);
    expect(message.parts[0].state.output).toContain('Export ready');
    expect(message.parts[0].state.output).toContain('result.txt');
    expect(message.parts[0].state.output).toContain('https://example.test/result.txt');
  });

  it('joins enabled native models to providers with capabilities and variant maps', () => {
    const result = toLegacyProviders([{ id: 'demo', name: 'Demo', activation: 'enabled' }, null], [
      { id: 'model', providerID: 'demo', name: 'Demo model', enabled: true, capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, variants: [{ id: 'fast', settings: { effort: 'low' } }], limit: { context: 1000, output: 100 } },
      { id: 'disabled', providerID: 'demo', enabled: false }, null,
    ]);
    expect(result.providers).toMatchObject([{ id: 'demo', models: [{ id: 'model', capabilities: { input: { text: true, image: true }, output: { text: true }, attachment: true }, variants: { fast: { effort: 'low' } } }] }]);
    expect(result.default).toEqual({ demo: 'model' });
  });
});
