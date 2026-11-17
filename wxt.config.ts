import { defineConfig } from 'wxt';
import { CHATGPT_MATCHES } from './lib/domain';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'XuanEcho',
    version: '0.1.0',
    description: '青萱沐雨时，旧语应时来。经你授权，在本地记录、查找和复用 ChatGPT 提示词。',
    permissions: ['storage', 'scripting'],
    host_permissions: CHATGPT_MATCHES,
    action: { default_title: 'XuanEcho · 提示词回响' },
  }
});
