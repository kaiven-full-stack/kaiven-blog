import { getCollection, type CollectionEntry } from 'astro:content';

/**
 * 博客文章数据层：分类 / 系列元数据与非草稿文章的统一获取、排序入口。
 *
 * 所有列表页、RSS 请从这里取文章，避免各自重复「过滤草稿 + 排序」的逻辑。
 * 约定排序：发布日期倒序，日期相同时以文章 id 升序做稳定 tie-break。
 */

/** 博客文章（astro:content 的 blog collection 条目） */
export type BlogPost = CollectionEntry<'blog'>;

/** 文章分类，与 content.config.ts 中 frontmatter 的 category 枚举一一对应 */
export type Category = 'zig' | 'redis' | 'cpython' | 'kernel' | 'mysql' | 'life';

/** 分类展示名 */
export const CATEGORY_LABELS: Record<Category, string> = {
  zig: 'Zig',
  redis: 'Redis',
  cpython: 'CPython',
  kernel: 'Linux 内核',
  mysql: 'MySQL',
  life: '生活',
};

/** 系列元数据 */
export interface SeriesMeta {
  /** 系列 id（当前与分类 id 一致），可安全用作 URL 片段 */
  id: Category;
  /** 系列展示名 */
  title: string;
  /** 系列简介 */
  description: string;
  /** 系列所属分类 */
  category: Category;
}

/**
 * 全部系列，按固定展示顺序排列。
 * 当前一个分类对应一个系列；若日后一个分类要拆多个系列，
 * 扩展这里的元数据并让 getSeriesForPost 返回更细的映射即可。
 */
export const SERIES_ORDER: readonly SeriesMeta[] = [
  {
    id: 'redis',
    title: 'Redis 系列',
    description: '从过期、淘汰到复制、哨兵与集群迁移，逐篇看清 Redis 内部的真实边界。',
    category: 'redis',
  },
  {
    id: 'zig',
    title: 'Zig 系列',
    description: '从分配器、指针家族到 comptime 与 C 互操作，逐篇拆开 Zig 的设计取舍。',
    category: 'zig',
  },
  {
    id: 'cpython',
    title: 'CPython 系列',
    description: '从对象生命、内存布局到字节码特化与自由线程，沿着 Python 表象走进 CPython 的实现现场。',
    category: 'cpython',
  },
  {
    id: 'kernel',
    title: 'Linux 内核系列',
    description: '从页表、写时复制到伙伴系统与 OOM，沿着一次访存沉进 Linux 内核的内存现场。',
    category: 'kernel',
  },
  {
    id: 'mysql',
    title: 'MySQL 系列',
    description: '从 B+ 树、MVCC、锁、恢复、优化器到主从复制，沿着一条 SQL 落进 InnoDB 的存储现场。',
    category: 'mysql',
  },
  {
    id: 'life',
    title: '生活随笔',
    description: '技术之外的日子：散步、读书、深夜便利店，记录日子里细碎的好时光。',
    category: 'life',
  },
];

/** 按系列 id 查找系列元数据 */
export const SERIES_BY_ID: Readonly<Record<Category, SeriesMeta>> = Object.fromEntries(
  SERIES_ORDER.map((series) => [series.id, series]),
);

/** 通用排序：发布日期倒序，日期相同时以 id 升序做稳定 tie-break */
export function comparePostsByDateDesc(a: BlogPost, b: BlogPost): number {
  return b.data.pubDate.valueOf() - a.data.pubDate.valueOf() || a.id.localeCompare(b.id);
}

/** 获取全部已发布（非草稿）文章，按发布日期倒序排列（id 稳定 tie-break） */
export async function getPublishedPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort(comparePostsByDateDesc);
}

/** 系列分组结果：一个系列及其文章（按日期倒序） */
export interface SeriesGroup {
  series: SeriesMeta;
  posts: BlogPost[];
}

/**
 * 按系列分组文章。组按 SERIES_ORDER 的顺序排列，只包含有文章的系列；
 * 组内文章按日期倒序（id 稳定 tie-break）排列。
 *
 * 不传 posts 时默认取全部已发布文章；也可传入自行筛选过的文章列表。
 */
export async function groupPostsBySeries(posts?: BlogPost[]): Promise<SeriesGroup[]> {
  const source = posts ?? (await getPublishedPosts());
  const byCategory = new Map<Category, BlogPost[]>();
  for (const post of source) {
    const list = byCategory.get(post.data.category) ?? [];
    list.push(post);
    byCategory.set(post.data.category, list);
  }
  return SERIES_ORDER.filter((series) => (byCategory.get(series.category)?.length ?? 0) > 0).map(
    (series) => ({
      series,
      posts: [...(byCategory.get(series.category) ?? [])].sort(comparePostsByDateDesc),
    }),
  );
}

/** 获取文章所属的系列元数据 */
export function getSeriesForPost(post: BlogPost): SeriesMeta {
  return SERIES_BY_ID[post.data.category];
}

/** 同系列内相邻文章 */
export interface AdjacentPosts {
  /** 阅读顺序中的上一篇：同系列中发布更早的文章；若当前已是系列最早一篇则为 undefined */
  prev: BlogPost | undefined;
  /** 阅读顺序中的下一篇：同系列中发布更晚的文章；若当前已是系列最新一篇则为 undefined */
  next: BlogPost | undefined;
}

/**
 * 获取文章在同系列中的相邻文章（prev = 更早一篇，next = 更晚一篇）。
 *
 * 不传 posts 时默认取全部已发布文章；在同一页面为多篇文章计算时，
 * 建议先调用 getPublishedPosts() 一次再把结果传入，避免重复读取。
 */
export async function getAdjacentPosts(
  post: BlogPost,
  posts?: BlogPost[],
): Promise<AdjacentPosts> {
  const source = posts ?? (await getPublishedPosts());
  const siblings = source
    .filter((p) => p.data.category === post.data.category)
    .sort(comparePostsByDateDesc);
  const index = siblings.findIndex((p) => p.id === post.id);
  if (index === -1) return { prev: undefined, next: undefined };
  // siblings 按日期倒序：索引更小的是更新一篇，索引更大的是更早一篇
  return {
    prev: siblings[index + 1],
    next: index > 0 ? siblings[index - 1] : undefined,
  };
}
