import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Windows Node deployment supports its explicit startup command', async () => {
  process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "C:\\Bridge Test\\start.ps1"';
  const { isAutoStartSupported, getAutoStart } = await import('./node_modules/opencode-bridge/dist/admin/autostart.js');
  assert.equal(isAutoStartSupported(), true);
  assert.equal(getAutoStart().supported, true);
});

test('Windows login launcher safely reuses the running deployment', async () => {
  const before = await (await fetch('http://127.0.0.1:4098/api/admin/bridge')).json();
  assert.equal(before.running, true);
  const root = path.dirname(fileURLToPath(import.meta.url));
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(root, 'start.ps1')], { encoding: 'utf8', timeout: 45000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const after = await (await fetch('http://127.0.0.1:4098/api/admin/bridge')).json();
  assert.equal(after.running, true);
  assert.equal(after.pid, before.pid, 'Repeated login launch must not replace the live Bridge');
});
