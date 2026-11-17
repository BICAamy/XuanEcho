import { browser } from 'wxt/browser';
import type { CaptureSettings } from './domain';
import type { CaptureInput } from './repository';
import type { CaptureDiagnostics } from './chatgpt';

export type Request = { scope: 'xuanecho' } & (
  | { action: 'state:get' | 'capture:settings' | 'records:clear' | 'page:status' }
  | { action: 'settings:set'; enabled: boolean }
  | { action: 'record:delete'; id: string }
  | { action: 'record:add'; input: CaptureInput }
  | { action: 'page:insert'; text: string }
  | { action: 'settings:changed'; settings: CaptureSettings }
);
export type PageStatus = { editorFound: boolean; captureError: string | null; diagnostics: CaptureDiagnostics };
export type Response<T> = { ok: true; data: T } | { ok: false; error: string };

export function isRequest(message: unknown): message is Request {
  if (!message || typeof message !== 'object') return false;
  const request = message as Request;
  return request.scope === 'xuanecho' && typeof request.action === 'string';
}
export function unwrap<T>(response: Response<T> | undefined): T {
  if (!response) throw new Error('扩展暂时未连接，请刷新 ChatGPT 页面后重试。');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
export async function requestBackground<T>(message: Request): Promise<T> {
  return unwrap<T>(await browser.runtime.sendMessage(message));
}
export async function requestPage<T>(tabId: number, message: Request): Promise<T> {
  try {
    return unwrap<T>(await browser.tabs.sendMessage(tabId, message, { frameId: 0 }));
  } catch (error) {
    if (error instanceof Error && /Receiving end|connection|port closed/i.test(error.message)) {
      throw new Error('尚未连接 ChatGPT 页面。安装或更新扩展后，请刷新该页面再试。');
    }
    throw error;
  }
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
