---
title: 秒过千万行：online DDL 的三档速度与门链
description: MySQL 系列第十篇。同一张千万行的表，加一列 28 毫秒、建索引 10 秒、改列型 46 秒，差距 1500 倍，全在 ALGORITHM 三个档位里。本篇实测 INSTANT/INPLACE/COPY：INSTANT 只动数据字典（文件 1004MB 一动不动、DROP COLUMN 也 31ms）；INPLACE 建影子表并发写入全程 2.8ms 无感、中途插入靠 online log 补进索引；COPY 的 #sql-1_61.ibd 从 128KB 长到 545MB 被逐步拍下。外加 MDL 门链时间线：28ms 的 INSTANT 被一个开着的事务拖成 11 秒、顺路挡了无辜 SELECT 8 秒。最慢的 DDL 不是算法慢，是排队。8.4 的 row version 源码记录与 INSTANT 支持矩阵逐条对上。
pubDate: 2026-09-25
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

千万行表加一列（`DEFAULT 7`，ALGORITHM=INSTANT）：28 毫秒，文件 1004MB → 1004MB，一个字节都没动。同一张表改列型 INT→BIGINT：46 秒，影子表长到 545MB。1650 倍的差距与行数无关，来自「要不要碰行」。

前面的九篇都在讲「一条 SQL 怎么跑」；这一篇讲**一条不常跑但一出事就上新闻的 SQL：ALTER TABLE**。百万行在线的表上加列、加索引、改列型，DBA 的经典恐惧来自旧时代：改个字段锁全表几小时。8.0 开始这事被拆成了三档速度：**INSTANT（元数据级，毫秒）、INPLACE（影子重建，分钟）、COPY（整表复制，最慢）**。第十篇把三档全部实测一遍，包括 8.4 里几个「文档要翻新」的意外。

先搭实验台：`ddl_t`，一千万行、1GB 数据。每种操作都先在 1 万行的小表上试错探测支持矩阵，再上千万行计时。

## 试错法：先把支持矩阵跑出来

MySQL 没有 `EXPLAIN ALTER`（MariaDB 才有），探测某个操作支持哪档算法最直接的办法是**显式指定、让服务器拒绝你**：`ALGORITHM=INSTANT` 报 1845/1846 错就是不支持，错误信息还附带原因。1 万行小表上把常见操作 × 三档全试一遍：

| 操作 | INSTANT | INPLACE | COPY |
| --- | --- | --- | --- |
| ADD COLUMN（尾部） | ✅ | ✅ | ✅ |
| ADD COLUMN FIRST | ✅ | ✅ | ✅ |
| **DROP COLUMN** | ✅ | ✅ | ✅ |
| ADD INDEX | ❌ 1845 | ✅ | ✅ |
| MODIFY VARCHAR(80→100)（扩容） | ❌ 1845 | ✅ | ✅ |
| MODIFY VARCHAR(80→40)（缩容） | ❌ | ❌ 1846 | 需 COPY* |
| MODIFY INT→BIGINT（改型） | ❌ | ❌ 1846 | ✅ |
| RENAME COLUMN | ✅ | ✅ | ✅ |

*缩容那格 COPY 也没跑成：数据超长被拒，换短数据后 COPY 可用。

三个发现值得圈出来。**第一：ADD COLUMN FIRST 走 INSTANT。** 8.0.12 之前「加在末尾」是 INSTANT 的硬条件，8.0.29 起任意位置都行，很多老文档还停在「必须 LAST」的年代。**第二：DROP COLUMN 走 INSTANT。** 8.0.29 前删列必须重建整表（数亿行的表删个字段要小时级），8.0.29 起秒删，这是本篇实测里最「新闻性」的一条。**第三：扩容 VARCHAR 走 INPLACE 不用重建。** 80→100 字节没有跨过变长长度字节数的档位（1 字节长度前缀覆盖 0-255），属于「原地改元数据」；但缩容和改型必须 COPY，错误码 1846 的 reason 写得明明白白：`Need to rebuild the table to change column type`。

