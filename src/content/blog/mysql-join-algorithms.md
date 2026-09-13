---
title: 拼桌的艺术：嵌套循环、索引与 hash join
description: MySQL 系列第九篇。同一个 join，248ms、1140ms、26.97 秒三条路，差距全在算法。本篇实测连接的三条走法：纯嵌套循环 200 次×百万行的 109 倍惨案；索引 NLJ 的 eq_ref 点查路径；hash join 的 build/probe 分工（FROM 顺序颠倒、计划一字不差）。大连接把 join_buffer_size 256KB 打爆后，Grace hash join 上场：两边输入按哈希分区溢写磁盘（专用仪器 wait/io/file/sql/hash_join 记到 1995 次文件 io），16MB 起溢写消失但耗时几乎不变，这个 join 的成本大头是十亿对配对，不是 IO。外加非等值 join 的规模阶梯（20k→200k 外推 25 分钟）与 8.4 源码里的 kMaxChunks=128、LIMIT 不溢写等机制逐条对上。
pubDate: 2026-09-22
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

同一个 join，同一批行，同一台机器：一条路 248ms，另一条 26.97 秒，差 109 倍。行数一样、结果一样，差的只是算法。

SQL 里一句 `JOIN`，执行器面前有三条路。第五篇讲优化器时给过一张单表访问的成本对照，但那张表只覆盖「一张表怎么读」；两张表**怎么拼**，是执行器的地盘，也是本篇的主题。优化器决定「谁跟谁连、按什么序」；执行器拿着计划，选择嵌套循环、索引查找还是 hash join。三者的差距，比访问方式之间的差距大得多：上面的 109 倍就是本篇第一个实验。

8.0.18 之前，这个话题没这么有意思：MySQL 只有两板斧（嵌套循环 + 索引），没索引的等值 join 一律嵌套循环硬扫，大家习惯性「join 前先建索引」。8.0.18 搬来了 hash join，8.0.20 又删掉了老 BNL（Block Nested Loop），**「等值 join 必须有索引」这条铁律在 8.x 里已经作废**。本篇照旧 docker 里的 MySQL 8.4.11 逐条实测，所有数字当场跑出来。

## 三条走法：同一个 join，109 倍

实验对象：`users`（百万行，city 无索引可用时是纯堆扫对象）join 一张 200 行的维度表 `dim2`（city、tier，**故意不建索引**），等值条件 `u.city = d.city`。

**走法一：hash join（8.4 无索引时的默认选择）。** EXPLAIN FORMAT=TREE 直接把结构画出来：

```text
-> Inner hash join (u.city = d.city)  (actual time=0.75..236 rows=400000)
    -> Covering index scan on u using idx_name_city   ← probe 侧：百万行
    -> Hash
        -> Table scan on d  (actual rows=200)          ← build 侧：200 行
```

树里挂 `-> Hash` 的那支是 **build 侧**（先读进内存建哈希表），另一支是 **probe 侧**（逐行来探测）。200 行的 dim2 进哈希表，百万行 users 逐行算哈希找桶：**每个 probe 行只花一次哈希计算**，与 build 侧多大无关。实测 **248ms**。

**走法二：索引嵌套循环（NLJ）。** 给维度表的 city 建主键（`PRIMARY KEY(city)`），同一查询立刻换走法：

```text
-> Nested loop inner join  (actual time=0.111..1127 rows=400000)
    -> Covering index scan on u using idx_name_city           ← 外层：百万行
    -> Single-row covering index lookup on d using PRIMARY    ← 内层：每行一次点查
        (city=u.city)  (actual rows=0.4 loops=1e+6)
```

外层扫 users 百万行，每行拿 city 去 dim 的主键树**点查**（树高 3，实际根常驻缓存）。`loops=1e+6` 是铁证：内层执行了一百万次。实测 **1140ms**。

**走法三：纯嵌套循环（hash join 关掉、索引也不给）。** `optimizer_switch='block_nested_loop=off,hash_join=off'`（要两个一起关，只关 hash_join 无效，这是 8.0.20 后 BNL 与 hash join 共用开关的暗坑）：

```text
-> Nested loop inner join
    -> Table scan on d                        ← 外层 200 行
    -> Filter: (u.city = d.city)
        -> Covering index scan on u ...       ← 内层：每个 d 行全量扫 users
```

