import { browser } from 'wxt/browser';
import { CHATGPT_MATCHES } from '../lib/domain';
import type { CaptureSettings } from '../lib/domain';
import { createCapture, findEditor, insertPrompt } from '../lib/chatgpt';
import { errorMessage, isRequest, requestBackground } from '../lib/messages';

export default defineContentScript({
  matches: CHATGPT_MATCHES,
  runAt: 'document_idle',
  main(ctx) {
    let captureError: string | null = null;
    let settingsRevision = 0;
    const capture = createCapture(async (input) => {
      const saved = await requestBackground<boolean>({ scope: 'xuanecho', action: 'record:add', input });
      captureError = null;
      return saved;
    }, (error) => { captureError = errorMessage(error); }, (diagnostic) => {
      if (import.meta.env.DEV) console.info('[XuanEcho] 采集诊断', diagnostic);
    });
    const refreshSettings = async () => {
      const revision = settingsRevision;
      try {
        const settings = await requestBackground<CaptureSettings>({ scope: 'xuanecho', action: 'capture:settings' });
        if (ctx.isValid && revision === settingsRevision) capture.configure(settings);
      } catch {
        capture.configure({ captureEnabled: false, captureToken: null });
        captureError = '无法连接 XuanEcho，请刷新此页面后重试。';
      }
    };
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (message, sender, respond) => {
      if (!isRequest(message) || sender.id !== browser.runtime.id) return;
      try {
        switch (message.action) {
          case 'settings:changed':
            settingsRevision++;
            capture.configure(message.settings);
            captureError = null;
            respond({ ok: true, data: null });
            break;
          case 'page:status':
            respond({ ok: true, data: { editorFound: Boolean(findEditor()), captureError, diagnostics: capture.getDiagnostics() } });
            break;
          case 'page:insert':
            if (typeof message.text !== 'string') throw new Error('提示词格式无效。');
            insertPrompt(message.text);
            respond({ ok: true, data: null });
            break;
        }
      } catch (error) { respond({ ok: false, error: errorMessage(error) }); }
    };
    browser.runtime.onMessage.addListener(listener);
    ctx.addEventListener(window, 'focus', () => { void refreshSettings(); });
    ctx.onInvalidated(() => { capture.dispose(); browser.runtime.onMessage.removeListener(listener); });
    void refreshSettings();
  },
});
