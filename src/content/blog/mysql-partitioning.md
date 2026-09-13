---
title: 删掉一个季度只要 143 毫秒：分区表
description: MySQL 系列第十一篇。DELETE 百万行 14.1 秒、1916 万次页访问、19M 条 undo；DROP PARTITION 同样百万行 143 毫秒、0 页访问。98 倍差距，因为删的是 .ibd 文件不是行。本篇实测分区表三件套：分区裁剪（对索引友好的范围条件竟不加分，裁剪的真本事另有其处）、三种删除的物理成本（DROP/EXCHANGE/DELETE）、以及分区的代价面（唯一键必须含分区列 ERROR 1503、local 索引无全局树）。外加 40.7 秒的 DROP PARTITION 被 MDL 排队污染后复测反转 284 倍的插曲，与 EXCHANGE PARTITION 从 1732 走到成功的错误阶梯。8.4 源码 prune_partition_set 的位图判定逐行对上。
pubDate: 2026-09-29
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

同样删掉一百万行：`DELETE FROM np_t WHERE id >= 2000000 AND id < 3000000` 花了 14.1 秒，19,159,753 次页访问，19M 行 undo；`ALTER TABLE p_t DROP PARTITION p1` 花了 143 毫秒，0 次页访问，0 行 undo。

第十篇结尾说「分区表是 online DDL 之外另一种不碰行的删除」，这一篇兑现。分区的核心思想一句话：**把一张逻辑表切成多个物理 .ibd，让「按片操作」取代「按行操作」**。`p_t#p#p1.ibd`、`p_t#p#p2.ibd`……每个分区一个独立表空间、独立的 B+ 树族；服务器层有一层分区 handler（源码 `ha_partition`）把它们拼成一张表。切法有 RANGE/LIST/HASH/KEY 四种，本篇主用最经典的 RANGE（按 id 十等分，一区一百万行），正是「按时间分区、按月归档」那张生产标配形状。

对照表 np_t 与 p_t 同数据同结构（千万行、city 索引），一切对比双盲跑。

一张逻辑表的物理真相：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="分区表结构：服务器层的分区 handler 把十个独立表空间拼成一张逻辑表 p_t；每个分区一个 .ibd 文件、一套独立的 B+ 树族，RANGE 按 id 十等分、一区一百万行" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my11As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">把一张逻辑表切成多个物理 .ibd：按片操作取代按行操作</text>
<rect class="bx-q" x="150" y="40" width="360" height="38" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="64" text-anchor="middle" font-size="13" fill="#2b2a26">逻辑表 p_t · 服务器层 ha_partition</text>
<line class="fl" x1="230" y1="78" x2="105" y2="108" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As1)"/>
<line class="fl" x1="300" y1="78" x2="255" y2="108" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As1)"/>
<line class="fl" x1="360" y1="78" x2="405" y2="108" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As1)"/>
<line class="fl" x1="430" y1="78" x2="555" y2="108" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As1)"/>
<rect class="bx" x="30" y="112" width="140" height="70" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="100" y="134" text-anchor="middle" font-size="11" fill="#2b2a26">p_t#p#p0.ibd</text>
<text class="ts" x="100" y="152" text-anchor="middle" font-size="10" fill="#6b675e">独立表空间</text>
<text class="ts" x="100" y="168" text-anchor="middle" font-size="10" fill="#6b675e">独立 B+ 树族</text>
<rect class="bx-sick" x="185" y="112" width="140" height="70" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="255" y="134" text-anchor="middle" font-size="11" fill="#2b2a26">p_t#p#p1.ibd</text>
<text class="ts" x="255" y="152" text-anchor="middle" font-size="10" fill="#6b675e">DROP 这一片 =</text>
<text class="ts" x="255" y="168" text-anchor="middle" font-size="10" fill="#6b675e">删这个文件</text>
<rect class="bx" x="340" y="112" width="140" height="70" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="410" y="134" text-anchor="middle" font-size="11" fill="#2b2a26">p_t#p#p2.ibd</text>
<text class="ts" x="410" y="152" text-anchor="middle" font-size="10" fill="#6b675e">每区一百万行</text>
<text class="ts" x="410" y="168" text-anchor="middle" font-size="10" fill="#6b675e">RANGE(id) 十等分</text>
<rect class="bx" x="495" y="112" width="140" height="70" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="565" y="134" text-anchor="middle" font-size="11" fill="#2b2a26">… p9.ibd</text>
<text class="ts" x="565" y="152" text-anchor="middle" font-size="10" fill="#6b675e">共 10 个分区</text>
<text class="ts" x="565" y="168" text-anchor="middle" font-size="10" fill="#6b675e">10 套统计与 latch</text>
<text class="ts" x="20" y="210" font-size="12" fill="#6b675e">每个分区一套独立的 PRIMARY 与 idx_city：没有跨分区的全局树</text>
<text class="ts" x="20" y="228" font-size="12" fill="#6b675e">正是「按时间分区、按月归档」的生产标配形状</text>
</svg>
</figure>

