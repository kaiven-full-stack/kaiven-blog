---
title: 第 513 个字段，房租涨了五倍：Redis 的对象编码与转换
description: 同一条 HSET 命令，第 512 次花 47 微秒，第 513 次花 112 微秒，整个键的内存从 5KB 跳到 28KB。本文逐类型拆开 Redis 的底层编码：embstr 的 44 字节、listpack 的连续内存、intset 的自动升位、quicklist 的分册结构，以及转换为什么只升不降。编码阈值均取 7.4.11 的默认值。
pubDate: 2026-09-10
category: redis
tags: [Redis, 数据库]
---

同一条 `HSET h f:N v`，第 512 次花了 47.3 微秒，键占用 5,168 字节；第 513 次花了 112.2 微秒，键占用变成 28,816 字节。没有报错，没有慢日志，键还是那个键。变化的只有一件事：Redis 在执行这笔 HSET 时，顺手把整个 hash 的底层存储从 listpack 换成了 hashtable。转换发生在一次普通的写命令里，成本也在那一次付清。

rehash 篇看的是键空间的 dict：怎么扩容、怎么渐进式搬家。这一篇走进每个键的内部：**每个键的值还有一套自己的存储决策**。同样是 hash，小的时候是一种结构，大了是另一种；set 会因为塞进一个非整数成员而连夜换结构；string 有 44 字节这条看不见的线。这套机制叫对象编码（object encoding）：同一种数据类型，多种底层实现，按大小自动切换。

实验在官方 Redis 7.4.11 容器中完成，源码名称以该版本为准。延迟数字用裸 socket 单连接往返测得，只描述本机，不应写进生产容量承诺。

## 先看清单：一个类型，不止一种存法

`OBJECT ENCODING` 直接回答「这个键现在用什么存」：

```text
string  → embstr / raw / int
hash    → listpack / hashtable
list    → listpack(quicklist 节点内) / quicklist
set     → intset / listpack / hashtable
zset    → listpack / skiplist
```

七个类型各自面对同一组问题：元素少而小时用最省的存法，多了大了换成通用结构。默认阈值都在配置里，7.4 的默认值值得先记下来（网上资料常把它们混成一组）：

```text
hash-max-listpack-entries   512     字段数阈值
hash-max-listpack-value      64     字段或值的字节上限
set-max-intset-entries      512     整数集合元素数上限
set-max-listpack-entries    128     set 的 listpack 元素数阈值
set-max-listpack-value       64     set 的元素字节上限
zset-max-listpack-entries   128     zset 成员数阈值
zset-max-listpack-value      64     zset 成员字节上限
```

下面逐个走进去看。

## string 的 44 字节：embstr 与 raw 的分界

最简单的类型也有编码。先看一个反直觉的事实：

```text
SET s:a 404            → OBJECT ENCODING 是 int
SET s:b "aaa...43字节"  → embstr
SET s:c "aaa...44字节"  → embstr
SET s:d "aaa...45字节"  → raw
```

三条线：

**能表示成整数的短字符串直接存成 int**。`SET counter 404` 之后对象里没有字符序列，只有一个 long long 值。`INCR` 能直接在这个值上运算，不用解析字符串。

**44 字节以内是 embstr**。embstr 是 embedded string 的缩写：把 SDS 头、字符串内容、robj 对象头**一次性分配在同一块内存里**。普通 raw 编码是两次分配，对象头一块、字符串一块；embstr 合成一块，对 CPU 缓存友好，创建和释放各只需要一次内存操作。

**45 字节起是 raw**。为什么恰好是 44？这不是随便选的数：Redis 的 jemalloc 分配器有固定尺寸的内存档位，44 字节内容加上对象头和 SDS 头恰好装进一个 64 字节的档位。卡着 44，是为了让 embstr 恰好不多不少地用满一个最小可用的整块。

一条推论随之而来：**embstr 是只读的**。任何 APPEND、SETRANGE 这类就地修改都会改变长度，破坏「内容与对象头同块」的布局。所以 embstr 上一旦发生修改，Redis 不在原地改，而是先升级成 raw 再操作；第一次 APPEND 就是换编码的那一笔。

