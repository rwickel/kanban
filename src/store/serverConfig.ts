const SERVER_URL_KEY = 'kanban_server_url';
const SERVER_PASSWORD_KEY = 'kanban_server_password';

export const DEFAULT_SERVER_URL = 'http://localhost:4096';

export interface ServerConfig {
  url: string;
  password: string;
}

export function getServerConfig(): ServerConfig {
  return {
    url: localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL,
    password: localStorage.getItem(SERVER_PASSWORD_KEY) || '',
  };
}

export function saveServerConfig(config: Partial<ServerConfig>): void {
  if (config.url !== undefined) localStorage.setItem(SERVER_URL_KEY, config.url);
  if (config.password !== undefined) localStorage.setItem(SERVER_PASSWORD_KEY, config.password);
}

export function getAuthHeader(): Record<string, string> {
  const { password } = getServerConfig();
  if (!password) return {};
  const token = btoa(`opencode:${password}`);
  return { Authorization: `Basic ${token}` };
}