## 裁剪：加分的地方和它帮不上忙的地方

「分区裁剪」（partition pruning）是分区最常被吹的能力：查询条件与分区键对齐时，只扫命中的分区。实测先给结论泼一盆冷水：**对索引友好的条件，裁剪不加分**：

```sql
SELECT COUNT(*) FROM p_t  WHERE id BETWEEN 2500000 AND 2599999;   -- EXPLAIN: partitions: p2
SELECT COUNT(*) FROM np_t WHERE id BETWEEN 2500000 AND 2599999;   -- EXPLAIN: partitions: NULL
```

冷池双盲（重启后首查，复跑两轮取稳定值）：

| 表 | 耗时 | 页读请求 |
| --- | --- | --- |
| p_t（分区，裁剪到 p2） | 45.5 / 45.7 ms | 1,566 |
| np_t（非分区） | 55.8 / 59.8 ms | 1,357 |

耗时接近（分区还略快），页读接近（分区还略多，10 个分区的打开与统计开销）。为什么差距这么小？因为 `id BETWEEN ...` 本身就是**聚簇索引友好的范围条件**：np_t 走 range 扫描只碰那 10 万行的树路径，p_t 裁剪到 p2 后走的也是同一棵树。**裁剪省下的，np_t 的 B+ 树早省过了**。

那裁剪什么时候真加分？两个场景。**其一：条件没法走索引时**。`WHERE city = 'city37'` 若 city 无索引，非分区表全表扫 1000 万行；分区表若按 city 的地区前缀分区，只扫一个分区。**其二：分区数就是并发单位时**。10 个分区 = 10 棵独立的树、10 份独立的 latch 与统计，热点分散（这也是很多「分区后变快」案例的真身：锁竞争分散了，与裁剪无关）。裁剪的判定在源码里朴素得漂亮（`sql_partition.cc` 的 `prune_partition_set`）：拿分区键的区间在分区定义数组上折半，把结果写进 `read_partitions` 位图，**start_part == end_part 即单区**。EXPLAIN 的 `partitions: p2` 就是这个位图的输出。