两种存法的内存块：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="embstr 与 raw 的内存布局对照：embstr 把 robj 对象头、SDS 头和不超过 44 字节的内容一次性分配在同一块内存里；raw 是两次分配，对象头一块，字符串内容另一块，中间用指针相连" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red4As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">embstr（≤44 字节）：一块内存</text>
<rect class="bx-q" x="40" y="40" width="480" height="44" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<line class="grid" x1="130" y1="40" x2="130" y2="84" stroke="#a29d90" stroke-width="1"/>
<line class="grid" x1="200" y1="40" x2="200" y2="84" stroke="#a29d90" stroke-width="1"/>
<text class="ts" x="85" y="66" text-anchor="middle" font-size="11" fill="#6b675e">robj 头</text>
<text class="ts" x="165" y="66" text-anchor="middle" font-size="11" fill="#6b675e">SDS 头</text>
<text class="ts" x="360" y="66" text-anchor="middle" font-size="11" fill="#6b675e">内容（≤44 字节）</text>
<text class="tc" x="40" y="104" font-size="11" fill="#b03a2e">一次分配，恰好装满一个 64 字节档位</text>
<text class="ts" x="20" y="140" font-size="12" fill="#6b675e">raw（≥45 字节）：两块内存</text>
<rect class="bx-q" x="40" y="152" width="120" height="44" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="100" y="178" text-anchor="middle" font-size="11" fill="#6b675e">robj 头</text>
<line class="fl" x1="160" y1="174" x2="256" y2="174" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As1)"/>
<text class="ts" x="208" y="164" text-anchor="middle" font-size="10" fill="#6b675e">指针</text>
<rect class="bx-q" x="260" y="152" width="300" height="44" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<line class="grid" x1="320" y1="152" x2="320" y2="196" stroke="#a29d90" stroke-width="1"/>
<text class="ts" x="290" y="178" text-anchor="middle" font-size="11" fill="#6b675e">SDS 头</text>
<text class="ts" x="440" y="178" text-anchor="middle" font-size="11" fill="#6b675e">内容（≥45 字节）</text>
<text class="ts" x="20" y="224" font-size="12" fill="#6b675e">两种存法对 GET 都透明，差别在分配次数与缓存局部性</text>
</svg>
</figure>

## listpack：一块连续内存装下整个 hash

hash、set、zset 共用的第一种编码都是 listpack：一块连续内存里顺序存放所有元素，每个条目记录自己的长度，不存指针：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 190" role="img" aria-label="listpack 编码的 hash：总长、条目数、f1、v1、f2、v2、结尾标记顺序排在一块连续内存里，条目只记自己的长度，不存任何指针" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">listpack 编码的 hash（两个字段的示意）</text>
<rect class="bx" x="40" y="48" width="70" height="44" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="75" y="74" text-anchor="middle" font-size="11" fill="#6b675e">总长</text>
<rect class="bx" x="110" y="48" width="70" height="44" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="145" y="74" text-anchor="middle" font-size="11" fill="#6b675e">条目数</text>
<rect class="bx-q" x="180" y="48" width="60" height="44" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="210" y="74" text-anchor="middle" font-size="11" fill="#6b675e">f1</text>
<rect class="bx-q" x="240" y="48" width="60" height="44" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="270" y="74" text-anchor="middle" font-size="11" fill="#6b675e">v1</text>
<rect class="bx-q" x="300" y="48" width="60" height="44" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="74" text-anchor="middle" font-size="11" fill="#6b675e">f2</text>
<rect class="bx-q" x="360" y="48" width="60" height="44" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="390" y="74" text-anchor="middle" font-size="11" fill="#6b675e">v2</text>
<rect class="bx" x="420" y="48" width="70" height="44" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="455" y="74" text-anchor="middle" font-size="11" fill="#6b675e">结尾标记</text>
<path class="fl" d="M40 100 L40 112 L490 112 L490 100" fill="none" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="265" y="132" text-anchor="middle" font-size="12" fill="#6b675e">一块连续内存：条目只记长度，不存指针</text>
<text class="ts" x="20" y="160" font-size="12" fill="#6b675e">同样 512 个字段：listpack 5,168 字节，hashtable 28,816 字节</text>
<text class="ts" x="20" y="180" font-size="12" fill="#6b675e">差价全是指针、条目头和桶数组；查找则从 O(1) 换成顺序扫描</text>
</svg>
</figure>

