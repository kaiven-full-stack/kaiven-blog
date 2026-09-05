---
title: 断线以后，不一定从头再来：Redis 的主从复制与增量同步
description: 两次不到一秒的断线，一次只补一万字节，一次却重新同步整个数据集。本文以 replication ID、offset 与 backlog 三份对账凭据为线索，拆开 PSYNC、全量同步、故障转移与 WAIT 的保证边界。文中实验在 Redis 7.4.11 上复核。
pubDate: 2026-09-05
tags: [Redis, 数据库]
---

```text
19:55:13  副本断线。主库随后写入约 10KB。
19:55:14  副本重连：+CONTINUE，只补缺页。

19:58:26  副本再次断线。主库随后写入约 192KB。
19:58:27  副本重连：+FULLRESYNC，从头再来。
```

两次断线都不到一秒，同一只副本回到同一台主库，得到的答复却完全不同。

决定它能不能续上旧账的，不是分开了几秒，而是分开以后主库的复制流向前走了多少字节，以及那些字节是否还留在柜台后的流水账里。时间只会影响写入量，真正参加判定的是 replication ID、offset 和 backlog。

这不是一次生产事故的复盘。现场由两只受限的 Redis 容器组成，网络与宿主机隔离，主库关闭自动 RDB 和 AOF，单批写入不超过 64KB；实验结束后容器、网络、卷与数据全部删除。文中数字只描述这次实验，机制和源码名称以 Redis 7.4.11 为准。

上一篇说，全量复制即使不在本地保存 RDB，也可能让主库再按一次 `fork` 的快门。这一篇沿那声快门往前追：Redis 为什么有时必须从头拍照，有时只需把断线期间漏掉的几页账补回来。

## 现场里的两本账

实验开始时，主库与副本都关闭持久化；主库保留 1MB 复制 backlog：

```sh
docker run -d --name lab-master --network lab-redis-net \
  --memory 256m --memory-swap 256m --cpus 0.5 \
  redis:7.4.11 redis-server \
  --save "" --appendonly no \
  --repl-backlog-size 1mb \
  --repl-backlog-ttl 3600


docker run -d --name lab-replica --network lab-redis-net \
  --memory 256m --memory-swap 256m --cpus 0.5 \
  redis:7.4.11 redis-server \
  --save "" --appendonly no \
  --replicaof lab-master 6379
```

Redis 7.4 默认开启无盘复制。为了让全量同步留下的 `fork` 和 RDB 文件路径更容易观察，部分实验显式用了 `repl-diskless-sync no`；这会改变快照的出口，不改变 PSYNC 是否能够部分同步的判据。

主库的 `INFO replication` 给出第一本账：

```text
role:master
master_replid:2c13ff03...
master_replid2:00000000...
master_repl_offset:10670
repl_backlog_active:1
repl_backlog_size:1048576
repl_backlog_first_byte_offset:1
repl_backlog_histlen:10670
```

副本也保存自己的进度：它正在跟随哪个 ID，已经从 socket 读到哪里，又已经把复制流应用到哪里。

这不是主库每写一个键就向副本发一份对象副本。写命令会被编码为 RESP 字节流，进入复制缓冲，再沿连接发给副本。复制双方对的是这条字节流，不是命令数量，也不是墙上的时间。

**断线时长是我们选的，重逢资格由账目决定。**

## 重逢时，只有两种答复

副本第一次连接主库，没有任何历史可出示，会发送：

```text
PSYNC ? -1
```

主库只能回答：

```text
+FULLRESYNC <replid> <offset>
```

这意味着：先接收一份完整数据集，再从给定 offset 后继续消费增量流。

已经同步过的副本断线时，会缓存上一条主库连接的复制状态。重连后，它发出的请求近似为：

```text
PSYNC <我认识的 replid> <我需要的下一个 offset>
```

若主库核对通过，答复是：

```text
+CONTINUE <当前 replid>
```

随后只发送副本缺失的那段 backlog。若核对失败，则回到 `+FULLRESYNC`，重新生成和传输整份快照。

```text
副本                                  主库
  │  PSYNC <replid> <offset>            │
  ├────────────────────────────────────>│
  │                                     ├─ 身份与历史都匹配
  │  +CONTINUE + 缺失字节                │
  │<────────────────────────────────────┤
  │                                     │
  │                                     └─ 身份或历史不匹配
  │  +FULLRESYNC + 完整快照              │
  │<────────────────────────────────────┘
```

