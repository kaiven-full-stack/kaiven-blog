---
title: 量具的量具：performance_schema 与事件金字塔
description: MySQL 系列第十二篇（收官）。本系列一路拿 Handler 计数器、buffer pool 页读、hash_join 仪器当量具，最后一篇把量具本身拆开：1260 个仪器默认开 780 个，语句与事务层默认记录、wait 与 stage 层默认关；一条 10.7 秒的 LIKE 全表扫在四层事件金字塔里现形（executing 10.75s、handler 表 IO 5.4s、InnoDB 文件读 9996 次）。两个反直觉实测：wait+stage 全开对冷跑与 2000 事务批量的开销都消失在噪声里，「P_S 拖慢生产」是过时直觉；INSERT...SELECT 的 509 次 Handler 读只对应 1 条语句事件，口径对不上不是 bug，是量具的分层。外加 digest 指纹、235MB 自耗与 sys 库 101 个视图的来历，最后给全系列收官。
pubDate: 2026-10-02
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

一条 10.7 秒的全表扫，四个层次各说各话：语句层 1 个事件 10.7 秒；阶段层 14 个 stage，executing 独占 10.75 秒；等待层 9996 次 InnoDB 文件读，外加 1 次 handler 表 IO 5.4 秒。同一件事，三种分辨率。量具从来不只一套；它是一座金字塔。

写到这里，系列已经拆过 B+ 树、MVCC、锁、恢复、优化器、复制、缓冲池、两阶段提交、连接算法、online DDL、分区表，十一篇里每一篇都在用**量具**：Handler 计数器对回表、`Innodb_buffer_pool_read_requests` 对页读、`wait/io/file/sql/binlog` 对 fsync、`wait/io/file/sql/hash_join` 对溢写。但量具自己从没被拆过：这些数字从哪来、谁在记录、记多细、要付多少钱？收官篇就拆这最后一层：**performance_schema（下称 P_S），MySQL 的自我观察系统**，量具的量具。

先盘仪器。8.4 里 P_S 默认开启，注册了 **1260 个仪器（instrument）**、默认开 780 个。仪器按家族分：`wait/io`（文件与表 IO）59 个开 52、`memory/*`（内存分配）475 个全开、`statement/sql` 160 个全开、`stage/sql` 119 个**只开 4 个**、`wait/synch`（锁与 latch）342 个**全关**。这个开关表本身就是一份设计宣言，往下看。

## 四层金字塔：同一件事的四种分辨率

P_S 的世界观是**事件（event）金字塔**，自下而上四层：

```text
transaction   （事务：BEGIN 到 COMMIT，隔离级别、锁时间）
statement     （语句：每条 SQL，耗时、扫行数、错误码）
stage         （阶段：语句内的 executing / Sending data / Opening tables…）
wait          （等待：一次文件读、一次表 IO、一次 latch——最细的原子动作）
```

下层是上层的零件：一条语句事件通过 `NESTING_EVENT_ID` 指向自己的 stage，stage 指向 wait，一根串起来的链。实测把它完整跑出来。开齐 wait/stage 的 consumer 与仪器（默认是关的，见下节），跑一条冷池的全表扫 `WHERE pad LIKE '%zzz%'`（10.7 秒），然后逐层取剖面：

```text
语句层（events_statements_history_long）
  statement/sql/select         1 个事件    10.7 s    SQL_TEXT、扫行数俱全

阶段层（events_stages_history_long, NESTING_EVENT_ID 串起来）
  stage/sql/executing          14 次      10.75 s   ← 独占几乎全部
  stage/sql/starting           23 次      ~0
  stage/sql/freeing items      17 次      ~0

等待层（events_waits_history_long）
  wait/io/table/sql/handler    1 次       5.4 s     ← 表 IO 大头
  wait/io/file/innodb/...      9996 次    92 ms 合计 ← 冷池的物理读
  idle                         3 次       0.1 ms    ← 连接闲着也算事件
```

四层读法各擅其长：**语句层答「谁慢」**（哪条 SQL、多久、扫了多少行，`events_statements_history_long` 的 33 行环形缓冲里躺着最近的历史）；**阶段层答「卡在哪一步」**（executing 独占 10.75s，说明不是优化、不是开表、不是送结果，就是干）；**等待层答「在等什么」**（handler 表 IO 5.4 秒 + 9996 次文件读，冷池的页在被逐页拉进来，呼应第七篇）。**金字塔的用法是自上而下钻取**：先语句找嫌疑人，再 stage 定位卡点，最后 wait 拿物证。

