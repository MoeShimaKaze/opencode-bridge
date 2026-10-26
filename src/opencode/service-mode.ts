import { getOpenCodeProtocol } from './shared-transport.js';

/** The native service belongs to the user's OpenCode installation, outside Bridge's process manager. */
export function isSharedNativeService(): boolean {
  return Boolean(process.env.NATIVE_OPENCODE_URL) || getOpenCodeProtocol() === 'v2';
}
