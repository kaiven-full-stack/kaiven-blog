---
title: 断线以后，不一定从头再来：Redis 的主从复制与增量同步
description: 两次不到一秒的断线，一次只补一万字节，一次却重新同步整个数据集。本文以 replication ID、offset 与 backlog 三个判据为线索，拆开 PSYNC、全量同步、故障转移与 WAIT 的保证边界。实验在隔离容器里完成，机制与源码名称以 Redis 7.4.11 为准。
pubDate: 2026-09-05
category: redis
tags: [Redis, 数据库]
---

同一只副本，两次断线都不到一秒，回到同一台主库，得到的答复却完全不同：第一次是 `+CONTINUE`，只补了约一万字节；第二次是 `+FULLRESYNC`，整个数据集从头再来。

分开了几秒并不参与判定。决定它能不能续上旧历史的，是分开以后主库的复制流向前走了多少字节，以及那些字节是否还保留着。时间只会影响写入量，真正参加判定的是 replication ID、offset 和 backlog。

实验现场由两只受限的 Redis 容器组成，网络与宿主机隔离，主库关闭自动 RDB 和 AOF，单批写入不超过 64KB；实验结束后容器、网络、卷与数据全部删除。文中数字只描述这次实验，机制和源码名称以 Redis 7.4.11 为准。fork 篇后面会讲到，全量复制即使不在本地保存 RDB，也可能让主库重新 fork 一次；这一篇先把那条路径的上游讲清楚：Redis 为什么有时必须从头生成快照，有时只需把断线期间漏掉的那段字节补回来。

## 主库与副本各记一份进度

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

主库的 `INFO replication` 给出主库侧的进度：

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

复制不是主库每写一个键就向副本发一份对象副本。写命令会被编码为 RESP 字节流，进入复制缓冲，再沿连接发给副本。复制双方对齐的是这条字节流，与命令数量和墙上的时间都无关。断线多久是我们选的，能不能续上由这三份记录决定。

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="PSYNC 交互时序：副本重连后递上自己认识的 replid 和需要的下一个 offset；主库核对身份与历史都匹配就回 +CONTINUE 只补发缺失字节，任何一项不匹配就回 +FULLRESYNC 重新生成并传输整份快照" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red11As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="red11Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">重逢时的一次问答，两种答复</text>
<rect class="bx-q" x="60" y="40" width="120" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="120" y="60" text-anchor="middle" font-size="12" fill="#6b675e">副本</text>
<rect class="bx-q" x="460" y="40" width="120" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="520" y="60" text-anchor="middle" font-size="12" fill="#6b675e">主库</text>
<line class="grid" x1="120" y1="72" x2="120" y2="216" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<line class="grid" x1="520" y1="72" x2="520" y2="216" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<line class="fl" x1="120" y1="96" x2="516" y2="96" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As1)"/>
<text class="ts" x="320" y="88" text-anchor="middle" font-size="11" fill="#6b675e">PSYNC &lt;我认识的 replid&gt; &lt;我需要的下一个 offset&gt;</text>
<line class="fl" x1="520" y1="140" x2="124" y2="140" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As1)"/>
<text class="ts" x="320" y="132" text-anchor="middle" font-size="11" fill="#6b675e">身份与历史都匹配：+CONTINUE，只补发缺失的那段字节</text>
<line class="flc" x1="520" y1="188" x2="124" y2="188" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#red11Ac1)"/>
<text class="tc" x="320" y="180" text-anchor="middle" font-size="11" fill="#b03a2e">任一项不匹配：+FULLRESYNC，重新生成并传输整份快照</text>
<text class="ts" x="20" y="234" font-size="12" fill="#6b675e">第一次连接没有历史可出示：PSYNC ? -1，答复只能是 FULLRESYNC</text>
</svg>
</figure>

两种答复只差一个单词，背后却可能相差一次 `fork`、一份 RDB、整段网络传输和一次副本加载。

## 判据一：replication ID

