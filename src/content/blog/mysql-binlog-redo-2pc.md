---
title: 提交的那一停：binlog、redo 与两阶段裁决
description: MySQL 系列第八篇。一笔提交 2.06ms，其中 99% 花在两次 fsync 上——本篇拆开这一停：为什么引擎先写 redo（prepare）、binlog 落盘后才敢说「提交」。sync_binlog × innodb_flush_log_at_trx_commit 矩阵实测双 1 2.06ms、双 0 20μs；关 binlog 退化成单阶段 0.84ms；8 路并发组提交把 fsync 摊薄到 0.38 次/事务。kill -9 三方对账：ack 2084、行数 2085、binlog XID 2085——崩溃窗口里那笔「引擎已 prepare、binlog 已落盘、ack 未发出」的事务被 binlog 裁决为提交；双 0 崩溃则留下 2085 个 binlog 超前于引擎的幽灵事务。外加外部 XA 跨重启存活实测与 8.4 源码裁决逻辑逐行对上。
pubDate: 2026-09-18
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

```text
17:55:41  插入程序狂奔，ack 计数 2084。
17:55:41  kill -9。mysqld 连一句遗言都没有。
17:56:12  重启完成。表里 2085 行，binlog 里 2085 个 XID。
17:56:12  客户端只收到 2084 个 ack。多出来的那一行，是谁批准的？
```

上一篇文章写缓冲池，结尾留了个钩子：change buffer 的「推迟落账」背后，是「改页前必须先记日志」的另一半。这一篇就停在那个**写路径上最贵的一瞬：提交（COMMIT）**。第四篇讲过 WAL——先记 redo 再改页；第六篇把 binlog 当复制素材拆过字节。但一笔提交从 `COMMIT` 语句到客户端收到 OK，中间要**跨两本日志、走一次内部两阶段提交（内部 XA）**：引擎先写 redo prepare，binlog 落盘之后才敢做 commit。为什么这么绕？谁裁决崩溃后的事务生死？实测会给出比文档更锋利的答案。

先钉住一笔提交的开销构成。量具：`performance_schema.events_waits_summary_global_by_event_name` 的 `wait/io/file/sql/binlog`（binlog 的 write+fsync 合计 io 次数）、`Innodb_os_log_fsyncs`（redo 的 fsync 计数）、`NOW(6)` 过程内计时（别在 shell 里 `time`，docker exec 的启动开销会污染毫秒级数字——这是我踩过的坑）。单行自动提交连续 500 笔，双 1 默认（`sync_binlog=1`、`innodb_flush_log_at_trx_commit=1`）：

```text
2,063.8 μs/提交
binlog 文件 io     1000 次（500 write + 500 fsync，恰好每事务 2 次）
redo fsync          711 次
```

**一笔 2 毫秒的提交，代码本身只值几十微秒，剩下 99% 都在等两次 fsync**。这两个参数各管一本日志的落盘纪律，是写路径上最重要的两个旋钮——矩阵跑起来。

## 四格矩阵：两本日志的纪律与账单

`sync_binlog` 管 binlog（0=交给 OS 缓存、1=每批 fsync、N=攒 N 个事务 fsync 一次）；`innodb_flush_log_at_trx_commit` 管 redo（0=每秒刷、1=每提交 fsync、2=每提交 write 进 OS 缓存）。同样 500 笔单行自动提交，各格实测（binlog io = write+fsync 合计；500 笔对照里 write 恒为 500 次，多出来的就是 fsync）：

| 组合 | μs/提交 | redo fsync | binlog io | 崩溃时丢什么 |
| --- | --- | --- | --- | --- |
| 双 1（默认） | 2,063.8 | ~711 | 1000（500w+500f） | **不丢已 ack 的** |
| (1, 0) | 810.0 | 0 | 1000（500w+500f） | 秒级 redo：**实例崩溃不丢，主机断电丢一秒** |
| (0, 1) | 1,025.1 | ~728 | 500（500w+0f） | binlog 只进 OS 缓存 |
| 双 0 | **20.4** | 1 | 500（500w+0f） | 两本都只有 OS 缓存兜底 |
| (1000, 2) | 42.6 | 1 | 500（500w+0f*） | 攒批 fsync + redo 进缓存 |

*sync_binlog=1000 在 500 笔内没攒满，fsync 一次未发——这就是它的语义：攒满 N 个才落一次盘。源码 `sync_binlog_file` 里 `sync_period && ++sync_counter >= sync_period` 的短路，0 与「不足 N」在单笔视角下同样不 fsync。

三组对照读出三个事实：