台词只差一个单词，背后却可能相差一次 `fork`、一份 RDB、整段网络传输和一次副本加载。

## 第一份证件：replication ID

`master_replid` 是一个 40 字符的随机标识。它不只是“这台服务器的 UUID”，更接近一段数据历史的名字。

主库生成复制流，副本完成全量同步后继承这段历史的 ID 与 offset。级联复制中的下游也沿用同一条流，因此一组机器可以共同回答：我们现在谈的是哪一版历史。

只比较 offset 不够。两台毫无关系的主库都可能刚好走到 offset 100000；数字相同，不代表前十万个字节相同。只有 `(replid, offset)` 放在一起，才能定位某段复制历史中的一个位置。

```text
history A: 2c13ff03... @ 100000
history B: 7e9de163... @ 100000
```

页码相同，书不是同一本。

这也是为什么主库身份变化会影响部分同步。若数据历史已经换代，副本拿着旧 ID 回来，不能只凭“我上次读到第几页”就继续。

**replication ID 属于数据的一脉，不只属于某台机器。**

## 第二份证件：offset

`master_repl_offset` 表示主库已经生成到复制流的哪个字节。每向复制缓冲写入 N 个字节，它就向前移动 N；副本则分别记录已经读入和已经应用的进度。

一条业务命令不等于一个 offset。一条短 `INCR` 只产生几十个协议字节，一条携带 64KB 值的 `SET` 会把 offset 一次推远六万多。事务中的命令、主库合成的过期删除以及数据库切换所需的 `SELECT`，也会成为复制流的一部分。

假设副本已经应用到 1000，它重连时请求的是下一个字节：

```text
PSYNC <replid> 1001
```

主库不需要理解“副本漏了三条 SET”。它只需知道从字节 1001 开始，自己是否仍保存着一段连续历史。

这解释了开场中最容易被忽略的变量：两次都断了不到一秒，一次只写 10KB，另一次写了 192KB。秒表很接近，复制页码却走出了完全不同的距离。

`INFO replication` 中副本条目的 `offset` 是它通过 `REPLCONF ACK` 报给主库的确认位置；`lag` 则是距离最近一次 ACK 过去了多少秒。**lag 是时间新鲜度，不是主从相差的字节数。**

## 第三份凭据在主库手里：backlog

副本带回 ID 和 offset，主库还要翻自己的复制 backlog。

从语义上看，backlog 是一扇滑动窗口，只保留最近一段复制字节：

```text
已经被裁掉                         仍在 backlog                         流尾
───────┆───────────────────────────────────────────────────────────┆
       ^                                                           ^
       repl_backlog_first_byte_offset                              master_repl_offset
```

`repl_backlog_histlen` 是窗口当前保存的历史长度，因此始终满足：

```text
first_byte_offset = master_repl_offset - histlen + 1
```

旧资料常把 backlog 描述成单块环形缓冲。这对 Redis 6.2 及更早版本成立；Redis 7.0 起，复制 backlog 与在线副本的输出共享同一组 `replBufBlock` 分块链表，并用 rax 索引帮助 PSYNC 定位。逻辑上它仍是“旧字节从左侧淘汰、新字节从右侧进入”的有限窗口，但内部已经不是一只首尾相接的数组。

这项变化也解释了两个细节。

第一，`repl-backlog-size` 是目标容量，不是 `histlen` 永远不能越过的硬边界。裁剪按块进行，慢副本还可能持有旧块引用，因此实际历史长度可以暂时略大于配置值。实验配置 1MB 时，曾观察到：

```text
master_repl_offset:1322121
repl_backlog_first_byte_offset:208737
repl_backlog_histlen:1113385
```

`histlen` 比 1048576 多出约 6%，公式仍然成立。

第二，backlog 不是每个副本各有一份。它是一份公共历史，所有回来验票的副本都查同一个窗口。在线副本自己的发送进度由它在共享分块链表上的引用位置记录。

**流水账不认识哪一只副本，它只保留最近那段字节。**

## 验票是一道区间题

主库处理 PSYNC 时，部分同步需要同时满足两组条件。

先验 ID：

```text
请求的 replid == 当前 master_replid
或者
请求的 replid == master_replid2
且请求 offset 没越过 second_repl_offset
```