`master_replid` 是一个 40 字符的随机标识。它不只是“这台服务器的 UUID”，更接近一段数据历史的名字。

主库生成复制流，副本完成全量同步后继承这段历史的 ID 与 offset。级联复制中的下游也沿用同一条流，因此一组机器可以共同回答：我们现在谈的是哪一版历史。

只比较 offset 不够。两台毫无关系的主库都可能刚好走到 offset 100000；数字相同，不代表前十万个字节相同。只有 `(replid, offset)` 放在一起，才能定位某段复制历史中的一个位置。

```text
history A: 2c13ff03... @ 100000
history B: 7e9de163... @ 100000
```

页码相同，书不是同一本。

这也是为什么主库身份变化会影响部分同步。若数据历史已经换代，副本拿着旧 ID 回来，不能只凭“我上次读到第几页”就继续。replication ID 属于一段数据历史，不只属于某台机器。

## 判据二：offset

`master_repl_offset` 表示主库已经生成到复制流的哪个字节。每向复制缓冲写入 N 个字节，它就向前移动 N；副本则分别记录已经读入和已经应用的进度。

一条业务命令不等于一个 offset。一条短 `INCR` 只产生几十个协议字节，一条携带 64KB 值的 `SET` 会把 offset 一次推远六万多。事务中的命令、主库合成的过期删除以及数据库切换所需的 `SELECT`，也会成为复制流的一部分。

假设副本已经应用到 1000，它重连时请求的是下一个字节：

```text
PSYNC <replid> 1001
```

主库不需要理解“副本漏了三条 SET”。它只需知道从字节 1001 开始，自己是否仍保存着一段连续历史。

这解释了开场里最容易被忽略的变量：两次都断了不到一秒，一次只写 10KB，另一次写了 192KB。秒表很接近，复制流走过的字节数却完全不同。

`INFO replication` 中副本条目的 `offset` 是它通过 `REPLCONF ACK` 报给主库的确认位置；`lag` 则是距离最近一次 ACK 过去了多少秒。**lag 是时间新鲜度，不是主从相差的字节数。**

## 判据三在主库手里：backlog

副本带回 ID 和 offset，主库还要查自己的复制 backlog。

从语义上看，backlog 是一扇滑动窗口，只保留最近一段复制字节：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 194" role="img" aria-label="复制 backlog 的滑动窗口：左边是被裁掉不再存在的历史字节，中间是窗口仍保留的 histlen 字节，右端是 master_repl_offset 流尾；新字节从右边进入，旧字节从左边淘汰，窗口滑动" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">backlog：一扇只保留最近历史的滑动窗口</text>
<rect class="bx-gone" x="40" y="52" width="140" height="28" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="110" y="70" text-anchor="middle" font-size="11" fill="#6b675e">已被裁掉</text>
<rect class="bx-q" x="180" y="52" width="440" height="28" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="400" y="70" text-anchor="middle" font-size="11" fill="#6b675e">仍在 backlog：histlen 字节，回来续传全靠它</text>
<line class="flc" x1="180" y1="46" x2="180" y2="96" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="186" y="112" font-size="10" fill="#b03a2e">repl_backlog_first_byte_offset</text>
<line class="flk" x1="620" y1="46" x2="620" y2="96" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="614" y="112" text-anchor="end" font-size="10" fill="#6b675e">master_repl_offset（流尾）</text>
<text class="ts" x="40" y="142" font-size="11" fill="#6b675e">first_byte_offset = master_repl_offset − histlen + 1：三个读数互相咬合</text>
<text class="ts" x="40" y="164" font-size="12" fill="#6b675e">窗口是公共的：所有回来请求续传的副本查同一份历史，它不认识任何一只副本</text>
<text class="ts" x="40" y="184" font-size="12" fill="#6b675e">Redis 7 的底层是分块链表，与副本输出共享；逻辑上仍是左淘汰、右进入</text>
</svg>
</figure>

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

