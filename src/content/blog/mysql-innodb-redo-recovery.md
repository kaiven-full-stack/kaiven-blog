---
title: 断电之后：WAL、redo 日志与崩溃恢复
description: MySQL 系列第四篇。docker kill -9 拔掉电源，3 秒后重启：已提交的 10001 行一行不少，未提交的 5000 行僵尸数据一行不留，CHECK TABLE 全绿。这份从容从哪来？本文把日志拆给你看：一条 UPDATE 的 redo 平均只有 75 字节（宽行 490），页头 LSN 单次前进 489，第一篇「三次 UPDATE 只改 17 字节」里页头页尾那 12 字节的谜底就此揭开；WAL 的证据是「日志已刷盘、21 个页还脏着、checkpoint 落后 5.3MiB」，6 秒后水位追平。然后真的拔两次电：第二次断电前 27MiB redo 未 checkpoint，重启后恢复日志只有一行进度条（源码实锤：回滚超过 1000 个行操作才打印，trx0roll.cc），undo 沿链逆向抄回把僵尸版抹干净。最后是 8.4 的新形态：redo 搬进 #innodb_redo 目录 32 文件环写、#ib_16384 双文件 doublewrite 16MiB 防「写一半的页」、checkpoint 改用消费者式推进。锁全在内存里，重启即散；数据没散，是因为每一笔都先落了日志。
pubDate: 2026-09-12
category: mysql
tags: [MySQL, 数据库, 事务]
---

10001 行已提交的数据，加上一个改了 5000 行还没提交的事务，95 个脏页还没写盘。`docker kill -9`，电源拔了，没有优雅停机，没有刷新。3 秒后服务回来：**已提交的一行不少，未提交的一行不留，CHECK TABLE 报 OK。** 第三篇结尾的问题在这里兑现：锁全住在内存里，重启即散。散的只有锁，数据凭什么没散？

这一篇就是答案：**WAL，先写日志，再写数据。** 每笔改动在碰页面之前先以极小体积落进 redo 日志；脏页慢慢刷、断电后照日志重放。四篇连起来看，InnoDB 的容错设计是一个整体：页与 B+ 树是资产（第一篇），undo 是后悔药（第二篇），锁是并发秩序（第三篇），redo 是断电后的重生（本篇）。

实验环境不变：docker 里的 MySQL 8.4.11。量具以 `SHOW GLOBAL STATUS LIKE 'Innodb_redo_log%'` 与 `SHOW ENGINE INNODB STATUS` 的 LSN 水位为主，核对靠 `docker logs`；本篇最重的一件仪器是 `docker kill -9`。生产事故的断电，在这里可以无限次免费重放。

## redo：一笔改动值多少字节

先看容量。8.4 的 redo 住在 `#innodb_redo/` 目录：32 个 `#ib_redo` 文件环成一个 100MiB 的圈（`innodb_redo_log_capacity`，可在线调），写满一圈回头复用。**redo 是一个环形缓冲区，不是无限追加的日志文件**。这与 8.0 前固定两个 ib_logfile 的设计完全不同，是 8.0.30 起的新形态。

一条 UPDATE 值多少 redo？实测两种行宽（`Innodb_redo_log_current_lsn` 前后差值）：

| 表 | 每事务 | redo 总量 | 每行 |
| --- | --- | --- | --- |
| churn（v 列 1 字节） | 5000 行 | 378,199 字节 | **75 字节** |
| churn_fat（pad 列 200 字节） | 5000 行 | 2,450,180 字节 | **490 字节** |

窄行每行 75 字节，宽行每行 490 字节，差值 415 ≈ 旧值加新值的字节量。**redo 记的是「改了什么」，不是「改完长什么样」**：物理页上的旧字节 → 新字节，加上页号定位，一条紧凑记录。这就是 WAL 的经济学：改 16KiB 的一页只在日志里花几十字节，提交的代价与「改了多少」成正比、与「数据多大」无关。

页自己也有记录。还记得第一篇卖的那个关子吗：三次 UPDATE 前后导出对比，17 个字节变了，其中 12 个在页头页尾，当时一笔带过。现在拆开：

```text
页 4 头部 @16，8 字节：FIL_PAGE_LSN = 2172500093 → 2172503745（前进 3652）
页 4 尾部 @16376，4 字节：旧版校验和（现已废弃）的遗物
页 4 头部 @0，4 字节：CRC32 校验和，随内容变
```

**FIL_PAGE_LSN 是页的「最后修改时间戳」**，即最后一次改动它的事务在全局 LSN 上的位置。受控实验更精确：单行表一次 UPDATE，页 4 的 FIL_PAGE_LSN 前进 489 字节（这条 redo 链还包含页内链表调整等元数据更新）。恢复时它有妙用，下文见。

## WAL：先记日志，再改页面

现在把提交时刻的现场拍下来。插 2 万行（约 8MiB 数据）并提交，`innodb_flush_log_at_trx_commit=1`（默认），提交返回的**那一瞬间**：

