import type { APIRoute } from 'astro';
import css from '../styles/giscus-dark.css?raw';

// 主题 CSS 走端点而非 public/：dev 下经过 middleware 补 CORS / 私有网络头，
// 构建时照常产出静态文件，CORS 由 public/_headers 提供。
export const GET: APIRoute = () =>
  new Response(css, { headers: { 'Content-Type': 'text/css' } });
