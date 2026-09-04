import { defineMiddleware } from 'astro:middleware';

// giscus 评论跑在 giscus.app 的 iframe 里，以 crossorigin 方式加载自定义主题 CSS，
// 响应必须开放 CORS；dev 下从公网源访问 localhost 还触发私有网络访问限制，
// 需额外带 Access-Control-Allow-Private-Network。生产环境由 public/_headers 负责。
const THEME_CSS = /^\/giscus-(light|dark)\.css$/;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
};

export const onRequest = defineMiddleware(async ({ request, url }, next) => {
  if (!THEME_CSS.test(url.pathname)) return next();
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const response = await next();
  for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
  return response;
});
