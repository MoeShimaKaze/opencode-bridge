import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PLUGIN_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PLUGIN_OUTPUT_CHARS = 24_000;

export const OPENCODE_PLUGIN_USAGE = [
  'OpenCode 插件管理用法：',
  '/plugin list [--builtin]',
  '/plugin add <npm 包名[@版本]>',
  '/plugin remove <npm 包名>',
  '/plugin check',
  '/plugin update',
  '/plugin --help',
].join('\n');

function buildPluginArgs(rawArgs: string): string[] {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(OPENCODE_PLUGIN_USAGE);
  }

  if (tokens.length === 1 && ['--help', '-h', 'help'].includes(tokens[0].toLowerCase())) {
    return ['plugin', '--help'];
  }

  const action = tokens[0].toLowerCase();
  const rest = tokens.slice(1);
  if (action === 'list') {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--builtin')) {
      throw new Error('用法: /plugin list [--builtin]');
    }
    return ['plugin', 'list', ...rest];
  }

  if (action === 'add' || action === 'remove') {
    const packageName = rest[0];
    const validPackageName = packageName
      && rest.length === 1
      && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._+-]+)?$/.test(packageName);
    if (!validPackageName) {
      throw new Error(`用法: /plugin ${action} <npm 包名[@版本]>`);
    }
    return ['plugin', action, packageName];
  }

  if (action === 'check' || action === 'update') {
    if (rest.length !== 0) {
      throw new Error(`用法: /plugin ${action}`);
    }
    return ['plugin', action];
  }

  throw new Error(OPENCODE_PLUGIN_USAGE);
}

function getCliEnvironment(): NodeJS.ProcessEnv {
  const home = os.homedir();
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TERM: 'dumb',
    FORCE_COLOR: '0',
  };
}

export async function runOpenCodePluginCommand(rawArgs: string): Promise<string> {
  if (!rawArgs.trim()) return OPENCODE_PLUGIN_USAGE;

  let args: string[];
  try {
    args = buildPluginArgs(rawArgs);
  } catch (error) {
    return `❌ ${error instanceof Error ? error.message : String(error)}`;
  }
  const isWindows = process.platform === 'win32';
  const command = isWindows ? `opencode ${args.join(' ')}` : 'opencode';
  const commandArgs = isWindows ? [] : args;

  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: os.homedir(),
      env: getCliEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: isWindows,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const remaining = MAX_PLUGIN_OUTPUT_CHARS - current.length;
      if (remaining <= 0) return current;
      return current + chunk.toString('utf8').slice(0, remaining);
    };
    const finish = (error?: Error, result?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) resolve(`❌ ${error.message}`);
      else resolve(result || 'OpenCode 插件命令已完成（没有输出）。');
    };

    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      finish(new Error(`无法启动 OpenCode CLI：${error.message}`));
    });
    child.on('close', (code) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (code === 0) {
        finish(undefined, output);
      } else {
        finish(new Error(output || `OpenCode 插件命令失败，退出码 ${code ?? 'unknown'}`));
      }
    });

    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('OpenCode 插件命令超时，请检查日志后重试。'));
    }, PLUGIN_COMMAND_TIMEOUT_MS);
  });
}
