---
title: 搬了一半的家，也照常开门营业：Redis 的渐进式 rehash
description: 百万键的字典要扩容，一次搬完会让主线程停下几百毫秒甚至几秒。本文把一次扩容冻结在半途：旧表还剩 1,012,381 个键、新表只搬进 47,619 个，期间 GET、SET、SCAN 一切照常。借此拆开两张表的分工、读驱动的顺手搬家、serverCron 的时间预算、SCAN 的倒序游标与子进程期间的全面暂停。实验使用官方 Redis 7.4.11 镜像。
pubDate: 2026-09-10
category: redis
tags: [Redis, 数据库]
---

一次百万键字典的扩容，搬到百分之四就停住了：旧表 1,048,576 个桶里还住着 1,012,381 个键，新表 2,097,152 个桶里只搬进来 47,619 个。七分钟过去，两个数字一动不动；这期间 GET、SET、SCAN、DBSIZE，一切照常。

先说清楚：这个现场是我在隔离容器里刻意冻住的一次扩容，不是什么故障。Redis 的字典在容量不够时会把桶数翻倍，但它并不一次搬完：旧表和新表并存，键分批迁移，每次读写顺手搬一点，空闲时后台预算再补一点。**大迁移被摊进了日常流量里，摊不完，也不影响营业。**

这一篇沿着这次冻结的现场，把渐进式 rehash 拆开看：两张表如何分工，迁移由谁驱动，SCAN 为什么在搬家途中也不会漏键，以及上一篇的 fork 子进程为什么会让所有搬家工作整体暂停。实验使用官方 Redis 7.4.11 镜像，源码名称以该版本为准。

## 先认识这张表：链地址法与 2 的幂

Redis 的键空间是一张标准的链地址哈希表。每个桶存一个指针，哈希冲突的键在同一桶里串成链：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 210" role="img" aria-label="链地址法哈希表：桶 0 串着两个 entry，桶 1 为空，桶 2 一个 entry，桶 3 串着三个 entry；桶数是 2 的幂，hash 与 size 减 1 做一次与运算就定位到桶" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red3As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">链地址法：冲突的键串在同一个桶里</text>
<rect class="bx" x="40" y="44" width="80" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="62" text-anchor="middle" font-size="11" fill="#6b675e">桶 0</text>
<line class="fl" x1="120" y1="58" x2="156" y2="58" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red3As1)"/>
<rect class="bx-q" x="160" y="44" width="76" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="198" y="62" text-anchor="middle" font-size="11" fill="#6b675e">entry</text>
<line class="fl" x1="236" y1="58" x2="262" y2="58" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red3As1)"/>
<rect class="bx-q" x="266" y="44" width="76" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="304" y="62" text-anchor="middle" font-size="11" fill="#6b675e">entry</text>
<rect class="bx" x="40" y="80" width="80" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="98" text-anchor="middle" font-size="11" fill="#6b675e">桶 1</text>
<text class="ts" x="160" y="98" font-size="11" fill="#6b675e">NULL</text>
<rect class="bx" x="40" y="116" width="80" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="134" text-anchor="middle" font-size="11" fill="#6b675e">桶 2</text>
<line class="fl" x1="120" y1="130" x2="156" y2="130" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red3As1)"/>
<rect class="bx-q" x="160" y="116" width="76" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="198" y="134" text-anchor="middle" font-size="11" fill="#6b675e">entry</text>
<rect class="bx" x="40" y="152" width="80" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="170" text-anchor="middle" font-size="11" fill="#6b675e">桶 3</text>
<line class="fl" x1="120" y1="166" x2="156" y2="166" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red3As1)"/>
<rect class="bx-q" x="160" y="152" width="76" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="198" y="170" text-anchor="middle" font-size="11" fill="#6b675e">entry</text>
<line class="fl" x1="236" y1="166" x2="262" y2="166" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red3As1)"/>
<rect class="bx-q" x="266" y="152" width="76" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="304" y="170" text-anchor="middle" font-size="11" fill="#6b675e">entry</text>
<line class="fl" x1="342" y1="166" x2="368" y2="166" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red3As1)"/>
<rect class="bx-q" x="372" y="152" width="76" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="410" y="170" text-anchor="middle" font-size="11" fill="#6b675e">entry</text>
<text class="ts" x="480" y="58" font-size="11" fill="#6b675e">桶数 = 1 &lt;&lt; ht_size_exp</text>
<text class="ts" x="480" y="80" font-size="11" fill="#6b675e">hash &amp; (size−1)：一次与运算定位</text>
<text class="tc" x="480" y="102" font-size="11" fill="#b03a2e">新库的第一张表：4 个桶</text>
<text class="ts" x="20" y="200" font-size="12" fill="#6b675e">元素数达到桶数（负载因子 1）就翻倍：第 5 个键把 4 桶撑成 8 桶</text>
</svg>
</figure>

