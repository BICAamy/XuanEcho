import { test, expect } from '@playwright/test';
import { comparableText, decodeState, emptyState, isChatGPTUrl, searchRecords, STATE_KEY } from '../lib/domain';
import { createRepository } from '../lib/repository';
import type { StoragePort } from '../lib/repository';

function memoryStorage(initial: Record<string, unknown> = {}) {
  let data = structuredClone(initial);
  const storage: StoragePort = {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(items) { data = { ...data, ...structuredClone(items) }; },
  };
  return storage;
}
const input = (captureToken: string, eventId = 'message-1', text = '  整理课程 PPT\n保留原文  ') =>
  ({ captureToken, eventId, text, sentAt: 1000 });

async function enabledRepository() {
  const storage = memoryStorage();
  const repo = createRepository(storage);
  const token = (await repo.setEnabled(true)).settings.captureToken!;
  return { storage, repo, token };
}

test('首次使用默认关闭，拒绝未授权采集', async () => {
  const repo = createRepository(memoryStorage());
  expect(await repo.get()).toEqual(emptyState());
  expect(await repo.capture(input('unapproved'))).toBe(false);
  expect((await repo.get()).records).toEqual([]);
});
test('原文完整保留，同一消息幂等，不同发送即使文本相同也独立保存', async () => {
  const { repo, token } = await enabledRepository();
  expect(await repo.capture(input(token))).toBe(true);
  expect(await repo.capture(input(token))).toBe(false);
  expect(await repo.capture(input(token, 'message-2'))).toBe(true);
  const { records } = await repo.get();
  expect(records).toHaveLength(2);
  expect(records[0]).toEqual({ id: 'message-2', text: input(token).text, source: 'chatgpt', createdAt: 1000 });
});
test('空白文本不入库', async () => {
  const { repo, token } = await enabledRepository();
  expect(await repo.capture(input(token, 'blank', ' \n\t '))).toBe(false);
});
test('暂停、再次开启均拒绝旧采集令牌', async () => {
  const { repo, token } = await enabledRepository();
  await repo.setEnabled(false);
  expect(await repo.capture(input(token))).toBe(false);
  const next = await repo.setEnabled(true);
  expect(next.settings.captureToken).not.toBe(token);
  expect(await repo.capture(input(token))).toBe(false);
  expect(await repo.capture(input(next.settings.captureToken!))).toBe(true);
});
test('并发采集与管理按顺序落盘，记录不互相覆盖', async () => {
  const { repo, token } = await enabledRepository();
  await Promise.all(Array.from({ length: 25 }, (_, i) => repo.capture(input(token, `id-${i}`))));
  expect((await repo.get()).records).toHaveLength(25);
  await Promise.all([repo.delete('id-1'), repo.capture(input(token, 'new')), repo.delete('id-2')]);
  const ids = (await repo.get()).records.map((record) => record.id);
  expect(ids).toHaveLength(24);
  expect(ids).toContain('new');
  expect(ids).not.toContain('id-1');
  expect(ids).not.toContain('id-2');
});
test('清空保留开关、更新令牌，旧请求不能恢复已清空的数据', async () => {
  const { repo, token } = await enabledRepository();
  await repo.capture(input(token));
  const cleared = await repo.clear();
  expect(cleared.records).toEqual([]);
  expect(cleared.settings.captureEnabled).toBe(true);
  expect(await repo.capture(input(token, 'late'))).toBe(false);
});
test('重新创建仓储后历史与开关仍存在', async () => {
  const { storage, repo, token } = await enabledRepository();
  await repo.capture(input(token));
  expect(await createRepository(storage).get()).toEqual(await repo.get());
});
test('一次存储失败不会阻塞后续操作，也不会假称写入成功', async () => {
  const { storage, repo, token } = await enabledRepository();
  const originalSet = storage.set;
  storage.set = async () => { throw new Error('quota exceeded'); };
  await expect(repo.capture(input(token))).rejects.toThrow('quota exceeded');
  storage.set = originalSet;
  expect((await repo.get()).records).toEqual([]);
  expect(await repo.capture(input(token))).toBe(true);
});
test('未知版本和损坏数据不静默重置、不覆盖', async () => {
  const initial = { [STATE_KEY]: { version: 99, records: ['keep me'] } };
  const storage = memoryStorage(initial);
  const repo = createRepository(storage);
  await expect(repo.get()).rejects.toThrow('本地数据格式无法识别');
  await expect(repo.clear()).rejects.toThrow();
  expect(await storage.get(STATE_KEY)).toEqual(initial);
  expect(() => decodeState(null)).toThrow();
});
test('中文部分匹配、英文大小写匹配，并按最近发送排序', () => {
  const records = [
    { id: 'a', text: '课程 PPT 第三章', source: 'chatgpt' as const, createdAt: 1 },
    { id: 'b', text: '整理课程第四章', source: 'chatgpt' as const, createdAt: 3 },
    { id: 'c', text: '实验报告', source: 'chatgpt' as const, createdAt: 2 },
  ];
  expect(searchRecords(records, '  课程 ').map((record) => record.id)).toEqual(['b', 'a']);
  expect(searchRecords(records, 'ppt').map((record) => record.id)).toEqual(['a']);
  expect(searchRecords(records, '').map((record) => record.id)).toEqual(['b', 'c', 'a']);
  expect(records[0]?.id).toBe('a');
});
test('仅接受 HTTPS 的准确 ChatGPT 域名', () => {
  expect(isChatGPTUrl('https://chatgpt.com/c/1')).toBe(true);
  expect(isChatGPTUrl('https://chat.openai.com/')).toBe(true);
  for (const url of [undefined, 'http://chatgpt.com/', 'https://chatgpt.com.evil.example/', 'https://evil.example/?chatgpt.com', 'chrome://extensions/']) {
    expect(isChatGPTUrl(url)).toBe(false);
  }
});
test('页面文本标准化只用于匹配，兼容换行和不换行空格', () => {
  expect(comparableText('  整理\n课程\u00a0PPT  ')).toBe('整理 课程 PPT');
});
