import {
  CATEGORY_LABELS,
  SERIES_ORDER,
  comparePostsByDateDesc,
  getPublishedPosts,
  type BlogPost,
  type Category,
} from './posts';
import { readingTime } from './readingTime';
import { cnDate } from './date';
import { concepts as conceptMeta, relatedLinks, type ConceptMeta, type RelatedLink } from '../data/graph';

/**
 * 知识图谱数据层（构建期）。
 *
 * 节点与边的来源：
 * - 文章节点：全部已发布文章（getPublishedPosts）；
 * - 标签节点：出现 ≥2 次的标签（单次标签是悬挂叶节点，不进图谱）；
 * - 知识点节点：src/data/graph.ts 里手工维护的归属关系；
 * - 文内互链：正文里出现的 /posts/<slug>/ 引用（自动提取）；
 * - 精选关联：src/data/graph.ts 里手工维护的跨系列强关联。
 *
 * 手工数据在构建时校验：引用了不存在的文章 id 会直接让 build 报错，
 * 避免文章改名/删除后图谱悄悄烂掉。
 */

/** 图谱节点种类：文章 / 标签 / 知识点 */
export type GraphNodeKind = 'post' | 'tag' | 'concept';

export interface GraphNode {
  /** 'post:<slug>' | 'tag:<标签>' | 'concept:<知识点id>' */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** 知识点节点：一句话说明 */
  description?: string;
  /** 文章节点：所属系列 id */
  series?: Category;
  /** 文章节点：系列展示名 */
  seriesLabel?: string;
  /** 文章节点：链接 */
  url?: string;
  /** 文章节点：阅读分钟数 */
  minutes?: number;
  /** 文章节点：发布日期（中文展示） */
  dateLabel?: string;
}

export type GraphEdgeKind = 'tag' | 'concept' | 'link' | 'related';

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** 精选关联的备注（如「镜像：应用层淘汰 vs 内核回收」） */
  note?: string;
}

export interface GraphStats {
  posts: number;
  concepts: number;
  tags: number;
  edges: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  /** 系列展示顺序（图谱初始布局按此在圆周上锚定） */
  seriesOrder: Category[];
  /** 各系列文章数（筛选按钮展示用） */
  seriesCounts: Partial<Record<Category, number>>;
}

/** 提取正文里引用的其他文章 slug（markdown 链接或裸 URL 均可） */
export function extractExplicitLinks(body: string): string[] {
  const slugs = new Set<string>();
  for (const match of body.matchAll(/\/posts\/([a-z0-9-]+)/g)) {
    slugs.add(match[1]);
  }
  return [...slugs];
}

/** 无向 pair key：排序后拼接，保证 a-b 与 b-a 同 key */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 收集全部文内互链（无向、去重、只保留存在的文章） */
function collectExplicitPairs(posts: BlogPost[]): { pairs: Set<string>; list: [string, string][] } {
  const postIds = new Set(posts.map((post) => post.id));
  const pairs = new Set<string>();
  const list: [string, string][] = [];
  for (const post of posts) {
    for (const slug of extractExplicitLinks(post.body ?? '')) {
      if (slug === post.id || !postIds.has(slug)) continue;
      const key = pairKey(post.id, slug);
      if (!pairs.has(key)) {
        pairs.add(key);
        list.push([post.id, slug]);
      }
    }
  }
  return { pairs, list };
}

