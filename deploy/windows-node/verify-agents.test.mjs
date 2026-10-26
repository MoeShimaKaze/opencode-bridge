import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(os.homedir(), '.config/opencode/agents');
const sources = fs.readdirSync(sourceDir).filter(name => name.endsWith('.md'));

test('chat exposes every local custom Agent after deployment', async () => {
  const response = await fetch('http://127.0.0.1:4098/api/chat/agents');
  assert.equal(response.status, 200);
  const { agents } = await response.json();
  const actualNames = new Set(agents.map(agent => agent.name));
  const missing = sources.map(name => path.basename(name, '.md')).filter(name => !actualNames.has(name));
  assert.deepEqual(missing, [], `Custom Agents missing from chat: ${missing.join(', ')}`);
});

test('runtime configuration preserves custom Agent prompts, models, modes and permissions', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'profile/opencode.json'), 'utf8'));
  for (const filename of sources) {
    const name = path.basename(filename, '.md');
    const { data, content } = matter(fs.readFileSync(path.join(sourceDir, filename), 'utf8'));
    const actual = config.agent?.[name];
    assert.ok(actual, `${name} missing from runtime config`);
    assert.equal(actual.prompt, content.trim(), `${name}: prompt`);
    for (const field of ['model', 'mode', 'temperature', 'steps', 'permission']) {
      assert.deepEqual(actual[field], data[field], `${name}: ${field}`);
    }
  }
});
