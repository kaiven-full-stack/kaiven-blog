---
title: 删掉一个季度只要 143 毫秒：分区表
description: MySQL 系列第十一篇。DELETE 百万行 14.1 秒、1916 万次页访问、19M 条 undo；DROP PARTITION 同样百万行 143 毫秒、0 页访问——98 倍差距，因为删的是 .ibd 文件不是行。本篇实测分区表三件套：分区裁剪（对索引友好的范围条件竟不加分——裁剪的真本事另有其处）、三种删除的物理账本（DROP/EXCHANGE/DELETE）、以及分区的代价面（唯一键必须含分区列 ERROR 1503、local 索引无全局树）。外加 40.7 秒的 DROP PARTITION 被 MDL 排队污染后复测反转 284 倍的插曲，与 EXCHANGE PARTITION 从 1732 走到成功的错误阶梯。8.4 源码 prune_partition_set 的位图裁决逐行对上。
pubDate: 2026-09-29
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

```text
22:04:31  DELETE FROM np_t WHERE id >= 2000000 AND id < 3000000;   -- 14.1 秒
22:05:02  19,159,753 次页访问，19M 行 undo，14.1 秒。
22:06:15  ALTER TABLE p_t DROP PARTITION p1;                        -- 143 毫秒
22:06:15  同样一百万行。0 次页访问，0 行 undo。
```

第十篇结尾说「分区表是 online DDL 之外另一种不碰行的删除」——这一篇兑现。分区的核心思想一句话：**把一张逻辑表切成多个物理 .ibd，让「按片操作」取代「按行操作」**。`p_t#p#p1.ibd`、`p_t#p#p2.ibd`……每个分区一个独立表空间、独立的 B+ 树族；服务器层有一层分区 handler（源码 `ha_partition`）把它们拼成一张表。切法有 RANGE/LIST/HASH/KEY 四种，本篇主用最经典的 RANGE（按 id 十等分，一区一百万行）——正是「按时间分区、按月归档」那张生产标配形状。

对照表 np_t 与 p_t 同数据同结构（千万行、city 索引），一切对比双盲跑。

> 读完这一篇，你应该能回答四个问题：**分区裁剪到底在什么条件下加分、什么条件下白搭？三种删除（DELETE / DROP PARTITION / EXCHANGE）的物理账本各是什么？分区在索引和唯一键上收你什么税？分区表最大的坑在哪？**

## 裁剪：加分的地方和它帮不上忙的地方

「分区裁剪」（partition pruning）是分区最常被吹的能力：查询条件与分区键对齐时，只扫命中的分区。实测先给结论泼一盆冷水——**对索引友好的条件，裁剪不加分**：

```sql
SELECT COUNT(*) FROM p_t  WHERE id BETWEEN 2500000 AND 2599999;   -- EXPLAIN: partitions: p2
SELECT COUNT(*) FROM np_t WHERE id BETWEEN 2500000 AND 2599999;   -- EXPLAIN: partitions: NULL
```

冷池双盲（重启后首查，复跑两轮取稳定值）：

| 表 | 耗时 | 页读请求 |
| --- | --- | --- |
| p_t（分区，裁剪到 p2） | 45.5 / 45.7 ms | 1,566 |
| np_t（非分区） | 55.8 / 59.8 ms | 1,357 |

耗时接近（分区还略快），页读接近（分区还略多——10 个分区的打开与统计开销）。为什么差距这么小？因为 `id BETWEEN ...` 本身就是**聚簇索引友好的范围条件**：np_t 走 range 扫描只碰那 10 万行的树路径，p_t 裁剪到 p2 后走的也是同一棵树——**裁剪省下的，np_t 的 B+ 树早省过了**。分区不是索引的替代品，是另一把刀。