它的好处是极端的紧凑：512 个字段的 hash 只占 5,168 字节，平均每字段约 10 字节，其中还包含字段名本身。同样的数据换成 hashtable 要 28,816 字节，五倍多的差距来自 dict 每个条目都要挂 dictEntry、桶数组、指针串联的开销。

代价也直白：**listpack 的查找是顺序扫描**。`HGET h f:400` 要从第一项扫到第 400 项；小数据下这不是问题（几百字节的内存一次就能装进缓存），大数据下就是灾难。所以它只服务小 hash，128 或 512 以内。

还有一个所有 listpack 编码共享的隐性约束：**写操作发生在连续内存的中间时要搬运后面的所有字节**。`HDEL` 掉中间一个字段，其后的内容都要前移。小结构搬得动，大结构不行，这也是阈值存在的另一个理由。

## 第 513 个字段：一次写命令里的转换

hash 的转换触发点在源码里很明确：新增后字段数超过 512，或者任何一个字段或值超过 64 字节，`hashTypeConvert` 立即执行，遍历 listpack，把所有条目搬进新建的 dict，当场完成。

实验把这笔成本精确记了下来。单连接往返延迟：

```text
第 512 个 HSET（仍是 listpack）    p50 = 47.3 微秒
第 513 个 HSET（触发转换）        p50 = 112.2 微秒
```

多出来的约 65 微秒就是搬 512 个字段的全部成本。可感知，但只是一笔普通写命令的两倍多，谈不上停顿或尖刺。渐进式 rehash 把键空间的迁移摊进流量，每个键内部的转换则一次付清；键足够小，付得起。

内存的价差要重得多：

```text
512 字段 listpack        5,168 字节
513 字段 hashtable      28,816 字节     5.6 倍
```

跳变不只因为结构变贵，还因为 dict 建表时的预分配：新表按下一个 2 的幂分配桶，512 个字段的 dict 直接拿到 1024 个桶。**涨的是这一整步，不是每个字段的单价**。同样的 hash 涨到 5,000 个字段，占用约 230KB，平均每字段反而比 513 个时便宜。

一次转换付的两笔账：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 222" role="img" aria-label="第 513 个 HSET 的两笔账：延迟从 47.3 微秒跳到 112.2 微秒，多出的 65 微秒是搬 512 个字段的成本；内存从 5168 字节跳到 28816 字节，5.6 倍里含 dict 预分配的 1024 个桶" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">第 513 笔 HSET：一次付清转换成本</text>
<text class="ts" x="20" y="52" font-size="12" fill="#6b675e">单连接往返 p50</text>
<text class="ts" x="160" y="76" text-anchor="end" font-size="11" fill="#6b675e">第 512 笔</text>
<rect class="bar" x="170" y="64" width="71" height="16" fill="#2b2a26"/>
<text class="ts" x="249" y="76" font-size="11" fill="#6b675e">47.3μs</text>
<text class="ts" x="160" y="100" text-anchor="end" font-size="11" fill="#6b675e">第 513 笔</text>
<rect class="bar" x="170" y="88" width="168" height="16" fill="#2b2a26"/>
<text class="tc" x="346" y="100" font-size="11" fill="#b03a2e">112.2μs：多出的 65μs 是搬 512 个字段</text>
<text class="ts" x="20" y="136" font-size="12" fill="#6b675e">MEMORY USAGE</text>
<text class="ts" x="160" y="160" text-anchor="end" font-size="11" fill="#6b675e">512 字段</text>
<rect class="bar" x="170" y="148" width="68" height="16" fill="#2b2a26"/>
<text class="ts" x="246" y="160" font-size="11" fill="#6b675e">5,168B · listpack</text>
<text class="ts" x="160" y="184" text-anchor="end" font-size="11" fill="#6b675e">513 字段</text>
<rect class="bar" x="170" y="172" width="380" height="16" fill="#2b2a26"/>
<text class="tc" x="440" y="168" font-size="11" fill="#b03a2e">28,816B · hashtable</text>
<text class="ts" x="20" y="210" font-size="12" fill="#6b675e">条长同一比例尺：延迟涨 2.4 倍，内存涨 5.6 倍，后者含 1024 桶的预分配</text>
</svg>
</figure>