第二，backlog 不是每个副本各有一份。它是一份公共历史，所有回来请求续传的副本都查同一个窗口。在线副本自己的发送进度由它在共享分块链表上的引用位置记录。backlog 不认识任何一只副本，它只保留最近那段字节。

## 部分同步的判定是一道区间题

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

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 280" role="img" aria-label="PSYNC 部分同步判定树：先验 replid 是否属于当前历史或可承认的上一段历史，不属于则 FULLRESYNC；再验请求 offset 是否仍在 backlog 窗口区间内，被裁掉或超出则 FULLRESYNC；两关都过才 CONTINUE 从该字节补发" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red11As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="200" y="36" width="240" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="320" y="58" text-anchor="middle" font-size="12" fill="#6b675e">副本递来 replid + offset</text>
<line class="fl" x1="320" y1="72" x2="320" y2="92" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As3)"/>
<rect class="bx" x="190" y="96" width="260" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="320" y="112" text-anchor="middle" font-size="11" fill="#6b675e">第一关 · ID 属于当前历史，</text>
<text class="ts" x="320" y="128" text-anchor="middle" font-size="11" fill="#6b675e">或属于可承认的上一段（replid2）？</text>
<line class="fl" x1="450" y1="116" x2="516" y2="126" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As3)"/>
<text class="ts" x="472" y="106" text-anchor="middle" font-size="10" fill="#6b675e">否</text>
<rect class="bx-sick" x="500" y="128" width="140" height="64" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="570" y="152" text-anchor="middle" font-size="12" fill="#b03a2e">FULLRESYNC</text>
<text class="ts" x="570" y="172" text-anchor="middle" font-size="10" fill="#6b675e">重建基线</text>
<line class="fl" x1="320" y1="136" x2="320" y2="156" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As3)"/>
<text class="ts" x="330" y="150" font-size="10" fill="#6b675e">是</text>
<rect class="bx" x="190" y="160" width="260" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="320" y="176" text-anchor="middle" font-size="11" fill="#6b675e">第二关 · offset 仍落在窗口内？</text>
<text class="ts" x="320" y="192" text-anchor="middle" font-size="11" fill="#6b675e">first_byte_offset ≤ 请求 ≤ 窗口右端</text>
<line class="fl" x1="450" y1="180" x2="496" y2="170" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As3)"/>
<text class="ts" x="470" y="164" text-anchor="middle" font-size="10" fill="#6b675e">否</text>
<line class="fl" x1="320" y1="200" x2="320" y2="220" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As3)"/>
<text class="ts" x="330" y="214" font-size="10" fill="#6b675e">是</text>
<rect class="bx-q" x="200" y="224" width="240" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="320" y="246" text-anchor="middle" font-size="12" fill="#b03a2e">CONTINUE：从该字节开始补发</text>
<text class="ts" x="20" y="122" font-size="10" fill="#6b675e">replid == master_replid，</text>
<text class="ts" x="20" y="136" font-size="10" fill="#6b675e">或 == replid2 且未越过</text>
<text class="ts" x="20" y="150" font-size="10" fill="#6b675e">second_repl_offset</text>
<text class="ts" x="20" y="272" font-size="12" fill="#6b675e">三个 FULLRESYNC 的死因各不相同：日志与 sync_partial_err 会分开记</text>
</svg>
</figure>

`master_replid2` 为什么存在，后面再说。只看最普通的断线重连，结论已经明确：

```text
断线短 + 写入少 + backlog 足够  → 可能部分同步
断线短 + 写入多 + backlog 太小  → 仍会全量同步
断线长 + 几乎没有写入           → 仍可能部分同步
```

**主库核对的是历史区间，与离线时长无关。**

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

副本想要的位置已经落在窗口左边。主库日志变成：

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

毫秒数、协议开销与具体 offset 每次都会变化，但判断不靠这些固定数字。唯一重要的关系是：副本请求的位置是否还落在 backlog 覆盖区间内。时间相近，复制流已经翻过了完全不同长度的历史。

