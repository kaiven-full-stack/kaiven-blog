---
title: 优化器在替你决定什么：代价、估计与口径
description: MySQL 系列第五篇。同一条 COUNT(*)，扫 PRIMARY 是 3,831 次页读、扫优化器亲自选定的 idx_name 却要 112,813 次，差 29 倍，10 万行小表复现同样 11 倍。优化器糊涂了吗？翻开 cost 数字才发现：两个索引的报价一模一样（34,965.25 = 99,900 行 × (0.25+0.1)，按行计价），tie-break 选瘦索引，而在「磁盘页」口径下瘦索引确实赢；29 倍差在「页访问次数」口径，那不在 cost 里。本文用 optimizer trace 逐步拆决策链：全表扫报价 100,463 vs 索引范围 72,782.8、估 207,950 行实际 100,000（2 倍估计误差）；ICP 开关一挡差 374 倍页读；直方图把 filtered 从拍脑袋的 10% 修成 95.58%/0.10%；回表 JOIN 1,627 页读但 MRR 开关毫无差别，内存表上它优化的是不存在的磁盘随机。四篇地基（页、undo、锁、redo）打完，这一篇看 SQL 到达后的 0.3 毫秒里发生了什么。
pubDate: 2026-09-13
category: mysql
tags: [MySQL, 数据库, 优化器]
---

一条 `SELECT COUNT(*) FROM users` 到达，0.3 毫秒后优化器已经替你拍板：走 idx_name。实测：PRIMARY 全树 3,831 次页读，idx_name 112,813 次，差 29 倍。它选了贵的。

前四篇拆的是 InnoDB 的「物理世界」：页与树（第一篇）、undo 与版本（第二篇）、锁（第三篇）、日志与恢复（第四篇）。这一篇换视角：**SQL 到达之后、字节被碰之前，中间那 0.3 毫秒里，优化器在替你决定什么？** 决定的是「访问路径」：这 100 万行数据，从哪棵树进、走多深、要不要回表、过滤条件在哪一层生效。这些决定每一项都对应真实的页访问数，而上面那组 29 倍的数字说明：**替你决定的那位，用的数字口径和你观察的不是同一个。**

环境不变：MySQL 8.4.11，百万行 users 表（PRIMARY + idx_name + idx_name_city 复合索引），量具以 buffer pool 页读请求（`Innodb_buffer_pool_read_requests` 的前后差值）、Handler 计数器、EXPLAIN / EXPLAIN ANALYZE / `OPTIMIZER_TRACE` 为主。量具本身的口径问题，恰恰是本篇后半的主角。

## 三条走法的页读数

先校准基线。四条查询，只变访问方式（同会话前后差值，页读请求口径）：

| 查询 | 走法 | 页读请求 | Handler 计数 |
| --- | --- | --- | --- |
| `WHERE id=500000` | 主键点查 | **3** | read_key=3 |
| `COUNT(name) WHERE name LIKE 'user00001%'` | 覆盖扫 idx_name（10 万行） | **233** | read_next=100,000 |
| `COUNT(age)` 同 WHERE | 索引扫 + 回表 | **400,188** | read_next=100,000 |
| `COUNT(*) FORCE INDEX(PRIMARY)` | 主键全树扫（百万行） | **3,831** | read_next=1,000,000 |

四个数字都是结构的结果：点查 3 页 = 树高 3（第一篇）；覆盖 233 ≈ 1695 个 idx_name 叶页的十分之一 + 树定位；回表 400,188 ≈ 10 万次「回主键树走三页 + 叶子本身」，**首篇的 400,189 在新会话里复现为 400,188，只差 1**；主键全树 3,831 ≈ 3437 叶 + 内部页 + 树根重复触碰。

