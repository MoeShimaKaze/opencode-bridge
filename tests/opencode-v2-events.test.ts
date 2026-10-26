import { describe, expect, it } from 'vitest';
import { V2EventMapper } from '../src/opencode/v2-events.js';
import { toLegacyMessages } from '../src/opencode/v2-records.js';

let sequence = 0;
const event = (type: string, data: Record<string, unknown>) => ({ id: `evt_${++sequence}`, created: 1792976400000 + sequence, type, data });
const ref = { sessionID: 'ses_shared', assistantMessageID: 'msg_shared' };
const parts = (events: any[]) => events.filter(e => e.type === 'message.part.updated').map(e => e.properties);

describe('native event mapping', () => {
  it('emits assistant metadata before parts and reconciles deltas with terminal snapshots', () => {
    const mapper = new V2EventMapper();
    const start = mapper.map(event('session.step.started', { ...ref, agent: 'build', model: { providerID: 'demo', id: 'model' }, started: 1792976400000 }));
    expect(start[0]).toMatchObject({ type: 'message.updated', properties: { info: { id: 'msg_shared', sessionID: 'ses_shared', role: 'assistant', modelID: 'model' } } });
    const deltaEvent = event('session.text.delta', { ...ref, ordinal: 0, delta: 'Hello' });
    expect(parts(mapper.map(deltaEvent))[0]).toMatchObject({ part: { id: 'msg_shared:text:0', text: 'Hello' }, delta: 'Hello' });
    expect(mapper.map(deltaEvent)).toEqual([]);
    const end = parts(mapper.map(event('session.text.ended', { ...ref, ordinal: 0, text: 'Hello world' })))[0];
    expect(end).toMatchObject({ part: { text: 'Hello world' }, delta: ' world' });
    expect(parts(mapper.map(event('session.text.ended', { ...ref, ordinal: 0, text: 'Hello world' })))).toEqual([]);
    expect(parts(mapper.map(event('session.text.delta', { ...ref, ordinal: 2, delta: 'Second' })))[0].part).toMatchObject({ id: 'msg_shared:text:2', text: 'Second' });
    expect(parts(mapper.map(event('session.reasoning.ended', { ...ref, ordinal: 1, text: 'Think' })))[0]).toMatchObject({ part: { id: 'msg_shared:reasoning:1', type: 'reasoning', text: 'Think' }, delta: 'Think' });
    expect(mapper.map(event('session.step.ended', { ...ref, finish: 'stop', cost: 0, tokens: { input: 1, output: 2 } }))[0]).toMatchObject({ type: 'message.updated', properties: { info: { id: 'msg_shared', finish: 'stop', time: { completed: expect.any(Number) } } } });
  });

  it('retains tool identity, parsed input and progress through success and failure', () => {
    const mapper = new V2EventMapper();
    const tool = { ...ref, id: 'call_shared' };
    const initial = parts(mapper.map(event('session.tool.input.started', { ...tool, name: 'read' })))[0].part;
    expect(initial).toMatchObject({ id: 'msg_shared:tool:call_shared', callID: 'call_shared', tool: 'read', state: { status: 'pending' } });
    mapper.map(event('session.tool.input.delta', { ...tool, delta: '{"path":' }));
    mapper.map(event('session.tool.input.ended', { ...tool, text: '{"path":"sample"}' }));
    expect(parts(mapper.map(event('session.tool.called', { ...tool, input: { path: 'sample' }, executed: true })))[0].part.state).toMatchObject({ status: 'running', input: { path: 'sample' } });
    expect(parts(mapper.map(event('session.tool.progress', { ...tool, metadata: { title: 'Reading', output: 'partial' } })))[0].part).toMatchObject({ tool: 'read', state: { status: 'running', title: 'Reading', metadata: { output: 'partial' } } });
    const success = parts(mapper.map(event('session.tool.success', { ...tool, executed: true, content: [{ type: 'text', text: 'sample content' }] })))[0].part;
    expect(success).toMatchObject({ id: initial.id, callID: 'call_shared', tool: 'read', state: { status: 'completed', input: { path: 'sample' }, output: 'sample content' } });
    const failure = parts(mapper.map(event('session.tool.failed', { ...ref, id: 'call_failed', executed: true, error: { type: 'unknown', message: 'Synthetic failure' } })))[0].part;
    expect(failure).toMatchObject({ callID: 'call_failed', state: { status: 'error', error: 'Synthetic failure' } });
  });

  it('uses the same per-kind ordinal part IDs for native history and streamed content', () => {
    const mapper = new V2EventMapper();
    const streamed = [
      ...parts(mapper.map(event('session.text.ended', { ...ref, ordinal: 0, text: 'First' }))),
      ...parts(mapper.map(event('session.reasoning.ended', { ...ref, ordinal: 0, text: 'Think' }))),
      ...parts(mapper.map(event('session.text.ended', { ...ref, ordinal: 1, text: 'Second' }))),
    ];
    const [history] = toLegacyMessages('ses_shared', [{ id: 'msg_shared', type: 'assistant', time: { created: 1792976400000 },
      content: [{ type: 'text', text: 'First' }, { type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Second' }] }]);
    expect(history.parts.map(p => p.id)).toEqual(streamed.map(p => p.part.id));
  });

  it('maps execution status, errors and permission tool correlation', () => {
    const mapper = new V2EventMapper();
    expect(mapper.map(event('session.execution.started', { sessionID: 'ses_shared' }))).toEqual([{ type: 'session.status', properties: { sessionID: 'ses_shared', status: { type: 'busy' } } }]);
    expect(mapper.map(event('session.execution.failed', { sessionID: 'ses_shared', error: { type: 'unknown', message: 'Synthetic failure' } }))).toMatchObject([
      { type: 'session.error', properties: { error: { data: { message: 'Synthetic failure' } } } }, { type: 'session.status', properties: { status: { type: 'idle' } } }, { type: 'session.idle' }]);
    expect(mapper.map(event('permission.asked', { id: 'per_shared', sessionID: 'ses_shared', action: 'read', resources: ['sample'], source: { type: 'tool', messageID: 'msg_shared', id: 'call_shared' }, message: 'Allow sample read?' }))[0]).toMatchObject({ type: 'permission.asked', properties: { id: 'per_shared', permission: 'read', patterns: ['sample'], description: 'Allow sample read?', tool: { messageID: 'msg_shared', callID: 'call_shared' } } });
  });

  it('preserves native provider status and response details in the legacy error payload', () => {
    const mapper = new V2EventMapper();
    expect(mapper.map(event('session.execution.failed', { sessionID: 'ses_shared', error: {
      type: 'api', message: 'Synthetic rate limit', status: 429, response: { body: 'Synthetic response' },
    } }))[0]).toMatchObject({ type: 'session.error', properties: { error: { name: 'APIError', data: {
      message: 'Synthetic rate limit', statusCode: 429, responseBody: 'Synthetic response', isRetryable: true,
    } } } });
  });

  it('converts basic forms while retaining original keys and option values for replies', () => {
    const mapper = new V2EventMapper();
    const form = { id: 'frm_shared', sessionID: 'ses_shared', title: 'Choose sample', fields: [
      { key: 'flavor', type: 'string', title: 'Flavor', options: [{ value: 'a', label: 'Alpha', description: 'First' }] },
      { key: 'enabled', type: 'boolean', title: 'Enabled?' },
      { key: 'notes', type: 'string', title: 'Notes' },
    ] };
    expect(mapper.map(event('form.created', { form }))[0]).toMatchObject({ type: 'question.asked', properties: { id: 'frm_shared', sessionID: 'ses_shared', questions: [
      { key: 'flavor', header: 'Flavor', options: [{ label: 'Alpha', value: 'a' }] },
      { key: 'enabled', options: [{ label: 'Yes', value: true }, { label: 'No', value: false }] },
      { key: 'notes', custom: true, options: [] },
    ] } });
    expect(mapper.getForm('frm_shared')).toEqual(form);
    mapper.forgetForm('frm_shared');
    expect(mapper.getForm('frm_shared')).toBeUndefined();
  });

  it('rejects unsupported forms explicitly and ignores malformed event boundaries', () => {
    const mapper = new V2EventMapper();
    for (const bad of [null, [], {}, { type: 'session.text.delta', data: { ...ref, ordinal: 'bad', delta: 'x' } }, { type: 'session.text.delta', data: { sessionID: 1 } }]) expect(mapper.map(bad)).toEqual([]);
    expect(mapper.map(event('form.created', { form: { id: 'frm_external', sessionID: 'ses_shared', title: 'External', fields: [{ key: 'visit', type: 'external', url: 'https://example.test' }] } }))[0]).toMatchObject({ type: 'session.error', properties: { error: { data: { message: expect.stringMatching(/unsupported/i) } } } });
  });
});
