import { browser } from 'wxt/browser';
import type { CaptureSettings } from './domain';
import type { CaptureInput } from './repository';
import type { CaptureDiagnostics } from './chatgpt';
import { isChatGPTUrl } from './domain';

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

const reconnecting = new Map<number, Promise<void>>();
const missingReceiver = (error: unknown) => error instanceof Error &&
  /Receiving end does not exist|Could not establish connection|message port closed|port closed/i.test(error.message);

async function reconnectPage(tabId: number): Promise<void> {
  const existing = reconnecting.get(tabId);
  if (existing) return existing;
  const connection = (async () => {
    const tab = await browser.tabs.get(tabId);
    if (!isChatGPTUrl(tab.url)) {
      throw new Error('当前标签页不是可访问的 ChatGPT 页面。请回到 ChatGPT，并确认扩展拥有该站点的访问权限。');
    }
    if (!browser.scripting?.executeScript) {
      throw new Error('当前扩展尚未启用重新连接权限。请在扩展管理页重新加载 XuanEcho，再打开弹窗。');
    }
    try {
      // 仅在消息接收端缺失时加载打包的页面脚本；不扩大域名范围，不读取旧聊天。
      await browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['/content-scripts/content.js'],
      });
    } catch (error) {
      if (/cannot access|permission|not allowed|cannot be scripted/i.test(errorMessage(error))) {
        throw new Error('Chrome 未允许页面脚本运行。请检查正式版 XuanEcho 的网站访问权限，并允许访问当前 ChatGPT 网站。');
      }
      throw new Error('ChatGPT 页面脚本加载失败。请重新加载正式版扩展，并检查扩展管理页的错误信息。');
    }
  })().finally(() => { reconnecting.delete(tabId); });
  reconnecting.set(tabId, connection);
  return connection;
}

export async function requestPage<T>(tabId: number, message: Request): Promise<T> {
  let response: Response<T> | undefined;
  try {
    response = await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (error) {
    if (!missingReceiver(error)) throw error;
  }
  if (response) return unwrap(response);
  await reconnectPage(tabId);
  try {
    response = await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (error) {
    if (!missingReceiver(error)) throw error;
    throw new Error('页面脚本已尝试加载，但仍未响应。请在扩展管理页检查 XuanEcho 的错误信息，并确认当前使用的是正式版。');
  }
  return unwrap(response);
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