那裁剪什么时候真加分？两个场景。**其一：条件没法走索引时**——`WHERE city = 'city37'` 若 city 无索引，非分区表全表扫 1000 万行；分区表若按 city 的地区前缀分区，只扫一个分区。**其二：分区数就是并发单位时**——10 个分区 = 10 棵独立的树、10 份独立的 latch 与统计，热点分散（这也是很多「分区后变快」案例的真身：不是裁剪，是锁竞争分散）。裁剪的判定在源码里朴素得漂亮（`sql_partition.cc` 的 `prune_partition_set`）：拿分区键的区间在分区定义数组上折半，把结果写进 `read_partitions` 位图，**start_part == end_part 即单区**——EXPLAIN 的 `partitions: p2` 就是这个位图的输出。

顺带一个实测意外：首轮跑 p_t 得到 177ms，复跑两轮都是 45.5ms——**冷启动后第一次查询有系统页加载噪声，量性能必须复跑**（老规矩，量具的坑比结论多）。

## 三种删除：物理账本对账

分区表的招牌场景：按时间分区，过期数据 DROP PARTITION 一刀走。三种删法同一任务（删掉一百万行）的实测账本：

| 删法 | 耗时 | 页访问 | undo 行 | binlog |
| --- | --- | --- | --- | --- |
| `DELETE FROM np_t WHERE id>=2M AND id<3M` | **14.1 s** | 19,159,753 | 19M | 19M 行前后像 |
| `ALTER TABLE p_t DROP PARTITION p1` | **143 ms** | 0 | 0 | DDL 元数据事件 |
| `ALTER TABLE p_t EXCHANGE PARTITION p2 WITH TABLE swap_t` | **80 ms** | 0 | 0 | DDL 元数据事件 |

**DELETE 是最贵的**，贵在它的物理语义：逐行找、逐行记 undo（19M 行写回滚段）、逐行标删、purge 线程后台慢慢收尸、binlog 记 19M 条 ROW 前后像给从库重演——14 秒里大部分时间在**为「可以反悔」付费**。而这百万行你根本不打算反悔。

**DROP PARTITION 删的是文件不是行。** `rm p_t#p#p1.ibd`（实际是内部 unlink + 字典除名 + 缓冲池清页），行们随文件一起消失——**没有 undo、没有逐行 binlog、没有 purge**。143ms 里大头是缓冲池扫描清理（8192 页里摘掉该分区的页）和字典提交。约束同样来自这个语义：**它是不进事务的 DDL，删错了没有闪回**（除非有备份/PITR，见系列的 binlog 篇）；而且隐式提交，开着的事务先咔嚓。

**EXCHANGE PARTITION 是「搬家不搬行」。** 把整个分区与一张同构表**原子互换字典指针**：p2 的 100 万行 80ms 全部出现在 swap_t 里，swap_t 的 10 万行进驻 p2——一行都没复制（.ibd 空间 id 互换身份）。这是数据归档的最优解：**老数据 EXCHANGE 出去留档、新表换进来，全程不碰行**。它的严格性也是三段错误阶梯换来的：对家必须是**非分区表**（ERROR 1732「Table to exchange with partition is partitioned」）、**列定义逐字对齐**含默认值与字符集（ERROR 1736「different definitions」）、**行必须落在目标分区范围内**（ERROR 1737「Found a row that does not match the partition」——我把 p3 范围的行塞给 p2 时被拦）。三道关卡全是字典级校验，所以才能毫秒完成。

### 一个 40.7 秒的插曲

第一次测 DROP PARTITION 得到 **40.7 秒**——差点写成「DROP PARTITION 并不快」的反结论。诊断：当时另一个连接正在跑千万行的 UPDATE，**UPDATE 挂着 SHARED MDL 不放，DROP PARTITION 要 EXCLUSIVE 只能排队**（第三篇 MDL 门链的又一次活体展示）。等 UPDATE 结束复测：143ms。**同一个 DDL，无干扰 143ms、被长事务挡住 40.7 秒，284 倍**——比 DELETE vs DROP 的 98 倍还大。分区的毫秒级删除是真的，但**它的敌人从来不是行数，是排队**：上线 DROP PARTITION 前，`information_schema.innodb_trx` 里有没有长事务，比表多大重要得多。

