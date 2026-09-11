---
title: 秒过千万行：online DDL 的三档速度与门链
description: MySQL 系列第十篇。同一张千万行的表，加一列 28 毫秒、建索引 10 秒、改列型 46 秒——差距 1500 倍，全在 ALGORITHM 三个档位里。本篇实测 INSTANT/INPLACE/COPY：INSTANT 只动数据字典（文件 1004MB 纹丝不动、DROP COLUMN 也 31ms）；INPLACE 建影子表并发写入全程 2.8ms 无感、中途插入靠 online log 补进索引；COPY 的 #sql-1_61.ibd 从 128KB 长到 545MB 被逐帧拍下。外加 MDL 门链时间线：28ms 的 INSTANT 被一个开着的事务拖成 11 秒、顺路挡了无辜 SELECT 8 秒——最慢的 DDL 不是算法慢，是排队。8.4 的 row version 源码账本与 INSTANT 支持 matrix 逐条对上。
pubDate: 2026-09-25
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

```text
21:07:33  千万行表加一列，DEFAULT 7：28 毫秒。
21:07:33  文件 1004MB → 1004MB。一个字节都没动。
21:09:41  同一张表改列型 INT→BIGINT：46 秒，影子表长到 545MB。
21:09:42  1650 倍。差的不是行数，是「要不要碰行」。
```

前面的九篇都在讲「一条 SQL 怎么跑」；这一篇讲**一条不常跑但一出事就上新闻的 SQL：ALTER TABLE**。百万行在线的表上加列、加索引、改列型——DBA 的经典恐惧来自旧时代：改个字段锁全表几小时。8.0 开始这事被拆成了三档速度：**INSTANT（元数据级，毫秒）、INPLACE（影子重建，分钟）、COPY（整表复制，最慢）**。第十篇把三档全部实测一遍——包括 8.4 里几个「文档要翻新」的意外。

先钉实验台：`ddl_t`，一千万行、1GB 数据。每种操作都先在 1 万行的小表上试错探测支持矩阵，再上千万行计时。

> 读完这一篇，你应该能回答四个问题：**三档算法各贵在哪、差多少？INSTANT 凭什么毫秒过千万行、它有什么上限？INPLACE 重建期间写入为什么不阻塞、中途插的行怎么进索引？最慢的 DDL 为什么往往不是算法慢？**

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

*缩容那格 COPY 也没跑成——数据超长被拒，换短数据后 COPY 可用。

三个发现值得圈出来。**第一：ADD COLUMN FIRST 走 INSTANT。** 8.0.12 之前「加在末尾」是 INSTANT 的硬条件，8.0.29 起任意位置都行——很多老文档还停在「必须 LAST」的年代。**第二：DROP COLUMN 走 INSTANT。** 8.0.29 前删列必须重建整表（数亿行的表删个字段要小时级），8.0.29 起秒删——这是本篇实测里最「新闻性」的一条。**第三：扩容 VARCHAR 走 INPLACE 不用重建。** 80→100 字节没有跨过变长长度字节数的档位（1 字节长度前缀覆盖 0-255），属于「原地改元数据」；但缩容和改型必须 COPY，错误码 1846 的 reason 写得明明白白：`Need to rebuild the table to change column type`。

## 三档计时：28ms / 10s / 46s

千万行上跑三档，同一张表，逐个计时并盯住文件大小：

```text
ADD COLUMN c1 INT DEFAULT 7, ALGORITHM=INSTANT
  耗时 27.8 ms；文件 1004MB → 1004MB
  事后 SELECT：COUNT(c1)=1000 万，SUM(c1)=700 万（前 1000 行）← 默认值全员生效

ADD INDEX idx_c1(c1), ALGORITHM=INPLACE, LOCK=NONE
  耗时 10.1 s

MODIFY c1 INT→BIGINT, ALGORITHM=COPY
  耗时 46.2 s；期间目录里出现 #sql-1_61.ibd，逐帧看它长大：
  128KB → 121MB → 226MB → 331MB → 440MB → 545MB → … → 建完换名转正
```