```text
Log sequence number          2347537359   ← 已产生的日志末尾
Log flushed up to            2347537359   ← 已刷盘的日志（与上面相等！）
Last checkpoint at           2342232939   ← 检查点，落后 5.3MiB
Modified db pages           21            ← 21 个脏页还没写盘
```

提交那一刻，**redo 已 100% 落盘**（flushed = current）。这就是 `innodb_flush_log_at_trx_commit=1` 的含义，也是「提交成功」的全部实质。但数据页还躺在内存里（21 个脏页），checkpoint 落后 5.3MiB。6 秒后再看：`Modified db pages 0`，水位全部追平。

**WAL 的秩序是：日志先行，页面随意。** 只要日志在，脏页什么时候刷盘无所谓，最坏情况它们没刷，重启时照日志重放一遍。checkpoint 的任务就是给「重放」划一条起跑线：脏页陆续刷盘后，checkpoint 推进，**日志里 checkpoint 之前的部分就可以被回收复用**（环形缓冲区的圈就是这么转起来的）。

断电前那组数字（第二次实验）正好是这个秩序的极端现场：**27MiB 日志未 checkpoint、95 个脏页没刷盘**。按「先写数据」的直觉，这 27MiB 涉及的已提交改动应该丢了。结局是没丢，因为它们在 redo 环里。

## 拔电源

两次断电实验，现场相同：已提交数据 + 一个挂着的未提交事务（`docker exec -d` 的容器内会话，挂 300 秒），`docker kill -9` 直接杀容器，**没有优雅停机、没有 SHUTDOWN、没有最后的刷盘**。

第一次：t_crash 表 10001 行已提交（SUM(v)=50015001），未提交事务正在给前 5000 行做 v+1000000，95 脏页。第二次规模放大：churn_fat 肥行表先灌 30 轮已提交 UPDATE（约 73MiB redo），再挂一个 5000 行肥行未提交事务，断电前 `logical_size=26,959,872`，**27MiB 日志在 checkpoint 前面**。

两次重启的完整恢复日志（`docker logs`，一字未删）：

```text
0 [System] [InnoDB] InnoDB initialization has started.
0 [System] [InnoDB] InnoDB initialization has ended.
0 [System] [Server] Starting XA crash recovery...
0 [System] [Server] XA crash recovery finished.
InnoDB: Progress in percents: 1 2 3 4 ... 100
0 [System] [Server] ready for connections
```

3 秒后服务可用。两行 System 之间的 0.9 秒是 redo 重放；那条唯一的进度条是 undo 回滚（下一节）。然后是核对：

```text
第一次：SELECT COUNT(*), SUM(v) FROM t_crash;
        → 10001 行，50015001 —— 与断电前完全一致
        SELECT id, v WHERE id IN (1, 5000, 5001, 10001) → 全是原值
        CHECK TABLE t_crash → OK
        INNODB_TRX → 0 个活跃事务

第二次：SELECT SUM(pad='J') AS committed, SUM(pad='Z') AS zombie FROM churn_fat;
        → 5000, 0 —— 已提交的 5000 行全在，僵尸版一个不留
```

**崩溃恢复就三步**：重放 redo（物理层面把所有改动重演一遍，无论提交与否）；回滚未提交（undo 层面沿链逆向抄回）；然后开门营业。没有神秘力量，只有日志。

### redo 重放：拿着 FIL_PAGE_LSN 挑活儿

重放不是无脑全量。第一篇讲页骨架时提过页头 LSN，现在它上岗：**每个 redo 记录自带它全局 LSN，每页头上有 FIL_PAGE_LSN**。恢复程序拿 redo 记录的 LSN 与目标页头上的 LSN 对表：

- redo 的 LSN ≤ 页的 FIL_PAGE_LSN：这页已经比这条日志新了，**跳过**；
- redo 的 LSN > 页的 FIL_PAGE_LSN：页面落后，**重放这条**。

所以 95 个脏页里，凡是断电前恰好已被后台线程刷下去的，重放时会被页头 LSN 挡回来：**每页只补自己缺的那几笔**，不重不漏。这也顺带解释了 CRC32 校验和的用途：重放前先验页身，撕裂页（见 doublewrite 节）当场现形。

### undo 回滚：那个进度条在数什么

重放完成后，数据库处于一个尴尬的状态：**页面里躺着未提交事务的改动**（重放是物理的，不问提交）。恢复程序扫一遍所有活跃事务标记，找到没有 COMMIT 记录的，启动回滚，**用第二篇的老朋友 undo，沿版本链逆向抄回**。5000 行的僵尸改动就这样被抹掉。

那条 `Progress in percent: 1 2 3 … 100` 的进度条，源码在 `trx0roll.cc`：

```c
/* We print rollback progress info if we are in crash recovery
   and the transaction has at least 1000 row operations to undo. */
if (trx == trx_roll_crash_recv_trx && trx_roll_max_undo_no > 1000) { ... }
```

**恢复期回滚超过 1000 个行操作才打印进度条**，我们的 5000 行刚好过线。0.3 秒刷完是实验规模小；生产上断电前的百万行大事务回滚起来以小时计，这条进度条是 DBA 在日志里唯一的安慰。