实测 **26.97 秒**：200 × 100 万次行比较，这就是没有索引也没有 hash join 的旧世界。三走法同框：

| 走法 | 耗时 | 每行成本 | 倍数 |
| --- | --- | --- | --- |
| hash join（无索引） | **248 ms** | 一次哈希 | 1× |
| 索引 NLJ（dim 有主键） | 1,140 ms | 一次树点查 | 4.6× |
| 纯嵌套循环（双关） | **26.97 s** | 全表扫一遍 | **109×** |

两个反直觉值得单独说。**第一：无索引的 hash join 比有索引的 NLJ 快 4.6 倍。** 索引点查（树高 3 + latch + 页定位）比一次哈希计算贵。**当外层是大表、内层是小表时，建索引不如让优化器走 hash**；「join 键没索引 = 慢查询」在 8.x 已经是过时直觉。**第二：三者的差距与表大小不成比例放大。** NLJ 的内层成本 × 外层行数（线性），hash join 的 probe 成本恒定，纯嵌套是乘积。表再大 10 倍，hash join 仍是 2.5 秒级，纯嵌套是 45 分钟级。

109 倍摆在一根比例尺上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="三条走法耗时条形图，条长严格等比：hash join 248 毫秒只有一小段，索引嵌套循环 1140 毫秒约四倍长，纯嵌套循环 26.97 秒的条占满画面，是 hash join 的 109 倍" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一个 join、同一批行：条长严格等比（20 像素 = 1 秒）</text>
<text class="ts" x="20" y="60" font-size="11" fill="#6b675e">hash join（无索引）</text>
<rect class="bar" x="180" y="46" width="5" height="18" fill="#2b2a26"/>
<text class="tc" x="193" y="60" font-size="11" fill="#b03a2e">248ms · 每行一次哈希</text>
<text class="ts" x="20" y="96" font-size="11" fill="#6b675e">索引 NLJ（dim 有主键）</text>
<rect class="bar" x="180" y="82" width="23" height="18" fill="#2b2a26"/>
<text class="ts" x="211" y="96" font-size="11" fill="#6b675e">1140ms · 每行一次树点查（loops=1e+6）</text>
<text class="ts" x="20" y="132" font-size="11" fill="#6b675e">纯嵌套循环（双关）</text>
<rect class="bar" x="180" y="118" width="539" height="18" fill="#b03a2e"/>
<text class="onbar" x="190" y="132" font-size="10" fill="#f6f3ec">26.97s · 200 次全表扫，两亿次行比较</text>
<text class="tc" x="620" y="110" font-size="12" fill="#b03a2e">109×</text>
<text class="ts" x="20" y="164" font-size="12" fill="#6b675e">成本形状不同：hash 的 probe 恒定、NLJ 随外层线性、纯嵌套是两侧行数的乘积</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">表再大 10 倍：hash 2.5 秒级，纯嵌套 45 分钟级</text>
</svg>
</figure>

## build 与 probe：谁进哈希表

hash join 的第一个决策是**哪边做 build**。build 侧要整个装进 join buffer，装不下就溢写，所以规则很简单：**估计行数小的一侧当 build**。实测验证到计划的对称性：

```sql
SELECT ... FROM t_noindex_a a JOIN t_noindex_b b ON a.v = b.v;  -- a 30 行，b 500 行，两边都无索引
SELECT ... FROM t_noindex_b b JOIN t_noindex_a a ON a.v = b.v;  -- FROM 顺序颠倒
```

两条 EXPLAIN FORMAT=TREE **一字不差**：build 恒为 30 行的 a，probe 恒为 500 行的 b。**FROM 的书写顺序不影响谁做 build**，优化器按估计行数换位，SQL 的声明式语义在这里体现得干干净净。前面大 join（users × fact2 50 万行）同理：50 万行的 fact2 做 build，百万行的 users 做 probe。

但有个容易踩的坑：**build 侧选的是「估计行数小」，不是「实际行数小」**。估计错的时候（比如过滤条件的效果被高估），build 侧可能实际比 probe 侧还大。后果与结果正确性无关：join buffer 更早打爆、溢写更狠。第五篇讲过估计的口径问题，在 join 算法选择上它继续生效：**直方图救估计，救的不只是访问方式，还有 build/probe 分工**。