## 代价面：索引、唯一键与打开成本

分区不是免费的，三笔税要心里有数。

**索引是 local 的，没有全局树。** 每个分区一套独立的索引树（p2 的 PRIMARY 和 idx_city 与 p3 的互不相干），分区表没有跨分区的全局索引。点查 `id=5,500,000` 若不带分区键条件，分区 handler 要把查询**广播到 10 棵树**各走一遍树高——10×3 页 vs 非分区的 1×4 页。所幸 RANGE(id) 的主键点查天然带分区键，裁剪后单树直达；**但二级索引条件不带分区键时（`WHERE city=...`），广播无处可躲**——这是分区表二级索引查询的固定税。

**唯一键必须包含分区列。** 实测：`PARTITION BY HASH(id)` 的表上加 `UNIQUE KEY(email)` 直接被拒：

```text
ERROR 1503: A UNIQUE INDEX must include all columns in the table's
partitioning function (prefixed columns are not considered).
```

原因想通就自然：唯一性要全局成立，但索引是 local 的——`email` 的唯一键在 4 个分区里各查各的，**没有一棵全局树能替它保证「全表没有第二个 me@x.com」**。所以要么把分区列并进唯一键（`UNIQUE(id, email)`，实测可建，唯一性语义变成「同分区内 email 唯一」），要么放弃分区、要么接受应用层保证。对「用户表按 id 哈希分区、email 唯一」这种需求，1503 是设计阶段就要撞上的墙。

**MAXVALUE 是兜底也是陷阱。** `PARTITION p9 VALUES LESS THAN MAXVALUE` 接住一切越界值（实测 id 超上限的行安落 p9）——但它同时**挡住后面的分区切分**：想 `REORGANIZE p9` 加新区时，p9 里已有的行要重排。生产上按月分区的表应该**只建到当前月、留空 MAXVALUE 兜底**（或干脆不建兜底，让越界插入直接报错暴露问题），滚月时 ADD PARTITION 一个新空区毫秒级。

## 合上账本

**分区的本质是「按文件删、按文件搬」。** DELETE 百万行 14.1 秒（19M undo 在为反悔付费），DROP PARTITION 143 毫秒（rm 一个 .ibd），EXCHANGE 80 毫秒（字典指针互换）——98 倍与 0 复制。归档场景的最优路径固定：EXCHANGE 出去留档、新表换入，全程不碰行。

**裁剪不是索引的替代品。** 索引友好的范围条件，B+ 树早把裁剪的活干了（实测两表 45 vs 55ms、页读持平）；裁剪的真本事在**无法走索引的条件**和**分区即并发单位**的场景。先想清楚查询形状，再决定要不要切。

**三笔税：广播、唯一键、打开成本。** 二级索引条件不带分区键时广播到每棵 local 树；唯一键必须含分区列（ERROR 1503 是设计期的墙，语义从「全局唯一」降级为「分区内唯一」）；10 个分区是 10 个 .ibd、10 套统计。**分区解决的是「数据生命周期」问题（删、归档、滚动），不是「查询快」问题**——为了快而分区，九成是错的开局。

**分区的敌人是排队，不是行数。** 143ms 的 DROP PARTITION 被长事务拖成 40.7 秒（284 倍）——比算法差距还大。DDL 前查长事务，第十篇的纪律在这里同样保命。

---

```text
22:04:31  DELETE 百万行：14.1s，1916 万页访问，undo 19M 行。
22:06:15  DROP PARTITION：143ms，0 页访问——删文件不删行。
22:07:40  EXCHANGE：80ms，百万行搬家零复制。
22:12:05  无干扰 143ms vs 被长事务挡 40.7s：284 倍，敌人是排队。
```

系列下一篇收个尾：前面十一篇把 InnoDB 的存储现场拆完了，最后一站是**查询之外的那只手——performance_schema 与事件仪器**，把本系列一路当量具用的计数器和仪器体系本身讲透（量具的量具），给全系列画上句号。