桶数永远是 2 的幂，源码里不直接存尺寸，只存指数（`ht_size_exp`，尺寸即 `1 << exp`）。这样取模可以退化为位掩码：`hash & (size - 1)`，一次与运算就定位了桶。新库的第一张表是 4 个桶（`DICT_HT_INITIAL_SIZE` 为 4）。

向这样一张表里逐个写键，尺寸会在满载时翻倍。容器里实测的扩容序列：

```text
键数      1-4      5-7      8-15    16-31    32-63    64-127
桶数       4        8        16      32       64       128
```

第 5 个键把表从 4 撑到 8，第 8 个键撑到 16，第 16 个键撑到 32。触发点很明确：**元素数达到桶数，负载因子到 1，就翻倍。**

百万键的场景下，最后一次扩容是从 1,048,576 桶到 2,097,152 桶。一次搬完意味着主线程要连续挪动上百万个条目、重新分配一整张 16MB 的桶数组，事件循环篇算过，这正是主线程最怕的那种长命令。渐进式 rehash 就是为了不付这笔一次性的成本。

## 冻结现场：两张表如何分工

实验先一次性灌入 1,048,576 个键，停在扩容阈值边缘；然后关闭主动 rehash（`CONFIG SET activerehashing no`），再突发写入 6 万个键越过阈值。扩容被触发，但写入很快结束，迁移刚起步就失去了推力，现场就此冻住：

```text
[Dictionary HT]
Hash table 0 stats (main hash table):
 table size: 1048576
 number of elements: 1012381
Hash table 1 stats (rehashing target):
 table size: 2097152
 number of elements: 47619
```

（观测用 `DEBUG HTSTATS 0`，需要 `--enable-debug-command yes`。）

这个状态在源码里由一个字段标记：`rehashidx`。它等于 -1 时没有迁移；一旦扩容启动，它变成 0，指向旧表还没搬的下一个桶。上面的现场里，它正指着旧表中段某处：前面的桶已经搬空，后面的桶还在等。

扩容启动那一刻发生了什么？`_dictResize()` 分配新表，把 `rehashidx` 置 0，然后**立刻返回**。没有任何搬运。两张表就此并存：

- **旧表（表 0）**：只出不进，桶被搬空后指针置 NULL；
- **新表（表 1）**：只进不出，新写入的键直接落在它里面，已搬的键也都在它里面。

此后所有操作都要先问一句「现在在搬家吗」（`dictIsRehashing`），答案决定了查找和写入的路径。

冻结现场与两张表的分工：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="渐进式 rehash 冻结现场：左边旧表 1048576 桶只出不进，rehashidx 之前的桶已搬空置 NULL，之后还住着 1012381 个键；右边新表 2097152 桶只进不出，已搬进 47619 个键，新写入的键直接落在这里" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red3As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">扩容启动只分配不搬运：两张表并存，rehashidx 记录搬到哪了</text>
<rect class="bx" x="30" y="44" width="270" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="165" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">表 0 · 旧表（1,048,576 桶）</text>
<rect class="bx-gone" x="45" y="82" width="60" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<rect class="bx-q" x="105" y="82" width="180" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="195" y="99" text-anchor="middle" font-size="10" fill="#6b675e">还住着 1,012,381 个键</text>
<line class="flc" x1="105" y1="76" x2="105" y2="116" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="110" y="132" font-size="10" fill="#b03a2e">rehashidx：下一个待搬的桶</text>
<text class="ts" x="60" y="152" font-size="10" fill="#6b675e">已搬空，置 NULL</text>
<text class="t" x="165" y="180" text-anchor="middle" font-size="12" fill="#2b2a26">只出不进</text>
<line class="fl" x1="300" y1="119" x2="346" y2="119" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red3As2)"/>
<text class="ts" x="323" y="109" text-anchor="middle" font-size="10" fill="#6b675e">一次一桶</text>
<rect class="bx-q" x="350" y="44" width="280" height="150" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="490" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">表 1 · 新表（2,097,152 桶）</text>
<rect class="bx" x="365" y="82" width="90" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="410" y="99" text-anchor="middle" font-size="10" fill="#6b675e">已搬进 47,619</text>
<rect class="bx-gone" x="455" y="82" width="160" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="535" y="99" text-anchor="middle" font-size="10" fill="#6b675e">空桶，等着接</text>
<text class="ts" x="365" y="132" font-size="10" fill="#6b675e">新写入的键直接落在这里</text>
<text class="t" x="490" y="180" text-anchor="middle" font-size="12" fill="#2b2a26">只进不出</text>
<text class="ts" x="30" y="224" font-size="12" fill="#6b675e">_dictResize() 分配新表、rehashidx 置 0、立刻返回：触发那一刻没有任何搬运</text>
<text class="ts" x="30" y="248" font-size="12" fill="#6b675e">rehashidx = −1 表示没在搬家；搬家期间它一直指着旧表的断点</text>
</svg>
</figure>