/** 校验手工数据与实际文章的一致性，返回问题清单（空数组 = 通过） */
function validateGraphData(posts: BlogPost[], explicitPairs: Set<string>): string[] {
  const postIds = new Set(posts.map((post) => post.id));
  const problems: string[] = [];
  const conceptIds = new Set<string>();

  for (const concept of conceptMeta) {
    if (!concept.id) problems.push('知识点缺少 id');
    if (conceptIds.has(concept.id)) problems.push(`知识点 id 重复：${concept.id}`);
    conceptIds.add(concept.id);
    if (concept.posts.length === 0) problems.push(`知识点 ${concept.id} 没有关联任何文章`);
    for (const postId of concept.posts) {
      if (!postIds.has(postId)) problems.push(`知识点 ${concept.id} 引用了不存在的文章：${postId}`);
    }
  }

  const seenPairs = new Set<string>();
  for (const link of relatedLinks) {
    if (link.from === link.to) problems.push(`精选关联不能指向自己：${link.from}`);
    if (!postIds.has(link.from)) problems.push(`精选关联 from 引用了不存在的文章：${link.from}`);
    if (!postIds.has(link.to)) problems.push(`精选关联 to 引用了不存在的文章：${link.to}`);
    const key = pairKey(link.from, link.to);
    if (seenPairs.has(key)) problems.push(`精选关联重复：${link.from} ↔ ${link.to}`);
    seenPairs.add(key);
    if (explicitPairs.has(key)) {
      problems.push(`精选关联 ${link.from} ↔ ${link.to} 已是文内互链，请从 relatedLinks 中删除（避免双重计分）`);
    }
  }

  return problems;
}

/** 组装完整图谱数据（/graph/ 页与 GraphView 组件共用） */
export async function getGraphData(): Promise<GraphData> {
  const posts = await getPublishedPosts();
  const { pairs: explicitPairs, list: explicitList } = collectExplicitPairs(posts);

  const problems = validateGraphData(posts, explicitPairs);
  if (problems.length > 0) {
    throw new Error(`[graph] src/data/graph.ts 与实际文章不一致：\n- ${problems.join('\n- ')}`);
  }

  const seriesCounts: Partial<Record<Category, number>> = {};
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const post of posts) {
    const { category, pubDate, title } = post.data;
    seriesCounts[category] = (seriesCounts[category] ?? 0) + 1;
    nodes.push({
      id: `post:${post.id}`,
      kind: 'post',
      label: title,
      series: category,
      seriesLabel: CATEGORY_LABELS[category],
      url: `/posts/${post.id}/`,
      minutes: readingTime(post.body ?? '').minutes,
      dateLabel: cnDate(pubDate),
    });
  }

  // 标签节点：出现 ≥2 次；与单一系列几乎重合的标签（如 Redis、数据库）只重复系列分组，不进图谱
  const tagStats = new Map<string, Partial<Record<Category, number>>>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      const bySeries = tagStats.get(tag) ?? {};
      bySeries[post.data.category] = (bySeries[post.data.category] ?? 0) + 1;
      tagStats.set(tag, bySeries);
    }
  }
  const graphTags = new Set<string>();
  for (const [tag, bySeries] of tagStats) {
    const entries = Object.entries(bySeries) as [Category, number][];
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    if (total < 2) continue;
    const seriesRedundant =
      entries.length === 1 && entries[0][1] >= (seriesCounts[entries[0][0]] ?? 0) * 0.8;
    if (!seriesRedundant) graphTags.add(tag);
  }
  for (const tag of graphTags) {
    nodes.push({ id: `tag:${tag}`, kind: 'tag', label: tag });
  }
  for (const post of posts) {
    for (const tag of post.data.tags) {
      if (graphTags.has(tag)) {
        edges.push({ source: `post:${post.id}`, target: `tag:${tag}`, kind: 'tag' });
      }
    }
  }

  // 知识点节点与归属边
  for (const concept of conceptMeta) {
    nodes.push({ id: `concept:${concept.id}`, kind: 'concept', label: concept.label, description: concept.description });
    for (const postId of new Set(concept.posts)) {
      edges.push({ source: `post:${postId}`, target: `concept:${concept.id}`, kind: 'concept' });
    }
  }

  // 文内互链与精选关联（文章-文章）
  for (const [from, to] of explicitList) {
    edges.push({ source: `post:${from}`, target: `post:${to}`, kind: 'link' });
  }
  for (const link of relatedLinks) {
    edges.push({ source: `post:${link.from}`, target: `post:${link.to}`, kind: 'related', note: link.note });
  }

  return {
    nodes,
    edges,
    stats: {
      posts: posts.length,
      concepts: conceptMeta.length,
      tags: graphTags.size,
      edges: edges.length,
    },
    seriesOrder: SERIES_ORDER.map((series) => series.id),
    seriesCounts,
  };
}