## 三档计时：28ms / 10s / 46s

千万行上跑三档，同一张表，逐个计时并盯住文件大小：

```text
ADD COLUMN c1 INT DEFAULT 7, ALGORITHM=INSTANT
  耗时 27.8 ms；文件 1004MB → 1004MB
  事后 SELECT：COUNT(c1)=1000 万，SUM(c1)=700 万（前 1000 行）← 默认值全员生效

ADD INDEX idx_c1(c1), ALGORITHM=INPLACE, LOCK=NONE
  耗时 10.1 s

MODIFY c1 INT→BIGINT, ALGORITHM=COPY
  耗时 46.2 s；期间目录里出现 #sql-1_61.ibd，逐步看它长大：
  128KB → 121MB → 226MB → 331MB → 440MB → 545MB → … → 建完换名转正
```

三档摆在同一根比例尺上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 176" role="img" aria-label="千万行表三档 DDL 耗时等比条形图：INSTANT 加列 27.8 毫秒短到在这个比例尺下只剩一个点，INPLACE 建索引 10.1 秒，COPY 改列型 46.2 秒，差距 1650 倍，与行数无关，全在要不要碰行" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一张千万行表：条长严格等比（10 像素 = 1 秒）</text>
<text class="ts" x="20" y="60" font-size="11" fill="#6b675e">INSTANT 加列</text>
<rect class="bar" x="150" y="46" width="3" height="18" fill="#2b2a26"/>
<text class="tc" x="161" y="60" font-size="11" fill="#b03a2e">27.8ms：这个比例尺下只剩一个点 · 文件 1004MB 一动不动</text>
<text class="ts" x="20" y="96" font-size="11" fill="#6b675e">INPLACE 建索引</text>
<rect class="bar" x="150" y="82" width="101" height="18" fill="#2b2a26"/>
<text class="ts" x="259" y="96" font-size="11" fill="#6b675e">10.1s · 扫聚簇树建新树，不重写行</text>
<text class="ts" x="20" y="132" font-size="11" fill="#6b675e">COPY 改列型</text>
<rect class="bar" x="150" y="118" width="462" height="18" fill="#b03a2e"/>
<text class="onbar" x="160" y="132" font-size="10" fill="#f6f3ec">46.2s · 影子表一行行抄，545MB</text>
<text class="ts" x="20" y="162" font-size="12" fill="#6b675e">1650 倍与行数无关，只在「要不要碰行」；能 INSTANT 不 INPLACE，能 INPLACE 不 COPY</text>
</svg>
</figure>

**INSTANT 的 27.8ms 没有碰任何一行。** 文件一动不动、行数不变，但新列立刻可查、默认值立刻在场。原因是**默认值就住在数据字典里**：8.0 的字典表（`mysql.dd_properties` 时代）为 INSTANT 加的列记了默认值，读旧行时按字典补出来。第一篇讲过 .ibd 的 SDI 自描述；8.0.12 之前的 INSTANT v1 把「行里有几列」记在第一个用户页的 PAGE_TYPE 上，只在加过列的表上有效；**8.0.29 的 v2 改成字典里记「行版本号」**：每个新加的列带 `version_added`、被删的列带 `version_dropped`（源码 `dict0mem.h`），读行时按「这一行的版本号」决定哪些列该补默认值、哪些列该跳过。**同一张表可以反复 ADD/DROP，行版本最多 64 代**（`MAX_ROW_VERSION`，源码明写 `version <= MAX_ROW_VERSION` 才合法）。第 65 次 INSTANT 加列会被拒绝，逼你做一次真重建来「归零」版本计数。这个上限日常碰不到，但它解释了为什么 INSTANT 不是无限免费。

