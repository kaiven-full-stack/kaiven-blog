import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );

  return rss({
    title: '听雨',
    description: '记录日子里细碎的好时光',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/posts/${post.id}/`,
      // 全文输出，订阅器里直接读完
      content: post.body ?? undefined,
      categories: post.data.tags,
    })),
    customData: `<language>zh-CN</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
  });
}