两次断线，两扇窗口：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="两次断线的窗口对照：第一次 backlog 1MB、断线期间只写约 10KB，副本请求的位置落在窗口内，CONTINUE 补发一万字节；第二次 backlog 只有 32KB、断线期间写了约 192KB，请求位置 2109062 落在窗口起点 2272582 的左边，已被裁掉，只能 FULLRESYNC" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">秒表几乎一样，复制流走过的字节天差地别（两行比例尺不同）</text>
<text class="ts" x="20" y="56" font-size="12" fill="#6b675e">第一次 · backlog 1MB · 写入约 10KB</text>
<rect class="bx-q" x="140" y="66" width="440" height="24" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="360" y="82" text-anchor="middle" font-size="10" fill="#6b675e">窗口：1MB 历史都在</text>
<line class="flc" x1="190" y1="58" x2="190" y2="98" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="196" y="112" font-size="10" fill="#b03a2e">请求位置在窗口内：CONTINUE，补发 10,628 字节</text>
<text class="ts" x="20" y="152" font-size="12" fill="#6b675e">第二次 · backlog 32KB · 写入约 192KB</text>
<rect class="bx-gone" x="140" y="162" width="280" height="24" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="280" y="178" text-anchor="middle" font-size="10" fill="#6b675e">被 192KB 新字节裁掉的旧历史</text>
<rect class="bx-q" x="420" y="162" width="160" height="24" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="500" y="178" text-anchor="middle" font-size="10" fill="#6b675e">窗口只剩 32KB</text>
<line class="flc" x1="190" y1="154" x2="190" y2="194" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="196" y="212" font-size="10" fill="#b03a2e">请求 2,109,062 &lt; 窗口起点 2,272,582：FULLRESYNC</text>
<text class="ts" x="20" y="234" font-size="12" fill="#6b675e">决定生死的是这 1 秒里窗口滑过了多少字节</text>
</svg>
</figure>

## 从头再来，要付三笔成本

部分同步只是把 backlog 中缺失的字节挂到副本发送路径上。全量同步则要重建基线，至少付出三笔成本。

第一笔是主库创建一致快照。Redis 7.4 默认开启无盘复制，若副本支持 EOF 能力，RDB 子进程把快照写入管道，由父进程转发到副本；显式关闭无盘复制时，子进程先生成磁盘 RDB。无论出口是网络还是文件，都需要 `fork` 出一只 RDB 子进程。

第二笔是网络传输。完整数据集必须送到副本。无盘复制免去了主库本地临时 RDB，并不消灭 RDB 编码和网络字节。

第三笔是副本加载。默认 `repl-diskless-load disabled` 时，副本先把 RDB 落到临时文件再加载；其他模式可以直接从 socket 加载，但会带来失败恢复或双数据集内存等不同权衡。全量加载期间，副本可能暂时无法正常服务请求。