**INSTANT 的 27.8ms 没有碰任何一行。** 文件纹丝不动、行数不变，但新列立刻可查、默认值立刻在场——因为**默认值就住在数据字典里**：8.0 的字典表（`mysql.dd_properties` 时代）为 INSTANT 加的列记了默认值，读旧行时按字典补出来。第一篇讲过 .ibd 的 SDI 自描述——8.0.12 之前的 INSTANT v1 把「行里有几列」记在第一个用户页的 PAGE_TYPE 上，只在加过列的表上有效；**8.0.29 的 v2 改成字典里记「行版本号」**，每个新加的列带 `version_added`、被删的列带 `version_dropped`（源码 `dict0mem.h`），读行时按「这一行的版本号」决定哪些列该补默认值、哪些列该跳过。**同一张表可以反复 ADD/DROP，行版本最多 64 代**（`MAX_ROW_VERSION`，源码明写 `version <= MAX_ROW_VERSION` 才合法）——第 65 次 INSTANT 加列会被拒绝，逼你做一次真重建来「归零」版本计数。这个上限日常碰不到，但它解释了为什么 INSTANT 不是无限免费。

**COPY 的 46 秒是「一行一行抄」。** `#sql-1_61.ibd` 是影子表：新表按新结构建好，服务器把旧表行读出、转换、写入影子表，建完索引、校验后**原子换名**（影子表改名成 ddl_t，旧表换名为 `#sql-ib` 留给你确认后删除）。545MB 的成长轨迹就是复制进度的实时进度条——运维盯 DDL 时 `ls /var/lib/mysql/db/#sql*` 比 SHOW PROCESSLIST 直观。COPY 期间写入是**被阻塞**的（它要拿全表排他锁，这一点下节对照）。

**INPLACE 的 10 秒是最微妙的一档。** 建索引不复制行、不动数据页，只**扫描聚簇树构建新索引树**——同样千万行，建索引 10 秒对改列型 46 秒，差的就是「要不要重写行」。但 INPLACE 的真正卖点不是快，是下一节的事。

## 并发：57 秒的重建，写入无感

三档算法真正的分界线是**并发**。实验：一个连接跑 `ALTER ... ADD INDEX, ALGORITHM=INPLACE, LOCK=NONE`（千万行，57 秒），同时另一个连接往表里 INSERT：

```text
INSERT（重建进行中）  2.8 ms   ← 无感
INSERT（重建中段）    3.6 ms   ← 无感
ALTER 完成           57.5 s
```

**重建的 57 秒里，写路径全程毫秒级。** LOCK=NONE 的意思是：DDL 不拿阻塞 DML 的表锁——这是「online」一词的本义。但这里有个必然的追问：**重建进行到一半时插进来的行，索引里没有它，怎么办？** 再补一个实验：重建**开始前**插一行 `log-probe-1`、重建**进行中**插一行 `log-probe-2`，ALTER 结束后用索引查：

```text
SELECT COUNT(*) FROM ddl_t WHERE pad = 'log-probe-1';   → 1  （走 idx_pad）
SELECT COUNT(*) FROM ddl_t WHERE pad = 'log-probe-2';   → 1  （走 idx_pad）
```

两行都在索引里。机制叫 **online log（变更日志/row log）**：INPLACE 重建期间，所有并发 DML 的变更被同时**追加进一个日志**；重建主体完成后，DDL 拿一次短暂的排他锁（毫秒到秒级），**回放这份日志**把中途的变更补进新索引。代价是双份写（DML 既改表也记日志），收益是 57 秒的重建窗口里业务零感知——「online」的账本：**大头不锁 + 尾部一小锁**。尾部那一下平时没人注意，但它存在：日志回放量大的 DDL 收尾会卡一下写入，重建越久窗口越大。

COPY 的并发是另一个极端：**重建全程拿排他锁，写入全部阻塞 46 秒**。所以 COPY 不只是慢，是不 online——8.0 之后它的地盘越缩越小，只剩「引擎不支持的改型」和「显式要一致性快照」两种场景。

