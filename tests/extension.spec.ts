import { test as base, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { STATE_KEY } from '../lib/domain';
import type { ExtensionState } from '../lib/domain';
import type { PageStatus, Response } from '../lib/messages';

declare const chrome: typeof import('wxt/browser').browser;
type App = { context: BrowserContext; chat: Page; popup: Page; worker: Worker; profile: string; extensionId: string };
const fixtureHtml = await readFile(resolve('tests/fixtures/chatgpt.html'), 'utf8');
const extensionPath = resolve('.output/chrome-mv3');

async function launch(profile: string) {
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1000, height: 800 },
  });
}
async function getState(worker: Worker): Promise<ExtensionState | undefined> {
  return worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key] as ExtensionState | undefined, STATE_KEY);
}
async function captureReport(app: App) {
  const response = await app.worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({ url: 'https://chatgpt.com/*' })).find((tab) => tab.url === url);
    if (tab?.id === undefined) throw new Error('Synthetic ChatGPT tab not found');
    return chrome.tabs.sendMessage(tab.id, { scope: 'xuanecho', action: 'page:status' }, { frameId: 0 });
  }, app.chat.url()) as Response<PageStatus>;
  if (!response.ok) throw new Error(response.error);
  return { page: response.data, settingEnabled: (await getState(app.worker))?.settings.captureEnabled };
}
const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'xuanecho-test-'));
    const context = await launch(profile);
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await context.route('https://chatgpt.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
      const chat = await context.newPage();
      await chat.goto('https://chatgpt.com/c/synthetic-conversation');
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 420, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popup.getByRole('button', { name: '同意并开启记录' })).toBeEnabled();
      await use({ context, chat, popup, worker, profile, extensionId });
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});
const enable = async (app: App) => {
  await app.popup.getByRole('button', { name: '同意并开启记录' }).click();
  await expect(app.popup.getByRole('button', { name: '暂停记录' })).toBeVisible();
};
const send = async (chat: Page, text: string, method: 'click' | 'enter' = 'enter') => {
  await chat.locator('#prompt-textarea').fill(text);
  if (method === 'click') await chat.getByRole('button', { name: '发送', exact: true }).click();
  else await chat.locator('#prompt-textarea').press('Enter');
};
const activateChat = async (app: App) => {
  await app.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
  });
};