字典代偿的机制：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 226" role="img" aria-label="INSTANT 的字典代偿：数据字典记下新列 c1 的默认值 7 和 version_added=2；版本 1 的旧行物理上没有 c1，读取时按字典补默认值；版本 2 的新行数据当场；每张表行版本最多 64 代，第 65 次 INSTANT 被拒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my10As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">ALTER 只改字典：行的物理字节一个没动</text>
<rect class="bx-q" x="20" y="44" width="210" height="96" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="125" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">数据字典</text>
<text class="ts" x="125" y="88" text-anchor="middle" font-size="10" fill="#6b675e">c1：DEFAULT 7</text>
<text class="ts" x="125" y="104" text-anchor="middle" font-size="10" fill="#6b675e">version_added = 2</text>
<text class="ts" x="125" y="120" text-anchor="middle" font-size="10" fill="#6b675e">被删的列记 version_dropped</text>
<line class="fl" x1="230" y1="76" x2="296" y2="70" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my10As2)"/>
<text class="ts" x="263" y="60" text-anchor="middle" font-size="10" fill="#6b675e">读取时补</text>
<rect class="bx" x="300" y="48" width="330" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="465" y="64" text-anchor="middle" font-size="11" fill="#6b675e">旧行 · 行版本 1（加列前写入）</text>
<text class="tc" x="465" y="80" text-anchor="middle" font-size="10" fill="#b03a2e">物理上没有 c1：按字典补出 c1=7</text>
<rect class="bx-q" x="300" y="100" width="330" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="465" y="116" text-anchor="middle" font-size="11" fill="#6b675e">新行 · 行版本 2（加列后写入）</text>
<text class="ts" x="465" y="132" text-anchor="middle" font-size="10" fill="#6b675e">c1 数据当场，不欠字典</text>
<rect class="bx-sick" x="20" y="156" width="610" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="325" y="177" text-anchor="middle" font-size="11" fill="#b03a2e">MAX_ROW_VERSION = 64：第 65 次 INSTANT 加列被拒，逼一次真重建把版本计数归零</text>
<text class="ts" x="20" y="214" font-size="12" fill="#6b675e">8.0.29 起 ADD/DROP/任意位置都走这套行版本记账：秒过的代价是字典里多几笔版本账</text>
</svg>
</figure>

**COPY 的 46 秒是「一行一行抄」。** `#sql-1_61.ibd` 是影子表：新表按新结构建好，服务器把旧表行读出、转换、写入影子表，建完索引、校验后**原子换名**（影子表改名成 ddl_t，旧表换名为 `#sql-ib` 留给你确认后删除）。545MB 的成长轨迹就是复制进度的实时进度条：运维盯 DDL 时 `ls /var/lib/mysql/db/#sql*` 比 SHOW PROCESSLIST 直观。COPY 期间写入是**被阻塞**的（它要拿全表排他锁，这一点下节对照）。

影子表的成长轨迹：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 230" role="img" aria-label="COPY 期间影子表文件的增长折线：sql-1_61.ibd 从 128KB 起步，被逐步拍下 121MB、226MB、331MB、440MB、545MB，建完索引校验后原子换名转正；顶部横条表示 COPY 全程 46 秒写入被全表排他锁阻塞" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">COPY 全程：写入被全表排他锁阻塞 46 秒</text>
<rect class="bx-sick" x="20" y="36" width="620" height="20" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="330" y="50" text-anchor="middle" font-size="10" fill="#b03a2e">EXCLUSIVE：INSERT / UPDATE 全部排队</text>
<text class="ts" x="20" y="82" font-size="11" fill="#6b675e">#sql-1_61.ibd 的尺寸（MB）</text>
<line class="grid" x1="70" y1="140" x2="610" y2="140" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="100" x2="610" y2="100" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="196" x2="70" y2="92" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="196" x2="620" y2="196" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="144" text-anchor="end" font-size="10" fill="#6b675e">300</text>
<text class="ts" x="62" y="104" text-anchor="end" font-size="10" fill="#6b675e">600</text>
<polyline class="curve-k" points="100,196 200,180 300,166 400,152 500,137 570,123" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="100" cy="196" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="200" cy="180" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="300" cy="166" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="400" cy="152" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="500" cy="137" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="570" cy="123" r="3" fill="#b03a2e"/>
<text class="ts" x="100" y="212" text-anchor="middle" font-size="10" fill="#6b675e">128KB</text>
<text class="ts" x="200" y="212" text-anchor="middle" font-size="10" fill="#6b675e">121</text>
<text class="ts" x="300" y="212" text-anchor="middle" font-size="10" fill="#6b675e">226</text>
<text class="ts" x="400" y="212" text-anchor="middle" font-size="10" fill="#6b675e">331</text>
<text class="ts" x="500" y="212" text-anchor="middle" font-size="10" fill="#6b675e">440</text>
<text class="ts" x="570" y="212" text-anchor="middle" font-size="10" fill="#6b675e">545MB</text>
<text class="tc" x="565" y="112" text-anchor="end" font-size="10" fill="#b03a2e">建完换名转正</text>
<text class="ts" x="20" y="228" font-size="11" fill="#6b675e">盯 DDL 的土办法：ls /var/lib/mysql/db/#sql*，文件尺寸就是进度条</text>
</svg>
</figure>

