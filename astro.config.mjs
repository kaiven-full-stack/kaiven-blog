// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.kaiven.cloud',
  markdown: {
    shikiConfig: {
      // 双主题：token 颜色随明暗切换，pre 背景在 global.css 里统一融入纸面
      themes: {
        light: 'vitesse-light',
        dark: 'vitesse-dark',
      },
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