## 最慢的 DDL：不是算法慢，是排队

三档讲完，看一个反例：**28ms 的 INSTANT 也可能变成 11 秒**。时间线实验，三个连接按序入场：

```text
A：BEGIN; SELECT ... FOR UPDATE;（事务挂着，10 秒后才提交）  t=0
B：ALTER TABLE ddl_t ADD COLUMN c2 ... ALGORITHM=INSTANT    t=1
C：SELECT COUNT(*) ...（无辜的全表读）                       t=3

结果：B 的 ALTER 等了 11.04 s 才完成；C 的 SELECT 等了 8.04 s。
      而 ALTER 本身只值 28ms。
```

A 的行锁跟 DDL 毫无关系（改的是另一行的 MDL 意向）；但 A 的事务挂着 `SHARED` 级 MDL 不放，B 的 ALTER 需要 `EXCLUSIVE` MDL 只能排队；**C 只需要 SHARED，本来跟 A 不冲突，但 MDL 队列讲先来后到——排在 EXCLUSIVE 后面的请求必须一起等**。门链：A 挡 B，B 挡 C。第三篇锁之旅讲过这个案例的解法（KILL 掉 B，C 毫秒级放行——实测当时 C 比 A 提交早 15 秒完成）；本篇补上量化：**INSTANT 的 28ms 被一个普通事务拖成 11.04 秒，膨胀 394 倍**。DDL 的风险预算别只算算法耗时：**排队时间上不封顶，且默认 `lock_wait_timeout` 给 DDL 的是一年**。上线 DDL 前查 `information_schema.innodb_trx` 有没有长事务，比挑算法更能保命。

## 合上账本

**三档速度，1650 倍。** 千万行实测：INSTANT 加列 27.8ms（字典级，文件纹丝不动）、INPLACE 建索引 10.1s（扫树建新树，不重写行）、COPY 改型 46.2s（影子表一行行抄，545MB 成长轨迹）。挑算法的顺序是本能反应：**能 INSTANT 不 INPLACE，能 INPLACE 不 COPY**——但 INPLACE/COPY 的选择权常在操作本身手里（改型必须 COPY，文档矩阵先查）。

**INSTANT 的魔法是字典代偿，上限是版本计数。** 默认值住字典、旧行按行版本号补列跳列，ADD/DROP 都秒过（8.0.29 起任意位置）；但每张表最多 64 个行版本（`MAX_ROW_VERSION`），第 65 次会被拒——INSTANT 不是无限免费，偶尔要靠一次真重建「归零」。

**online 的账本是「大头不锁 + 尾部一小锁」。** INPLACE 重建 57 秒写入全程 2.8ms 无感，靠 online log 双写；重建中途插入的行，收尾时回放日志补进索引（实测两路探针行事后都走索引）。尾部锁的时长与日志量成正比——重建越久，收尾越重。COPY 全程排他，46 秒写入全阻塞，8.0 后只剩改型等少数场景。

**最慢的 DDL 是排队。** 28ms 的 INSTANT 被长事务拖成 11.04 秒（394 倍），顺路挡死无辜 SELECT 8 秒——MDL 门链的先来后到比任何算法都贵。**DDL 前查长事务、盯 MDL 等待，比背算法矩阵更是保命技**；`lock_wait_timeout` 对 DDL 默认一年，别指望它救你。

---

```text
21:07:33  INSTANT 加列：27.8ms，1004MB → 1004MB，默认值从字典来。
21:08:10  INPLACE 建索引：10.1s，写入全程 2.8ms 无感。
21:09:41  COPY 改型：46.2s，#sql-1_61.ibd 逐帧长到 545MB。
21:12:05  INSTANT 被长事务挡 11.04s——比算法贵 394 倍的是排队。
```

系列下一篇把镜头拉到「一行的生死」之外：**分区表**——十亿行的表按时间切片，DROP PARTITION 秒删一个季度，那是 online DDL 之外另一种「不碰行」的删除。
