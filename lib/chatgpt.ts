import { comparableText } from './domain';
import type { CaptureSettings } from './domain';
import type { CaptureInput } from './repository';

const EDITOR_SELECTORS = [
  '#prompt-textarea[contenteditable]',
  'textarea#prompt-textarea',
  'textarea[data-testid="prompt-textarea"]',
  '[data-testid="prompt-textarea"][contenteditable]',
  '#prompt-textarea [contenteditable]',
  '[data-testid="prompt-textarea"] [contenteditable]',
  // 实站也有不带 id 的 ProseMirror；用编辑器类型和语义角色定位，不依赖固定 id。
  '.ProseMirror[role="textbox"][contenteditable]',
];
const SEND_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送"], button[aria-label="Send message"], button[aria-label="Send"]';
const USER_SELECTOR = '[data-message-author-role="user"], [data-user-message-bubble]';
const INTENT_TTL = 30_000;

export function findEditor(): HTMLElement | null {
  for (const selector of EDITOR_SELECTORS) {
    const editor = Array.from(document.querySelectorAll<HTMLElement>(selector)).find((candidate) => {
      const writable = candidate instanceof HTMLTextAreaElement
        ? !candidate.disabled && !candidate.readOnly : candidate.isContentEditable;
      const style = getComputedStyle(candidate);
      // 不把历史消息的编辑框、隐藏副本或只读控件当成主输入框。
      return writable && candidate.getClientRects().length > 0 &&
        style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        !candidate.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], [data-message-author-role], [data-testid^="conversation-turn-"]');
    });
    if (editor) return editor;
  }
  return null;
}
export function editorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement) return editor.value;
  // innerText 会给相邻 <p> 加双换行；编辑器中的每个段落实际只对应一个换行。
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
    if (node.childNodes.length === 1 && node.firstChild instanceof HTMLBRElement) return '';
    const children = Array.from(node.childNodes);
    const isBlock = (child?: Node) => child instanceof HTMLElement && /^(P|DIV)$/.test(child.tagName);
    return children.map((child, index) =>
      (index > 0 && (isBlock(child) || isBlock(children[index - 1])) ? '\n' : '') + read(child),
    ).join('');
  };
  return read(editor);
}

function findSendButton(editor = findEditor()): HTMLButtonElement | null {
  const form = editor?.closest('form');
  return form?.querySelector<HTMLButtonElement>(SEND_SELECTOR) ??
    form?.querySelector<HTMLButtonElement>('button[type="submit"]') ??
    document.querySelector<HTMLButtonElement>(SEND_SELECTOR);
}

function userMessages(): HTMLElement[] {
  // 两种标记可能同时出现在内外层，只选最内层消息，避免一条消息重复计数。
  return Array.from(document.querySelectorAll<HTMLElement>(USER_SELECTOR)).filter((node) => !node.querySelector(USER_SELECTOR));
}
function messageText(node: HTMLElement): string {
  return (node.querySelector<HTMLElement>('.whitespace-pre-wrap') ?? node).innerText;
}

export function insertPrompt(text: string): void {
  const editor = findEditor();
  if (!editor) throw new Error('未找到 ChatGPT 输入框。请打开可输入的对话，或刷新页面后重试。');
  if (editorText(editor).trim()) throw new Error('输入框中已有草稿。请先保存或清空草稿，再填入历史提示词。');
  if (!text.trim()) throw new Error('这条提示词没有可填入的文本。');
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('当前输入框不支持填入。');
    setter.call(editor, text);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } else {
    // 浏览器编辑命令产生编辑事件，使 ProseMirror 同步状态并保留撤销栈。
    const selection = window.getSelection();
    if (!selection) throw new Error('无法选中 ChatGPT 输入框。');
    selection.selectAllChildren(editor);
    if (!document.execCommand('insertText', false, text)) {
      throw new Error('当前编辑器未接受填入，请刷新页面后重试。');
    }
  }
  if (comparableText(editorText(editor)) !== comparableText(text)) {
    throw new Error('未能确认填入结果，请检查输入框内容。');
  }
  // 只编辑，不触发按键、submit 或发送按钮。
}