## 读写顺手搬家：每次一桶，不是每次一个键

冻结状态下做一次普通读操作，看两张表的数字变化：

```text
GET m:2 之前    旧表 8 键   新表 1 键
GET m:2 之后    旧表 6 键   新表 3 键
```

一次 GET，旧表少了 2 个键。因为搬家的最小单位是**桶**，不是键：`m:2` 落在旧表第 3 号桶，这个桶里还串着另一个键，一次搬走。`_dictRehashStep()` 就是这件事的入口：查找键时若发现正在迁移，就顺手执行 `dictRehash(d, 1)`，搬一个非空桶，跳过至多 10 个空桶。

更有意思的是方向。7.4 的实现里，查找会先算出键落在旧表的哪个桶；若那个桶还没搬（桶号 ≥ rehashidx 且非空），就直接搬**这个桶**，反正马上要读它，顺手搬它对 CPU 缓存最友好。若是别的情形，才按 rehashidx 顺序搬下一桶。

写入也一样。冻结现场里插入一个新键 `brand:new`：

```text
SET brand:new 之前   旧表 858,896 键   新表 249,680 键
SET brand:new 之后   旧表 858,892 键   新表 249,685 键
```

新表多 5：新键本身进了新表，插入路径顺手搬走旧表一桶里的 4 个键。旧表的计数从此只减不增：搬家期间，所有新键都直接写进新表，没有任何新条目再进旧表。

这也解释了开头那个「没有后台线程」的判断：迁移的推力大头不在后台，而在每一次读写里。平时没人注意，是因为它太小了：一次一桶，微秒级，摊在命令延迟里看不见。

两次操作的前后账：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 226" role="img" aria-label="读写顺手搬家的前后对照：GET m:2 之前旧表 8 键新表 1 键，之后旧表 6 键新表 3 键，因为搬家的最小单位是桶，m:2 所在桶里串着的另一个键一并搬走；SET brand:new 之后新表多 5，新键本身进新表，又顺手搬走旧表一桶里的 4 个键" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">搬家的最小单位是桶：一次命令最多带走一个非空桶</text>
<text class="t" x="20" y="52" font-size="13" fill="#2b2a26">GET m:2（小表演示）</text>
<text class="ts" x="20" y="78" font-size="11" fill="#6b675e">之前</text>
<rect class="bx" x="70" y="64" width="90" height="22" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="115" y="79" text-anchor="middle" font-size="11" fill="#6b675e">旧表 8 键</text>
<rect class="bx-q" x="170" y="64" width="90" height="22" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="215" y="79" text-anchor="middle" font-size="11" fill="#6b675e">新表 1 键</text>
<text class="ts" x="20" y="110" font-size="11" fill="#6b675e">之后</text>
<rect class="bx" x="70" y="96" width="90" height="22" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="115" y="111" text-anchor="middle" font-size="11" fill="#6b675e">旧表 6 键</text>
<rect class="bx-q" x="170" y="96" width="90" height="22" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="215" y="111" text-anchor="middle" font-size="11" fill="#6b675e">新表 3 键</text>
<text class="tc" x="20" y="142" font-size="11" fill="#b03a2e">m:2 在旧表 3 号桶，桶里还串着一个键：一桶端走，−2 / +2</text>
<text class="t" x="20" y="176" font-size="13" fill="#2b2a26">SET brand:new（冻结现场）</text>
<text class="ts" x="20" y="200" font-size="11" fill="#6b675e">旧表 858,896 → 858,892　新表 249,680 → 249,685</text>
<text class="tc" x="360" y="200" font-size="11" fill="#b03a2e">新键直进新表 + 顺手搬走一桶 4 键 = +5</text>
<text class="ts" x="360" y="52" font-size="12" fill="#6b675e">另一条腿：serverCron 每轮 1ms 预算，</text>
<text class="ts" x="360" y="72" font-size="12" fill="#6b675e">以 100 桶为单位搬，直到预算用完；</text>
<text class="ts" x="360" y="92" font-size="12" fill="#6b675e">没有流量的冷表靠它排空，</text>
<text class="ts" x="360" y="112" font-size="12" fill="#6b675e">速度约每秒 1.7 万键</text>
</svg>
</figure>

