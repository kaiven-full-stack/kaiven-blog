import {
  comparePostsByDateDesc,
  getPublishedPosts,
  type BlogPost,
} from './posts';
import { concepts as conceptMeta, relatedLinks } from '../data/relations';

/**
 * 文章页底部「相关文章」推荐（构建期）。
 *
 * 关联信号的来源：
 * - 文内互链：正文里出现的 /posts/<slug>/ 引用（自动提取）；
 * - 知识点归属：src/data/relations.ts 里手工维护的文章-知识点关系；
 * - 精选关联：src/data/relations.ts 里手工维护的跨系列强关联。
 *
 * 手工数据在构建时校验：引用了不存在的文章 id 会直接让 build 报错，
 * 避免文章改名/删除后推荐悄悄烂掉。
 */

/** 提取正文里引用的其他文章 slug（markdown 链接或裸 URL 均可） */
function extractExplicitLinks(body: string): string[] {
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
function validateRelationData(posts: BlogPost[], explicitPairs: Set<string>): string[] {
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

  const { pairs: explicitPairs } = collectExplicitPairs(source);
  const problems = validateRelationData(source, explicitPairs);
  if (problems.length > 0) {
    throw new Error(`[related] src/data/relations.ts 与实际文章不一致：\n- ${problems.join('\n- ')}`);
  }

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