**(1,0) 0.81ms ≈ binlog 一停。** redo 不 fsync 了（计数 0，全靠每秒的 master thread 刷），省掉的恰是 2.06 − 0.81 ≈ 1.2ms——**两本日志的 fsync 各值约 1ms**，这就是 NVMe 上一次 fsync 的单价（容器里 dd oflag=dsync 实测同量级）。双 0 的 20μs 里 fsync 已全部消失（binlog 一列 500 次 io 全是 write），剩下的就是纯代码路径。

**(1000,2) 是「便宜的近似安全」。** 43μs 比双 0 贵一倍多，但换回的是：binlog 攒满 1000 个事务（或轮转/关库时）才落一次盘、redo 每笔都 write 进 OS 缓存——**mysqld 崩溃几乎不丢（OS 缓存还在），只有主机断电才丢窗口**。很多「我要安全但受不了双 1」的业务，落点其实是这一格而不是双 0。

**双 0 比双 1 快 100 倍，账单在崩溃那天结算**——结算方式见下文 kill -9 实验，比「丢几行」有意思得多。

还有一个对照必须做：**binlog 整个关掉（skip-log-bin）会怎样？** 重启后同样 500 笔提交：

```text
skip-log-bin：  837.8 μs/提交，redo fsync 555 次（每事务恰好 1 次）
双 1（开着）：  2,063.8 μs/提交，redo fsync 711 次
```

关掉 binlog 后，**两阶段提交整个消失了**：没有 binlog 这个「第二参与者」，redo 不需要 prepare/commit 两段式，一笔 fsync 直达提交——快了 1.2ms。源码上这是 `total_ha_2pc`（具备两阶段能力的日志/引擎数）从 2 降到 1：协调者不需要裁决，事务单阶段完成。**binlog 的存在本身就是提交变慢的原因**，复制和恢复是一对明码标价的取舍。

## 中间态长什么样：一条提交的四步

把 2.06ms 切开，一笔事务提交的真实次序（8.4 源码 `MYSQL_BIN_LOG::ordered_commit`）：

```text
① 引擎层写 redo（prepare 段）并落盘        ← innodb_flush_log_at_trx_commit=1 的 fsync
② 事务的事件流写进 binlog 并落盘            ← sync_binlog=1 的 fsync
③ 引擎层写 redo（commit 段）                ← 不用立刻落盘
④ 客户端收到 OK
```

关键在 ①②③ 的**顺序**：redo 的 prepare 必须先于 binlog 落盘。为什么？看崩溃后重启时恢复程序手里的两张牌：引擎侧扫描 redo，找出所有 **prepared 状态**的事务（改动的页已在、但没走到 commit 段）；binlog 侧顺序扫描文件，收集每个 `Xid` 事件（= 事务在 binlog 里完整落盘的凭证）。然后裁决——8.4 的裁决逻辑在 `sql/xa/recovery.cc`，核心就一句：

```cpp
if (info.commit_list ? info.commit_list->count(xid) != 0 : ...) {
  exec_status = ht.commit_by_xid(&ht, ...);   // binlog 里有它 → 提交
} else {
  exec_status = ht.rollback_by_xid(&ht, ...); // binlog 里没有 → 回滚
}
```

**binlog 是裁决书，引擎是执行者。** 所以 prepare 必须先落盘：如果 binlog 里有这笔事务、引擎侧却找不到 prepared 记录（redo 没落盘就崩了），就会出现「binlog 承诺了复制流、引擎却拿不出数据」——从库重演出主库不存在的行。顺序反过来的话（binlog 先落盘、redo 后落盘），崩溃点选在中间，就会破坏「主库表内容 ⊆ binlog 内容 ⊆ 从库内容」这条链。至于 ④ 的 ack，源码里发在引擎 commit 段（`process_commit_stage_queue` → `signal_done`）之后——但**崩溃裁决只认 ②**：只要 binlog 里有凭证，引擎的 commit 段没走到也会被恢复程序补提交。这就是「异步复制」里「异步」的确切位置：**客户端的 OK 比从库的重演早一步，比崩溃的安全性晚一步**。

那 binlog 里收集 XID 的具体位置在哪？`sql/binlog/log_sanitizer.cc` 的 `process_xid_event`：恢复程序逐事件读 binlog，每读到一个 `Xid_log_event`，就 `m_internal_xids.insert(ev.xid)`——这份集合传给 `ha_recover(&m_internal_xids, ...)`，就是上面那句裁决的 `commit_list`。整个「binlog 是裁决书」在源码里就这几行，朴素得惊人。

## kill -9：三方对账

机制讲完，上崩坏。外部脚本经 TCP 连接逐笔 INSERT（autocommit），每收到一个 ack 就落一次盘计数；3 秒后 `kill -9` mysqld（容器里 PID 1，一击毙命，buffer pool、OS 里 MySQL 自己的缓存都救不了它）。重启后三方对账：

```text
客户端 ack 计数：    2,084
表里行数：           2,085   ← 多一行！
binlog Xid 事件数：  2,085   ← 与行数严丝合缝
```