## 大规模验证：三批 GET，搬走五十七万个键

小表现在放大。冻结现场（旧表约 101 万键、新表约 4.8 万键）上跑三批、每批十万次随机 GET：

```text
            旧表剩余      新表已有      本批搬走
GET 批次 1   820,129      239,871      约 192,251
GET 批次 2   644,644      415,356      约 175,485
GET 批次 3   481,537      578,463      约 163,181
```

十万次 GET 搬走十几万键：平均每桶串着 1.5 个以上的键，搬一桶带走的往往不止一个条目。随机 GET 会均匀命中旧表各处，读到的桶还没搬就顺手搬走，读到的桶已搬过就只查两张表。无论如何，每次读最多多搬一桶，不会更多。

十万次 GET 只完成 19% 的迁移，也说明单靠随机流量，搬家速度取决于键被访问的分布。热键所在的桶很快搬完，冷键的桶要等很久。这份不均衡正是渐进式的本意：迁移速度与业务流量同频，永远不制造一次性的长命令。

## serverCron 的兜底：每秒 10 毫秒的搬家预算

流量会停，搬家不能无限期挂着。兜底的是事件循环篇介绍过的 `serverCron`：默认每 100 毫秒运行一次，其中有一段专门推进迁移，但带时间预算。

7.4 的实现按时间计量：每轮 `databasesCron()` 里给 rehash 的预算是 1 毫秒（`INCREMENTAL_REHASHING_THRESHOLD_US` 为 1000 微秒），用 `dictRehashMicroseconds()` 以 100 桶为单位反复搬，直到预算耗尽。配置项 `activerehashing`（默认 yes）就是这个开关。

把前一步的现场交给 cron（重新 `CONFIG SET activerehashing yes`），观察排空速度：

```text
时刻      旧表剩余      新表已有
t0        465,660      594,340
t0+1s     447,201      612,799
t0+2s     430,154      629,846
t0+3s     412,816      647,184
...
t0+15s    合并完成，只剩一张 2,097,152 桶的表
```

每秒稳定搬走约 1.7 万个条目。若没有流量帮忙，照这个速度，五十万键要半分钟左右才能搬完：每秒 10 次调度乘以每次 1 毫秒，每秒就是 10 毫秒的预算。慢，但从不阻塞，预算一到就把执行权还给事件循环。

所以「有没有后台线程在搬家」的完整答案是：**没有专职线程，但有两条腿。** 一条是读写顺手的搬运，跟业务流量走；一条是 serverCron 的时间预算，跟调度走。两条腿都被设计得足够小步。

## 双表期间的查找：先查旧表，再查新表

迁移中的一次 `GET k`，完整路径是：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 186" role="img" aria-label="双表期间一次 GET 的查找路径四步：先用旧表尺寸掩码定位；桶号大于等于 rehashidx 且非空才扫旧表这条链；没找到再用新表尺寸掩码扫新表链；两张表都没有才判定键不存在" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red3As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">迁移中的一次 GET：最多扫两张表各一条链</text>
<rect class="bx" x="20" y="52" width="140" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="90" y="74" text-anchor="middle" font-size="11" fill="#6b675e">① hash &amp; (旧size−1)</text>
<text class="ts" x="90" y="92" text-anchor="middle" font-size="11" fill="#6b675e">定位旧表的桶</text>
<line class="fl" x1="160" y1="80" x2="186" y2="80" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red3As4)"/>
<rect class="bx" x="190" y="52" width="160" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="270" y="74" text-anchor="middle" font-size="11" fill="#6b675e">② 桶号 ≥ rehashidx？</text>
<text class="ts" x="270" y="92" text-anchor="middle" font-size="11" fill="#6b675e">没搬空才扫这条链</text>
<line class="fl" x1="350" y1="80" x2="376" y2="80" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red3As4)"/>
<rect class="bx" x="380" y="52" width="150" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="455" y="74" text-anchor="middle" font-size="11" fill="#6b675e">③ 没找到：</text>
<text class="ts" x="455" y="92" text-anchor="middle" font-size="11" fill="#6b675e">换 &amp; (新size−1) 扫新表</text>
<line class="fl" x1="530" y1="80" x2="556" y2="80" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red3As4)"/>
<rect class="bx-sick" x="560" y="52" width="86" height="56" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="603" y="74" text-anchor="middle" font-size="11" fill="#6b675e">④ 都没有：</text>
<text class="tc" x="603" y="92" text-anchor="middle" font-size="11" fill="#b03a2e">键不存在</text>
<text class="ts" x="20" y="142" font-size="12" fill="#6b675e">桶号 &lt; rehashidx 的旧表桶已经搬空，直接跳过</text>
<text class="ts" x="20" y="164" font-size="12" fill="#6b675e">双表并存的全部固定成本：两次掩码，最多两条短链</text>
</svg>
</figure>

