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
    server: {
      // CORS 交给 src/middleware.ts：giscus 的主题 CSS 需要带
      // Access-Control-Allow-Private-Network，Vite 内置 CORS 加不了这个头
      cors: false,
    },
  },
});