裁剪的判定过程：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="分区裁剪：查询条件 id BETWEEN 2500000 AND 2599999 在分区定义数组上折半定位，read_partitions 位图只点亮 p2 一位，EXPLAIN 的 partitions p2 就是位图的输出；但这种索引友好的范围条件不加分，np_t 的 B+ 树早把这段路省过了" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my11As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">prune_partition_set：区间折半，写进位图</text>
<rect class="bx-q" x="150" y="38" width="360" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="330" y="57" text-anchor="middle" font-size="11" fill="#6b675e">WHERE id BETWEEN 2500000 AND 2599999</text>
<line class="fl" x1="330" y1="68" x2="272" y2="88" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As2)"/>
<rect class="bx" x="20" y="92" width="56" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="48" y="113" text-anchor="middle" font-size="10" fill="#6b675e">p0</text>
<rect class="bx" x="80" y="92" width="56" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="108" y="113" text-anchor="middle" font-size="10" fill="#6b675e">p1</text>
<rect class="bx-sick" x="140" y="92" width="56" height="34" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="168" y="113" text-anchor="middle" font-size="10" fill="#b03a2e">p2 ✓</text>
<rect class="bx" x="200" y="92" width="56" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="228" y="113" text-anchor="middle" font-size="10" fill="#6b675e">p3</text>
<rect class="bx" x="260" y="92" width="56" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="288" y="113" text-anchor="middle" font-size="10" fill="#6b675e">p4</text>
<rect class="bx" x="320" y="92" width="56" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="348" y="113" text-anchor="middle" font-size="10" fill="#6b675e">p5</text>
<rect class="bx" x="380" y="92" width="56" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="408" y="113" text-anchor="middle" font-size="10" fill="#6b675e">p6…p9</text>
<rect class="bx-gone" x="440" y="92" width="180" height="34" rx="2" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="530" y="113" text-anchor="middle" font-size="10" fill="#6b675e">位图其余位：0，不扫</text>
<text class="ts" x="20" y="152" font-size="12" fill="#6b675e">read_partitions 位图只亮一位，start_part == end_part：EXPLAIN 的 partitions: p2 就是它</text>
<text class="tc" x="20" y="176" font-size="12" fill="#b03a2e">但对索引友好的范围条件，裁剪不加分：np_t 的 B+ 树 range 扫描早把这段路省过了</text>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">冷池实测：p_t 45.5ms / 1566 页读，np_t 55.8ms / 1357 页读，几乎打平</text>
</svg>
</figure>

顺带一个实测意外：首轮跑 p_t 得到 177ms，复跑两轮都是 45.5ms。**冷启动后第一次查询有系统页加载噪声，量性能必须复跑**（老规矩，量具的坑比结论多）。

## 三种删除：物理成本对照

分区表的招牌场景：按时间分区，过期数据 DROP PARTITION 一刀走。三种删法同一任务（删掉一百万行）的实测数字：

| 删法 | 耗时 | 页访问 | undo 行 | binlog |
| --- | --- | --- | --- | --- |
| `DELETE FROM np_t WHERE id>=2M AND id<3M` | **14.1 s** | 19,159,753 | 19M | 19M 行前后像 |
| `ALTER TABLE p_t DROP PARTITION p1` | **143 ms** | 0 | 0 | DDL 元数据事件 |
| `ALTER TABLE p_t EXCHANGE PARTITION p2 WITH TABLE swap_t` | **80 ms** | 0 | 0 | DDL 元数据事件 |

**DELETE 是最贵的**，贵在它的物理语义：逐行找、逐行记 undo（19M 行写回滚段）、逐行标删、purge 线程后台慢慢收尸、binlog 记 19M 条 ROW 前后像给从库重演。14 秒里大部分时间在**为「可以反悔」付费**。而这百万行你根本不打算反悔。

