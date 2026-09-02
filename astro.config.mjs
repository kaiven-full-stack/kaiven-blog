// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // 部署到 Cloudflare Pages 后替换为实际域名（如 https://xxx.pages.dev）
  site: 'https://tingyu.pages.dev',
  vite: {
    plugins: [tailwindcss()],
  },
});