test('授权、采集、中文搜索、全文、填入不发送、草稿保护、删除、清空和暂停', async ({ app }) => {
  const { chat, popup, worker } = app;
  await send(chat, '未授权发送，不应记录');
  expect((await getState(worker))?.records ?? []).toEqual([]);
  await enable(app);
  await expect(popup.getByText('0 条记录', { exact: true })).toBeVisible();
  await chat.locator('#prompt-textarea').fill('这只是未发送的草稿');
  await chat.locator('#prompt-textarea').press('Shift+Enter');
  expect((await getState(worker))?.records).toEqual([]);
  const text = '整理计算机网络第三章笔记\n重点讲清楚考点';
  await send(chat, text);
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  expect((await getState(worker))?.records[0]?.text).toBe(text);
  await expect(popup.locator('.prompt-card')).toHaveCount(1);
  await send(chat, '根据截图整理实验报告', 'click');
  await expect(popup.locator('.prompt-card')).toHaveCount(2);
  await popup.getByRole('searchbox').fill('计算机网络');
  await expect(popup.locator('.prompt-card')).toHaveCount(1);
  await expect(popup.locator('.prompt-text')).toHaveText(text.replace(/\s+/gu, ' '));
  await expect(popup.locator('.prompt-text')).toHaveAttribute('title', text);
  await popup.getByRole('button', { name: '展开', exact: true }).click();
  await expect(popup.locator('.prompt-full-text')).toBeVisible();
  expect(await popup.locator('.prompt-full-text').textContent()).toBe(text);
  await popup.getByRole('button', { name: '收起', exact: true }).click();
  await expect(popup.locator('.prompt-full-text')).toBeHidden();
  await activateChat(app);
  const beforeInsert = await chat.evaluate(() => (window as any).fixtureSent);
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect(chat.locator('#prompt-textarea')).toHaveText(text, { useInnerText: true });
  await expect.poll(() => chat.evaluate(() => document.body.dataset.model)).toBe(text);
  expect(await chat.evaluate(() => (window as any).fixtureSent)).toBe(beforeInsert);
  expect((await getState(worker))?.records).toHaveLength(2);
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect(popup.getByRole('alert')).toContainText('已有草稿');
  await expect(chat.locator('#prompt-textarea')).toHaveText(text, { useInnerText: true });
  await chat.locator('#prompt-textarea').press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(3);
  await popup.getByRole('searchbox').fill('不存在的关键词');
  await expect(popup.getByText('暂时没有找到这段回响')).toBeVisible();
  await popup.getByRole('searchbox').fill('实验报告');
  await popup.getByRole('button', { name: '删除这条提示词' }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  await popup.getByRole('searchbox').fill('');
  await popup.getByRole('button', { name: '清空历史' }).click();
  await popup.getByRole('button', { name: '保留历史' }).click();
  expect((await getState(worker))?.records).toHaveLength(2);
  await popup.getByRole('button', { name: '暂停记录' }).click();
  await send(chat, '暂停后不应采集');
  expect((await getState(worker))?.records).toHaveLength(2);
  await popup.getByRole('button', { name: '清空历史' }).click();
  await popup.getByRole('button', { name: '确认清空' }).click();
  await expect(popup.getByText('0 条记录', { exact: true })).toBeVisible();
  expect((await getState(worker))?.settings.captureEnabled).toBe(false);
  await popup.screenshot({ path: 'test-results/popup-empty.png' });
});

test('正式版页面脚本失效后重试恢复连接，不重复记录也不导入旧消息', async ({ app }) => {
  const { chat, popup, worker, extensionId } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?bubble-layout');
  await enable(app);
  await chat.getByRole('textbox').fill('失联前已经保存的消息');
  await chat.getByRole('textbox').press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  // WXT 使用此事件使旧脚本失效，模拟升级或重新加载后的孤立页面上下文。
  await chat.evaluate((extensionId) => {
    document.dispatchEvent(new CustomEvent(`${extensionId}:content:wxt:content-script-started`, {
      detail: { contentScriptName: 'content', messageId: 'simulate-disconnected-script' },
    }));
  }, extensionId);
  expect(await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    try { await chrome.tabs.sendMessage(tab!.id!, { scope: 'xuanecho', action: 'page:status' }); return true; }
    catch { return false; }
  })).toBe(false);
  await activateChat(app);
  // 两次同时重试也只恢复一份监听器。
  await popup.getByRole('button', { name: '重新检测当前页面' }).evaluate((button) => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(popup.locator('.connection')).toContainText('已连接 ChatGPT');
  expect((await getState(worker))?.records).toHaveLength(1);
  await chat.getByRole('textbox').fill('重新连接后的新消息');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  expect((await getState(worker))?.records[0]?.text).toBe('重新连接后的新消息');
});

test('旧消息、回复、失败发送、重渲染、重复事件与输入法不误采集', async ({ app }) => {
  const { chat, popup, worker } = app;
  await enable(app);
  await chat.evaluate(() => {
    (window as any).addMessage('assistant', '只有 AI 回复');
    (window as any).blockSubmit = true;
  });
  await send(chat, '发送被页面阻止');
  expect((await getState(worker))?.records).toHaveLength(0);
  await chat.locator('#prompt-textarea').dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  expect((await getState(worker))?.records).toHaveLength(0);
  await chat.evaluate(() => {
    history.pushState({}, '', '/c/another-synthetic-conversation');
    document.querySelector<HTMLElement>('#prompt-textarea')!.innerHTML = '<p><br></p>';
    (window as any).addMessage('user', '发送被页面阻止', 'another-old-user');
  });
  expect((await getState(worker))?.records).toHaveLength(0);
  await chat.evaluate(() => { (window as any).blockSubmit = false; });
  await send(chat, '一次真实发送', 'click');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  await chat.evaluate(() => {
    const messages = document.querySelector('#messages')!;
    messages.innerHTML = messages.innerHTML;
    messages.append(document.createTextNode(' '));
  });
  await send(chat, '一次真实发送');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  expect((await getState(worker))?.records.every((record) => record.text === '一次真实发送')).toBe(true);
  await popup.screenshot({ path: 'test-results/popup-history.png' });
});