**INPLACE 的 10 秒是最微妙的一档。** 建索引不复制行、不动数据页，只**扫描聚簇树构建新索引树**。同样千万行，建索引 10 秒对改列型 46 秒，差的就是「要不要重写行」。但 INPLACE 的真正卖点不在快，在下一节。

## 并发：57 秒的重建，写入无感

三档算法真正的分界线是**并发**。实验：一个连接跑 `ALTER ... ADD INDEX, ALGORITHM=INPLACE, LOCK=NONE`（千万行，57 秒），同时另一个连接往表里 INSERT：

```text
INSERT（重建进行中）  2.8 ms   ← 无感
INSERT（重建中段）    3.6 ms   ← 无感
ALTER 完成           57.5 s
```

**重建的 57 秒里，写路径全程毫秒级。** LOCK=NONE 的意思是：DDL 不拿阻塞 DML 的表锁，这是「online」一词的本义。但这里有个必然的追问：**重建进行到一半时插进来的行，索引里没有它，怎么办？** 再补一个实验：重建**开始前**插一行 `log-probe-1`、重建**进行中**插一行 `log-probe-2`，ALTER 结束后用索引查：

```text
SELECT COUNT(*) FROM ddl_t WHERE pad = 'log-probe-1';   → 1  （走 idx_pad）
SELECT COUNT(*) FROM ddl_t WHERE pad = 'log-probe-2';   → 1  （走 idx_pad）
```

两行都在索引里。机制叫 **online log（变更日志/row log）**：INPLACE 重建期间，所有并发 DML 的变更被同时**追加进一个日志**；重建主体完成后，DDL 拿一次短暂的排他锁（毫秒到秒级），**回放这份日志**把中途的变更补进新索引。代价是双份写（DML 既改表也记日志），收益是 57 秒的重建窗口里业务零感知。「online」的构成：**大头不锁 + 尾部一小锁**。尾部那一下平时没人注意，但它存在：日志回放量大的 DDL 收尾会卡一下写入，重建越久窗口越大。