分工的现场：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 226" role="img" aria-label="hash join 的 build 与 probe 分工：小表 dim2 的 200 行整体读进 join buffer 建哈希表；百万行的 users 作为 probe 侧逐行算哈希找桶，每行只花一次哈希计算；FROM 书写顺序不影响分工，优化器按估计行数换位" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my9As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">谁进哈希表，谁来探测</text>
<rect class="bx-sick" x="20" y="44" width="190" height="90" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="115" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">build · dim2</text>
<text class="ts" x="115" y="86" text-anchor="middle" font-size="10" fill="#6b675e">200 行整体读进 join buffer</text>
<text class="ts" x="115" y="102" text-anchor="middle" font-size="10" fill="#6b675e">city → 哈希 → 建桶</text>
<text class="ts" x="115" y="120" text-anchor="middle" font-size="10" fill="#6b675e">估计行数小的一侧当选</text>
<line class="fl" x1="210" y1="89" x2="256" y2="89" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my9As2)"/>
<rect class="bx-q" x="260" y="44" width="130" height="90" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="325" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">哈希表</text>
<rect class="bx" x="278" y="76" width="22" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="306" y="76" width="22" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="334" y="76" width="22" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="278" y="96" width="22" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="306" y="96" width="22" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="334" y="96" width="22" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="325" y="126" text-anchor="middle" font-size="10" fill="#6b675e">住在 join buffer</text>
<line class="fl" x1="450" y1="89" x2="394" y2="89" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my9As2)"/>
<text class="ts" x="422" y="79" text-anchor="middle" font-size="10" fill="#6b675e">逐行探测</text>
<rect class="bx" x="454" y="44" width="186" height="90" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="547" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">probe · users</text>
<rect class="msg" x="472" y="80" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="486" y="80" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="500" y="80" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="514" y="80" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="528" y="80" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="542" y="80" width="8" height="10" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="547" y="108" text-anchor="middle" font-size="10" fill="#6b675e">百万行逐行算哈希找桶</text>
<text class="ts" x="547" y="124" text-anchor="middle" font-size="10" fill="#6b675e">每行一次哈希，与 build 多大无关</text>
<text class="ts" x="20" y="162" font-size="12" fill="#6b675e">FROM 顺序颠倒，EXPLAIN 一字不差：分工由估计行数决定，不由书写顺序</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">50 万行 fact2 join 百万行 users 同理：fact2 做 build，users 做 probe</text>
<text class="ts" x="20" y="206" font-size="12" fill="#6b675e">实测 248ms：40 万行输出，probe 侧每行只花一次哈希计算</text>
</svg>
</figure>

## 溢写：Grace hash join 登场

join buffer（`join_buffer_size`，默认 256KB）装不下 build 侧时怎么办？8.4 的答案是 **Grace hash join**：两边输入都按**连接键的哈希值**切成 N 个分区，分别溢写到磁盘上的 chunk 文件；然后逐对分区读回内存做经典 hash join。同一个键只会落进同一对分区，分而治之后每对都装得下。

实测把这个机制完整逼了出来。users（百万行）join fact2（50 万行，city 无索引），连接条件带一个非等值尾巴（`u.city = f.city AND u.id <> f.id`）。build 侧 50 万行约 8MB，256KB 的 buffer 远远不够，溢写发生。证据一：**专用 performance_schema 仪器 `wait/io/file/sql/hash_join`**（专门为 hash join 的 chunk 文件设的仪器，8.x 新增）：

```text
连接执行前后 COUNT_STAR 差值：1,995 次文件 io
```

证据二：耗时 42.31s、结果 999,500,000 行，恰好等于算术：users 的 city 均匀落 500 城（每城 2000 行），fact2 取偶数 id 只落其中 250 个偶数城（每城 2000 行），配对数 = 250 城 × 2000 × 2000，再减去 u.id = f.id 的 50 万对。**数字精确对上，溢写没有偷工减料**。

然后是 join_buffer_size 矩阵（同一查询、只换会话级 buffer）：

| join_buffer_size | 耗时 | hash_join 文件 io | 说明 |
| --- | --- | --- | --- |
| 256KB（默认） | 41.4 s | 1,995 | Grace：双输入溢写 |
| 16MB | 40.8 s | **0** | 经典：全内存 |
| 64MB | 41.1 s | 0 | 经典：全内存 |