四条走法的页读，一根对数标尺：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="四条查询的页读请求对数条形图：主键点查 3 次，覆盖扫描 idx_name 233 次，主键全树扫 3831 次，索引扫加回表 400188 次；每个数字都能从树的结构推出来" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">页读请求（Innodb_buffer_pool_read_requests 差值，条长对数刻度）</text>
<text class="ts" x="90" y="52" font-size="11" fill="#6b675e">主键点查 WHERE id=500000：树高 3，一步到底</text>
<rect class="bar" x="90" y="58" width="48" height="16" fill="#2b2a26"/>
<text class="tc" x="146" y="71" font-size="11" fill="#b03a2e">3</text>
<text class="ts" x="90" y="92" font-size="11" fill="#6b675e">覆盖扫 idx_name · 10 万行：瘦树的一段</text>
<rect class="bar" x="90" y="98" width="237" height="16" fill="#2b2a26"/>
<text class="tc" x="335" y="111" font-size="11" fill="#b03a2e">233</text>
<text class="ts" x="90" y="132" font-size="11" fill="#6b675e">主键全树扫 · 百万行：3437 叶 + 内部页</text>
<rect class="bar" x="90" y="138" width="360" height="16" fill="#2b2a26"/>
<text class="tc" x="458" y="151" font-size="11" fill="#b03a2e">3,831</text>
<text class="ts" x="90" y="172" font-size="11" fill="#6b675e">索引扫 + 回表 COUNT(age)：每行 ×4 页</text>
<rect class="bar" x="90" y="178" width="562" height="16" fill="#b03a2e"/>
<text class="onbar" x="100" y="190" font-size="10" fill="#f6f3ec">400,188</text>
</svg>
</figure>

这组数字本身就是排序依据：优化器的工作，就是在每条 SQL 开始前**预估**这张表的每一行，然后挑便宜的。问题在于，它的预估和实测，用的是不同单位。

## 29 倍的差别：优化器选了「贵」的

不 FORCE 任何索引时，`SELECT COUNT(*) FROM users` 优化器自己选 idx_name（EXPLAIN：`type=index, key=idx_name, Using index`）。但实测：

```text
扫 PRIMARY：  3,831 次页读
扫 idx_name：112,813 次页读     ← 优化器选的，贵 29 倍
```

不是缓存噪音：10 万行的 t_idx 小表复现，PRIMARY 1,010 vs idx_name 11,262（11 倍），且两表的「每多少条记录一次页触碰」完全一致：**idx_name 约 8.9 条一次，PRIMARY 约 99 条一次**。8.9 这个数字有出处：InnoDB 的行缓存以 8 条为一批（`row0mysql.h` 的 `MYSQL_FETCH_CACHE_SIZE`，`row0sel.cc` 每批缓存用完要重新定位页、重新拿 latch，页访问计数就在这里跳）。二级索引扫描走的正是这条「小批缓存」路径，主键扫描的批量更粗。**同一棵 16KiB 页的树，访问粒度不同，页读请求数就差一个数量级。**

优化器糊涂了吗？翻开它的报价单（EXPLAIN FORMAT=JSON，两个 FORCE 各跑一遍）：

```text
FORCE INDEX(PRIMARY)：   query_cost = 34965.25
FORCE INDEX(idx_name)：  query_cost = 34965.25     ← 一模一样
```

拆开看这 34,965.25 怎么来的：`99,900 行 × (0.25 + 0.1)`，**每行 0.25 的读代价（memory_block_read_cost）+ 每行 0.1 的 CPU 评估（evaluate_cost）**。cost 模型按「行数」计价，页数与访问次数都不在算式里。两个索引扫同样的 99,900 行，报价自然相同；报价打平后 tie-break 选**瘦**的：idx_name 的磁盘页只有 PRIMARY 的 0.42 倍（145 vs 333 叶页）。

再看那 29 倍去了哪：**不在报价单上**。cost 单位是「行」，29 倍差的是「页访问次数」（latch/固定开销），而优化器对此根本不记。更妙的是换到「磁盘页」口径：真发生磁盘 IO 时 idx_name 要摸的不同页更少（26MiB vs 54MiB），**瘦索引真的更好**。所以这不是失误，是口径：