57 秒里的双写与收尾：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="INPLACE 重建 57 秒的时间线：主条是重建过程，不拿阻塞 DML 的表锁，两次并发 INSERT 分别 2.8 和 3.6 毫秒无感完成；每笔并发 DML 双写进 online log；重建主体完成后 DDL 拿一次短暂排他锁回放日志，把中途变更补进新索引" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my10As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">LOCK=NONE 的 57 秒：大头不锁，尾部一小锁</text>
<line class="flk" x1="200" y1="38" x2="200" y2="52" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="200" y="32" text-anchor="middle" font-size="10" fill="#6b675e">INSERT 2.8ms</text>
<line class="flk" x1="340" y1="38" x2="340" y2="52" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="340" y="32" text-anchor="middle" font-size="10" fill="#6b675e">INSERT 3.6ms</text>
<rect class="bx" x="110" y="54" width="444" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="120" y="70" font-size="10" fill="#6b675e">INPLACE 重建进行中 · 57.5s：扫描聚簇树建新索引，不阻塞 DML</text>
<rect class="bx-sick" x="554" y="54" width="18" height="24" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="563" y="46" text-anchor="middle" font-size="10" fill="#b03a2e">尾部小锁</text>
<line class="flc" x1="200" y1="78" x2="200" y2="102" stroke="#b03a2e" stroke-width="1.2" stroke-dasharray="4 3"/>
<line class="flc" x1="340" y1="78" x2="340" y2="102" stroke="#b03a2e" stroke-width="1.2" stroke-dasharray="4 3"/>
<rect class="bx-sick" x="110" y="106" width="444" height="24" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="332" y="122" text-anchor="middle" font-size="10" fill="#b03a2e">online log：每笔并发 DML 双写（既改表，也记日志）</text>
<line class="flc" x1="548" y1="112" x2="562" y2="82" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#my10As3)"/>
<text class="ts" x="480" y="100" text-anchor="middle" font-size="10" fill="#6b675e">收尾回放</text>
<text class="ts" x="20" y="158" font-size="12" fill="#6b675e">重建中途插入的 log-probe-2，靠这次回放补进新索引：事后两路探针都走索引可查</text>
<text class="ts" x="20" y="180" font-size="12" fill="#6b675e">重建越久、日志越多，尾部锁越长：那一下平时没人注意，但它存在</text>
</svg>
</figure>

COPY 的并发是另一个极端：**重建全程拿排他锁，写入全部阻塞 46 秒**。所以 COPY 的问题不只是慢，还有不 online：8.0 之后它的地盘越缩越小，只剩「引擎不支持的改型」和「显式要一致性快照」两种场景。

## 最慢的 DDL：不是算法慢，是排队

三档讲完，看一个反例：**28ms 的 INSTANT 也可能变成 11 秒**。时间线实验，三个连接按序入场：

```text
A：BEGIN; SELECT ... FOR UPDATE;（事务挂着，10 秒后才提交）  t=0
B：ALTER TABLE ddl_t ADD COLUMN c2 ... ALGORITHM=INSTANT    t=1
C：SELECT COUNT(*) ...（无辜的全表读）                       t=3

结果：B 的 ALTER 等了 11.04 s 才完成；C 的 SELECT 等了 8.04 s。
      而 ALTER 本身只值 28ms。
```

A 的行锁跟 DDL 毫无关系（改的是另一行的 MDL 意向）；但 A 的事务挂着 `SHARED` 级 MDL 不放，B 的 ALTER 需要 `EXCLUSIVE` MDL 只能排队；**C 只需要 SHARED，本来跟 A 不冲突，但 MDL 队列讲先来后到，排在 EXCLUSIVE 后面的请求必须一起等**。门链：A 挡 B，B 挡 C。第三篇锁之旅讲过这个案例的解法（KILL 掉 B，C 毫秒级放行，实测当时 C 比 A 提交早 15 秒完成）；本篇补上量化：**INSTANT 的 28ms 被一个普通事务拖成 11.04 秒，膨胀 394 倍**。DDL 的风险预算别只算算法耗时：**排队时间上不封顶，且默认 `lock_wait_timeout` 给 DDL 的是一年**。上线 DDL 前查 `information_schema.innodb_trx` 有没有长事务，比挑算法更能保命。

