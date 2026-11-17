import { browser } from 'wxt/browser';
import { CHATGPT_MATCHES, isChatGPTUrl } from '../lib/domain';
import type { CaptureSettings } from '../lib/domain';
import { createRepository } from '../lib/repository';
import { errorMessage, isRequest } from '../lib/messages';

export default defineBackground(() => {
  const repository = createRepository(browser.storage.local);
  const ready = browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  let requests: Promise<unknown> = Promise.resolve();
  const notifySettings = async (settings: CaptureSettings) => {
    const tabs = await browser.tabs.query({ url: CHATGPT_MATCHES });
    await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) =>
      browser.tabs.sendMessage(tab.id!, { scope: 'xuanecho', action: 'settings:changed', settings }, { frameId: 0 }),
    ));
  };
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRequest(message)) return;
    const handle = async () => {
      await ready;
      const fromPage = sender.id === browser.runtime.id && sender.frameId === 0 &&
        sender.tab?.id !== undefined && isChatGPTUrl(sender.url);
      const fromPopup = sender.id === browser.runtime.id && sender.url === browser.runtime.getURL('/popup.html');
      if (message.action === 'capture:settings' && fromPage) return (await repository.get()).settings;
      if (message.action === 'record:add' && fromPage) {
        const input = message.input;
        if (!input || typeof input.eventId !== 'string' || !input.eventId || input.eventId.length > 200 ||
          typeof input.text !== 'string' || typeof input.captureToken !== 'string' ||
          !Number.isFinite(input.sentAt) || Math.abs(Date.now() - input.sentAt) > 60_000) {
          throw new Error('采集消息无效，请刷新 ChatGPT 页面后重试。');
        }
        try { return await repository.capture(input); }
        catch { throw new Error('提示词未能保存，本地存储可能已满。请删除部分历史或稍后重试。'); }
      }
      if (!fromPopup) throw new Error('此操作只能从 XuanEcho 弹窗发起。');
      switch (message.action) {
        case 'state:get': return repository.get();
        case 'settings:set': {
          if (typeof message.enabled !== 'boolean') throw new Error('设置无效。');
          const state = await repository.setEnabled(message.enabled);
          await notifySettings(state.settings);
          return state;
        }
        case 'record:delete': {
          if (typeof message.id !== 'string') throw new Error('记录无效。');
          return repository.delete(message.id);
        }
        case 'records:clear': {
          const state = await repository.clear();
          await notifySettings(state.settings);
          return state;
        }
        default: throw new Error('不支持的操作。');
      }
    };
    // 连同开关广播一起按接收顺序处理，避免多个弹窗把旧开关覆盖到页面。
    const result = requests.then(handle);
    requests = result.catch(() => undefined);
    void result.then((data) => sendResponse({ ok: true, data }),
      (error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  });
});