## set 的三条路：整数、listpack、hashtable

set 的编码路径是所有类型里最多的，因为它多了一个专属选项：

**全是整数且不超过 512 个 → intset**。这是又一个「为一种数据量身定做」的结构：一串排序的整数，按当前最大值需要的宽度统一存储。元素 1、100、70000 在一起时，每个都占 4 字节（int32 档）；加入 5,000,000,000 时整个集合升位到 int64 档，每个元素占 8 字节：

```text
SADD s 1               MEMORY USAGE = 64 字节（int16 档起步）
SADD s 70000           MEMORY USAGE = 72 字节（升到 int32 档）
SADD s 5000000000      MEMORY USAGE = 88 字节（升到 int64 档）
```

排序带来的福利是二分查找和 O(log n) 的插入，代价是**升位或插入时要整体重排**。同样地，intset 也只在集合小的时候使用。

**混入一个非整数元素 → 立即离开 intset**。实验在 100 个整数的 set 里 `SADD s2 hello`：

```text
100 个整数                    intset
加入 "hello" 之后             listpack
```

注意去向是 listpack 而不是 hashtable：元素数还在 128 以内，先用第二种紧凑结构。要到元素超过 128 个，或任一元素超过 64 字节，才最终换成 hashtable。

**元素超过阈值 → hashtable**。`SADD` 第 513 个整数时转换发生：

```text
512 个整数 intset          1,328 字节
513 个整数 hashtable      24,712 字节     18.6 倍
```

set 是所有类型里内存跳变最陡的：intset 实在太省了，每元素只有 2–8 字节，对比 hashtable 的每元素约 50 字节，落差最大。

三条路一张图：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 300" role="img" aria-label="set 的三条编码路径：新集合全是整数且不超过 512 个走 intset，含非整数且不超过 128 个走 listpack；intset 混入非整数转 listpack，超过 512 个整数转 hashtable；listpack 超过 128 个或 64 字节也转 hashtable。下方是 intset 的升位实验：加 1 是 int16 档 64 字节，加 70000 升 int32 档 72 字节，加 50 亿升 int64 档 88 字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red4As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">set 的编码路径：三种结构，三个单价</text>
<rect class="bx-q" x="20" y="88" width="110" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="75" y="106" text-anchor="middle" font-size="12" fill="#2b2a26">新建 set</text>
<text class="ts" x="75" y="124" text-anchor="middle" font-size="10" fill="#6b675e">SADD 进来</text>
<line class="fl" x1="130" y1="98" x2="186" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As4)"/>
<text class="ts" x="140" y="76" font-size="10" fill="#6b675e">全是整数 ≤512</text>
<line class="fl" x1="130" y1="122" x2="186" y2="152" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As4)"/>
<text class="ts" x="128" y="150" font-size="10" fill="#6b675e">含非整数</text>
<rect class="bx-q" x="190" y="44" width="140" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="260" y="64" text-anchor="middle" font-size="13" fill="#2b2a26">intset</text>
<text class="ts" x="260" y="82" text-anchor="middle" font-size="10" fill="#6b675e">每元素 2–8 字节，排序存储</text>
<rect class="bx-q" x="190" y="140" width="140" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="260" y="160" text-anchor="middle" font-size="13" fill="#2b2a26">listpack</text>
<text class="ts" x="260" y="178" text-anchor="middle" font-size="10" fill="#6b675e">≤128 个且 ≤64 字节</text>
<line class="fl" x1="260" y1="92" x2="260" y2="136" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As4)"/>
<text class="ts" x="268" y="118" font-size="10" fill="#6b675e">混入非整数</text>
<line class="fl" x1="330" y1="68" x2="416" y2="100" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As4)"/>
<text class="ts" x="352" y="72" font-size="10" fill="#6b675e">&gt;512 个整数</text>
<line class="fl" x1="330" y1="164" x2="416" y2="128" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As4)"/>
<text class="ts" x="336" y="160" font-size="10" fill="#6b675e">&gt;128 个或 &gt;64 字节</text>
<rect class="bx-sick" x="420" y="90" width="160" height="48" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="500" y="110" text-anchor="middle" font-size="13" fill="#2b2a26">hashtable</text>
<text class="ts" x="500" y="128" text-anchor="middle" font-size="10" fill="#6b675e">每元素约 50 字节，单程票</text>
<rect class="bx" x="20" y="208" width="560" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="36" y="230" font-size="12" fill="#2b2a26">intset 内部：按当前最大值升位</text>
<text class="ts" x="36" y="252" font-size="11" fill="#6b675e">SADD 1 → int16 档 64B；SADD 70000 → 全体升 int32，72B；SADD 5000000000 → 升 int64，88B</text>
<text class="ts" x="20" y="288" font-size="12" fill="#6b675e">升位与插入都要整体重排；换来的福利是二分查找和 O(log n) 插入</text>
</svg>
</figure>