要点在第 2 步：桶号小于 rehashidx 的旧表桶已经搬空，直接跳过。于是每次查找最多扫两张表各一条链。没有遍历，没有全表锁，最坏情形也只是「两条短链」。

## SCAN 为什么不漏键：倒序递增的游标

`SCAN` 是增量遍历，每次只返回一部分键和下一个游标。单表时它按桶序扫，看似自然。双表并存时它凭什么保证把键都还给你？旧表的桶会消失，新表的桶会随时新增。

答案是那个著名的**倒序二进制递增游标**。实验里 `COUNT 1` 逐桶扫一张 8 桶表，游标序列是：

```text
0 → 6 → 1 → 3 → 7 → 0（结束）
```

写成二进制：

```text
000 → 110 → 001 → 011 → 111 → 溢出归零
```

这不是从小到大加一，而是把游标反转后加一再反转。效果是**从低位向高位逐位扩张遍历**：先扫完所有第 0 位组合的桶，再扫第 1 位，再扫第 2 位。

为什么偏偏是倒序？因为扩容翻倍后，旧表一个桶的键只会散到新表「桶号最高位多一个 1」的两个桶里去。从低位向高位遍历，恰好保证：**某个桶被搬走以后，它在新表的归宿桶会在这个游标路径的「未走部分」里被再次访问。** 正序遍历则没有这个性质：先扫过的桶分裂出的新桶可能落在已走过的区域，键就漏了。