type Intent = {
  text: string; sentAt: number; token: string;
  conversationId: string | null;
  knownIds: Set<string>; knownNodes: WeakSet<Element>;
  knownMatchingMessages: number;
};
export type CaptureStage = 'paused' | 'ready' | 'send-detected' | 'waiting-editor' | 'waiting-message' |
  'text-mismatch' | 'saving' | 'saved' | 'skipped' | 'timeout' | 'navigation' | 'error';
export type CaptureDiagnostics = {
  adapterVersion: 'capture-3';
  captureEnabled: boolean;
  stage: CaptureStage;
  lastEvent: 'enter' | 'pointerdown' | 'click' | 'submit' | null;
  lastEventAt: number | null;
  lastSavedAt: number | null;
  sendAttempts: number;
  confirmedMessages: number;
  savedRecords: number;
  userMessageCount: number;
  sendButtonFound: boolean;
  messageMarkerCounts: { authorRole: number; userBubble: number };
};
export function createCapture(
  onCapture: (input: CaptureInput) => Promise<boolean>,
  onError: (error: unknown) => void,
  onDiagnostic?: (diagnostic: CaptureDiagnostics) => void,
) {
  let settings: CaptureSettings = { captureEnabled: false, captureToken: null };
  let pending: Intent | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;
  const diagnostics = {
    stage: 'paused' as CaptureStage,
    lastEvent: null as CaptureDiagnostics['lastEvent'],
    lastEventAt: null as number | null,
    lastSavedAt: null as number | null,
    sendAttempts: 0, confirmedMessages: 0, savedRecords: 0,
  };
  // 仅包含阶段、计数和时间，不包含原文、URL、消息 ID 或授权令牌。
  const getDiagnostics = (): CaptureDiagnostics => ({
    adapterVersion: 'capture-3', captureEnabled: settings.captureEnabled, ...diagnostics,
    userMessageCount: userMessages().length,
    sendButtonFound: Boolean(findSendButton()),
    messageMarkerCounts: {
      authorRole: document.querySelectorAll('[data-message-author-role="user"]').length,
      userBubble: document.querySelectorAll('[data-user-message-bubble]').length,
    },
  });
  const setStage = (stage: CaptureStage) => {
    if (diagnostics.stage === stage) return;
    diagnostics.stage = stage;
    onDiagnostic?.(getDiagnostics());
  };
  const fallbackIds = new WeakMap<Element, string>();
  const conversationId = () => location.pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
  const messageId = (node: Element) => {
    const id = node.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (id) return id;
    const turn = node.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid');
    // 轮次编号会在不同对话中重用，不能直接作为全局 ID。
    return turn ? `turn:${location.pathname}:${turn}` : null;
  };
  const clearPending = () => { pending = null; clearTimeout(timeout); };

  const confirm = () => {
    scheduled = false;
    const intent = pending;
    if (!intent) return;
    if (Date.now() - intent.sentAt > INTENT_TTL) { clearPending(); setStage('timeout'); return; }
    if (intent.conversationId && conversationId() !== intent.conversationId) {
      clearPending(); setStage('navigation'); return;
    }
    const editor = findEditor();
    if (editor && comparableText(editorText(editor)) === comparableText(intent.text)) {
      setStage('waiting-editor'); return;
    }
    let unmatchedMessage = false;
    const nodes = userMessages();
    const matchingCount = nodes.filter((node) => comparableText(messageText(node)) === comparableText(intent.text)).length;
    for (const node of nodes) {
      const id = messageId(node);
      if (intent.knownNodes.has(node) || (id && intent.knownIds.has(id))) continue;
      if (comparableText(messageText(node)) !== comparableText(intent.text)) { unmatchedMessage = true; continue; }
      // 新布局不一定提供消息 ID。重渲染旧气泡不能当成发送，匹配文本数量必须增长。
      if (!id && matchingCount <= intent.knownMatchingMessages) continue;
      let eventId = id;
      if (!eventId) {
        eventId = fallbackIds.get(node) ?? crypto.randomUUID();
        fallbackIds.set(node, eventId);
      }
      clearPending();
      diagnostics.confirmedMessages++;
      const attempt = diagnostics.sendAttempts;
      setStage('saving');
      void onCapture({ eventId: `chatgpt:${eventId}`, text: intent.text,
        captureToken: intent.token, sentAt: intent.sentAt }).then((saved) => {
          if (saved) { diagnostics.savedRecords++; diagnostics.lastSavedAt = Date.now(); }
          if (settings.captureEnabled && attempt === diagnostics.sendAttempts) setStage(saved ? 'saved' : 'skipped');
        }).catch((error) => {
          if (settings.captureEnabled && attempt === diagnostics.sendAttempts) setStage('error');
          onError(error);
        });
      return;
    }
    setStage(unmatchedMessage ? 'text-mismatch' : 'waiting-message');
  };
  const scheduleConfirm = () => {
    if (!pending || scheduled) return;
    scheduled = true;
    queueMicrotask(confirm);
  };
  const observer = new MutationObserver(scheduleConfirm);
  const rememberIntent = (event: NonNullable<CaptureDiagnostics['lastEvent']>) => {
    if (!settings.captureEnabled || !settings.captureToken) return;
    const editor = findEditor();
    if (!editor) return;
    const text = editorText(editor);
    if (!text.trim()) return;
    const button = findSendButton(editor);
    if (button?.disabled || button?.getAttribute('aria-disabled') === 'true') return;
    // 同一次发送的 pointerdown/click/submit 共用快照，不能在页面变化后重新取基线。
    if (pending && pending.token === settings.captureToken && pending.text === text && Date.now() - pending.sentAt < 1000) {
      diagnostics.lastEvent = event;
      scheduleConfirm();
      return;
    }
    const nodes = userMessages();
    clearPending();
    diagnostics.lastEvent = event;
    diagnostics.lastEventAt = Date.now();
    diagnostics.sendAttempts++;
    setStage('send-detected');
    pending = { text, sentAt: Date.now(), token: settings.captureToken, conversationId: conversationId(),
      knownIds: new Set(nodes.map(messageId).filter((id): id is string => Boolean(id))), knownNodes: new WeakSet(nodes),
      knownMatchingMessages: nodes.filter((node) => comparableText(messageText(node)) === comparableText(text)).length };
    timeout = setTimeout(() => { if (pending) { clearPending(); setStage('timeout'); } }, INTENT_TTL);
    scheduleConfirm();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    const editor = findEditor();
    if (editor && event.target instanceof Node && editor.contains(event.target)) rememberIntent('enter');
  };
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (event.target.closest('a[href]')) clearPending();
    const button = event.target.closest('button');
    if (button && button === findSendButton()) rememberIntent('click');
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (button && button === findSendButton()) rememberIntent('pointerdown');
  };
  const onSubmit = (event: SubmitEvent) => {
    const editor = findEditor();
    if (event.isTrusted && editor && event.target instanceof Element && event.target.contains(editor)) rememberIntent('submit');
  };
  return {
    getDiagnostics,
    configure(next: CaptureSettings) {
      if (next.captureEnabled === settings.captureEnabled && next.captureToken === settings.captureToken) return;
      settings = next;
      setStage(next.captureEnabled ? 'ready' : 'paused');
      clearPending();
      observer.disconnect();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('input', scheduleConfirm, true);
      window.removeEventListener('popstate', clearPending);
      if (!settings.captureEnabled) return;
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['data-message-author-role', 'data-user-message-bubble', 'data-message-id', 'data-testid'] });
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('submit', onSubmit, true);
      document.addEventListener('input', scheduleConfirm, true);
      window.addEventListener('popstate', clearPending);
    },
    dispose() { this.configure({ captureEnabled: false, captureToken: null }); clearPending(); },
  };
}