**最反直觉的数字在这：buffer 从 256KB 扩到 16MB，溢写彻底消失（1995 → 0 次 io），耗时只快了 0.5 秒。** 这个 join 的成本大头根本不是溢写 IO，是**十亿对配对的逐行比较与输出**（999,500,000 对进聚合，250 城每城 2000 × 2000）。「join buffer 不够 = 慢」是常被夸大的直觉：对结果集巨大的 join，瓶颈在乘法本身；对结果集小但中间量大的 join（比如大量分区来回读写），溢写才是大头。**调 join_buffer_size 之前先看两个数：hash_join 仪器的 io 差值（有没有溢写）、EXPLAIN ANALYZE 的实际行数（成本大头是不是乘法）**。

矩阵画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 198" role="img" aria-label="join_buffer_size 矩阵条形图：256KB 默认时 41.4 秒、1995 次文件 io；16MB 时 40.8 秒、io 归零；64MB 时 41.1 秒、io 仍是零；溢写消失耗时几乎不动，成本大头是十亿对配对" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一查询只换 buffer：条长 = 耗时（10 像素 = 1 秒），右侧 = hash_join 文件 io</text>
<text class="ts" x="20" y="60" font-size="11" fill="#6b675e">256KB（默认）</text>
<rect class="bar" x="150" y="46" width="414" height="18" fill="#2b2a26"/>
<text class="onbar" x="160" y="59" font-size="10" fill="#f6f3ec">41.4s</text>
<text class="tc" x="572" y="60" font-size="11" fill="#b03a2e">io 1995 · Grace 双输入溢写</text>
<text class="ts" x="20" y="96" font-size="11" fill="#6b675e">16MB</text>
<rect class="bar" x="150" y="82" width="408" height="18" fill="#2b2a26"/>
<text class="onbar" x="160" y="95" font-size="10" fill="#f6f3ec">40.8s</text>
<text class="ts" x="572" y="96" font-size="11" fill="#6b675e">io 0 · 全内存经典 hash</text>
<text class="ts" x="20" y="132" font-size="11" fill="#6b675e">64MB</text>
<rect class="bar" x="150" y="118" width="411" height="18" fill="#2b2a26"/>
<text class="onbar" x="160" y="131" font-size="10" fill="#f6f3ec">41.1s</text>
<text class="ts" x="572" y="132" font-size="11" fill="#6b675e">io 0 · 再大也不再快</text>
<text class="ts" x="20" y="164" font-size="12" fill="#6b675e">三条几乎一样长：这个 join 的大头是 999,500,000 对配对，不是 IO</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">先查 io 差值与实际行数，再决定调不调 buffer</text>
</svg>
</figure>

源码里溢写的护栏也值得记一笔（`sql/iterators/hash_join_iterator.h`）：**每个输入最多 128 个 chunk 文件**（`kMaxChunks = 128`，注释明说是防文件描述符耗尽，且恒取 2 的幂便于位运算路由）。还有两个精细设计，注释原话：单个分区读回内存仍装不下（哈希倾斜时常见），就「能装多少装多少，装满后整个 probe 分区重读一遍」，多读几遍 probe 换正确性；带 LIMIT 无排序无分组的查询会**禁止溢写**，改走「哈希表装满就边 probe 边输出」的流式模式，尽早吐出行来。