访问顺序与分裂去向：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 284" role="img" aria-label="倒序游标与桶分裂：8 桶表按 COUNT 1 扫描，游标依次返回 0、6、1、3、7 再归零结束；8 桶翻倍成 16 桶时，旧表 3 号桶 011 的键只会散到新表 3 号桶 0011 和 11 号桶 1011，区别只在最高位，归宿桶永远落在倒序路径未走的部分" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red3As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">8 桶表、COUNT 1：圈码是游标返回的顺序</text>
<rect class="bx-q" x="30" y="40" width="68" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="64" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 0</text>
<text class="ts" x="64" y="84" text-anchor="middle" font-size="10" fill="#6b675e">000</text>
<text class="tc" x="88" y="54" text-anchor="middle" font-size="11" fill="#b03a2e">①</text>
<rect class="bx" x="108" y="40" width="68" height="56" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="142" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 1</text>
<text class="ts" x="142" y="84" text-anchor="middle" font-size="10" fill="#6b675e">001</text>
<text class="tc" x="166" y="54" text-anchor="middle" font-size="11" fill="#b03a2e">③</text>
<rect class="bx" x="186" y="40" width="68" height="56" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="220" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 2</text>
<text class="ts" x="220" y="84" text-anchor="middle" font-size="10" fill="#6b675e">010</text>
<rect class="bx" x="264" y="40" width="68" height="56" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="298" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 3</text>
<text class="ts" x="298" y="84" text-anchor="middle" font-size="10" fill="#6b675e">011</text>
<text class="tc" x="322" y="54" text-anchor="middle" font-size="11" fill="#b03a2e">④</text>
<rect class="bx" x="342" y="40" width="68" height="56" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="376" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 4</text>
<text class="ts" x="376" y="84" text-anchor="middle" font-size="10" fill="#6b675e">100</text>
<rect class="bx" x="420" y="40" width="68" height="56" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="454" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 5</text>
<text class="ts" x="454" y="84" text-anchor="middle" font-size="10" fill="#6b675e">101</text>
<rect class="bx-q" x="498" y="40" width="68" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="532" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 6</text>
<text class="ts" x="532" y="84" text-anchor="middle" font-size="10" fill="#6b675e">110</text>
<text class="tc" x="556" y="54" text-anchor="middle" font-size="11" fill="#b03a2e">②</text>
<rect class="bx-q" x="576" y="40" width="68" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="610" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">桶 7</text>
<text class="ts" x="610" y="84" text-anchor="middle" font-size="10" fill="#6b675e">111</text>
<text class="tc" x="634" y="54" text-anchor="middle" font-size="11" fill="#b03a2e">⑤</text>
<text class="ts" x="20" y="122" font-size="12" fill="#6b675e">游标 0 → 6 → 1 → 3 → 7 → 0（结束）：反转、加一、再反转，从低位向高位逐位扩张</text>
<text class="ts" x="20" y="144" font-size="12" fill="#6b675e">没带圈码的桶也在路径上：一次调用可以连扫几桶，游标是断点书签</text>
<text class="ts" x="20" y="180" font-size="12" fill="#6b675e">8 桶翻倍成 16 桶时，3 号桶（011）的键只有两个去向：</text>
<rect class="bx" x="60" y="196" width="140" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="130" y="220" text-anchor="middle" font-size="12" fill="#6b675e">旧表桶 3 · 011</text>
<line class="fl" x1="200" y1="208" x2="286" y2="196" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red3As5)"/>
<line class="fl" x1="200" y1="224" x2="286" y2="240" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red3As5)"/>
<rect class="bx-q" x="290" y="178" width="150" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="365" y="200" text-anchor="middle" font-size="12" fill="#6b675e">新表桶 3 · 0011</text>
<rect class="bx-q" x="290" y="224" width="150" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="365" y="246" text-anchor="middle" font-size="12" fill="#6b675e">新表桶 11 · 1011</text>
<text class="tc" x="460" y="200" font-size="12" fill="#b03a2e">区别只在最高位长出一个 1</text>
<text class="ts" x="460" y="222" font-size="12" fill="#6b675e">分裂去向由完整哈希值的</text>
<text class="ts" x="460" y="240" font-size="12" fill="#6b675e">下一位决定，哈希不重算</text>
<text class="ts" x="20" y="276" font-size="12" fill="#6b675e">倒序路径保证：桶被搬走后，它的归宿桶一定还在「未走的部分」里等着被扫到</text>
</svg>
</figure>

双表并存的 SCAN 具体这样走：游标先在**小表**（扩容时是旧表）定位一个桶，扫完它，还要连带扫**大表**中与它对应的那些桶（桶号高位相符的一组）；然后游标按倒序规则前进。上面的 SCAN 实验发生在迁移进行中的状态，最终 `total keys seen: 9`，与 `DBSIZE` 精确相等，不多、不少、不重。

冻结现场上的百万键规模复测：`SCAN --count 5000` 全量遍历，返回 1,108,576 个键，与 `DBSIZE` 完全一致。搬家过半的字典上，客户端看到的仍然是一份完整的键名单。

不过 SCAN 的承诺是「遍历开始到结束期间一直存在的键不漏不重」，正在被搬动的桶可能在两表各扫到一次或恰好在切点漏掉一瞬，所以去重仍由客户端负责；`KEYS m:*` 的实测也确认两表都会被检查。它解决的是「不漏长期存在的键」，不是「精确到瞬间的集合快照」。

## 缩容：反方向的搬家

键被删掉，表也要跟着缩小，否则空桶占内存。缩容阈值是对称的：**元素少于桶数的 1/8（`HASHTABLE_MIN_FILL` 为 8），就缩到不小于元素数的最小 2 的幂。** 与扩容一样由插入删除路径的 `dictShrinkIfNeeded()` 和 cron 的轮询共同检查。

实验接着上面继续：冻结状态下批量删除 85 万个键。删除进行到大约第 80 万个时，负载跌破 1/8，缩容启动，又一套双表并存出现，只是这次方向反了：

```text
[Dictionary HT]
Hash table 0 stats (main hash table):
 table size: 2097152
 number of elements: 255942
Hash table 1 stats (rehashing target):
 table size: 262144
 number of elements: 2635
```

旧表 209 万桶，新表只有 26 万桶（缩为 1/8）。最终排空后 258,577 个键住进 262,144 桶，负载 98.6%：缩容不留余量，立即又站在扩容阈值的边缘。

