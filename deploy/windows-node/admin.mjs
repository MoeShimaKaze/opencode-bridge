import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND = `"${powershell}" -NoP -NonI -W Hidden -Exec RemoteSigned -File "${path.join(runtimeRoot, 'start.ps1')}"`;
if (process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND.length > 260) throw new Error('Startup command exceeds Windows Run length limit');
process.env.BRIDGE_EMBEDDED_MODE = '1';
process.env.BRIDGE_SPAWNED_BY_ADMIN = '1';
// These fallback values satisfy the SDK constructor; persisted app credentials
// are injected by config.js before the adapters are created.
process.env.FEISHU_APP_ID = 'disabled-unused';
process.env.FEISHU_APP_SECRET = 'disabled-unused';
await import('./node_modules/opencode-bridge/dist/config.js');
const { createAdminServer } = await import('./node_modules/opencode-bridge/dist/admin/admin-server.js');
const { bridgeManager } = await import('./node_modules/opencode-bridge/dist/admin/bridge-manager.js');
const { VERSION } = await import('./node_modules/opencode-bridge/dist/utils/version.js');
const server = createAdminServer({ port: 4098, version: VERSION, bridgeManager });
await server.start();
const result = await bridgeManager.start();
if (!result.success) console.error(result.error);