同一任务的三种账单：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="删掉一百万行的三种账单：DELETE 14.1 秒、1916 万次页访问、19M 行 undo 和 binlog 前后像；DROP PARTITION 143 毫秒、0 页访问、0 undo，删的是 ibd 文件；EXCHANGE PARTITION 80 毫秒、0 行复制，互换字典指针" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">删掉同一百万行：条长等比（10 像素 = 0.3 秒）</text>
<text class="ts" x="20" y="58" font-size="11" fill="#6b675e">DELETE 逐行</text>
<rect class="bar" x="150" y="44" width="470" height="20" fill="#b03a2e"/>
<text class="onbar" x="160" y="59" font-size="10" fill="#f6f3ec">14.1s · 19,159,753 次页访问 · 19M undo · binlog 19M 行前后像</text>
<text class="ts" x="20" y="98" font-size="11" fill="#6b675e">DROP PARTITION</text>
<rect class="bar" x="150" y="84" width="5" height="20" fill="#2b2a26"/>
<text class="tc" x="163" y="99" font-size="11" fill="#b03a2e">143ms · 0 页访问 · 0 undo：删的是 p_t#p#p1.ibd 这个文件</text>
<text class="ts" x="20" y="138" font-size="11" fill="#6b675e">EXCHANGE</text>
<rect class="bar" x="150" y="124" width="3" height="20" fill="#2b2a26"/>
<text class="ts" x="163" y="139" font-size="11" fill="#6b675e">80ms · 0 行复制：与同构表原子互换字典指针，归档最优解</text>
<text class="tc" x="628" y="59" text-anchor="end" font-size="12" fill="#b03a2e">98×</text>
<text class="ts" x="20" y="172" font-size="12" fill="#6b675e">DELETE 的 14 秒大头在为「可以反悔」付费：undo、逐行 binlog、purge 收尸</text>
<text class="ts" x="20" y="192" font-size="12" fill="#6b675e">DROP/EXCHANGE 不进事务：删错没有闪回，隐式提交还会咔嚓掉开着的事务</text>
</svg>
</figure>

**DROP PARTITION 删的是文件不是行。** `rm p_t#p#p1.ibd`（实际是内部 unlink + 字典除名 + 缓冲池清页），行们随文件一起消失：**没有 undo、没有逐行 binlog、没有 purge**。143ms 里大头是缓冲池扫描清理（8192 页里摘掉该分区的页）和字典提交。约束同样来自这个语义：**它是不进事务的 DDL，删错了没有闪回**（除非有备份/PITR，见系列的 binlog 篇）；而且隐式提交，开着的事务先咔嚓。

**EXCHANGE PARTITION 是「搬家不搬行」。** 把整个分区与一张同构表**原子互换字典指针**：p2 的 100 万行 80ms 全部出现在 swap_t 里，swap_t 的 10 万行进驻 p2，一行都没复制（.ibd 空间 id 互换身份）。这是数据归档的最优解：**老数据 EXCHANGE 出去留档、新表换进来，全程不碰行**。它的严格性也是三段错误阶梯换来的：对家必须是**非分区表**（ERROR 1732「Table to exchange with partition is partitioned」）、**列定义逐字对齐**含默认值与字符集（ERROR 1736「different definitions」）、**行必须落在目标分区范围内**（ERROR 1737「Found a row that does not match the partition」，我把 p3 范围的行塞给 p2 时被拦）。三道关卡全是字典级校验，所以才能毫秒完成。

### 一个 40.7 秒的插曲

第一次测 DROP PARTITION 得到 **40.7 秒**，差点写成「DROP PARTITION 并不快」的反结论。诊断：当时另一个连接正在跑千万行的 UPDATE，**UPDATE 挂着 SHARED MDL 不放，DROP PARTITION 要 EXCLUSIVE 只能排队**（第三篇 MDL 门链的又一次活体展示）。等 UPDATE 结束复测：143ms。**同一个 DDL，无干扰 143ms、被长事务挡住 40.7 秒，284 倍**，比 DELETE vs DROP 的 98 倍还大。分区的毫秒级删除是真的，但**它的敌人从来不是行数，是排队**：上线 DROP PARTITION 前，`information_schema.innodb_trx` 里有没有长事务，比表多大重要得多。

## 代价面：索引、唯一键与打开成本

分区不是免费的，三笔税要心里有数。

**索引是 local 的，没有全局树。** 每个分区一套独立的索引树（p2 的 PRIMARY 和 idx_city 与 p3 的互不相干），分区表没有跨分区的全局索引。点查 `id=5,500,000` 若不带分区键条件，分区 handler 要把查询**广播到 10 棵树**各走一遍树高：10×3 页 vs 非分区的 1×4 页。所幸 RANGE(id) 的主键点查天然带分区键，裁剪后单树直达；**但二级索引条件不带分区键时（`WHERE city=...`），广播无处可躲**。这是分区表二级索引查询的固定税。