这里有个工程上值得留意的推论：**负载在 1/8 阈值附近震荡的模式，会反复触发缩容与扩容。** 每次 resize 都要分配新桶数组、迁移全部条目，虽然渐进式把成本摊薄了，但两张表并存的窗口里 SCAN 要扫更多桶、`dictShrink` 也会碰内存分配器。键数在阈值附近周期性波动的场景（比如每天批量导入再清空的作业），实际会不断搬家。这类场景可以在低峰期观察 `DEBUG HTSTATS` 的表尺寸是否反复跳动。

还有一个细节：缩容时两张表里**新表是小的那张**，SCAN 的「小表定位、大表连扫」逻辑通过比较尺寸自动适应方向，不关心谁新谁旧。

## fork 期间：搬家全面暂停

到这里，迁移的两条腿都介绍完了。但还有第三种状态，也是上一篇 fork 篇埋下的伏笔：**子进程存活期间，两条腿同时停下。**

上一篇讲过，RDB 保存、AOF 重写都靠 fork 子进程完成，子进程看到的是 fork 那一刻的数据快照；父进程的写操作会触发写时复制，被碰过的页都要复制一份。而 rehash 恰恰是成片改写内存的元凶：搬一次桶，旧表桶指针、新表桶指针、条目链全都要写。搬家期间 fork，COW 成本会大幅上升。

所以 Redis 的对策是分三档（`updateDictResizePolicy()`）：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="updateDictResizePolicy 三档：无子进程时 ENABLE 正常扩缩容；有子进程存活时 AVOID 避免扩缩容，扩容放宽到 4 倍负载、缩容放宽到 1/32 才强制；当前进程是子进程时 FORBID 禁止一切。实验对照：无子进程时十万次 GET 搬走约 186071 键，BGSAVE 子进程存活期间同样十万次 GET 搬走 0 键" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">搬家策略三档：看有没有子进程在场</text>
<rect class="bx-q" x="20" y="40" width="195" height="72" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="117" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">ENABLE</text>
<text class="ts" x="117" y="82" text-anchor="middle" font-size="10" fill="#6b675e">无子进程</text>
<text class="ts" x="117" y="100" text-anchor="middle" font-size="10" fill="#6b675e">正常扩缩容、正常搬家</text>
<rect class="bx-sick" x="232" y="40" width="195" height="72" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="329" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">AVOID</text>
<text class="ts" x="329" y="82" text-anchor="middle" font-size="10" fill="#6b675e">有子进程存活</text>
<text class="ts" x="329" y="100" text-anchor="middle" font-size="10" fill="#6b675e">扩容放宽到 4 倍负载才强制</text>
<rect class="bar" x="444" y="40" width="195" height="72" rx="4" fill="#2b2a26"/>
<text class="onbar" x="541" y="62" text-anchor="middle" font-size="12" fill="#f6f3ec">FORBID</text>
<text class="onbar" x="541" y="82" text-anchor="middle" font-size="10" fill="#f6f3ec">当前进程就是子进程</text>
<text class="onbar" x="541" y="100" text-anchor="middle" font-size="10" fill="#f6f3ec">禁止一切</text>
<text class="ts" x="20" y="142" font-size="12" fill="#6b675e">AVOID 档的实验对照（冻结现场，各十万次随机 GET）：</text>
<text class="ts" x="20" y="168" font-size="11" fill="#6b675e">无子进程</text>
<rect class="bar" x="110" y="156" width="334" height="16" fill="#2b2a26"/>
<text class="onbar" x="277" y="168" text-anchor="middle" font-size="10" fill="#f6f3ec">搬走约 186,071 键</text>
<text class="ts" x="20" y="196" font-size="11" fill="#6b675e">BGSAVE 子进程存活</text>
<rect class="bx-gone" x="110" y="184" width="334" height="16" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="tc" x="120" y="196" font-size="10" fill="#b03a2e">搬走 0 键：连读驱动的顺手搬家都停了</text>
<text class="ts" x="20" y="228" font-size="12" fill="#6b675e">activerehashing 开关只管 serverCron 那条腿；三档策略管住的是两条腿</text>
</svg>
</figure>

AVOID 档不是硬禁止：扩容被放宽到 4 倍负载才强制执行，缩容被放宽到 1/32 才强制，最坏情况下哈希性能的退化也被限制了。

但 AVOID 挡的是「开启新迁移」吗？实验给出了更强的答案。冻结的迁移现场上，先跑一批 10 万次 GET 作对照，再启动 `BGSAVE`、在子进程存活期间跑同样一批：