实验数据集只有约 3.8MB，磁盘式全量同步的 `latest_fork_usec` 约 0.5 毫秒，`total_forks` 随全量次数增加，COW 也只有约 0.5MB。数字很小，是因为现场刻意受限；机制与 fork 篇里数百 MB 的实验一致：数据越大，fork、传输、加载和保存窗口越值得单独预算。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="全量同步三泳道：主线程 fork 后继续服务，同步期间的新写入进复制缓冲；RDB 子进程生成完整快照，无盘时写进管道；副本接收并加载快照，期间可能无法服务，加载完再追平增量" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red11As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一次全量同步的三条时间线</text>
<text class="t" x="20" y="68" font-size="12" fill="#2b2a26">主库</text>
<rect class="bx-sick" x="100" y="52" width="40" height="24" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="120" y="68" text-anchor="middle" font-size="9" fill="#b03a2e">fork</text>
<rect class="bx-q" x="140" y="52" width="470" height="24" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="375" y="68" text-anchor="middle" font-size="10" fill="#6b675e">继续服务；同步期间的新写入进复制缓冲，最后追赶用</text>
<text class="t" x="20" y="128" font-size="12" fill="#2b2a26">子进程</text>
<rect class="bx" x="140" y="112" width="280" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="280" y="128" text-anchor="middle" font-size="10" fill="#6b675e">生成完整 RDB（无盘：直接写管道）</text>
<line class="fl" x1="118" y1="76" x2="136" y2="108" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red11As5)"/>
<text class="t" x="20" y="188" font-size="12" fill="#2b2a26">副本</text>
<rect class="bx" x="180" y="172" width="240" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="300" y="188" text-anchor="middle" font-size="10" fill="#6b675e">接收并加载（期间可能无法服务）</text>
<rect class="bx-q" x="440" y="172" width="170" height="24" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="525" y="188" text-anchor="middle" font-size="10" fill="#6b675e">追增量，回到在线</text>
<line class="fl" x1="280" y1="136" x2="280" y2="168" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#red11As5)"/>
<text class="ts" x="288" y="156" font-size="10" fill="#6b675e">快照字节流</text>
<line class="fl" x1="525" y1="76" x2="525" y2="168" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#red11As5)"/>
<text class="ts" x="533" y="156" font-size="10" fill="#6b675e">缓冲的新写入</text>
<text class="ts" x="20" y="224" font-size="12" fill="#6b675e">无盘复制省掉的是本地临时文件：fork、RDB 编码、网络字节一样都不少</text>
</svg>
</figure>

全量同步不是“部分同步失败以后多传一点”，而是重新建立一条共享历史。

## 公共 backlog 与副本各自的发送进度

backlog 和副本输出缓冲经常被当成同一项配置。Redis 7 的底层存储虽然已经共享，逻辑职责仍然不同。

backlog 是公共历史：即使某只副本断线，只要窗口没有被释放或覆盖，它回来仍能查询旧字节。

在线副本的输出状态则各自独立：每只副本在共享分块链表上各有自己的发送位置。某只副本太慢，会积压它尚未消费的块，并受 `client-output-buffer-limit replica` 约束。7.4.11 的默认限制为：硬限制 256MB，或持续 60 秒超过 64MB；若配置的硬限制小于 backlog，Redis 还会把有效硬限抬到 backlog 大小，因为二者共享内存。

慢副本被输出缓冲限制断开以后，不一定全量重来。若它重连够快，请求 offset 仍在 backlog 中，照样可以 `CONTINUE`。反过来，给每只在线副本很大的输出空间，也不能替代公共 backlog 对断线历史的保存。

```text
backlog：          为可能回来的副本保存最近的历史字节
副本发送位置：      记录当前这只在线副本发送到哪里
输出缓冲限制：      防止一只慢副本长期扣住过多共享块
```

一个保存重逢的资格，一个约束正在进行的投递。

## 没有副本以后，backlog 也会被释放

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

于是，即使主库在这十秒里没有写入任何业务数据，旧副本回来也可能全量同步。原因不在 offset 被写入冲掉，而是可续的历史连同 ID 一起被清空了。

这次实验还踩中过一个真实的坑：为了快速观察，我把 backlog TTL 留在了 10 秒，随后做故障转移；旧主库独处稍久，backlog 被释放、ID 轮换，原本应该演示的增量接管变成全量。恢复 3600 秒后，历史才顺利接上。

**历史是否仍被承认，不只取决于容量，也取决于主库愿意等多久。**

## 换了主库，旧 ID 为什么还能用

故障转移后，新主库必须生成新的 `master_replid`。否则旧主库若也继续接受写入，两条已经分叉的历史会共用同一个名字。

