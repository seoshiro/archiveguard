import { exportArchive, inventory, type Input, type Inventory, type Decisions, type Policy } from './engine';
import type { Locale } from './i18n';
type Request = { operation: 'scan'; inputs: Input[] } | { operation: 'export'; inputs: Input[]; inventory: Inventory; decisions: Decisions; policy: Policy; locale?: Locale };
self.onmessage = async (event: MessageEvent<Request>) => {
  const progress = (done: number, total: number, label: string) => self.postMessage({ type: 'progress', done, total, label });
  try {
    const message = event.data;
    if (message.operation === 'scan') self.postMessage({ type: 'inventory', inventory: await inventory(message.inputs, progress) });
    else {
      const result = await exportArchive(message.inputs, message.inventory, message.decisions, message.policy, progress, message.locale);
      self.postMessage({ type: 'export', ...result, locale: message.locale || 'en' }, { transfer: [result.zip.buffer] });
    }
  } catch (e) { self.postMessage({ type: 'error', message: e instanceof Error ? e.message : 'The operation failed. Try a smaller sample.' }); }
};