```text
                     旧表剩余      新表已有      本批搬走
无子进程（对照）      858,896      435,756      约 186,071
BGSAVE 子进程存活    858,896      435,756      0
子进程退出后          672,821      435,756      约 170,701
```

子进程存活期间，十万次 GET 没有搬动**任何一个键**，连读驱动的顺手搬家都停了。`dictRehash()` 开头就检查 `dict_can_resize`，AVOID 档下未达强制阈值直接返回 0，一步都不搬。

这个结果的另一面值得强调：迁移的中途 fork 是被允许的，两张表并存的状态会原样进入 RDB 快照的视角。暂停的只是推进，不是维持。子进程一退出，读写又把搬家带着走。

## 每个键的哈希值，只算一次

还有一个实现细节很容易被忽略：这么频繁的搬家，每次都要对键重新做哈希吗？

条目结构里存着初次插入时算好的完整哈希值。搬家到新表时只是重新取掩码（`hash & (新 size - 1)`）定位新桶，哈希函数不重跑。缩容甚至更简单：从大表搬到小表，桶号直接截断高位即可，源码注释里专门写了这一点。

扩容后一个桶分裂成两个，区分两个新桶靠的正是完整哈希值的下一位。这也是倒序游标能工作的底层前提：键在扩容后的去向，由哈希值高位决定，而倒序遍历恰好按高位逐层访问。

## 在自己的实例上核对

想在自己的实例上核对本文的说法，可用的观测点：

- `DEBUG HTSTATS <db>`：两张表的尺寸、元素数（需要显式开启 debug 命令）；
- `INFO persistence` 的 `loading` 与 `ht_size` 类字段：不开 debug 命令时的替代观测；
- `LATENCY HISTORY` 与慢日志：迁移本身不该出现在这里，出现了说明有别的问题（比如后文阈值震荡）；
- `CONFIG SET activerehashing no`：只在隔离实验里冻住现场用，生产环境不要关。关了以后 cron 那条腿就没了，冷键的桶只能等读写。

边界也要说清。渐进式 rehash 摊薄的是**主线程的单次停顿**，不减少总工作量：百万条目照样要逐桶搬完，只是不挤在一瞬间。双表并存期间，每次操作最多查两条链、SCAN 每游标要兼顾两表，日常命令里有少量固定开销。fork 期间迁移暂停，若子进程寿命很长（大数据集慢磁盘），两张表可能并存很久，这段时间 SCAN 的成本最高。

成本仍然在，渐进式换来的是成本不再有尖峰。

## 渐进式的规则

扩容在负载因子 1 时触发，翻倍分配：1,048,576 桶撑到第 1,048,577 个键，就启动向 2,097,152 桶的迁移；触发瞬间只分配不搬运，两张表立刻并存。搬家以桶为单位，读写顺手执行：一次 GET 或 SET 最多搬一个非空桶，桶里串着的键一次带走，十万次随机 GET 搬走约 17–19 万键，且新键只进新表。serverCron 提供每秒 10 毫秒的兜底预算：没有流量的冷表靠 cron 排空，速度约每秒 1.7 万条，`activerehashing` 是这个开关，默认开。SCAN 靠倒序二进制游标保证不漏：0→6→1→3→7 的顺序从低位向高位扩张，扩容分裂出的新桶永远落在未走的路径上，百万键双表状态下全量 SCAN 与 DBSIZE 精确一致。缩容在负载 1/8 时触发，缩到阈值边缘：209 万桶删到只剩 25 万键时缩回 26 万桶，负载立即回到 98.6%，阈值附近的震荡会反复触发搬家，是容量规划时值得避开的状态。fork 子进程期间，迁移全面暂停：AVOID 策略不仅冻结新 resize，连读驱动的搬运都停，十万次 GET 搬动 0 键。这是给写时复制的让路，成片改写内存的搬家，正是 COW 最怕的访存模式。

从第一个键跨过阈值到最后一个桶搬空，没有任何一个瞬间值得写进慢日志。所谓渐进式，并没有把搬家变快：一百万个键仍然要一百万次挪动。它做到的是把「一次让所有人等待的大迁移」，换成「一万次谁也没察觉的顺手搬运」。

---

本文是 Redis 系列的第八篇。上一篇《快照在后台，停顿发生在前台》讲 fork 与写时复制，本文的「子进程暂停搬家」正是它留下的那条线索；事件循环与 serverCron 的调度背景见《一个命令没走完，所有人都在门外》。