/** 文字版知识点索引条目 */
export interface ConceptIndexEntry {
  id: string;
  label: string;
  description?: string;
  posts: { url: string; title: string }[];
}

/** 全部知识点及其文章（按文章数倒序，供 /graph/ 页文字索引用） */
export async function getConceptIndex(): Promise<ConceptIndexEntry[]> {
  const posts = await getPublishedPosts();
  const byId = new Map(posts.map((post) => [post.id, post]));
  return conceptMeta
    .map((concept) => ({
      id: concept.id,
      label: concept.label,
      description: concept.description,
      posts: [...new Set(concept.posts)]
        .filter((postId) => byId.has(postId))
        .map((postId) => ({ url: `/posts/${postId}/`, title: byId.get(postId)!.data.title })),
    }))
    .sort((a, b) => b.posts.length - a.posts.length || a.label.localeCompare(b.label, 'zh'));
}

/** 相关文章推荐结果 */
export interface RelatedPost {
  post: BlogPost;
  score: number;
  /** 推荐理由（如「共同知识点：引用计数、写时复制」） */
  reasons: string[];
}

/**
 * 计算文章的相关文章（取前 3）。
 *
 * 评分：精选关联 / 文内互链 +4，每个共同知识点 +3，共同标签 +0.5（封顶 1.5，只做同分排序的 tie-break）。
 * 至少要有一个实质信号（知识点 / 互链 / 精选关联）才会入选，纯系列通用标签不算相关。
 */
export async function getRelatedPosts(post: BlogPost, posts?: BlogPost[]): Promise<RelatedPost[]> {
  const source = posts ?? (await getPublishedPosts());

  const conceptLabelsByPost = new Map<string, string[]>();
  for (const concept of conceptMeta) {
    for (const postId of new Set(concept.posts)) {
      const list = conceptLabelsByPost.get(postId) ?? [];
      list.push(concept.label);
      conceptLabelsByPost.set(postId, list);
    }
  }

  const relatedNotes = new Map<string, string>();
  for (const link of relatedLinks) {
    relatedNotes.set(pairKey(link.from, link.to), link.note || '精选关联');
  }

  const { pairs: explicitPairs } = collectExplicitPairs(source);
  const myConcepts = new Set(conceptLabelsByPost.get(post.id) ?? []);
  const myTags = new Set(post.data.tags);

  const results: RelatedPost[] = [];
  for (const other of source) {
    if (other.id === post.id) continue;

    const reasons: string[] = [];
    let score = 0;

    const note = relatedNotes.get(pairKey(post.id, other.id));
    if (note) {
      score += 4;
      reasons.push(note);
    } else if (explicitPairs.has(pairKey(post.id, other.id))) {
      score += 4;
      reasons.push('文内互链');
    }

    const sharedConcepts = [...new Set(conceptLabelsByPost.get(other.id) ?? [])].filter((label) =>
      myConcepts.has(label),
    );
    if (sharedConcepts.length > 0) {
      score += sharedConcepts.length * 3;
      const shown = sharedConcepts.slice(0, 2).join('、');
      reasons.push(`共同知识点：${shown}${sharedConcepts.length > 2 ? ' 等' : ''}`);
    }

    if (reasons.length === 0) continue;

    const sharedTags = other.data.tags.filter((tag) => myTags.has(tag)).length;
    score += Math.min(sharedTags * 0.5, 1.5);

    results.push({ post: other, score, reasons });
  }

  results.sort((a, b) => b.score - a.score || comparePostsByDateDesc(a.post, b.post));
  return results.slice(0, 3);
}

/** 重新导出手工数据类型，方便数据文件与页面引用 */
export type { ConceptMeta, RelatedLink };