但立即彻底否认旧 ID，又会让所有原本追随同一条历史的副本被迫全量同步。Redis 的做法是保留一栏“曾用名”：“当前 ID”换新，旧 ID 移到 `master_replid2`，并用 `second_repl_offset` 标出它仍然有效到哪里。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 206" role="img" aria-label="故障转移前后的 ID 换挡：提升以前 replid 是 A、流位置 2306223；提升以后新主库 replid 换成 B，旧 ID A 移进 master_replid2 曾用名栏，second_repl_offset 标出 A 仍有效到 2306224；拿着旧 ID 的副本在限额内仍可部分同步到新历史 B" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red11As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">换主时的 ID 换挡：新历史 B，曾用名 A</text>
<rect class="bx" x="30" y="44" width="250" height="86" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="155" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">提升以前</text>
<text class="ts" x="155" y="90" text-anchor="middle" font-size="11" fill="#6b675e">replid = A</text>
<text class="ts" x="155" y="110" text-anchor="middle" font-size="11" fill="#6b675e">流位置 = 2306223</text>
<line class="fl" x1="280" y1="87" x2="356" y2="87" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red11As6)"/>
<text class="ts" x="318" y="77" text-anchor="middle" font-size="10" fill="#6b675e">故障转移</text>
<rect class="bx-q" x="360" y="44" width="270" height="86" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="495" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">提升以后（新主库）</text>
<text class="ts" x="495" y="88" text-anchor="middle" font-size="11" fill="#6b675e">replid = B · replid2 = A</text>
<text class="ts" x="495" y="108" text-anchor="middle" font-size="11" fill="#6b675e">second_repl_offset = 2306224</text>
<text class="ts" x="30" y="160" font-size="12" fill="#6b675e">拿旧 ID A 回来的副本：位置没越过 2306224 且字节还在窗口，就能续到新历史 B</text>
<text class="ts" x="30" y="184" font-size="12" fill="#6b675e">曾用名只留一代：连续多次拓扑变化，不能无限追溯祖谱</text>
</svg>
</figure>

新历史 B 从分叉点继续前进；拿着旧历史 A 的副本，只要请求位置没有越过 A 的有效上限，且所需字节仍在 backlog，就可以部分同步到 B。

实验中，一只副本提升为主库后生成新 ID，旧 ID 进入 `master_replid2`，offset 没有归零。随后立刻把旧主库反向挂到新主库，日志显示：

```text
Partial resynchronization ... accepted.
Sending 0 bytes of backlog.
```

零字节不表示 PSYNC 没有执行，而是双方恰好停在同一位置。旧主库的 ID 与新主库的第二 ID 对得上，offset 也仍有效，于是它不需要重新接收数据集。

这套能力通常称作 PSYNC2，自 Redis 4.0 起用于改善故障转移后的部分同步。它允许两段历史在分叉点附近短暂搭桥，却只保留一段上一代 ID；连续多次拓扑变化，不能无限追溯祖谱。旧 ID 没有继续当现任 ID，它只在“曾用名”栏里获得一次通行机会。

## 断线和重启，不是同一种离开

断线时，副本进程仍活着。它把主库连接缓存为 `cached_master`，保留 replid、已应用 offset 和输入状态，重连后可以直接发起 PSYNC。

重启则会丢失内存中的连接状态。副本能否带回旧的复制身份，取决于复制元数据有没有进入持久化快照。RDB 可以保存 `repl-id`、`repl-offset` 和复制数据库编号，副本加载后有机会恢复 cached master，再尝试部分同步；AOF 本身不携带同等的复制身份信息，官方升级与重启建议因此会特别强调 RDB 路径。

实验时我也被持久化留下的痕迹骗过一次。主库虽然以 `save ""`、`appendonly no` 启动，磁盘式全量复制仍生成过标准 `dump.rdb`。后来为了演示“无持久化崩溃”，主库重启时意外加载了这份复制快照，数据和部分复制元信息都回来了。

这个结果没有推翻配置，只说明：

```text
关闭自动 RDB 保存
≠
磁盘式全量复制从未生成 RDB 文件
```

改用真正干净的数据目录后，`SHUTDOWN NOSAVE` 重启才表现为新的历史。实验的错误预期反而提醒了一条重要边界：断线只是连接暂时断开，重启以后还能不能续上原历史，要看复制元数据有没有被保存下来。

## WAIT 等的是确认，不是永不丢失

