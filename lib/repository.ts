import { decodeState, STATE_KEY } from './domain';
import type { ExtensionState, PromptRecord } from './domain';

export type StoragePort = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};
export type CaptureInput = { eventId: string; text: string; captureToken: string; sentAt: number };

export function createRepository(storage: StoragePort) {
  // 唯一写入者在 background；串行读改写避免多标签页与弹窗互相覆盖。
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const read = async () => decodeState((await storage.get(STATE_KEY))[STATE_KEY]);
  const write = async (state: ExtensionState) => {
    await storage.set({ [STATE_KEY]: state });
    return state;
  };
  return {
    get: () => enqueue(read),
    setEnabled: (enabled: boolean) => enqueue(async () => {
      const state = await read();
      if (state.settings.captureEnabled === enabled) return state;
      state.settings = { captureEnabled: enabled, captureToken: enabled ? crypto.randomUUID() : null };
      return write(state);
    }),
    capture: (input: CaptureInput) => enqueue(async () => {
      const state = await read();
      if (!state.settings.captureEnabled || state.settings.captureToken !== input.captureToken) return false;
      if (!input.text.trim() || state.records.some((record) => record.id === input.eventId)) return false;
      const record: PromptRecord = {
        id: input.eventId, text: input.text, source: 'chatgpt', createdAt: input.sentAt,
      };
      state.records.unshift(record);
      await write(state);
      return true;
    }),
    delete: (id: string) => enqueue(async () => {
      const state = await read();
      state.records = state.records.filter((record) => record.id !== id);
      return write(state);
    }),
    clear: () => enqueue(async () => {
      const state = await read();
      state.records = [];
      if (state.settings.captureEnabled) state.settings.captureToken = crypto.randomUUID();
      return write(state);
    }),
  };
}