## zset：有序存储，和一套双索引

zset 的 listpack 阶段有个特别的细节：**它靠插入排序维持有序**。每个条目按「分数、成员」排列，新成员插进来时找到位置、插入、后面整体后移。所以 ZSCORE 在 listpack 编码下也是扫描，但 128 个条目以内，扫描比任何指针结构都快。

第 129 个成员触发转换，去向是 skiplist 编码，而「skiplist」这个名字只说了一半。转换后的 zset 内部是**两套结构**：

```text
dict：成员 → 分数          单点查询用
zskiplist：按分数排序的跳表   范围查询用
```

为什么需要两套、怎么协作，是下一篇的主题，这里先记下转换瞬间的数字：

```text
128 成员 listpack          1,328 字节
129 成员 skiplist         12,128 字节     9.1 倍
```

延迟侧，第 129 个 ZADD 从稳态的约 44 微秒涨到约 72 微秒，比 hash 的转换更贵一点，因为要同时建 dict 和跳表两套结构。

## list：从第一笔起就是 quicklist

list 的路径和上面都不同：**没有阈值转换，从头到尾都住在 quicklist 里**。

quicklist 是「链表串起的一串小 listpack」：每个节点内部是一段紧凑的 listpack，节点之间用指针连接。它同时回答了两个矛盾的需求：链表的头部尾部插入删除是 O(1)，listpack 的每个节点内部又极度省内存。

实验里 3 个小元素的 list，编码显示 listpack（这是 7.x 的显示口径，指 quicklist 节点未压缩的形态），64 个元素也还只占 816 字节。节点的容量由 `list-max-listpack-size` 控制，默认 -2，意思是**每个节点不超过 8KB**：一端不停 RPUSH，quicklist 的做法不是把单个 listpack 无限撑大，而是 8KB 一册、分册串接、指针相连。

单个元素超大时另有一套：30KB 的单个元素不进 listpack，而是独占一个 plain 节点。这个设计让「一个正常队列里混进一条巨大消息」不至于拖累整个队列的紧凑性。

