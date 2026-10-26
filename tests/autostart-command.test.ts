import { afterEach, expect, it, vi } from 'vitest';
import { isAutoStartSupported } from '../src/admin/autostart.js';
afterEach(()=>vi.unstubAllEnvs());
it.skipIf(process.platform!=='win32')('supports the explicit Windows Node startup command',()=>{
  vi.stubEnv('OPENCODE_BRIDGE_AUTOSTART_COMMAND','"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoP -File "C:\\Bridge\\start.ps1"');
  expect(isAutoStartSupported()).toBe(true);
});