Redis 复制默认是异步的。主库执行写命令以后通常立即回复客户端，不等待副本确认。副本每秒发送 `REPLCONF ACK`，把已经应用到本地数据集的 offset 报给主库。

`WAIT numreplicas timeout` 可以在某次写后要求等待一定数量副本确认到该客户端的最新写 offset：

```text
127.0.0.1:6379> SET order:42 paid
OK
127.0.0.1:6379> WAIT 1 2000
(integer) 1
```

副本在线时，实验在几十毫秒内得到 1；断开副本后，同样的 `WAIT 1 2000` 等满约两秒返回 0。超时不会抛出异常，返回值就是当前确认数量，调用者必须检查它是否达到要求。

但 ACK 表示副本已经处理复制流，不等于数据已写入磁盘，也不等于集群拥有强一致提交协议。实验关闭了主从双方的 RDB 与 AOF：写入一个标记，`WAIT 1` 返回 1，随后让主库不保存退出并重新建立复制历史，这笔已确认的写仍然可以丢失，副本也可能在下一次全量同步中被新主库数据覆盖。

Redis 7.2 加入的 `WAITAOF` 可以进一步等待本机和副本把指定 offset `fsync` 到 AOF，但它也要求相关节点确实开启 AOF，并且调用者检查返回数量。等待落盘提高耐久性，不会自动提供共识、领导者租约或线性一致读。

`min-replicas-to-write` 也不是逐条写入的 N 副本提交。它按最近 ACK 的秒级新鲜度统计“健康副本”数量，不足时拒绝新写，是一种尽力缩小故障丢失窗口的护栏。

**WAIT 能证明某个时刻有几只副本追到了这个 offset，不能证明这段历史从此不会再被改写。**

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

批量重连时，全量同步还可能形成另一种压力。Redis 7.4 默认的无盘复制会等待 `repl-diskless-sync-delay`，默认 5 秒，希望把这段时间内到达的多个副本合并进一次 RDB 子进程；`repl-diskless-sync-max-replicas` 可以在达到指定数量时提前开始，默认 0 表示不启用该数量阈值。等待五秒是在赌还有别的副本即将连上来：赌对了，少 fork 几次；赌错了，第一只副本多等几秒。

backlog 是为断线重逢预付的历史，预算要在断线以前做完。

## 排查一次全量同步，要看哪几项

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
| 请求位置是否已被覆盖 | `first_byte_offset`、`histlen`、双方 offset |
| 是否因 backlog 被释放 | `repl_backlog_active` 与主库日志 |
| 全量同步是否制造 fork 停顿 | `total_forks`、`latest_fork_usec` |
| 副本是否正在加载 | `master_sync_in_progress` 与同步进度 |
| WAIT 为什么没达标 | 副本连接状态、ACK offset 与返回数量 |

一次 `FULLRESYNC` 至少可能死于 ID 不匹配、offset 越界或 backlog 根本不存在。把它们都写成“网络抖了一下”，等于没有排查。

## PSYNC 判定的东西

ID 说明双方谈的是不是同一段历史：相同 offset 不足以证明数据相同，故障转移通过第二 ID 为上一段历史保留有限的续传窗口。offset 是字节位置，与命令条数无关：一秒钟能走多远取决于复制流量，因此断线时长不能单独决定同步方式。backlog 是一份共享的滑动历史：Redis 7 用分块链表与副本输出共享数据，配置大小是目标窗口而非逐字节硬上限。全量同步不是免费兜底：它重新触发快照、传输和加载，还要保存同步期间的新写入，频繁全量会把网络问题放大成 CPU、内存和延迟问题。确认与持久化是两条轴：`WAIT` 等副本应用 offset，`WAITAOF` 等 AOF fsync，它们能提高安全性，却都不把异步复制自动变成共识系统。

Redis 从不挽留断线的副本。它只是把复制流多保留一段，等对方回来时核对 ID 与 offset。能续上多少，取决于分开以前留下了多大的窗口、窗口又保留了多久。