**2085 个提交，客户端只确认了 2084 个。** 多出来的那笔是崩溃窗口里的事务：引擎 redo 已 prepare（落盘）、binlog 的 Xid 事件已落盘、**唯独 ack 还没发回客户端**。重启时裁决逻辑翻 binlog：XID 在名单里 → `commit_by_xid`——**表里多出一行客户端从不知道自己拥有的数据**。对应用程序这是一记警钟：**「没收到 OK」不等于「没发生」**。重试插行前先 SELECT（或 INSERT ... ON DUPLICATE KEY），别把「超时」直接当「失败」——这笔账在双 1 下就是这么结的：不丢已 ack 的、可能多出没 ack 的。

同一实验里还有一个隐藏角色：**TC 日志**（事务协调者的备忘）。MySQL 在 binlog 开启时用 binlog 本身当 TC；关 binlog 且引擎不认账的极端场景才退回 `TC_LOG_MMAP`（内存映射文件）。8.4 把这套 XID 账本挪进了 binlog 的恢复流程（`Binlog_recovery`），旧版本散在 `tc_log.cc` 的逻辑收拢成了 `log_sanitizer` + `recovery.cc` 两个文件——这也是 8.4 源码里这一段突然变好读的原因。

## 双 0 的账单：幽灵事务

把两个旋钮都拧到 0 再崩一次。插入程序狂奔到 ack 69036 时 kill -9，重启后对账：

```text
客户端 ack 计数：    69,036
表里行数：           69,037   ← 仍然多一行（redo 的 prepare 在双 0 下……等等）
binlog Xid 事件数：  71,122   ← 比行数多 2,085 个！
```

两个结果都值得细看：

**引擎只多了一行，不是两千行。** 双 0 下 redo 不是不写，只是不主动 fsync（每秒批量刷）。但事务的事件要写进 binlog 缓存之前，组提交的 leader 会先做一次 `ha_flush_logs(true)`——源码 `fetch_and_process_flush_stage_queue` 的注释明写：*"We flush prepared records of transactions to the log of storage engine in a group right before flushing them to binary log"*。**binlog 每次真落盘（这里每 500 事务一次）之前，都会把队列里全体的 redo prepare 先刷下去**。所以引擎侧的 prepared 凭证意外地齐，裁决照常、行数基本守恒（多的那一行同上一节：ack 没发出但裁决为提交）。

**binlog 超前了 2085 个事务。** `sync_binlog=0` 意味着 binlog 的 write/fsync 全交给了 OS 缓存——mysqld 死了，**内核还在**，缓存里的数据被内核照常写完（容器 kill 的是 mysqld，不是主机）。于是 binlog 文件里留下了 xid 69038..71183 共 2085 个 `Xid` 事件：**从库会重演它们，主库引擎却从来没提交它们**。重启后的主库没有这些行，从库（如果接上）会有——主从裂开一道 2085 行宽的缝，而且不报错、不告警，只等某天 SELECT 出不一致才现形。

这就是双 0 真正的账单：**不是「丢一秒数据」这么体面，是「复制流里长出主库没有的事务」**。双 1 丢的是什么都不丢（引擎裁决书完整）；双 0 丢的是 binlog 与引擎的一致性。参数表格里那行「崩溃时丢什么」，写「主从一致性」比写「1 秒事务」准确得多。

## 组提交：fsync 的拼车

2ms 一笔、99% 在 fsync——高并发下这买卖怎么做？答案是人多好办事：**组提交（group commit）**。多个并发事务的 binlog 写入拼成一班，一次 fsync 全带走。8 路 docker-exec 并发、每路 250 笔、双 1：

```text
串行（1 路 × 500 笔）：   redo fsync 711 次 / 500 事务 = 1.42 次/事务
并发（8 路 × 250 笔）：   redo fsync 757 次 / 2000 事务 = 0.38 次/事务
```

**同样双 1，并发把 fsync 摊薄到 0.38 次/事务**——三笔事务拼一辆车，每笔均摊成本掉到 1/4。机制在 `ordered_commit` 的三阶段流水线：flush 阶段（收队列、刷引擎日志、写 binlog 缓存）→ sync 阶段（leader 独自 fsync，follower 等待）→ commit 阶段（挨个做引擎 commit）。第一个到的当 leader，后到的一批 follower——**等待 fsync 的时间本身就是攒批窗口**，fsync 越慢、批越大，天然负反馈。

8.4 还给了个手动挡：`binlog_group_commit_sync_delay`（微秒）——leader 在 fsync 前故意多等这一下，攒更大的批。实测 delay=5000μs：

```text
默认（0）：     fsync/事务 0.378，binlog io 1242 次/2000 事务
delay=5000μs：  fsync/事务 0.318，binlog io  702 次/1838 事务（部分连接超时掉队）
```