test('暂停或清空时使尚未确认的发送失效', async ({ app }) => {
  const { chat, popup, worker } = app;
  await enable(app);
  await chat.evaluate(() => { (window as any).delaySubmit = true; });
  await send(chat, '暂停前的待确认发送');
  await popup.getByRole('button', { name: '暂停记录' }).click();
  await enable(app);
  await chat.evaluate(() => { (window as any).pendingSend(); (window as any).delaySubmit = false; });
  expect((await getState(worker))?.records).toHaveLength(0);
  await send(chat, '用于清空测试的记录');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  await chat.evaluate(() => { (window as any).delaySubmit = true; });
  await send(chat, '清空前的待确认发送');
  await popup.getByRole('button', { name: '清空历史' }).click();
  await popup.getByRole('button', { name: '确认清空' }).click();
  await chat.evaluate(() => { (window as any).pendingSend(); });
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(0);
  await chat.evaluate(() => { (window as any).delaySubmit = false; });
  await popup.evaluate(async () => {
    await Promise.all([false, true, false].map((enabled) => chrome.runtime.sendMessage({
      scope: 'xuanecho', action: 'settings:set', enabled,
    })));
  });
  await send(chat, '多个开关请求结束于暂停，不应记录');
  expect((await getState(worker))?.settings.captureEnabled).toBe(false);
  expect((await getState(worker))?.records).toHaveLength(0);
});