一个容易忽略的细节：**仪器开着才有事件**。stage 层我第一次查是空的，因为 `stage/sql` 家族 119 个仪器默认只开 4 个，`executing` 不在其中；`UPDATE setup_instruments SET ENABLED='YES'` 补开后才现形。**「表是空的」在 P_S 里几乎总是「仪器没开」而不是「没发生」**，这是新手最大的坑。

## 开销：那个吓退一代人的传说

「P_S 拖慢生产」是 DBA 圈流传多年的话术，源头是 5.x 时代 wait 事件逐条记账的锁竞争。8.4 的实测给了它一记反驳：**两个场景，开销都消失在噪声里**。

场景一（冷跑单查询）：wait+stage 全开 vs 默认，同一 LIKE 全表扫：

```text
默认（wait/stage 关）      5.54 s    复跑 5.17 s
全开（wait/stage 全上）    5.22 s    ← 更快，纯噪声
```

场景二（高事件率批量）：2000 个自动提交事务（每事务 1 语句 + 若干 wait 事件）：

```text
默认      3.99 s   复跑 4.19 s
全开      4.28 s   复跑 4.10 s    ← ~2% 以内，不可分辨
```

为什么这么便宜？8.x 的 P_S 早已改造：事件缓冲是**每线程无锁环形缓冲**（不再全局争抢）、wait 仪器的计时用的是廉价的单调时钟读取、未启用的仪器**编译期短路**（`ENABLED=NO` 的仪器在代码路径上只过一个分支判断）。真正贵的从来不是「开着」，而是**开着 history_long 的高吞吐场景反复大表扫描**（环形缓冲写得飞快、查询又全表扫它）。P_S 自己的表也是表，查它的代价走普通查询优化。生产建议很朴素：**默认配置放心用，wait/stage 按需临时开（`UPDATE setup_consumers` 运行时生效），用完关掉**；注意 consumer 是内存态，**重启就回默认**。我实测重启即复原，别指望它持久。

P_S 自己的开销也要看一眼：**235MB 自耗**（`memory_summary_global_by_event_name` 里 `memory/performance_schema/*` 的合计，其中 digest 汇总表独占 40.3MB）。这是「观察系统本身的重量」，128MB 池的实验机上占了大头，生产 TB 级内存里是零头。

## 口径核对：509 次 Handler 读 vs 1 条语句事件

系列里量具用得最狠的是 Handler 计数器（第一篇「回表 40 万页读」、第九篇 hash join 对比）。收官做一次口径核对，看系列的两套量具在 P_S 眼里是什么。实验：一条 `INSERT INTO ps_t SELECT id, 1 FROM users WHERE id <= 500`（源表扫 500 行）：

```text
Handler_read_next 差值           509
events_statements_history        1 个事件（这条 INSERT）
events_statements_summary_by_digest 的 COUNT_STAR    +1
```

**509 vs 1，都对，量的是不同层。** Handler 是 server 层向存储引擎「要行」的次数（`Handler_read_next` 500 行逐行 + 9 次树定位/批切换；写侧另有 `Handler_write` 涨了 500。它是个混着后台噪声的粗计数器，这也是踩过才知道的坑：`Com_commit` 不数自动提交）；语句事件是「这条 SQL 整体」的记录。P_S 里没有 509 这个数吗？有：它在语句事件的 `ROWS_EXAMINED` 与等待层的 `wait/io/table/sql/handler` 计数里，**只是分辨率不同**。这就是量具分层的意义：**计数器快而粗（一次原子加），事件金字塔细而贵（要留痕）**。系列的快速对比全用计数器，解剖单条 SQL 才上金字塔，两条路各走各的。

顺带把系列的另一件量具归进体系：`Innodb_buffer_pool_reads` 这类 SHOW STATUS 计数器住在 `global_status` 表里（第七篇的 `read_requests`、第八篇的 `binlog` 仪器）。它们**不属于事件金字塔**，是独立于 P_S 的轻量计数器体系（有些在 P_S 之前就存在）。而 `wait/io/file/sql/hash_join`（第九篇）和 `wait/io/file/sql/binlog`（第八篇）是**金字塔 wait 层的仪器**。系列里你已经用了一整座金字塔的塔尖。