- **磁盘页口径**（cost 的隐含假设）：瘦索引赢，优化器对；
- **页访问次数口径**（latch 开销，缓存全热时你要付的）：PRIMARY 赢 29 倍；
- **行数口径**（报价单本身）：平局。

一个 Tie，三种说法。**「优化器选错了」几乎总是「你俩没在对口径」**。

三种口径，三张记分牌：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 246" role="img" aria-label="同一次 COUNT 的三种口径：行数口径两个索引报价都是 34965.25 打平；磁盘页口径 idx_name 只摸 26MiB 对 PRIMARY 的 54MiB，瘦索引赢；页访问次数口径 PRIMARY 3831 对 idx_name 112813，差 29 倍，这笔 latch 与小批缓存的开销不在报价单上" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一条 COUNT(*)：三种口径，三个赢家</text>
<text class="t" x="20" y="52" font-size="12" fill="#2b2a26">行数口径（报价单）</text>
<rect class="bx" x="200" y="40" width="180" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="290" y="54" text-anchor="middle" font-size="10" fill="#6b675e">PRIMARY 34,965.25</text>
<rect class="bx" x="390" y="40" width="180" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="480" y="54" text-anchor="middle" font-size="10" fill="#6b675e">idx_name 34,965.25</text>
<text class="tc" x="586" y="54" font-size="11" fill="#b03a2e">平局</text>
<text class="t" x="20" y="102" font-size="12" fill="#2b2a26">磁盘页口径</text>
<rect class="bar" x="200" y="90" width="200" height="20" fill="#2b2a26"/>
<text class="onbar" x="208" y="104" font-size="10" fill="#f6f3ec">PRIMARY 54MiB</text>
<rect class="bar" x="200" y="114" width="96" height="20" fill="#6b675e"/>
<text class="ts" x="304" y="128" font-size="10" fill="#6b675e">idx_name 26MiB</text>
<text class="tc" x="586" y="108" font-size="11" fill="#b03a2e">瘦索引赢</text>
<text class="t" x="20" y="168" font-size="12" fill="#2b2a26">页访问次数口径</text>
<rect class="bar" x="200" y="156" width="15" height="20" fill="#2b2a26"/>
<text class="ts" x="222" y="170" font-size="10" fill="#6b675e">PRIMARY 3,831</text>
<rect class="bar" x="200" y="180" width="440" height="20" fill="#b03a2e"/>
<text class="onbar" x="208" y="194" font-size="10" fill="#f6f3ec">idx_name 112,813（8.9 行一次页触碰：行缓存 8 条一批）</text>
<text class="tc" x="586" y="176" font-size="11" fill="#b03a2e">差 29 倍</text>
<text class="ts" x="20" y="224" font-size="12" fill="#6b675e">cost 只按行计价：99,900 × (0.25 + 0.1)，页数与 latch 开销不在算式里</text>
<text class="ts" x="20" y="242" font-size="12" fill="#6b675e">tie-break 选瘦索引，在磁盘页口径下它确实更好</text>
</svg>
</figure>

## 0.3 毫秒的决策链：trace 逐步看