test('textarea 兼容、缺失输入框和不支持页面有明确反馈', async ({ app }) => {
  const { chat, popup, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?textarea');
  await enable(app);
  await send(chat, 'textarea 中的中文提示词', 'click');
  await expect(popup.locator('.prompt-card')).toHaveCount(1);
  await activateChat(app);
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect(chat.locator('#prompt-textarea')).toHaveValue('textarea 中的中文提示词');
  expect((await getState(worker))?.records).toHaveLength(1);
  await chat.locator('#prompt-textarea').evaluate((node) => node.remove());
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect(popup.getByRole('alert')).toContainText('未找到 ChatGPT 输入框');
  await chat.goto('about:blank');
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect(popup.getByRole('alert')).toContainText('请先切换到 ChatGPT');
});

test('实站无 id 的 ProseMirror 输入框支持检测、按钮和 Enter 采集与填入', async ({ app }) => {
  const { chat, popup, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?anonymous-editor');
  const editor = chat.getByRole('textbox');
  await expect(editor).not.toHaveAttribute('id');
  await activateChat(app);
  await popup.getByRole('button', { name: '重新检测当前页面' }).click();
  await expect(popup.locator('.connection')).toContainText('已连接 ChatGPT');
  await enable(app);
  await editor.fill('无 id 输入框的点击发送');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  const text = '无 id 输入框的 Enter 发送\n第二行内容';
  await editor.fill(text);
  await editor.press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  expect((await getState(worker))?.records[0]?.text).toBe(text);
  await popup.getByRole('searchbox').fill('Enter');
  await activateChat(app);
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect.poll(() => chat.evaluate(() => document.body.dataset.model)).toBe(text);
  expect(await chat.evaluate(() => (window as any).fixtureSent)).toBe(2);
  expect((await getState(worker))?.records).toHaveLength(2);
});

test('无 id 适配排除隐藏和历史消息内的编辑框，等主编辑器出现再连接', async ({ app }) => {
  const { chat, popup, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?anonymous-editor');
  await chat.evaluate(() => {
    const editor = document.querySelector('.ProseMirror')!;
    const hidden = editor.cloneNode(true) as HTMLElement;
    hidden.style.visibility = 'hidden';
    hidden.textContent = '隐藏输入框，不得记录';
    document.body.prepend(hidden);
    const historical = editor.cloneNode(true) as HTMLElement;
    historical.textContent = '旧消息编辑框，不得记录';
    document.querySelector('[data-message-author-role="user"]')!.append(historical);
    editor.remove();
  });
  await activateChat(app);
  await popup.getByRole('button', { name: '重新检测当前页面' }).click();
  await expect(popup.locator('.connection')).toContainText('未找到输入框');
  await enable(app);
  await chat.locator('form').evaluate((form) => {
    form.insertAdjacentHTML('afterbegin', '<div class="ProseMirror" role="textbox" contenteditable="plaintext-only" style="min-height:36px">后来出现的输入框</div>');
  });
  await popup.getByRole('button', { name: '重新检测当前页面' }).click();
  await expect(popup.locator('.connection')).toContainText('已连接 ChatGPT');
  expect((await getState(worker))?.records).toHaveLength(0);
});

test('Markdown 粗体与有序列表渲染后仍保存原文，后续短文本正常记录', async ({ app }) => {
  const { chat, popup, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?bubble-layout');
  await enable(app);
  await chat.evaluate(() => {
    const add = (window as any).addMessage;
    (window as any).addMessage = (role: string, text: string) => {
      add(role, text);
      if (role !== 'user' || !text.includes('**行程准备**')) return;
      const body = document.querySelector('#messages article:last-child [data-user-message-bubble] .whitespace-pre-wrap')!;
      // 固定的合成 HTML：模拟发送后 Markdown 被网页排版，绝不渲染真实用户原文。
      body.innerHTML = '<p>准备一份活动备忘：</p><ol><li><strong>行程准备</strong></li><li>随身物品</li></ol><p>要求：</p><ol><li>简短明确</li><li>保留重点</li></ol>';
    };
  });
  const source = '准备一份活动备忘：\n\n1. **行程准备**\n2. 随身物品\n\n\n要求：\n\n1. 简短明确\n2. 保留重点';
  await chat.getByRole('textbox').fill(source);
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  expect((await getState(worker))?.records[0]?.text).toBe(source);
  await activateChat(app);
  await popup.getByRole('button', { name: '填入', exact: true }).click();
  await expect.poll(() => chat.evaluate(() => document.body.dataset.model)).toBe(source);
  expect(await chat.evaluate(() => (window as any).fixtureSent)).toBe(1);
  await chat.getByRole('textbox').press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  expect((await getState(worker))?.records[0]?.text).toBe(source);
  await chat.getByRole('textbox').fill('31415926');
  await chat.getByRole('textbox').press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(3);
});

test('多个段落文本区域都参与发送确认，不仅匹配首段', async ({ app }) => {
  const { chat, worker } = app;
  await enable(app);
  await chat.evaluate(() => {
    const add = (window as any).addMessage;
    (window as any).addMessage = (role: string, text: string) => {
      add(role, text);
      if (role !== 'user') return;
      const message = document.querySelector('#messages article:last-child [data-message-author-role="user"]')!;
      message.replaceChildren(...text.split('\n\n').map(part => {
        const paragraph = document.createElement('p');
        paragraph.className = 'whitespace-pre-wrap'; paragraph.textContent = part;
        return paragraph;
      }));
    };
  });
  const source = '第一段介绍活动。\n\n第二段列出准备工作。\n\n第三段说明时间。';
  await send(chat, source);
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  expect((await getState(worker))?.records[0]?.text).toBe(source);
});

test('粘贴的真实 HTML 列表按段落读取，点击发送后保留完整条目', async ({ app }) => {
  const { chat, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?bubble-layout');
  await enable(app);
  const editor = chat.getByRole('textbox');
  // 模拟富文本粘贴后的编辑器结构，不把整份内容塞进一个文本节点。
  await editor.evaluate((node) => {
    node.innerHTML = '<p>准备课程卡片：</p><ol><li><p><strong>概念要点</strong></p></li><li><p>应用步骤</p></li></ol><p>要求：</p><ol><li><p>简洁</p></li><li><p>标明重点</p></li></ol>';
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  });
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  const saved = (await getState(worker))!.records[0]!.text;
  expect(saved).toContain('概念要点\n');
  expect(saved).toContain('应用步骤');
  expect(saved).toContain('简洁\n');
  expect(saved).toContain('标明重点');
});

test('气泡保留列表编号但渲染粗体时仍确认完整 Markdown 原文', async ({ app }) => {
  const { chat, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?bubble-layout');
  await enable(app);
  await chat.evaluate(() => {
    const add = (window as any).addMessage;
    (window as any).addMessage = (role: string, text: string) => {
      add(role, text);
      if (role !== 'user') return;
      const body = document.querySelector('#messages article:last-child .whitespace-pre-wrap')!;
      body.innerHTML = '<p>准备课程卡片：</p><p>1. <strong>概念要点、2. 应用步骤、3. 复习安排</strong></p><p>要求：</p><p>1. 简洁</p><p>2. 标明重点</p>';
    };
  });
  const source = '准备课程卡片：\n\n1. **概念要点、2. 应用步骤、3. 复习安排**\n\n\n要求：\n\n1. 简洁\n2. 标明重点';
  await chat.getByRole('textbox').fill(source);
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  expect((await getState(worker))?.records[0]?.text).toBe(source);
});

test('渲染代码块中的字面 Markdown 符号不丢失，保存原始围栏', async ({ app }) => {
  const { chat, worker } = app;
  await enable(app);
  await chat.evaluate(() => {
    const add = (window as any).addMessage;
    (window as any).addMessage = (role: string, text: string) => {
      add(role, text);
      if (role !== 'user') return;
      const body = document.querySelector('#messages article:last-child .whitespace-pre-wrap')!;
      body.innerHTML = '<p>检查以下表达式：</p><pre><code>const total = 2 * 3;\nconst marker = "**literal**";</code></pre>';
    };
  });
  const source = '检查以下表达式：\n\n```ts\nconst total = 2 * 3;\nconst marker = "**literal**";\n```';
  await send(chat, source, 'click');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  expect((await getState(worker))?.records[0]?.text).toBe(source);
});

test('格式兼容不接受不同正文，也不把匹配的 AI 回复当作用户发送', async ({ app }) => {
  const { chat, worker } = app;
  await enable(app);
  await chat.evaluate(() => {
    const add = (window as any).addMessage;
    (window as any).addMessage = (role: string, text: string) => {
      add(role, text);
      const body = document.querySelector('#messages article:last-child .whitespace-pre-wrap')!;
      body.innerHTML = role === 'user' ? '<p>复习<strong>重点乙</strong></p>' : '<p>复习<strong>重点甲</strong></p>';
    };
  });
  await send(chat, '复习**重点甲**');
  await expect.poll(async () => (await captureReport(app)).page.diagnostics.stage).toBe('text-mismatch');
  expect((await getState(worker))?.records).toHaveLength(0);
  expect((await captureReport(app)).page.diagnostics.confirmedMessages).toBe(0);
});

test('用户实站气泡标记与中文发送按钮支持键盘、点击和延迟属性', async ({ app }) => {
  const { chat, popup, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?bubble-layout');
  await enable(app);
  expect(await chat.locator('[data-message-author-role="user"]').count()).toBe(0);
  await chat.getByRole('textbox').fill('新的气泡布局，Enter 发送');
  await chat.getByRole('textbox').press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  await chat.evaluate(() => { (window as any).lateMarker = true; });
  await chat.getByRole('textbox').fill('新的气泡布局，中文按钮发送');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  await expect.poll(async () => (await captureReport(app)).page.diagnostics.savedRecords).toBe(2);
  const report = await captureReport(app);
  expect(report.page.diagnostics.stage).toBe('saved');
  expect(report.page.diagnostics.messageMarkerCounts).toEqual({ authorRole: 0, userBubble: 3 });
  expect(report.page.diagnostics.sendAttempts).toBe(2);
  expect(report.settingEnabled).toBe(true);
  expect(report.page.diagnostics.captureEnabled).toBe(true);
  expect(JSON.stringify(report)).not.toContain('新的气泡布局');
  expect(JSON.stringify(report)).not.toContain('captureToken');
});

test('无 ID 气泡的同文重渲染不误记，pointerdown 提交只保存一次', async ({ app }) => {
  const { chat, worker } = app;
  await chat.goto('https://chatgpt.com/c/synthetic-conversation?bubble-layout');
  await enable(app);
  const editor = chat.getByRole('textbox');
  await editor.fill('同文消息');
  await editor.press('Enter');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(1);
  await chat.evaluate(() => { (window as any).blockSubmit = true; });
  await editor.fill('同文消息');
  await editor.press('Enter');
  await chat.evaluate(() => {
    const messages = document.querySelector('#messages')!;
    messages.innerHTML = messages.innerHTML;
    document.querySelector<HTMLElement>('.ProseMirror')!.innerHTML = '<p><br></p>';
  });
  expect((await getState(worker))?.records).toHaveLength(1);
  await chat.evaluate(() => { (window as any).blockSubmit = false; (window as any).sendOnPointerDown = true; });
  await editor.fill('按钮在 pointerdown 时提交');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  expect((await getState(worker))?.records[0]?.text).toBe('按钮在 pointerdown 时提交');
});

test('诊断能区分发送未确认与存储成功，输出不包含提示词', async ({ app }) => {
  const { chat, popup, worker } = app;
  await enable(app);
  await chat.evaluate(() => {
    const add = (window as any).addMessage;
    (window as any).addMessage = (role: string, text: string) => {
      add(role, text);
      if (role === 'user') document.querySelector('#messages article:last-child [data-message-author-role]')!.removeAttribute('data-message-author-role');
    };
  });
  await send(chat, '不应出现在诊断中的原文');
  const report = await captureReport(app);
  const output = JSON.stringify(report);
  expect(report.page.diagnostics.stage).toBe('waiting-message');
  expect(report.page.diagnostics.sendAttempts).toBe(1);
  expect(report.page.diagnostics.confirmedMessages).toBe(0);
  expect(report.page.diagnostics.savedRecords).toBe(0);
  expect((await getState(worker))?.records).toHaveLength(0);
  expect(output).not.toContain('不应出现在诊断中的原文');
});

test('多标签页连续发送不丢记录，重新打开浏览器后本地历史仍存在', async ({ app }) => {
  const { chat, popup, worker, context } = app;
  await enable(app);
  const second = await context.newPage();
  await second.goto('https://chatgpt.com/c/second-synthetic');
  await send(chat, '第一个标签页');
  await send(second, '第二个标签页');
  await expect.poll(async () => (await getState(worker))?.records.length).toBe(2);
  await popup.close();
  const reopenedPopup = await context.newPage();
  await reopenedPopup.goto(`chrome-extension://${app.extensionId}/popup.html`);
  await expect(reopenedPopup.locator('.prompt-card')).toHaveCount(2);
  await context.close();
  const reopened = await launch(app.profile);
  try {
    const nextWorker = reopened.serviceWorkers()[0] ?? await reopened.waitForEvent('serviceworker');
    expect((await getState(nextWorker))?.records.map((record) => record.text).sort()).toEqual(['第一个标签页', '第二个标签页'].sort());
    expect((await getState(nextWorker))?.settings.captureEnabled).toBe(true);
  } finally { await reopened.close(); }
});