Grace 的分而治之：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 264" role="img" aria-label="Grace hash join 溢写流程：build 侧 8MB 装不进 256KB 的 join buffer，两边输入都按连接键哈希切成最多 128 个分区，分别溢写成磁盘 chunk 文件；同一个键只会落进同一对分区，逐对读回内存做经典 hash join" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my9As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">buffer 装不下时：切分区、写磁盘、逐对处理</text>
<rect class="bx-sick" x="20" y="40" width="270" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="155" y="56" text-anchor="middle" font-size="11" fill="#6b675e">build 侧 50 万行 ≈ 8MB</text>
<text class="tc" x="155" y="72" text-anchor="middle" font-size="11" fill="#b03a2e">join buffer 只有 256KB：装不下</text>
<line class="fl" x1="155" y1="80" x2="155" y2="100" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my9As3)"/>
<text class="ts" x="163" y="96" font-size="10" fill="#6b675e">按连接键哈希路由</text>
<rect class="bx" x="40" y="104" width="56" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="68" y="123" text-anchor="middle" font-size="9" fill="#6b675e">chunk 0</text>
<rect class="bx" x="102" y="104" width="56" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="130" y="123" text-anchor="middle" font-size="9" fill="#6b675e">chunk 1</text>
<rect class="bx" x="164" y="104" width="56" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="192" y="123" text-anchor="middle" font-size="9" fill="#6b675e">chunk 2</text>
<text class="ts" x="240" y="123" font-size="11" fill="#6b675e">… ≤128 个</text>
<text class="ts" x="40" y="152" font-size="10" fill="#6b675e">build 侧分区，溢写到磁盘</text>
<rect class="bx" x="380" y="104" width="56" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="408" y="123" text-anchor="middle" font-size="9" fill="#6b675e">chunk 0</text>
<rect class="bx" x="442" y="104" width="56" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="470" y="123" text-anchor="middle" font-size="9" fill="#6b675e">chunk 1</text>
<rect class="bx" x="504" y="104" width="56" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="532" y="123" text-anchor="middle" font-size="9" fill="#6b675e">chunk 2</text>
<text class="ts" x="580" y="123" font-size="11" fill="#6b675e">…</text>
<text class="ts" x="380" y="152" font-size="10" fill="#6b675e">probe 侧同样切分</text>
<line class="fl" x1="68" y1="134" x2="68" y2="170" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my9As3)"/>
<line class="fl" x1="408" y1="134" x2="408" y2="170" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my9As3)"/>
<rect class="bx-q" x="40" y="174" width="220" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="150" y="190" text-anchor="middle" font-size="10" fill="#6b675e">分区对 (0,0) 读回内存</text>
<text class="ts" x="150" y="206" text-anchor="middle" font-size="10" fill="#6b675e">经典 hash join</text>
<rect class="bx-q" x="380" y="174" width="220" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="490" y="190" text-anchor="middle" font-size="10" fill="#6b675e">分区对 (1,1)、(2,2)… 逐对处理</text>
<text class="ts" x="490" y="206" text-anchor="middle" font-size="10" fill="#6b675e">每对都装得下</text>
<text class="ts" x="20" y="238" font-size="12" fill="#6b675e">同一个键只会落进同一对分区：分而治之不丢配对；仪器 wait/io/file/sql/hash_join 记下 1995 次 io</text>
<text class="ts" x="20" y="256" font-size="12" fill="#6b675e">单对仍装不下（哈希倾斜）：能装多少装多少，probe 分区多读几遍换正确性</text>
</svg>
</figure>

## 非等值：算法管不到的地方

hash join 只吃**等值条件**。`ON u.id > f.id AND u.city = f.city` 里，`city` 的等值部分进 hash join，`id` 的不等值部分去哪了？EXPLAIN 的结构给出答案：它被挂在 hash join **之上**当过滤器：

```text
-> Filter: (u.id <> f.id)
    -> Inner hash join (u.city = f.city)
```

也就是说混合条件还是受益于 hash join 的（等值部分先剪枝）。但**纯非等值**（`ON u.id > f.id`，一个等值都没有）就无路可退了：hash join 完全出局，只剩嵌套循环。实测规模阶梯（users × fact2 限行对齐）：

| 规模（两侧行数上限） | 耗时 | 输出对数 |
| --- | --- | --- |
| 20k × 20k | 0.19 s | 195,000 |
| 100k × 100k | 0.62 s | 4,975,000 |
| 200k × 200k | 1.97 s | 19,950,000 |

耗时随规模超线性爬升，外推到全量 500k × 1M 约 25 分钟。我实测跑到 39 分钟还没完才杀掉，与外推同量级。**非等值 join 是执行器的荒地**：嵌套循环是唯一答案，优化器能做的只是挑个区间索引（实测里它选了「每次迭代重规划的范围扫」，`re-planned for each iteration`）尽力剪枝。写 SQL 的人能做的更实际：**把非等值改写成等值 + 范围**（比如按时间桶先等值 join 再在同桶内比较），或者干脆在应用层做。