再验 offset：

```text
backlog 存在
且 requested_offset >= first_byte_offset
且 requested_offset <= first_byte_offset + histlen
```

可以画成一张决策树：

```text
副本递来 replid + offset
  │
  ├─ ID 不属于当前历史，也不属于可承认的上一段历史
  │      └─ FULLRESYNC
  │
  ├─ ID 可以承认，但 offset 已被窗口左侧裁掉
  │      └─ FULLRESYNC
  │
  ├─ offset 尚未存在或超出可续范围
  │      └─ FULLRESYNC
  │
  └─ ID 匹配，offset 仍在窗口
         └─ CONTINUE，从该字节开始补发
```

`master_replid2` 为什么存在，后面再说。只看最普通的断线重连，结论已经明确：

```text
断线短 + 写入少 + backlog 足够  → 可能部分同步
断线短 + 写入多 + backlog 太小  → 仍会全量同步
断线长 + 几乎没有写入           → 仍可能部分同步
```

**主库验的是历史区间，不是离线时长。**

## 两次不到一秒的断线

第一轮实验保留 1MB backlog。副本停掉后，主库写入十个约 1KB 的值，约一秒内重新启动副本。主库日志给出：

```text
Partial resynchronization request ... accepted.
Sending 10628 bytes of backlog starting from offset 1.
```

`sync_full` 没有增加，`sync_partial_ok` 从 0 变成 1。副本只补了约 10KB 的缺口。

第二轮把 backlog 改为 32KB。副本再次停掉，在相近的不到一秒窗口中，主库写入三笔 64KB 数据。重连时：

```text
Replica request offset:              2109062
repl_backlog_first_byte_offset:      2272582
```

副本想要的页码已经落在窗口左边。主库日志变成：

```text
Unable to partial resync ... for lack of backlog
```

随后 `sync_full` 增加，副本收到新的 `FULLRESYNC`。

| 对照项 | 第一次 | 第二次 |
| --- | ---: | ---: |
| 断线时间 | 不到 1s | 不到 1s |
| 断线期间写入 | 约 10KB | 约 192KB |
| backlog 配置 | 1MB | 32KB |
| 结果 | `CONTINUE` | `FULLRESYNC` |

毫秒数、协议开销与具体 offset 每次都会变化，但判断不靠这些固定数字。唯一重要的关系是：副本请求的位置是否还落在 backlog 覆盖区间内。

时间相近，账已经翻过了不同数量的页。

## 从头再来，要付三笔账

部分同步只是把 backlog 中缺失的字节挂到副本发送路径上。全量同步则要重建基线，至少付出三笔成本。

第一笔是主库创建一致快照。Redis 7.4 默认开启无盘复制，若副本支持 EOF 能力，RDB 子进程把快照写入管道，由父进程转发到副本；显式关闭无盘复制时，子进程先生成磁盘 RDB。无论出口是网络还是文件，都需要 `fork` 出一只 RDB 子进程。

第二笔是网络传输。完整数据集必须送到副本。无盘复制免去了主库本地临时 RDB，并不消灭 RDB 编码和网络字节。

第三笔是副本加载。默认 `repl-diskless-load disabled` 时，副本先把 RDB 落到临时文件再加载；其他模式可以直接从 socket 加载，但会带来失败恢复或双数据集内存等不同权衡。全量加载期间，副本可能暂时无法正常服务请求。

实验数据集只有约 3.8MB，磁盘式全量同步的 `latest_fork_usec` 约 0.5 毫秒，`total_forks` 随全量次数增加，COW 也只有约 0.5MB。数字很小，是因为现场刻意受限；机制与上一篇数百 MB 实验一致：数据越大，fork、传输、加载和保存窗口越值得单独预算。

```text
主库       [fork] ── 继续服务，并保存同步期间的新写入
子进程             └── 生成完整 RDB ──────────────┐
副本                                               └── 接收并加载 ── 追增量
```

全量同步不是“部分同步失败以后多传一点”，而是重新建立一条共享历史。

## 公共流水账与私人快递

backlog 和副本输出缓冲经常被当成同一项配置。Redis 7 的底层存储虽然已经共享，逻辑职责仍然不同。

backlog 是公共历史：即使某只副本断线，只要窗口没有被释放或覆盖，它回来仍能查询旧字节。