另一组数字值得留意：**回滚比提交贵**。提交只需把 undo 写好（向前抄一次）；回滚要把每环 undo 逐条读回、逐行改回（沿链逆向走一遍）。这也解释了为什么 InnoDB 需要 MVCC 篇讲的 purge 异步回收：把清理挪出关键路径，提交才能便宜。

## doublewrite：页是 16KiB，磁盘的最小写入不是

WAL 防的是「改动丢失」，还有另一种祸：「**写了一半的页**」。16KiB 的页刷盘时，操作系统对文件的写请求通常按 4KiB 分解，断电可能停在中间，页面半新半旧。重放 redo 能补齐新的一半，但**旧一半已经损坏**：redo 记录的是「旧字节 → 新字节」的物理 diff，旧字节没了，diff 无从套起。这叫**撕裂页（torn page）**。

解法朴素到发笑：**先把整页抄去一个中立地点，再写原位。** 8.4 的实现是 `#innodb_redo` 旁边的两个文件：

```text
#ib_16384_0.dblwr   4,194,304 字节
#ib_16384_1.dblwr  12,582,912 字节
```

合计 16MiB = 128 页 × 16KiB × 2（`innodb_doublewrite_pages=128`）。批刷流程：脏页先顺序写入 dblwr 文件，fsync，再写到各自 .ibd 里的原位。若原位写撕裂，**dblwr 里那份完好的副本还在**，恢复时直接整页拷回，再走 redo。实测灌 3 万行肥数据前后，两个 dblwr 文件尺寸一点没变：**它是循环复用的缓冲区，不是追加型文件**，与 redo 的环形设计呼应。

（有人会问：redo 自己会不会撕裂？redo 记录有校验和、块内也有填充机制，重放时验坏即停，撕裂的日志尾巴会被识别并丢弃，不影响已完成部分。另外 `innodb_flush_method=O_DIRECT` 绕开页缓存、自 8.0.20 起 doublewrite 恒开，这两道闸门就不展开了。）

## 8.4 的三处换代

这一篇的实验里，8.4 与老教程对不上的地方有三处，值得单独记下：

**redo 从「两个大文件」变成「环写目录」。** 老资料里的 `ib_logfile0/1` 在 8.0.30 后已被 `#innodb_redo/` 目录的 32 个小文件取代，`innodb_redo_log_capacity` 在线可调（老设计改尺寸要求停机）。容量不是越大越好：**checkpoint 才是圈速的裁判**。日志消费太慢、圈追上来，写入线程就得等（`Innodb_log_waits` 计数器，正常应为 0；本实验全程 0）。

**checkpoint 从「追脏页」变成「消费者式推进」。** 老资料爱画「checkpoint 等待最老脏页」的图；8.4 的 `Innodb_redo_log_checkpoint_lsn` 是消费者式推进，配合后台 flush 线程的节奏。对使用者影响不大，对读老教程的人是坑：日志里看到 checkpoint LSN 与脏页数不同步，不是异常，是新设计。

**undo 与 redo 彻底分家。** 第二篇已经拆过 undo 的独立表空间；这里补一句分工：**undo 管「回到过去」（回滚、MVCC），redo 管「重演未来」（重放）**。两本日志一进一退，撑起 ACID 的 A 与 D；C（一致性）是前两篇的锁与隔离级别在撑。四篇至此合龙。

## 断电之后靠什么

redo 记的是 diff，不是照片：窄行 75 字节、宽行 490 字节一条；页头的 FIL_PAGE_LSN 随每次改动前进（单次 UPDATE +489），第一篇 17 字节差异里的 12 字节页头页尾之谜，至此全部拆开。

提交的实质是「日志已落盘」，不是「数据已写盘」：提交瞬间 flushed = current，而 21 个脏页还在内存里、checkpoint 落后 5.3MiB。断电丢不丢，只看日志刷没刷；`innodb_flush_log_at_trx_commit=1` 的每次提交 fsync，就是为这一刻付的钱。

崩溃恢复三步走：重放、回滚、开门。redo 重放拿页头 LSN 挑活儿，每页只补缺的；未提交事务由 undo 沿链逆向抹掉（>1000 行操作才有进度条，trx0roll.cc 实锤）；两次 kill -9 的核对结果完全一致：已提交的一行不少、僵尸版一行不留。

撕裂页的解法是「先抄一份再写原位」：doublewrite 双文件 16MiB 循环复用，防的是 redo 补不了的那半页。WAL 管「丢改动」，dblwr 管「坏基线」，两道防线各管一祸。

锁是内存的秩序，日志是磁盘的秩序。第三篇那些 GRANTED 与 WAITING 断电即散；数据不散，是因为每一笔在成为页上的事实之前，先成为了日志里的事实。四篇合起来：资产（页与树）→ 后悔药（undo）→ 并发（锁与 MVCC）→ 重生（redo），InnoDB 的容错设计没有单点神迹，只有层层核对。

存储、MVCC、锁、日志，前四篇到这里齐了。接下来转向查询侧：第一篇回表的 1717 倍、EXPLAIN 的 Covering 标注，那些「为什么这么走」的问题，下一篇从优化器开始拆。
