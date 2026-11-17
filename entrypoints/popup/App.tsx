import { useEffect, useId, useState } from 'react';
import { browser } from 'wxt/browser';
import { isChatGPTUrl, searchRecords, STATE_KEY } from '../../lib/domain';
import type { ExtensionState, PromptRecord } from '../../lib/domain';
import { errorMessage, requestBackground, requestPage } from '../../lib/messages';
import type { PageStatus } from '../../lib/messages';
import './App.css';

type Notice = { kind: 'success' | 'error'; text: string };
type Connection = { kind: 'ready' | 'warning'; text: string };


function EchoMark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <rect width="40" height="40" rx="13" fill="currentColor" />
    <path d="M27 13a10 10 0 1 0 0 14M25 18a4 4 0 1 0 0 4" stroke="#fffcef" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M29 9c-6 0-8 3-7 7 4 1 7-2 7-7Z" fill="#cfe3a4" />
  </svg>;
}

function PromptCard({ record, busy, onInsert, onDelete }: {
  record: PromptRecord; busy: boolean; onInsert: () => void; onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const date = new Date(record.createdAt);
  const preview = record.text.replace(/\s+/gu, ' ').trim();
  return <article className="prompt-card">
    <time className="record-meta" dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')}>
      {new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)}
    </time>
    <p className="prompt-text" title={record.text}>{preview}</p>
    <div className="record-actions">
      <button className="text-button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起' : '展开'}
      </button>
      <button className="text-button delete-button" disabled={busy} onClick={onDelete} aria-label="删除这条提示词">删除</button>
      <button className="insert-button" disabled={busy} onClick={onInsert}>填入</button>
    </div>
    <p id={detailsId} className="prompt-full-text" hidden={!expanded}>{record.text}</p>
  </article>;
}