两种命运：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="非等值条件的两种命运：左边混合条件里等值部分仍走 hash join 先剪枝，非等值部分挂在上层当 Filter；右边纯非等值只剩嵌套循环，耗时随规模超线性爬升，20k 是 0.19 秒、100k 是 0.62 秒、200k 是 1.97 秒，外推全量约 25 分钟" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">有一个等值条件，和一个是纯非等值：两种命运</text>
<rect class="bx" x="60" y="44" width="220" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="170" y="66" text-anchor="middle" font-size="11" fill="#6b675e">Filter: u.id &lt;&gt; f.id</text>
<line class="fl" x1="170" y1="98" x2="170" y2="84" stroke="#6b675e" stroke-width="1.4"/>
<rect class="bx-sick" x="40" y="98" width="260" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="170" y="116" text-anchor="middle" font-size="11" fill="#b03a2e">Inner hash join</text>
<text class="ts" x="170" y="134" text-anchor="middle" font-size="10" fill="#6b675e">u.city = f.city：等值部分先剪枝</text>
<text class="ts" x="170" y="164" text-anchor="middle" font-size="11" fill="#6b675e">混合条件仍吃到 hash join 的好处</text>
<text class="ts" x="170" y="182" text-anchor="middle" font-size="11" fill="#6b675e">非等值退化成上层过滤器</text>
<line class="axis" x1="370" y1="196" x2="630" y2="196" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="370" y1="196" x2="370" y2="56" stroke="#6b675e" stroke-width="1.2"/>
<polyline class="curve-k" points="400,183 480,168 560,121" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="400" cy="183" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="480" cy="168" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="560" cy="121" r="3" fill="#b03a2e"/>
<line class="curve-k" x1="560" y1="121" x2="614" y2="62" stroke="#2b2a26" stroke-width="1.6" stroke-dasharray="5 4"/>
<text class="ts" x="400" y="212" text-anchor="middle" font-size="10" fill="#6b675e">20k</text>
<text class="ts" x="480" y="212" text-anchor="middle" font-size="10" fill="#6b675e">100k</text>
<text class="ts" x="560" y="212" text-anchor="middle" font-size="10" fill="#6b675e">200k</text>
<text class="ts" x="386" y="188" font-size="9" fill="#6b675e">0.19s</text>
<text class="ts" x="488" y="160" font-size="9" fill="#6b675e">0.62s</text>
<text class="ts" x="568" y="116" font-size="9" fill="#6b675e">1.97s</text>
<text class="tc" x="612" y="52" text-anchor="end" font-size="10" fill="#b03a2e">外推全量 ≈25min</text>
<text class="ts" x="500" y="232" text-anchor="middle" font-size="11" fill="#6b675e">纯非等值：只剩嵌套循环，超线性爬升（实测 39 分钟未完）</text>
</svg>
</figure>

## 109 倍从哪来

同一个 join 三条走法，109 倍：hash join 248ms（每行一次哈希）、索引 NLJ 1140ms（每行一次树点查）、纯嵌套 26.97s（200 × 百万次比较）。**无索引的 hash join 比有索引的 NLJ 还快 4.6 倍**。「join 键必须有索引」在 8.x 是过时直觉，它只在嵌套循环的世界里成立。

build/probe 由估计行数说了算：小侧进哈希表，FROM 顺序颠倒计划不变。但选的是「估计」不是「实际」，估计跑偏的代价是更狠的溢写，直方图在这里继续生效。

溢写不可怕，可怕的是不知道瓶颈在哪。256KB 打爆后 Grace hash join 接管：双输入按键哈希切最多 128 个 chunk 文件（`kMaxChunks = 128`，2 的幂）逐对处理，`wait/io/file/sql/hash_join` 仪器记下 1995 次 io；buffer 扩到 16MB 溢写归零，耗时却只快 0.5 秒。**这个 join 的大头是十亿对乘法，不是 IO**。调 join_buffer_size 前先看仪器和实际行数，别盲调。

非等值仍是荒地：hash join 只吃等值，混合条件里非等值退化成 join 之上的 Filter；纯非等值只有嵌套循环一条路，规模阶梯外推全量 25 分钟。改写成等值 + 范围，或搬去应用层，是写 SQL 的人的活。

执行器的拼桌艺术到这讲完。下一篇换个题材：表结构本身怎么变。百万行在线的表上加列、建索引、改列型，怎么不锁表地完成，online DDL 的三种算法从 8.0 的 INSTANT 加列讲起。