广播的样子：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="local 索引的广播税：带分区键的点查裁剪后单树直达 1 乘 3 页；不带分区键的二级索引条件 WHERE city 要广播到 10 棵独立的 local 索引树，各走一遍树高 10 乘 3 页，而非分区表只要 1 乘 4 页" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my11As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">带不带分区键，两种页账</text>
<text class="ts" x="20" y="52" font-size="11" fill="#6b675e">带分区键：id=5,500,000</text>
<rect class="bx-q" x="20" y="60" width="150" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="95" y="76" text-anchor="middle" font-size="10" fill="#6b675e">裁剪命中单分区</text>
<text class="ts" x="95" y="92" text-anchor="middle" font-size="10" fill="#6b675e">一棵树直达</text>
<line class="fl" x1="170" y1="80" x2="206" y2="80" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As4)"/>
<rect class="bx" x="210" y="60" width="110" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="265" y="84" text-anchor="middle" font-size="11" fill="#b03a2e">1 × 3 页</text>
<text class="ts" x="340" y="84" font-size="11" fill="#6b675e">（非分区表是 1 × 4 页：树更高一层）</text>
<text class="ts" x="20" y="134" font-size="11" fill="#6b675e">不带分区键：WHERE city='city37'</text>
<rect class="bx-sick" x="20" y="142" width="150" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="95" y="158" text-anchor="middle" font-size="10" fill="#6b675e">无法裁剪</text>
<text class="ts" x="95" y="174" text-anchor="middle" font-size="10" fill="#6b675e">city 的 local 树各分区一套</text>
<line class="fl" x1="170" y1="162" x2="206" y2="162" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my11As4)"/>
<rect class="bx" x="210" y="142" width="40" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="256" y="142" width="40" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="302" y="142" width="40" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="348" y="142" width="40" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="394" y="142" width="40" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="230" y="166" text-anchor="middle" font-size="9" fill="#6b675e">p0</text>
<text class="ts" x="276" y="166" text-anchor="middle" font-size="9" fill="#6b675e">p1</text>
<text class="ts" x="322" y="166" text-anchor="middle" font-size="9" fill="#6b675e">p2</text>
<text class="ts" x="368" y="166" text-anchor="middle" font-size="9" fill="#6b675e">…</text>
<text class="ts" x="414" y="166" text-anchor="middle" font-size="9" fill="#6b675e">p9</text>
<text class="tc" x="450" y="166" font-size="11" fill="#b03a2e">广播 10 棵树：10 × 3 页</text>
<text class="ts" x="20" y="212" font-size="12" fill="#6b675e">分区表没有全局索引树：不带分区键的二级索引查询，广播是固定税</text>
</svg>
</figure>

**唯一键必须包含分区列。** 实测：`PARTITION BY HASH(id)` 的表上加 `UNIQUE KEY(email)` 直接被拒：

```text
ERROR 1503: A UNIQUE INDEX must include all columns in the table's
partitioning function (prefixed columns are not considered).
```

原因想通就自然：唯一性要全局成立，但索引是 local 的。`email` 的唯一键在 4 个分区里各查各的，**没有一棵全局树能替它保证「全表没有第二个 me@x.com」**。所以要么把分区列并进唯一键（`UNIQUE(id, email)`，实测可建，唯一性语义变成「同分区内 email 唯一」），要么放弃分区、要么接受应用层保证。对「用户表按 id 哈希分区、email 唯一」这种需求，1503 是设计阶段就要撞上的墙。