function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [connection, setConnection] = useState<Connection>({ kind: 'warning', text: '正在检测当前页面…' });
  const [pageStatus] = useState<PageStatus | null>(null);

  const refreshState = async () => {
    try { setState(await requestBackground<ExtensionState>({ scope: 'xuanecho', action: 'state:get' })); }
    catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }); }
  };
  const refreshConnection = async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isChatGPTUrl(tab.url)) {
        setConnection({ kind: 'warning', text: '请在 ChatGPT 网页中打开扩展，即可填入提示词。' });
        return;
      }
      const status = await requestPage<PageStatus>(tab.id, { scope: 'xuanecho', action: 'page:status' });
      setConnection(status.captureError ? { kind: 'warning', text: status.captureError }
        : status.editorFound ? { kind: 'ready', text: '已连接 ChatGPT · 填入后由你确认发送' }
        : { kind: 'warning', text: '未找到输入框，请打开可输入的 ChatGPT 对话。' });
    } catch (error) {  setConnection({ kind: 'warning', text: errorMessage(error) }); }
  };
  useEffect(() => {
    void refreshState();
    void refreshConnection();
    const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area === 'local' && changes[STATE_KEY]) void refreshState();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try { await operation(); }
    catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }); }
    finally { setBusy(false); }
  };
  const toggleCapture = () => run(async () => {
    const next = await requestBackground<ExtensionState>({ scope: 'xuanecho', action: 'settings:set', enabled: !state?.settings.captureEnabled });
    setState(next);
    setNotice({ kind: 'success', text: next.settings.captureEnabled ? '已开启：从下一次发送开始记录，不导入旧聊天。' : '已暂停记录，已保存的历史仍可使用。' });
    await refreshConnection();
  });
  const insert = (record: PromptRecord) => run(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isChatGPTUrl(tab.url)) throw new Error('请先切换到 ChatGPT 网页，再打开扩展填入提示词。');
    await requestPage(tab.id, { scope: 'xuanecho', action: 'page:insert', text: record.text });
    setNotice({ kind: 'success', text: '已填入 ChatGPT 输入框。请检查内容后自行发送。' });
  });
  const remove = (id: string) => run(async () => {
    setState(await requestBackground<ExtensionState>({ scope: 'xuanecho', action: 'record:delete', id }));
    setNotice({ kind: 'success', text: '已删除这条提示词。' });
  });
  const clear = () => run(async () => {
    setState(await requestBackground<ExtensionState>({ scope: 'xuanecho', action: 'records:clear' }));
    setConfirmClear(false);
    setNotice({ kind: 'success', text: '已清空全部历史记录。' });
  });
  const records = searchRecords(state?.records ?? [], query);
  const enabled = state?.settings.captureEnabled ?? false;

  return <main className="app-shell">
    <header className="brand-header">
      <div className="brand-mark"><EchoMark /></div>
      <div><h1>XuanEcho <span>萱之回响</span></h1><p>青萱沐雨时，旧语应时来。</p></div>
      <span className="version">V0.1</span>
    </header>

    <section className={`capture-panel ${enabled ? 'is-enabled' : ''}`} aria-label="记录设置">
      <div className="capture-heading"><span className={`status-dot ${enabled ? 'on' : ''}`} />
        <h2>{enabled ? '正在记录你的提示词' : '提示词记录已暂停'}</h2>
        <button className="capture-toggle" disabled={busy || !state} onClick={toggleCapture} aria-pressed={enabled}>
          {enabled ? '暂停记录' : '同意并开启记录'}
        </button>
      </div>
    </section>

    <div className="search-wrap">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
      <input type="search" aria-label="搜索历史提示词" placeholder="搜一搜，让旧语再次回响…" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    <div className="list-heading"><h2>{query.trim() ? '搜索结果' : '最近发送'}</h2>
      <span>{query.trim() ? `${records.length} 条匹配 / ` : ''}{state?.records.length ?? 0} 条记录</span>
    </div>

    {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    {!state ? <div className="empty-state"><p>{notice ? '历史记录暂时无法读取' : '正在读取本地历史…'}</p>
      {notice && <button className="text-button" onClick={() => { void refreshState(); }}>重新读取</button>}</div>
      : records.length ? <section className="prompt-list" aria-label="提示词历史" aria-busy={busy}>
        {records.map((record) => <PromptCard key={record.id} record={record} busy={busy}
          onInsert={() => { void insert(record); }} onDelete={() => { void remove(record.id); }} />)}
      </section> : <div className="empty-state">
        <div className="empty-symbol" aria-hidden="true">↺</div>
        <h3>{query.trim() ? '暂时没有找到这段回响' : '下一句好用的提示词，从这里留下'}</h3>
        <p>{query.trim() ? '试试更短的关键词，也支持中文片段搜索。'
          : enabled ? '去 ChatGPT 发送一条文本消息，它会出现在这里。' : '同意并开启记录后，日常发送的提示词会自动保存在这里。'}</p>
      </div>}

    <div className={`connection ${connection.kind}`}><span className="status-dot" /><p>{connection.text}</p>
      <button className="text-button" onClick={() => { void refreshConnection(); }} aria-label="重新检测当前页面">重试</button>
    </div>

    <footer><span>本地保存 · 由你掌控</span>
      <button className="text-button clear-button" disabled={busy || !state?.records.length} onClick={() => setConfirmClear(true)}>清空历史</button>
    </footer>
    {confirmClear && <div className="modal-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-description" onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) setConfirmClear(false);
      if (event.key === 'Tab') {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <h2 id="clear-title">清空全部历史？</h2>
      <p id="clear-description">将删除此浏览器保存的 {state?.records.length ?? 0} 条提示词，无法撤销。记录开关会保持当前状态。</p>
      <div className="dialog-actions"><button autoFocus disabled={busy} onClick={() => setConfirmClear(false)}>保留历史</button>
        <button className="danger-button" disabled={busy} onClick={() => { void clear(); }}>{busy ? '正在清空…' : '确认清空'}</button></div>
      {notice?.kind === 'error' && <p role="alert">{notice.text}</p>}
    </section></div>}
  </main>;
}

export default App;