`OPTIMIZER_TRACE` 把那 0.3 毫秒拍成慢镜头。以 `WHERE name LIKE 'user00001%'` 的 COUNT 为例，五个关键步骤：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 304" role="img" aria-label="OPTIMIZER_TRACE 的五步决策链：改写、依赖分析、rows_estimation 成本预估（全表扫报价 100463 对索引范围 72782.8，选后者）、执行计划加上回表细节变成 93577.8、refine_plan 把过滤条件下推；cost 是一层层加上去的" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my5As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">0.3 毫秒拍成慢镜头：WHERE name LIKE 'user00001%' 的决策链</text>
<rect class="bx" x="40" y="40" width="270" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="175" y="60" text-anchor="middle" font-size="11" fill="#6b675e">① 改写：常量传播、条件化简</text>
<line class="fl" x1="175" y1="72" x2="175" y2="82" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As3)"/>
<rect class="bx" x="40" y="86" width="270" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="175" y="106" text-anchor="middle" font-size="11" fill="#6b675e">② 依赖分析：单表，map 1 位</text>
<line class="fl" x1="175" y1="118" x2="175" y2="128" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As3)"/>
<rect class="bx-sick" x="40" y="132" width="270" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="175" y="149" text-anchor="middle" font-size="11" fill="#b03a2e">③ rows_estimation</text>
<text class="ts" x="175" y="165" text-anchor="middle" font-size="10" fill="#6b675e">给每种访问方式报价</text>
<line class="fl" x1="310" y1="144" x2="356" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As3)"/>
<line class="fl" x1="310" y1="160" x2="356" y2="170" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As3)"/>
<rect class="bx" x="360" y="116" width="270" height="30" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="495" y="135" text-anchor="middle" font-size="10" fill="#6b675e">table_scan：rows 995,870 · cost 100,463</text>
<rect class="bx-q" x="360" y="154" width="270" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="495" y="173" text-anchor="middle" font-size="10" fill="#b03a2e">idx_name range：rows 207,950 · cost 72,782.8 ← 中选</text>
<line class="fl" x1="175" y1="172" x2="175" y2="188" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As3)"/>
<rect class="bx" x="40" y="192" width="270" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="175" y="209" text-anchor="middle" font-size="11" fill="#6b675e">④ 执行计划：range on idx_name</text>
<text class="ts" x="175" y="225" text-anchor="middle" font-size="10" fill="#6b675e">cost 涨到 93,577.8：叠上回表细节</text>
<line class="fl" x1="175" y1="232" x2="175" y2="244" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As3)"/>
<rect class="bx" x="40" y="248" width="270" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="175" y="269" text-anchor="middle" font-size="11" fill="#6b675e">⑤ refine_plan：条件下推（ICP）</text>
<text class="ts" x="360" y="212" font-size="11" fill="#6b675e">估 207,950、实 100,000：dive 对 LIKE</text>
<text class="ts" x="360" y="230" font-size="11" fill="#6b675e">前缀区间有系统性偏差（约 2 倍）</text>
<text class="ts" x="360" y="256" font-size="11" fill="#6b675e">EXPLAIN 首行的 114,373 还要再叠</text>
<text class="ts" x="360" y="274" font-size="11" fill="#6b675e">Aggregate 节点：cost 是逐层加出来的</text>
<text class="ts" x="20" y="298" font-size="12" fill="#6b675e">读 trace 的姿势：别只看最终数字，看加法过程</text>
</svg>
</figure>

第③步就是成本预估：全表扫报价 100,463，索引范围扫报价 72,783，选后者。两个数字都需要解释。

**rows 207,950 是怎么来的？** 索引上的范围估计（index dive）：优化器拿 `'user00001' <= name <= 'user00001\xff...'` 这个区间去 idx_name 上做几次二分定位，从 B+ 树的页层级推算区间行数。而实测（EXPLAIN ANALYZE）：

```text
Index range scan ... (cost=93578 rows=207950) (actual rows=100000)
```

**估 207,950，实 100,000，2 倍高估**。dive 的推算对 LIKE 前缀区间有系统性偏差（9 位自由数字被当成略非均匀）。2 倍误差在这个查询里无害（方向是保守），但同样机制的误差在别处可以翻车，比如让优化器在「索引 vs 全表」的临界点上改判，这正是下一节直方图要救的病。**优化器的一切决策都建立在估计上，而估计是采样，不是数数。**

**cost 72,782.8 与④的 93,577.8 差在哪？** ③是纯读代价（行 × 0.25 + 页假设），④加上回表的执行细节（本查询 COUNT(age) 要回表，每行回主键树）。数字越算越细，最后 EXPLAIN 首行的 114,373 还要再叠 Aggregate 节点。**trace 里能看到 cost 是怎么一层层加上去的，这是读 trace 的正确姿势：别只看最终数字，看加法过程。**