在线副本的输出状态则是私人快递：每只副本在共享分块链表上各有自己的发送位置。某只副本太慢，会积压它尚未消费的块，并受 `client-output-buffer-limit replica` 约束。7.4.11 的默认限制为：硬限制 256MB，或持续 60 秒超过 64MB；若配置的硬限制小于 backlog，Redis 还会把有效硬限抬到 backlog 大小，因为二者共享内存。

慢副本被输出缓冲限制断开以后，不一定全量重来。若它重连够快，请求 offset 仍在 backlog 中，照样可以 `CONTINUE`。反过来，给每只在线副本很大的输出空间，也不能替代公共 backlog 对断线历史的保存。

```text
backlog：          给可能回来的副本留旧账
副本发送位置：      记录当前这只在线副本寄到哪里
输出缓冲限制：      防止一只慢副本长期扣住过多共享块
```

一个保存重逢资格，一个约束正在投递的专线。

## 没有副本以后，账本也会被销毁

`repl-backlog-ttl` 控制主库在没有任何已连接副本后，愿意把 backlog 再保留多久。7.4.11 默认 3600 秒，0 表示永不因这一原因释放。

实验把 TTL 临时设成 10 秒，断开唯一副本。约十秒后日志出现：

```text
Replication backlog freed after 10 seconds without connected replicas.
```

相应指标归零：

```text
repl_backlog_active:0
repl_backlog_first_byte_offset:0
repl_backlog_histlen:0
```

更关键的是，释放 backlog 时主库会更换当前 replication ID，并清空第二 ID。因为历史字节已经不在了，继续保留旧名号只会让未来的副本产生“这本书我认识”的错觉。

于是，即使主库在这十秒里没有写入任何业务数据，旧副本回来也可能全量同步。不是 offset 被大量写入冲掉，而是整个验票柜台已经撤了。

这次实验还踩中过一个真实的坑：为了快速观察，我把 backlog TTL 留在了 10 秒，随后做故障转移；旧主库独处稍久，backlog 被释放、ID 轮换，原本应该演示的增量接管变成全量。恢复 3600 秒后，历史才顺利接上。

**历史是否仍被承认，不只取决于容量，也取决于主库愿意等多久。**

## 换了主库，旧证件为什么还能用

故障转移后，新主库必须生成新的 `master_replid`。否则旧主库若也继续接受写入，两条已经分叉的历史会共用同一个名字。

但立即彻底否认旧 ID，又会让所有原本追随同一条历史的副本被迫全量同步。Redis 的做法是保留一栏“曾用名”：“当前 ID”换新，旧 ID 移到 `master_replid2`，并用 `second_repl_offset` 标出它仍然有效到哪里。

```text
提升以前
replid = A
流位置 = 2306223

提升以后
replid  = B
replid2 = A
second_repl_offset = 2306224
```

新历史 B 从分叉点继续前进；拿着旧历史 A 的副本，只要请求位置没有越过 A 的有效上限，且所需字节仍在 backlog，就可以部分同步到 B。

实验中，一只副本提升为主库后生成新 ID，旧 ID 进入 `master_replid2`，offset 没有归零。随后立刻把旧主库反向挂到新主库，日志显示：

```text
Partial resynchronization ... accepted.
Sending 0 bytes of backlog.
```

零字节不是没有执行 PSYNC，而是双方恰好停在同一位置。旧主库的 ID 与新主库的第二 ID 对得上，页码也仍有效，于是它不需要重新接收数据集。

这套能力通常称作 PSYNC2，自 Redis 4.0 起用于改善故障转移后的部分同步。它允许两段历史在分叉点附近短暂搭桥，却只保留一段上一代 ID；连续多次拓扑变化，不能无限追溯祖谱。

**旧证件没有继续当现任证件，它只在背面的曾用名栏里获得一次通行机会。**

## 断线和重启，不是同一种离开

断线时，副本进程仍活着。它把主库连接缓存为 `cached_master`，保留 replid、已应用 offset 和输入状态，重连后可以直接发起 PSYNC。

重启则会丢失内存中的连接状态。副本能否带回旧证件，取决于复制元数据有没有进入持久化快照。RDB 可以保存 `repl-id`、`repl-offset` 和复制数据库编号，副本加载后有机会恢复 cached master，再尝试部分同步；AOF 本身不携带同等的复制身份信息，官方升级与重启建议因此会特别强调 RDB 路径。