分册结构：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 190" role="img" aria-label="quicklist 分册结构：三个普通节点各是一段不超过 8KB 的紧凑 listpack，节点之间用双向指针串接；一个 30KB 的超大元素独占一个 plain 节点，不拖累其他册的紧凑性" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red4As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">quicklist：链表串起的一串小 listpack，默认每册 ≤8KB</text>
<rect class="bx-q" x="30" y="52" width="140" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx" x="40" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="80" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="120" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="64" text-anchor="middle" font-size="10" fill="#6b675e">节点 · 一段 listpack</text>
<rect class="bx-q" x="200" y="52" width="140" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx" x="210" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="250" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="290" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="270" y="64" text-anchor="middle" font-size="10" fill="#6b675e">节点 · 一段 listpack</text>
<rect class="bx-q" x="370" y="52" width="140" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx" x="380" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="420" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="460" y="70" width="34" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="440" y="64" text-anchor="middle" font-size="10" fill="#6b675e">节点 · 一段 listpack</text>
<rect class="bx-sick" x="540" y="52" width="100" height="56" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="590" y="64" text-anchor="middle" font-size="10" fill="#6b675e">plain 节点</text>
<text class="tc" x="590" y="86" text-anchor="middle" font-size="10" fill="#b03a2e">30KB 元素</text>
<text class="ts" x="590" y="100" text-anchor="middle" font-size="10" fill="#6b675e">独占一册</text>
<line class="fl" x1="170" y1="80" x2="196" y2="80" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As5)"/>
<line class="fl" x1="340" y1="80" x2="366" y2="80" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As5)"/>
<line class="fl" x1="510" y1="80" x2="536" y2="80" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red4As5)"/>
<text class="ts" x="20" y="140" font-size="12" fill="#6b675e">RPUSH 不停加册，不撑大单册：头尾插删 O(1)，册内紧凑无指针</text>
<text class="ts" x="20" y="162" font-size="12" fill="#6b675e">list-max-listpack-size 默认 −2 即每册 8KB 上限；list 没有阈值转换，从第一笔起就住在这里</text>
</svg>
</figure>

## 转换是单程票：只升不降

到这里出现一个自然的问题：hash 涨过 513 个字段又删剩 20 个，会回到 listpack 吗？

不会。实验确认：

```text
zset 涨到 129 个成员（skiplist）
删到只剩 29 个成员            仍是 skiplist
```

```text
set 涨到 513 个整数（hashtable）
删到只剩 13 个整数            仍是 hashtable
```

源码里没有删除路径上的降级逻辑。理由是防抖动：如果一个键的元素数在 512/513 附近反复横跳，双向转换会让每次越线都搬一次家，每次都是全量重排。单程票把震荡的代价限制在一侧：涨过去贵一次，跌回来不动。

这张单程票：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="编码转换是单程票：从 listpack 或 intset 到 hashtable 或 skiplist 只有向右的实线箭头，标注第 513 个字段越线当场付搬家钱；反向只有带叉的虚线，删回 20 个字段也不回头" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red4As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">转换只升不降</text>
<rect class="bx-q" x="40" y="48" width="170" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="125" y="70" text-anchor="middle" font-size="13" fill="#2b2a26">listpack / intset</text>
<text class="ts" x="125" y="90" text-anchor="middle" font-size="10" fill="#6b675e">紧凑小结构</text>
<rect class="bx-sick" x="420" y="48" width="190" height="52" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="515" y="70" text-anchor="middle" font-size="13" fill="#2b2a26">hashtable / skiplist</text>
<text class="ts" x="515" y="90" text-anchor="middle" font-size="10" fill="#6b675e">通用大结构</text>
<line class="fl" x1="210" y1="64" x2="416" y2="64" stroke="#6b675e" stroke-width="1.8" marker-end="url(#red4As6)"/>
<text class="ts" x="313" y="54" text-anchor="middle" font-size="11" fill="#6b675e">第 513 个字段：越线那笔写命令当场付清</text>
<line class="fl" x1="420" y1="96" x2="214" y2="96" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="5 4"/>
<text class="tc" x="313" y="100" text-anchor="middle" font-size="14" fill="#b03a2e">✕</text>
<text class="ts" x="313" y="120" text-anchor="middle" font-size="11" fill="#6b675e">删回 20 个字段：也不回头，源码里没有降级路径</text>
<rect class="bx" x="90" y="138" width="480" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="159" text-anchor="middle" font-size="11" fill="#6b675e">例外：SUNIONSTORE 生成的新键按出生身材选编码，intset ∪ intset 仍是 intset</text>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">想收回大结构的开销：等值归零重建，或用集合运算生成新键</text>
</svg>
</figure>