## 过滤的层次：ICP 的 374 倍

WHERE 条件在哪一层生效，价差可以到百倍。复合索引 idx_name_city(name, city)，查询 `name LIKE 'user00001%' AND city='city5'`：范围在 name 上定（20 万行），city 的判断在哪做？

- **不开 ICP**：20 万条索引条目全部回表，server 层再判 city，**回表 20 万次，页面读了 400,256 次**；
- **开 ICP（默认）**：city 就在索引条目里，存储引擎在回表**之前**判断，只把通过的 200 条带回，**1,071 次页读**。

```text
EXPLAIN: Extra = Using index condition     ← ICP 的标志
ICP ON:  1,071 页读
ICP OFF: 400,256 页读      ← 374 倍
```

**索引下推的本质：把「过滤条件」从 server 层下推到存储引擎层，在索引条目上就地判断**。第二篇讲过回表是「每行重走一遍聚簇树」，ICP 就是让大多数行在重走之前就死在索引上。生效条件也就清楚了：条件里的列必须在索引里（本例 city 是复合索引第二列）、且走的是要回表的索引访问。若索引已覆盖（要的列都在索引里），根本没有回表可省，ICP 无用武之地，EXPLAIN 也不显示它。

同一家族还有两个常被混谈的开关，顺手用实验划清边界。**MRR（多范围读）**：回表按索引顺序逐行进行，主键散乱时磁盘上是随机 IO；MRR 把主键攒起来排序后批量回。但实测回表 JOIN 场景 MRR on/off 页读没有差别（1,627 vs 1,622）：测试表全在内存，**MRR 优化的是磁盘随机 IO 的时间，不是页访问的次数**，量具（页读数）天生看不见它。**BKA（批量键访问）**默认关闭（`batched_key_access=off`），需要 JOIN BUFFER 攒外表的键再批量探内表；本实验的 PK 等值 JOIN 每次 lookup 只要 3 页（树高），攒批反而多此一举。优化各自有生效条件，把开关一律打开不是工程做法。ICP 的 374 倍和 MRR 的 0 倍，是这句话的一体两面。