fsync 更省了，但 8 路里有连接因为单笔延迟过高而超时掉队（完成 1838/2000）——**用尾延迟换吞吐的旋钮**，OLTP 单笔敏感的业务慎拧。顺带一提 redo 侧的同款：prepare 的 fsync 也能被 leader 一并批量刷（上节双 0 实验里 `ha_flush_logs` 的组刷就是它），两本日志都在拼车。

## 外部 XA：把裁决权还给应用

内部 XA 的裁决书是 binlog，因为两个参与者（binlog、InnoDB）同属一台服务器。真正的分布式事务（跨库、跨服务）里没有谁能单方面裁决——这时候用**外部 XA**：`XA START → ... → XA PREPARE → （协调者决策）→ XA COMMIT/XA ROLLBACK`，裁决权在应用程序手里。实测它跨崩溃的行为，和内部 XA 形成漂亮的对偶：

```text
XA START 'crash_xa_1'; INSERT t_xa VALUES (1,100); XA PREPARE 'crash_xa_1';
  → XA RECOVER 列出 crash_xa_1；表里查不到这行（还没提交）
  → binlog 里已经写下 XA_prepare 事件（复制流知道"有个事务在等裁决"）
kill -9 → 重启：
  → 日志：Starting XA crash recovery... finished.
  → XA RECOVER 仍然列出 crash_xa_1   ← prepared 事务跨重启活了下来
  → 表里仍然没有这行
XA COMMIT 'crash_xa_1'（人工，几天后也行）：
  → 行落地；binlog 追加 XA COMMIT 事件，从库同序重演
```

三个对照记住这张对偶表：**内部 XA 的 prepared 事务，重启后被 binlog 自动裁决（提交或回滚），无需人工；外部 XA 的 prepared 事务，重启后原样悬置，等协调者发令。** binlog 在两种 XA 里都扮演「让从库能重演」的载体，区别只在于谁来填最后的裁决——服务器自己（查 Xid 名单），还是应用（发 XA COMMIT）。代价也直白：外部 XA 的 prepared 状态会**占着 undo 和锁**直到裁决到来，悬置越久代价越大——分布式事务尽量短、prepare 后立刻决，是比「能不能用」更重要的纪律。

## 合上账本

**一笔提交的 2ms，是两本日志的过路费。** redo prepare 先落盘、binlog 后落盘、引擎 commit 收尾——这个顺序是崩溃裁决的地基：binlog 是裁决书，引擎照单执行。关掉 binlog（skip-log-bin）实测提交从 2.06ms 掉到 0.84ms：**两阶段的复杂性本来就是为「复制+恢复」付的税**，单机不欠这笔钱。

**双 1 的承诺精确到 ack。** kill -9 三方对账：ack 2084、行数 2085、XID 2085——崩溃窗口里「prepare 了、binlog 有凭证、ack 未发出」的事务被裁决提交。**不丢已 ack 的，但可能多出没 ack 的**：重试逻辑别把超时当失败，先查再写。

**双 0 的账单不是丢数据，是长幽灵。** binlog 超前引擎 2085 个事务：从库会重演出主库没有的行，主从一致性在无告警中裂开。`sync_binlog=0` 的风险表述应该是「复制流与引擎脱钩」，而不是「丢一秒」——中间还有 (1000, 2) 这种「实例崩溃基本不丢、只防不住断电」的落点。

**并发是 fsync 的解药。** 组提交把双 1 的 fsync 从 1.42 次/事务摊到 0.38 次/事务：fsync 等待本身就是攒批窗口。`binlog_group_commit_sync_delay` 能再榨一层，代价是单笔尾延迟——吞吐和延迟在这个旋钮上明码标价。

**裁决权有三个归属。** 服务器查 binlog 名单（内部 XA，重启即决）、应用程序发令（外部 XA，prepared 跨重启悬置等人）、人工 TC 日志（无 binlog 的单机，8.4 已收进 binlog 恢复流程）。**同一台服务器里的「分布式事务」，分布式的是日志，不是机器。**

---

```text
17:55:41  双 1 矩阵：2.06ms / 笔，99% 是两次 fsync。
18:02:10  8 路并发组提交：fsync 摊到 0.38 次/事务。
18:15:33  kill -9：ack 2084，行 2085，XID 2085——binlog 裁决为提交。
18:24:47  双 0 再崩：binlog 超前引擎 2085 个事务，从库将重演幽灵。
18:31:09  XA PREPARE 后 kill -9：事务悬置存活，等一句人工 XA COMMIT。
```

两本日志的账算完了，下一篇回到磁盘上：表大于内存之后，**索引与数据的物理布局如何决定回表代价**还没在字节级拆过——连接算法与 join buffer 落盘，那是查询执行侧的下一站。
