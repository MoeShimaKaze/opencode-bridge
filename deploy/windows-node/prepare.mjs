import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(os.homedir(), '.config/opencode/opencode.json');
const original = JSON.parse(fs.readFileSync(source, 'utf8'));
const data = path.join(root, 'data');
const profile = path.join(root, 'profile');
for (const dir of [data, profile, path.join(root, 'logs'), path.join(root, 'bin')]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(data, '.env'), 'ADMIN_PORT=4098\n');
const configFile = path.join(profile, 'opencode.json');
const agents = { ...original.agent };
const agentDir = path.join(path.dirname(source), 'agents');
if (fs.existsSync(agentDir)) {
  for (const filename of fs.readdirSync(agentDir).filter(name => name.endsWith('.md'))) {
    const { data: metadata, content } = matter(fs.readFileSync(path.join(agentDir, filename), 'utf8'));
    agents[path.basename(filename, '.md')] = { ...metadata, prompt: content.trim() };
  }
}
fs.writeFileSync(configFile, JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  model: original.model,
  small_model: original.small_model,
  provider: original.provider,
  agent: agents,
}, null, 2));
process.env.OPENCODE_BRIDGE_CONFIG_DIR = data;
const { configStore } = await import('./node_modules/opencode-bridge/dist/store/config-store.js');
const current = configStore.get();
configStore.merge({
  FEISHU_ENABLED: 'false', DISCORD_ENABLED: 'false', WECOM_ENABLED: 'false',
  TELEGRAM_ENABLED: 'false', QQ_ENABLED: 'false', WHATSAPP_ENABLED: 'false', WEIXIN_ENABLED: 'false',
  DINGTALK_ENABLED: 'true', ENABLED_PLATFORMS: 'dingtalk',
  OPENCODE_HOST: '127.0.0.1', OPENCODE_PORT: '4096', OPENCODE_AUTO_START: 'false',
  OPENCODE_AUTO_START_FOREGROUND: 'false', OPENCODE_SERVER_USERNAME: 'opencode',
  OPENCODE_SERVER_PASSWORD: current.OPENCODE_SERVER_PASSWORD || crypto.randomBytes(32).toString('base64url'),
  OPENCODE_CONFIG_FILE: configFile,
  DEFAULT_PROVIDER: current.DEFAULT_PROVIDER || original.model.split('/')[0],
  DEFAULT_MODEL: current.DEFAULT_MODEL || original.model.split('/').slice(1).join('/'),
  DEFAULT_WORK_DIRECTORY: path.dirname(root), ALLOWED_DIRECTORIES: path.dirname(root),
  GROUP_REQUIRE_MENTION: 'true', ADMIN_PORT: '4098', WEB_ADMIN_DISABLED: 'false', CLI_LANG: 'zh',
  RELIABILITY_CRON_ENABLED: 'false', RELIABILITY_CRON_API_ENABLED: 'false',
  RELIABILITY_PROACTIVE_HEARTBEAT_ENABLED: 'false', RELIABILITY_MODE: 'observe',
});
configStore.markMigrated();
const adminFile = path.join(root, 'node_modules/opencode-bridge/dist/admin/admin-server.js');
const admin = fs.readFileSync(adminFile, 'utf8');
if (!admin.includes("app.listen(port, '127.0.0.1'")) {
  if (!admin.includes("app.listen(port, '0.0.0.0'")) throw new Error('Unexpected admin listen configuration');
  fs.writeFileSync(adminFile, admin.replace("app.listen(port, '0.0.0.0'", "app.listen(port, '127.0.0.1'"));
}
const autoStartFile = path.join(root, 'node_modules/opencode-bridge/dist/admin/autostart.js');
let autoStart = fs.readFileSync(autoStartFile, 'utf8');
if (!autoStart.includes('OPENCODE_BRIDGE_AUTOSTART_COMMAND')) {
  const replacements = [
    ['    const exec = process.execPath;', "    if (process.platform === 'win32' && process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND?.trim()) {\n        return process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND.trim();\n    }\n    const exec = process.execPath;"],
    ['return r.status === 0;', "return r.status === 0 && String(r.stdout).includes(process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND?.trim() || '');"],
    ['const value = `"${execPath}"`;', 'const value = process.env.OPENCODE_BRIDGE_AUTOSTART_COMMAND?.trim() || `"${execPath}"`;'],
  ];
  for (const [before, after] of replacements) {
    if (!autoStart.includes(before)) throw new Error('Unexpected autostart module version');
    autoStart = autoStart.replace(before, after);
  }
  fs.writeFileSync(autoStartFile, autoStart);
}
fs.writeFileSync(path.join(root, 'bin/opencode.cmd'), '@echo off\r\n"%~dp0..\\node_modules\\opencode-windows-x64\\bin\\opencode.exe" %*\r\n');
console.log(JSON.stringify({ configFile, database: configStore.getDbPath(), model: original.model, platforms: ['dingtalk'], credentialAccounts: configStore.getDingtalkAccounts().length }));
process.exit(0);