ICP 把过滤挪到了哪一层：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 248" role="img" aria-label="ICP 前后对照：不开 ICP 时 20 万条索引条目全部回表，city 条件在 server 层才判断，页读 400256 次；开 ICP 后 city 就在索引条目上就地判断，只有通过的 200 条回表，页读 1071 次，差 374 倍" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my5As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">name LIKE 'user00001%' AND city='city5'：city 在哪一层判</text>
<text class="ts" x="20" y="48" font-size="11" fill="#6b675e">不开 ICP</text>
<rect class="bx" x="20" y="56" width="170" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="105" y="72" text-anchor="middle" font-size="10" fill="#6b675e">索引范围扫</text>
<text class="ts" x="105" y="88" text-anchor="middle" font-size="10" fill="#6b675e">20 万条条目</text>
<line class="fl" x1="190" y1="76" x2="236" y2="76" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As4)"/>
<text class="ts" x="213" y="66" text-anchor="middle" font-size="9" fill="#6b675e">条条回表</text>
<rect class="bx" x="240" y="56" width="180" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="72" text-anchor="middle" font-size="10" fill="#6b675e">server 层才判 city</text>
<text class="ts" x="330" y="88" text-anchor="middle" font-size="10" fill="#6b675e">19.98 万行白回</text>
<line class="fl" x1="420" y1="76" x2="466" y2="76" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As4)"/>
<rect class="bx-q" x="470" y="56" width="110" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="525" y="80" text-anchor="middle" font-size="10" fill="#6b675e">剩 200 行</text>
<rect class="bar" x="20" y="104" width="440" height="14" fill="#b03a2e"/>
<text class="tc" x="468" y="115" font-size="10" fill="#b03a2e">400,256 页读</text>
<text class="ts" x="20" y="146" font-size="11" fill="#6b675e">开 ICP（默认）</text>
<rect class="bx" x="20" y="154" width="170" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="105" y="170" text-anchor="middle" font-size="10" fill="#6b675e">索引范围扫</text>
<text class="ts" x="105" y="186" text-anchor="middle" font-size="10" fill="#6b675e">20 万条条目</text>
<line class="fl" x1="190" y1="174" x2="236" y2="174" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As4)"/>
<rect class="bx-sick" x="240" y="154" width="180" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="330" y="170" text-anchor="middle" font-size="10" fill="#b03a2e">ICP：条目上就地判 city</text>
<text class="ts" x="330" y="186" text-anchor="middle" font-size="10" fill="#6b675e">city 就在复合索引里</text>
<line class="fl" x1="420" y1="174" x2="466" y2="174" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my5As4)"/>
<text class="ts" x="443" y="164" text-anchor="middle" font-size="9" fill="#6b675e">200 条回表</text>
<rect class="bx-q" x="470" y="154" width="110" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="525" y="178" text-anchor="middle" font-size="10" fill="#6b675e">剩 200 行</text>
<rect class="bar" x="20" y="202" width="23" height="14" fill="#2b2a26"/>
<text class="tc" x="50" y="213" font-size="10" fill="#b03a2e">1,071 页读 · 差 374 倍（两根条按平方根刻度）</text>
<text class="ts" x="20" y="238" font-size="11" fill="#6b675e">生效条件：条件列在索引里 + 访问路径要回表；索引已覆盖时 ICP 无用武之地</text>
</svg>
</figure>

## 拍脑袋的 10%：直方图救估计

第③步的 rows 估计靠索引 dive，没有索引的列呢？默认答案令人发指：**拍一个 10%**。建一张 20 万行的偏斜表：city9 占 95%（19 万行），其余 50 个城市各 200 行，city 无索引：

```text
EXPLAIN WHERE city='city9'：  filtered = 10.00%
EXPLAIN WHERE city='city3'：  filtered = 10.00%     ← 一视同仁的 10%
```

95% 的行和 0.1% 的行，在优化器眼里都是 10%。这是「没有信息时的默认假设」：均匀。对偏斜数据，这个假设能把计划带沟里（该走索引的估成 90% 筛除率、放弃索引；或反之）。

建直方图后再看（`ANALYZE TABLE ... UPDATE HISTOGRAM ON city WITH 100 BUCKETS`）：

```text
WHERE city='city9'：  filtered = 95.58%     ← 直方图说话
WHERE city='city3'：  filtered = 0.10%
```

**直方图是对「列的分布」的采样统计**：100 个桶把 19 万 vs 200 的悬殊记下来，等值查询落到哪个桶就用哪个桶的密度。它的适用场景因此清晰：**偏斜、无索引、当过滤条件用的列**。为偶尔的查询加索引太贵（写入放大，第一篇算过这笔成本），直方图零写入成本、手动维护。

最后一块拼图：给 city 加索引后，filtered 变成 100%、rows 直接精确到 100,053 / 200，**索引本身就是统计**（dive 现在有了落点）。三段演进值得连起来记：**无信息时拍 10%，有直方图时按桶说话，有索引时直接探树。** 估计的精度台阶，是用维护成本换的：直方图要 ANALYZE 更新，索引要每次写入都付。