实验时我也被持久化留下的痕迹骗过一次。主库虽然以 `save ""`、`appendonly no` 启动，磁盘式全量复制仍生成过标准 `dump.rdb`。后来为了演示“无持久化崩溃”，主库重启时意外加载了这份复制快照，数据和部分复制元信息都回来了。

这个结果没有推翻配置，只说明：

```text
关闭自动 RDB 保存
≠
磁盘式全量复制从未生成 RDB 文件
```

改用真正干净的数据目录后，`SHUTDOWN NOSAVE` 重启才表现为新的历史。实验的错误预期反而提醒了一条重要边界：断线只是暂时离开柜台，重启能否还是原来那位持证人，要看证件有没有被保存下来。

## WAIT 等的是确认，不是永不丢失

Redis 复制默认是异步的。主库执行写命令以后通常立即回复客户端，不等待副本确认。副本每秒发送 `REPLCONF ACK`，把已经应用到本地数据集的 offset 报给主库。

`WAIT numreplicas timeout` 可以在某次写后要求等待一定数量副本确认到该客户端的最新写 offset：

```text
127.0.0.1:6379> SET order:42 paid
OK
127.0.0.1:6379> WAIT 1 2000
(integer) 1
```

副本在线时，实验在几十毫秒内得到 1；断开副本后，同样的 `WAIT 1 2000` 等满约两秒返回 0。超时不是异常抛出，返回值就是当前确认数量，调用者必须检查它是否达到要求。

但 ACK 表示副本已经处理复制流，不等于数据已写入磁盘，也不等于集群拥有强一致提交协议。实验关闭了主从双方的 RDB 与 AOF：写入一个标记，`WAIT 1` 返回 1，随后让主库不保存退出并重新建立复制历史，这笔已确认的写仍然可以丢失，副本也可能在下一次全量同步中被新主库数据覆盖。

Redis 7.2 加入的 `WAITAOF` 可以进一步等待本机和副本把指定 offset `fsync` 到 AOF，但它也要求相关节点确实开启 AOF，并且调用者检查返回数量。等待落盘提高耐久性，不会自动提供共识、领导者租约或线性一致读。

`min-replicas-to-write` 也不是逐条写入的 N 副本提交。它按最近 ACK 的秒级新鲜度统计“健康副本”数量，不足时拒绝新写，是一种尽力缩小故障丢失窗口的护栏。

**WAIT 能证明某个时刻有几只副本追到这页，不能证明这页从此永远不会被撕掉。**

## 读副本，读到的是一条稍慢的历史

异步复制意味着副本可以落后。`replica-serve-stale-data` 默认是 `yes`：主从链接断开时，副本仍会用已有数据回答读请求。若改成 `no`，除少量管理命令外会返回 `MASTERDOWN`。

即使刚执行过 `WAIT 1`，随后随机读取任意一只副本也不保证读到自己的写。`WAIT 1` 只说明至少一只副本确认到了目标 offset，没有指定客户端下一次会连到哪一只。

过期键同样遵守复制历史。主库真正执行过期删除时，把 `DEL` 或 `UNLINK` 语义写入复制流；副本通常不自行删除主库键，以免不同机器按各自时钟形成不同数据集。读路径可以把逻辑上已过期的键表现为不存在，物理删除仍等待主库的复制命令。

读副本扩展了吞吐和可用路径，也把“我读的是哪个 offset”变成业务必须承担的问题。

## backlog 应按字节流量预算

默认 1MB backlog 对低写入实例可能覆盖几分钟，对高写入实例可能只覆盖几毫秒。拿“通常能扛十秒断线”作为通用经验，没有意义。

一个更接近问题本身的估算是：

```text
backlog 目标容量
≈ 峰值复制字节速率 × 希望容忍的断线窗口
+ 协议、抖动与批量写入余量
```

这里要用复制流字节速率，不是业务 payload 大小。键名、RESP framing、事务包裹、过期删除、脚本传播方式和数据库选择都会贡献字节；一条大命令还可能让分块裁剪后的实际 `histlen` 短暂越过配置容量。

容量之外还有时间。若所有副本断开超过 `repl-backlog-ttl`，backlog 会被释放；若主库重启没有恢复复制元数据，ID 会换代；若副本输出缓冲超限，在线连接也会被踢出，再转而依赖 backlog 自救。

