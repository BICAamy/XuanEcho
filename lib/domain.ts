export const STATE_KEY = 'xuanecho.v1';
export const CHATGPT_MATCHES = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

export type PromptRecord = {
  id: string;
  text: string;
  source: 'chatgpt';
  createdAt: number;
};
export type CaptureSettings = {
  captureEnabled: boolean;
  // 重新启用或清空时更换令牌，拒绝暂停前尚未落盘的请求。
  captureToken: string | null;
};
export type ExtensionState = {
  version: 1;
  settings: CaptureSettings;
  records: PromptRecord[];
};
export const emptyState = (): ExtensionState => ({
  version: 1, settings: { captureEnabled: false, captureToken: null }, records: [],
});

export function isChatGPTUrl(value?: string): boolean {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname);
  } catch { return false; }
}

// 仅用于页面确认，不改写保存的原文。
export function comparableText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function searchRecords(records: PromptRecord[], query: string): PromptRecord[] {
  const keyword = query.trim().toLocaleLowerCase();
  return records.filter((record) => record.text.toLocaleLowerCase().includes(keyword))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function decodeState(value: unknown): ExtensionState {
  if (value === undefined) return emptyState();
  const state = value as ExtensionState;
  if (!state || state.version !== 1 || !Array.isArray(state.records) ||
    typeof state.settings?.captureEnabled !== 'boolean' ||
    !(state.settings.captureToken === null || typeof state.settings.captureToken === 'string') ||
    (state.settings.captureEnabled && !state.settings.captureToken) ||
    !state.records.every((record) => record && typeof record.id === 'string' &&
      typeof record.text === 'string' && record.source === 'chatgpt' && Number.isFinite(record.createdAt))) {
    throw new Error('本地数据格式无法识别。为保护历史记录，已停止写入，请先备份扩展数据。');
  }
  return state;
}