精度台阶与各自的价格：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 232" role="img" aria-label="行数估计的三级台阶：无信息时任何等值条件一律拍 filtered 10%，95% 的行与 0.1% 的行同待遇；建直方图后 100 个桶记下分布，city9 报 95.58%、city3 报 0.10%，维护靠手动 ANALYZE、零写入成本；加索引后 dive 直接探树，行数精确到个位，代价是每次写入都付" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">20 万行偏斜表（city9 占 95%）：估计精度的三级台阶</text>
<rect class="bx" x="30" y="140" width="190" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="125" y="160" text-anchor="middle" font-size="12" fill="#2b2a26">① 无信息</text>
<text class="tc" x="125" y="178" text-anchor="middle" font-size="10" fill="#b03a2e">filtered 一律 10%</text>
<text class="ts" x="125" y="194" text-anchor="middle" font-size="10" fill="#6b675e">95% 与 0.1% 同待遇</text>
<rect class="bx" x="235" y="92" width="190" height="112" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="112" text-anchor="middle" font-size="12" fill="#2b2a26">② 直方图</text>
<text class="ts" x="330" y="132" text-anchor="middle" font-size="10" fill="#6b675e">100 个桶记下分布</text>
<text class="tc" x="330" y="150" text-anchor="middle" font-size="10" fill="#b03a2e">city9 → 95.58%</text>
<text class="tc" x="330" y="166" text-anchor="middle" font-size="10" fill="#b03a2e">city3 → 0.10%</text>
<text class="ts" x="330" y="186" text-anchor="middle" font-size="10" fill="#6b675e">维护：手动 ANALYZE，零写入成本</text>
<rect class="bx-q" x="440" y="44" width="190" height="160" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="535" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">③ 索引</text>
<text class="ts" x="535" y="84" text-anchor="middle" font-size="10" fill="#6b675e">dive 直接探树</text>
<text class="tc" x="535" y="102" text-anchor="middle" font-size="10" fill="#b03a2e">rows 精确到 100,053 / 200</text>
<text class="ts" x="535" y="122" text-anchor="middle" font-size="10" fill="#6b675e">索引本身就是统计</text>
<text class="ts" x="535" y="142" text-anchor="middle" font-size="10" fill="#6b675e">维护：每次写入都付</text>
<text class="ts" x="535" y="162" text-anchor="middle" font-size="10" fill="#6b675e">（写入放大，第一篇算过）</text>
<text class="ts" x="20" y="226" font-size="12" fill="#6b675e">台阶每上一级都有价格标签：估计是采样，不是数数；精度是用维护成本换的</text>
</svg>
</figure>

## 先对口径，再谈对错

走法的价差是结构性的，不是玄学：点查 3 页（树高）、覆盖 233（瘦树的一段）、回表 400,188（每行 ×4 页）、全树 3,831，每个数字都能从第一篇的结构推出来。优化器的全部工作是在执行前预估这张表，而预估的单位是行。

cost 按「行」算，不按「页」算：99,900 行 × (0.25+0.1) = 34,965.25，两个索引同价，tie-break 选瘦的。29 倍的页访问差不在报价单上，磁盘页口径下瘦索引还真的赢。「优化器选错了」几乎总是口径没对齐：先问自己量的是磁盘页、页访问次数、还是行数。

估计是采样，不是数数：index dive 估 207,950 实测 100,000（2 倍偏差）；无索引的列拍 10%；直方图把 95.58%/0.10% 分清，索引让 dive 落地成精确数。精度台阶的每一步都有价格标签。

优化各自有生效条件：ICP 要条件列在索引里且访问需回表，374 倍；MRR 优化磁盘随机，内存表上页读一动不动；BKA 要 JOIN BUFFER 且键散乱才划算。把开关全部打开不是工程做法。

量具和优化器一样有口径：Handler 看不见回表（首篇）、页读请求 ≠ 磁盘页 ≠ cost 单位（本篇）、MRR 的收益页读数天生测不到。排查慢查询的第一步永远是确认量具在量你以为的东西，这一课与第一篇的「Handler 看不到回表」正好配成一对。

单机的 InnoDB（页、undo、锁、redo、优化器）到这里讲完。下一篇讲复制：一份数据如何变成多份、主从之间的坑（延迟、半同步、GTID）从哪来。想跟着做的话，实验环境把单机换成一对主从容器就行。