最后一件系列没拆过的宝贝：**digest 指纹**。每条语句解析时被规约成模板（字面量换成 `?`：`INSERT INTO ps_t SELECT ...` 与 `INSERT INTO ps_t SELECT ... WHERE id <= ?` 同指纹），模板哈希成 64 位 hex（实测 `44e35cee979b...`），**同指纹的语句在 `events_statements_summary_by_digest` 聚合成一行**：次数、总耗时、扫行数、首见末见时间。这是「哪类 SQL 最贵」的答案表：不用抓慢日志，SQL 现场聚合。上限 `max_digest_length=1024` 字节，超长 SQL 的指纹截断（超长 in 列表会折叠不全）。**sys 库的 101 个视图**就是这张表的糖衣（`sys.statements_with_runtimes_in_95th_percentile` 之类）。sys 不采集任何东西，只是 P_S 表的预写查询。

## 排查的标准动作

十二篇的量具经验收敛成一个流程。**第一步：`events_statements_summary_by_digest` 按 SUM_TIMER_WAIT 排序**，找最贵的指纹，不用等慢日志。**第二步：拿指纹去 `events_statements_history`** 看最近一次执行的 ROWS_EXAMINED vs ROWS_SENT（扫 100 万送 10 行 = 第九篇的回表/扇出问题）。**第三步：必要时开 stage/wait**（`UPDATE setup_consumers ... YES`）对单条 SQL 钻取，阶段定位卡点、等待拿证据。**第四步：回到系列前十一篇的知识**：是页读的问题去查第七篇的缓冲池，是估计跑偏去第五篇的直方图，是锁去第三篇的 MDL，是分区广播去第十一篇。量具告诉你「哪里慢」，十一篇的结构知识回答「为什么慢、怎么改」。

这套动作里藏着本篇最后一条纪律：**口径先行**。第五篇的「三种口径」（行数/磁盘页/页访问次数）到本篇的「四层分辨率」（事务/语句/阶段/等待），系列反复撞见同一堵墙：**数字不一致时，先问量具量的是什么单位，再问谁对谁错**。`Handler_read_next` 509 次、`ROWS_EXAMINED` 500 行、文件读 9996 次，说的是同一条 SQL 的三个侧面。把口径问清楚，「优化器选错了」会变成「你俩没在对口径」（第五篇），「P_S 拖慢生产」会变成「8.x 早不是那个时代」（本篇）。**量具的怀疑精神，是这一系列最想留给你的东西**。

## 收官：一条 SQL 的完整一生

十二篇，从一行数据的字节布局走到量具本身，刚好绕成一个环。第一篇拆页、区、段与 B+ 树，数据住在哪；第二篇 MVCC，一行读旧版本怎么做到不锁；第三篇锁，写与写怎么互斥、MDL 怎么排队；第四篇恢复，拔电源后靠什么站起来；第五篇优化器，代价怎么估、口径怎么对；第六篇复制，一份账本怎么变成多份；第七篇缓冲池，页在内存里的进出与生死；第八篇两阶段提交，一笔提交跨两本日志的那一停；第九篇连接算法，两张表怎么拼最便宜；第十篇 online DDL，表结构怎么在线地变；第十一篇分区，表怎么按文件切、按文件删；本篇量具，这一切怎么被看见。

串成一句话：**一条 SQL 落进 InnoDB，先被解析成指纹（本篇），被优化器估价（第五篇），可能走 B+ 树点查（第一篇）、可能回表（第一篇）、可能拼表（第九篇）；读的页来自缓冲池，miss 了才碰磁盘（第七篇）；写的事务穿过两阶段提交（第八篇），改动进 undo 与 redo（第二、四篇），可能被锁挡住（第三篇）；表结构在在线地演化（第十篇），数据按片归档（第十一篇），账本复制成多份（第六篇）。而这一切的每一步，都有一个仪器在记录（本篇）。**

钉住 MySQL 8.4 LTS 的这十二篇，全部实验来自同一台 docker 里的 8.4.11，所有数字当场跑出来、源码逐行对上。**两个独立来源对上的瞬间，是做实验最踏实的瞬间**（第一篇的话，收官时依然成立）。系列到此收官；PITR、直方图、hypergraph 优化器都还是空位，下一篇写哪块，看下一个问题什么时候出现。
