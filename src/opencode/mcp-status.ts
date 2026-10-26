import { opencodeConfig } from '../config.js';
import { fetchOpenCode, getOpenCodeProtocol } from './shared-transport.js';

export interface OpenCodeMCPStatus {
  status: string;
  error?: string;
}

export async function getOpenCodeMCPStatus(directory?: unknown): Promise<Record<string, OpenCodeMCPStatus>> {
  // Detect the active OpenCode protocol before choosing its MCP endpoint.
  const healthUrl = new URL('/global/health', opencodeConfig.baseUrl);
  const healthResponse = await fetchOpenCode(healthUrl);
  if (!healthResponse.ok) {
    throw new Error(`OpenCode 健康检查失败（HTTP ${healthResponse.status}）`);
  }
  const protocol = getOpenCodeProtocol();
  if (!protocol) {
    throw new Error('无法识别 OpenCode API 版本');
  }

  const resolvedDirectory = typeof directory === 'string' && directory.trim() ? directory.trim() : process.cwd();
  const url = protocol === 'v2'
    ? new URL('/api/mcp', opencodeConfig.baseUrl)
    : new URL('/mcp', opencodeConfig.baseUrl);
  if (protocol === 'v2') {
    url.searchParams.set('location[directory]', resolvedDirectory);
  } else {
    url.searchParams.set('directory', resolvedDirectory);
  }

  const response = await fetchOpenCode(url);
  if (!response.ok) {
    throw new Error(`OpenCode MCP 状态查询失败（HTTP ${response.status}）`);
  }

  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error(`OpenCode MCP 接口返回了非 JSON 响应（HTTP ${response.status}）`);
  }

  const payload: unknown = await response.json();
  const status = normalizeMCPStatusPayload(payload);
  return status;
}

function normalizeMCPStatusPayload(payload: unknown): Record<string, OpenCodeMCPStatus> {
  const wrapped = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).data ?? payload
    : payload;

  if (Array.isArray(wrapped)) {
    const status: Record<string, OpenCodeMCPStatus> = Object.create(null) as Record<string, OpenCodeMCPStatus>;
    for (const item of wrapped) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : '';
      if (!name) continue;
      const normalized = normalizeMCPStatus(record.status ?? record);
      if (normalized) status[name] = normalized;
    }
    return status;
  }

  if (!wrapped || typeof wrapped !== 'object') {
    throw new Error('OpenCode 返回的 MCP 状态格式无效');
  }

  const status: Record<string, OpenCodeMCPStatus> = Object.create(null) as Record<string, OpenCodeMCPStatus>;
  for (const [name, value] of Object.entries(wrapped as Record<string, unknown>)) {
    const normalized = normalizeMCPStatus(value);
    if (normalized) status[name] = normalized;
  }
  return status;
}

function normalizeMCPStatus(value: unknown): OpenCodeMCPStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.status && typeof record.status === 'object' && !Array.isArray(record.status)
    ? record.status as Record<string, unknown>
    : undefined;
  const status = typeof record.status === 'string'
    ? record.status
    : typeof nested?.status === 'string'
      ? nested.status
      : 'unknown';
  const error = typeof record.error === 'string' ? record.error : nested?.error;
  return {
    status,
    ...(typeof error === 'string' ? { error } : {}),
  };
}

export function formatOpenCodeMCPStatus(
  status: Record<string, OpenCodeMCPStatus>,
  directory: string,
): string {
  const entries = Object.entries(status);
  if (entries.length === 0) {
    return `🧩 MCP 服务状态\n工作目录：${directory}\n\n此目录下没有配置 MCP 服务。`;
  }

  const lines = entries.map(([name, value]) => {
    const error = 'error' in value && value.error ? `：${value.error}` : '';
    switch (value.status) {
      case 'connected': return `✅ ${name}：已连接`;
      case 'disabled': return `⚪ ${name}：已禁用`;
      case 'failed': return `❌ ${name}：连接失败${error}`;
      case 'needs_auth': return `🔐 ${name}：需要授权`;
      case 'needs_client_registration': return `🔐 ${name}：需要客户端注册${error}`;
      default: return `❔ ${name}：${String(value.status)}${error}`;
    }
  });

  return `🧩 MCP 服务状态\n工作目录：${directory}\n\n${lines.join('\n')}`;
}