批量重连时，全量同步还可能形成另一种压力。Redis 7.4 默认的无盘复制会等待 `repl-diskless-sync-delay`，默认 5 秒，希望把这段时间内到达的多个副本合并进一次 RDB 子进程；`repl-diskless-sync-max-replicas` 可以在达到指定数量时提前开始，默认 0 表示不启用该数量阈值。

等待五秒不是故意拖慢单只副本，而是在赌还有别人即将到站。赌对了，少按几次 fork 快门；赌错了，第一只副本多等几秒。

**backlog 是替重逢预付的历史，预算必须在断线以前完成。**

## 排查一次全量同步，要看哪几页

先确认结果：

```text
INFO stats
  sync_full
  sync_partial_ok
  sync_partial_err
```

`sync_partial_ok` 增加说明 PSYNC 成功续接；`sync_partial_err` 表示部分同步请求失败；`sync_full` 增加说明最终启动了全量同步。主库日志还会直接写出“accepted”“for lack of backlog”或 ID 不匹配等原因。

再核对身份与窗口：

```text
INFO replication
  master_replid
  master_replid2
  master_repl_offset
  second_repl_offset
  repl_backlog_active
  repl_backlog_size
  repl_backlog_first_byte_offset
  repl_backlog_histlen
```

然后看全量同步付了多少成本：

```text
INFO stats
  total_forks
  latest_fork_usec

INFO persistence
  rdb_bgsave_in_progress
  current_cow_size
  rdb_last_cow_size
```

副本侧则看 `master_link_status`、`master_sync_in_progress`、已读与已应用 offset、剩余同步字节和链接断开时长。在线副本的 `lag` 只能说明 ACK 新鲜度，不能替代 offset 对比。

| 问题 | 首要证据 |
| --- | --- |
| 这次是部分还是全量 | `sync_partial_ok`、`sync_partial_err`、`sync_full` |
| 是否换了一段历史 | `master_replid`、`master_replid2` |
| 请求页码是否已被覆盖 | `first_byte_offset`、`histlen`、双方 offset |
| 是否因 backlog 被释放 | `repl_backlog_active` 与主库日志 |
| 全量同步是否制造 fork 停顿 | `total_forks`、`latest_fork_usec` |
| 副本是否正在加载 | `master_sync_in_progress` 与同步进度 |
| WAIT 为什么没达标 | 副本连接状态、ACK offset 与返回数量 |

一次 `FULLRESYNC` 至少可能死于 ID 不匹配、offset 越界或 backlog 根本不存在。把它们都写成“网络抖了一下”，等于没有排查。

## 重逢的代价，要在分开以前算

**ID 说明双方谈的是不是同一段历史。** 相同 offset 不足以证明数据相同；故障转移通过第二 ID 为上一段历史保留有限的通行窗口。

**offset 是字节页码，不是命令计数。** 一秒钟能走多远取决于复制流量，因此断线时间不能单独决定同步方式。

**backlog 是一份共享的滑动历史。** Redis 7 用分块链表与副本输出共享数据，而不是为每只副本维护一只旧式环形数组；配置大小也是目标窗口，不是严格的逐字节硬上限。

**全量同步不是免费兜底。** 它重新触发快照、传输和加载，还要保存同步期间的新写入。频繁全量会把网络问题放大成 CPU、内存和延迟问题。

**确认与持久化是两条轴。** `WAIT` 等副本应用 offset，`WAITAOF` 等 AOF fsync；它们能提高安全性，却都不把异步复制自动变成共识系统。

Redis 从不挽留断线的副本。它只是把复制流多保留几页，等对方回来时核对名字与页码。能续几页，取决于离开以前留下了多大的账本。

---

```text
19:55:14  旧 ID 对得上，请求页码仍在窗口：+CONTINUE。
19:58:27  同一只副本回来，请求页码已被裁掉：+FULLRESYNC。
19:58:28  快门再次响起，新的完整历史开始传输。
20:05:00  容器删除，账本与柜台一并消失。
```

第一场重逢只补了约一万字节，第二场重逢重新搬运整个数据集。副本离开的时间几乎一样，主库替它保留的历史却不一样。

复制没有记住“你刚才只走了一会儿”。它只认一段 ID、一个字节位置，以及那页账是否还在。

夜里的柜台熄了灯。流水账合上以前，最后一页的页码仍在向前走。
