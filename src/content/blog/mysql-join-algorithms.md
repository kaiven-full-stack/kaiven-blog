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

## build 与 probe：谁进哈希表

hash join 的第一个决策是**哪边做 build**。build 侧要整个装进 join buffer，装不下就溢写，所以规则很简单：**估计行数小的一侧当 build**。实测验证到计划的对称性：

```sql
SELECT ... FROM t_noindex_a a JOIN t_noindex_b b ON a.v = b.v;  -- a 30 行，b 500 行，两边都无索引
SELECT ... FROM t_noindex_b b JOIN t_noindex_a a ON a.v = b.v;  -- FROM 顺序颠倒
```

两条 EXPLAIN FORMAT=TREE **一字不差**：build 恒为 30 行的 a，probe 恒为 500 行的 b。**FROM 的书写顺序不影响谁做 build**，优化器按估计行数换位，SQL 的声明式语义在这里体现得干干净净。前面大 join（users × fact2 50 万行）同理：50 万行的 fact2 做 build，百万行的 users 做 probe。

但有个容易踩的坑：**build 侧选的是「估计行数小」，不是「实际行数小」**。估计错的时候（比如过滤条件的效果被高估），build 侧可能实际比 probe 侧还大。后果与结果正确性无关：join buffer 更早打爆、溢写更狠。第五篇讲过估计的口径问题，在 join 算法选择上它继续生效：**直方图救估计，救的不只是访问方式，还有 build/probe 分工**。

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

源码里溢写的护栏也值得记一笔（`sql/iterators/hash_join_iterator.h`）：**每个输入最多 128 个 chunk 文件**（`kMaxChunks = 128`，注释明说是防文件描述符耗尽，且恒取 2 的幂便于位运算路由）。还有两个精细设计，注释原话：单个分区读回内存仍装不下（哈希倾斜时常见），就「能装多少装多少，装满后整个 probe 分区重读一遍」，多读几遍 probe 换正确性；带 LIMIT 无排序无分组的查询会**禁止溢写**，改走「哈希表装满就边 probe 边输出」的流式模式，尽早吐出行来。

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

## 109 倍从哪来

同一个 join 三条走法，109 倍：hash join 248ms（每行一次哈希）、索引 NLJ 1140ms（每行一次树点查）、纯嵌套 26.97s（200 × 百万次比较）。**无索引的 hash join 比有索引的 NLJ 还快 4.6 倍**。「join 键必须有索引」在 8.x 是过时直觉，它只在嵌套循环的世界里成立。

build/probe 由估计行数说了算：小侧进哈希表，FROM 顺序颠倒计划不变。但选的是「估计」不是「实际」，估计跑偏的代价是更狠的溢写，直方图在这里继续生效。

溢写不可怕，可怕的是不知道瓶颈在哪。256KB 打爆后 Grace hash join 接管：双输入按键哈希切最多 128 个 chunk 文件（`kMaxChunks = 128`，2 的幂）逐对处理，`wait/io/file/sql/hash_join` 仪器记下 1995 次 io；buffer 扩到 16MB 溢写归零，耗时却只快 0.5 秒。**这个 join 的大头是十亿对乘法，不是 IO**。调 join_buffer_size 前先看仪器和实际行数，别盲调。

非等值仍是荒地：hash join 只吃等值，混合条件里非等值退化成 join 之上的 Filter；纯非等值只有嵌套循环一条路，规模阶梯外推全量 25 分钟。改写成等值 + 范围，或搬去应用层，是写 SQL 的人的活。

执行器的拼桌艺术到这讲完。下一篇换个题材：表结构本身怎么变。百万行在线的表上加列、建索引、改列型，怎么不锁表地完成，online DDL 的三种算法从 8.0 的 INSTANT 加列讲起。