这堵墙的形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="唯一键必须含分区列的原因：UNIQUE(email) 的查重只能落在每个分区各自的 local 索引里，p0 到 p3 各查各的，没有一棵全局树能证明全表没有第二个相同 email，于是 ERROR 1503；出路是把分区列并进唯一键，语义降级为分区内唯一" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">UNIQUE(email) 撞上 PARTITION BY HASH(id)：ERROR 1503</text>
<rect class="bx" x="30" y="44" width="140" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="100" y="66" text-anchor="middle" font-size="10" fill="#6b675e">p0 · local idx_email</text>
<text class="ts" x="100" y="84" text-anchor="middle" font-size="10" fill="#6b675e">只能查自己这片</text>
<rect class="bx" x="185" y="44" width="140" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="255" y="66" text-anchor="middle" font-size="10" fill="#6b675e">p1 · local idx_email</text>
<text class="ts" x="255" y="84" text-anchor="middle" font-size="10" fill="#6b675e">只能查自己这片</text>
<rect class="bx" x="340" y="44" width="140" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="410" y="66" text-anchor="middle" font-size="10" fill="#6b675e">p2 · local idx_email</text>
<text class="ts" x="410" y="84" text-anchor="middle" font-size="10" fill="#6b675e">只能查自己这片</text>
<rect class="bx-gone" x="495" y="44" width="140" height="56" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="565" y="66" text-anchor="middle" font-size="10" fill="#6b675e">全局树？</text>
<text class="tc" x="565" y="84" text-anchor="middle" font-size="10" fill="#b03a2e">不存在</text>
<rect class="bx-sick" x="30" y="116" width="605" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="332" y="137" text-anchor="middle" font-size="11" fill="#b03a2e">没人能保证「全表没有第二个 me@x.com」：唯一性要全局成立，索引却各管一片</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">出路三选一：UNIQUE(id, email)（语义降级为「同分区内唯一」）、放弃分区、应用层保证</text>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">1503 是设计阶段就要撞的墙，不是运行时才暴露的坑</text>
</svg>
</figure>

**MAXVALUE 是兜底也是陷阱。** `PARTITION p9 VALUES LESS THAN MAXVALUE` 接住一切越界值（实测 id 超上限的行安落 p9），但它同时**挡住后面的分区切分**：想 `REORGANIZE p9` 加新区时，p9 里已有的行要重排。生产上按月分区的表应该**只建到当前月、留空 MAXVALUE 兜底**（或干脆不建兜底，让越界插入直接报错暴露问题），滚月时 ADD PARTITION 一个新空区毫秒级。

## 按文件操作的得与失

分区的本质是「按文件删、按文件搬」：DELETE 百万行 14.1 秒（19M undo 在为反悔付费），DROP PARTITION 143 毫秒（删一个 .ibd），EXCHANGE 80 毫秒（字典指针互换），98 倍与 0 复制。归档场景的最优路径固定：EXCHANGE 出去留档、新表换入，全程不碰行。

裁剪不是索引的替代品：索引友好的范围条件，B+ 树早把裁剪的活干了（实测两表 45 vs 55ms、页读持平）；裁剪的真本事在**无法走索引的条件**和**分区即并发单位**的场景。先想清楚查询形状，再决定要不要切。

三笔税：广播、唯一键、打开成本。二级索引条件不带分区键时广播到每棵 local 树；唯一键必须含分区列（ERROR 1503 是设计期的墙，语义从「全局唯一」降级为「分区内唯一」）；10 个分区是 10 个 .ibd、10 套统计。**分区解决的是「数据生命周期」问题（删、归档、滚动），不是「查询快」问题**。为了快而分区，九成是错的开局。

分区的敌人是排队，不是行数：143ms 的 DROP PARTITION 被长事务拖成 40.7 秒（284 倍），比算法差距还大。DDL 前查长事务，第十篇的纪律在这里同样保命。

下一篇收个尾：前面十一篇把 InnoDB 的存储现场拆完了，最后一站是**查询之外的那只手，performance_schema 与事件仪器**。把本系列一路当量具用的计数器和仪器体系本身讲透（量具的量具），给全系列画上句号。