但存在一个例外，而且只在「结果集新建」时发生。`SUNIONSTORE` 这类集合运算会根据结果**重新选择**编码：两个 intset 的并集，结果直接存成 intset：

```text
SADD s6 1 2 3；SADD s7 10 20
SUNIONSTORE dst s6 s7     → dst 的编码是 intset
```

`ZUNIONSTORE` 同理，结果小且元素短时会存成 listpack。逻辑很直白：结果是一个全新的键，没有任何历史包袱，按当下的大小选最省的存法即可。**单程票的限制只针对已有键，新键永远按出生时的身材选编码。**

## 每个类型一张决策图

把各类型的选择逻辑并排画出来：

```text
string   整数？→ int
         ≤44 字节？→ embstr
         否则 → raw

hash     字段数 ≤512 且字段/值 ≤64 字节？→ listpack
         否则 → hashtable

list     永远 quicklist（节点内 listpack，单节点 ≤8KB，超大元素独占节点）

set      全整数且 ≤512 个？→ intset
         元素数 ≤128 且 ≤64 字节？→ listpack
         否则 → hashtable

zset     成员数 ≤128 且 ≤64 字节？→ listpack（插入排序维持有序）
         否则 → skiplist（内含 dict + 跳表双结构）
```

## 这套设计在买什么

listpack 和 intset 的共同哲学是「小数据不值得指针的开销」。指针加条目头的开销在 jemalloc 下每条目几十字节，而小 hash 里每字段可能只有几字节有效数据，比例完全失衡。连续内存还有免费的搭车福利：一次缓存行加载带出一串相邻条目。

转换本身几十微秒、发生在写命令里、无锁无停顿，Redis 把它当作一笔稍贵的写操作处理，不引入任何后台机制。对比 rehash 篇：键空间的 dict 靠渐进式摊，键内部的编码靠「键小所以一次付得起」。两种策略的分界线就是阈值本身的大小。

只升不降看似浪费（删剩 20 个字段的 hash 永远占着 dict 的开销），但避免了阈值附近反复搬家。想收回这部分内存，可以等值归零后重建，或用集合运算生成新键。

阈值的副作用也要有清醒认识。内存跳变 5.6–18.6 倍意味着：大量键集体逼近阈值的实例，内存曲线会呈现台阶状上涨；`hash-max-listpack-entries` 调大能省内存，但同时也把「listpack 顺序扫描」的适用范围放大了，HGET 的尾延迟会先于内存受益受损。调阈值是在两个方向上同时下注，不是单向优化。

## 怎么看当前编码和内存

```text
OBJECT ENCODING key          当下用哪种存法
OBJECT HELP                  看全部子命令
MEMORY USAGE key [SAMPLES 0] 这个键占多少字节（含内部结构）
CONFIG GET *listpack*        各类型阈值现值
DEBUG OBJECT key             压缩、引用等底层细节（需显式开启）
```

容量评估时最有用的组合是 `MEMORY USAGE` 对照阈值：一个「10 万个 500 字段的 hash」的实例，单看键数和数据量会严重低估内存，因为每个 hash 都刚好卡在 dict 侧，每字段约 45 字节的结构开销乘上去才是真实占用。

对象编码是 Redis 内存效率的地基：绝大多数真实业务里，海量的「小对象」都住在这套紧凑结构里，省下的内存是数量级的。这套效率的另一面，是每个键都要回答「什么时候值得换大结构」。Redis 的回答干脆利落：一条线划在那里，越线的那一笔写命令把过去和未来一起结清。

下一篇走进那条线之后的 zset：skiplist 编码里同时挂着的 dict 和跳表，究竟怎么分工。

---

系列至此第十篇。键空间 dict 与渐进式 rehash 见《搬了一半的家，也照常开门营业》，本文的键内转换与之对照；转换瞬间的写路径与 serverCron 的关系见《一个命令没走完，所有人都在门外》。