11 秒是怎么花掉的：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="MDL 门链甘特图：A 的事务持有 SHARED MDL 十秒才提交；B 的 INSTANT ALTER 从 t=1 起排队等 EXCLUSIVE，等了 11.04 秒而本体只值 28 毫秒；C 的无辜 SELECT 从 t=3 起排在 EXCLUSIVE 后面等了 8.04 秒；A 一提交，B 和 C 相继放行" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三个连接按序入场：A 挂事务、B 发 ALTER、C 只想读</text>
<text class="ts" x="20" y="58" font-size="11" fill="#6b675e">A · 事务</text>
<rect class="bx-q" x="110" y="44" width="380" height="18" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="57" font-size="10" fill="#6b675e">持 SHARED MDL：BEGIN + FOR UPDATE，10 秒后才提交</text>
<text class="ts" x="20" y="94" font-size="11" fill="#6b675e">B · ALTER</text>
<rect class="bx-sick" x="148" y="80" width="420" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="156" y="93" font-size="10" fill="#6b675e">排队等 EXCLUSIVE MDL：11.04s</text>
<rect class="bar" x="568" y="80" width="4" height="18" fill="#2b2a26"/>
<text class="tc" x="560" y="72" text-anchor="end" font-size="10" fill="#b03a2e">本体只值 28ms</text>
<text class="ts" x="20" y="130" font-size="11" fill="#6b675e">C · SELECT</text>
<rect class="bx" x="224" y="116" width="306" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="232" y="129" font-size="10" fill="#6b675e">排在 EXCLUSIVE 后面陪等：8.04s</text>
<rect class="bar" x="530" y="116" width="4" height="18" fill="#2b2a26"/>
<line class="flc" x1="490" y1="38" x2="490" y2="142" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3"/>
<text class="tc" x="496" y="156" font-size="10" fill="#b03a2e">t=10 A 提交：B 放行，C 跟着放行</text>
<line class="axis" x1="110" y1="170" x2="600" y2="170" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="110" y="186" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="224" y="186" text-anchor="middle" font-size="10" fill="#6b675e">t=3 C 入场</text>
<text class="ts" x="338" y="186" text-anchor="middle" font-size="10" fill="#6b675e">6s</text>
<text class="ts" x="490" y="186" text-anchor="middle" font-size="10" fill="#6b675e">10s</text>
<text class="ts" x="600" y="186" text-anchor="middle" font-size="10" fill="#6b675e">13s</text>
<text class="ts" x="148" y="186" text-anchor="middle" font-size="10" fill="#6b675e">t=1</text>
<text class="ts" x="20" y="212" font-size="12" fill="#6b675e">门链：A 挡 B、B 挡 C；C 与 A 本来完全兼容，输在队列的先来后到</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">上线 DDL 前查 innodb_trx 有没有长事务，比挑算法更能保命</text>
</svg>
</figure>

## 三档速度之外

三档速度，1650 倍。千万行实测：INSTANT 加列 27.8ms（字典级，文件一动不动）、INPLACE 建索引 10.1s（扫树建新树，不重写行）、COPY 改型 46.2s（影子表一行行抄，545MB 成长轨迹）。挑算法的顺序是本能反应：**能 INSTANT 不 INPLACE，能 INPLACE 不 COPY**。但 INPLACE/COPY 的选择权常在操作本身手里（改型必须 COPY，文档矩阵先查）。

INSTANT 的魔法是字典代偿，上限是版本计数：默认值住字典、旧行按行版本号补列跳列，ADD/DROP 都秒过（8.0.29 起任意位置）；但每张表最多 64 个行版本（`MAX_ROW_VERSION`），第 65 次会被拒。INSTANT 不是无限免费，偶尔要靠一次真重建「归零」。

online 的构成是「大头不锁 + 尾部一小锁」：INPLACE 重建 57 秒写入全程 2.8ms 无感，靠 online log 双写；重建中途插入的行，收尾时回放日志补进索引（实测两路探针行事后都走索引）。尾部锁的时长与日志量成正比，重建越久，收尾越重。COPY 全程排他，46 秒写入全阻塞，8.0 后只剩改型等少数场景。

最慢的 DDL 是排队：28ms 的 INSTANT 被长事务拖成 11.04 秒（394 倍），顺路挡死无辜 SELECT 8 秒，MDL 门链的先来后到比任何算法都贵。**DDL 前查长事务、盯 MDL 等待，比背算法矩阵更是保命技**；`lock_wait_timeout` 对 DDL 默认一年，别指望它救你。

下一篇把视角从「一行的生死」挪开：**分区表**。十亿行的表按时间切片，DROP PARTITION 秒删一个季度，那是 online DDL 之外另一种「不碰行」的删除。
