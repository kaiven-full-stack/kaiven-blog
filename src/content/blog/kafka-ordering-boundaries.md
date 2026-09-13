---
title: 顺序的边界：重试、多实例与全局有序的代价
description: 消息队列系列第六篇。分区内全序绑的是落日志的顺序，不是你的调用顺序，实测它漏在三处。第一批注入一次瞬时故障，重试后落盘，日志顺序变成 2、3、1，一条不丢、时序翻掉，官方 retries 文档逐字写着这个场景；不需要故障，第一批在途慢 400ms 同样翻。幂等 producer 能堵这个洞：同样的延迟下 kafkajs 用每 broker 一把互斥锁让抢跑的批次排队，保住了顺序，但没发出去就失败的批次会让出序列号，业务时序依然没人管。单分区上两个实例各发奇偶号，seq=2 第 6 个才到达；跨分区则根本没有时序。全局有序的代价两头量：写入端单分区 8.6 万条/秒对 3 分区分流 15.4 万，key 钉死成热分区跌回 8.2 万；消费端就是上一篇竞速的 13.1 秒对 6.4 秒。顺序的范围一级比一级窄，每往外一步，责任就多认领一步。
pubDate: 2026-10-23
category: mq
tags: [Kafka, 消息队列, 分布式]
---

上一篇结尾说，要把顺序保证四个字放上秤。Kafka 的文档和教程把「分区内有序」当成卖点反复念，念得它像一句无条件承诺。这一篇把它放上秤：先看承诺的原文到底绑的是什么，再实测三个它保不住的地方，最后给全局有序开个价。剧透结论：承诺本身没有说谎，但它窄得超出多数人的想象，而且每往外扩一步，责任就往消费端挪一步。

## 一、承诺绑的是落日志的顺序

先把主语掰清楚。官方承诺（上一篇引过原文）说的是：任何消费者读一个 topic-partition，读到的顺序与写入顺序完全一致。这里的「写入顺序」指**落进日志的顺序**，也就是 offset 的顺序。这一条无条件成立：日志只追加，先落的 offset 一定小，任何读者都翻不了案。

会漏的全在上游：**谁先落进去**。你以为的顺序是你调用 `send` 的顺序，日志记的却是请求到达 broker 的顺序，这两者之间隔着一段没人担保的路。第一段路就能翻车。

手里的顺序和日志里的顺序，分开画：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="调用顺序与日志顺序：send 1 2 3 是你以为的顺序，中间隔着网络、重试、批量在途这段没人担保的路，日志只记到达顺序，先落进去的 offset 小" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq6As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">承诺绑的是落日志的顺序；你以为的，是调用 send 的顺序</text>
<rect class="bx" x="40" y="44" width="80" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="80" y="67" text-anchor="middle" font-size="14" fill="#2b2a26">send(1)</text>
<rect class="bx" x="140" y="44" width="80" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="180" y="67" text-anchor="middle" font-size="14" fill="#2b2a26">send(2)</text>
<rect class="bx" x="240" y="44" width="80" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="280" y="67" text-anchor="middle" font-size="14" fill="#2b2a26">send(3)</text>
<line class="fl" x1="120" y1="62" x2="134" y2="62" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As1)"/>
<line class="fl" x1="220" y1="62" x2="234" y2="62" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As1)"/>
<text class="ts" x="340" y="66" font-size="12" fill="#6b675e">调用顺序：1 → 2 → 3</text>
<line class="fl" x1="80" y1="80" x2="80" y2="94" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As1)"/>
<line class="fl" x1="180" y1="80" x2="180" y2="94" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As1)"/>
<line class="fl" x1="280" y1="80" x2="280" y2="94" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As1)"/>
<rect class="bx-gone" x="40" y="100" width="580" height="44" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="330" y="126" text-anchor="middle" font-size="12" fill="#6b675e">网络、重试、批量在途、快慢不一致：一段没人担保的路</text>
<line class="fl" x1="190" y1="144" x2="190" y2="158" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As1)"/>
<rect class="bx-q" x="40" y="164" width="300" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="90" y="187" text-anchor="middle" font-size="14" fill="#2b2a26">offset 0</text>
<text class="t" x="190" y="187" text-anchor="middle" font-size="14" fill="#2b2a26">offset 1</text>
<text class="t" x="290" y="187" text-anchor="middle" font-size="14" fill="#2b2a26">offset 2</text>
<text class="ts" x="360" y="186" font-size="12" fill="#6b675e">先落进去的 offset 小，读者读到的就是这个顺序</text>
</svg>
</figure>

生产者发完一批不会干等落盘回执再发下一批：Java 客户端允许单连接上最多 5 个未确认请求同时在途（`max.in.flight.requests.per.connection` 默认 5），kafkajs 默认干脆不设上限。同时在途，就意味着同一分区的两批消息可能一起在路上飞。实验把这一点逼出来：单分区 topic，依序发 seq=1、2、3 三条，给第一个 Produce 请求注入一次可重试的失败（monkey-patch 客户端网络层，等价于 leader 选举期间 broker 回一个 NOT_LEADER_OR_FOLLOWER，真实故障没法按需上演，注入是这类实验的常规做法）：

```text
[190ms] 注入：第一个 Produce 请求失败一次（seq=1 那批）
[244ms] seq=2 的 send 完成
[246ms] seq=3 的 send 完成
[444ms] seq=1 的 send 完成（重试后）

日志顺序：offset0=seq2  offset1=seq3  offset2=seq1
```

三条全在，一条没丢，每个请求最终都成功了，broker 全程健康，但日志里的顺序是 2、3、1。第一批撞上一次瞬时故障、退避 300ms 重试，第二三批一路绿灯先落进日志。官方文档在 `retries` 条目里逐字写着这个场景："Allowing retries while setting enable.idempotence to false and max.in.flight.requests.per.connection to greater than 1 will potentially change the ordering of records"，开着重试、关着幂等、在途大于 1，三个条件凑齐就可能翻序；翻法也写死了，"if two batches are sent to a single partition, and the first fails and is retried but the second succeeds, then the records in the second batch may appear first"，两个批次发往同一分区，第一批失败重试而第二批成功，第二批的记录就可能排在前面。kafkajs 的默认形态正好三个条件全中。

这次翻车在时间轴上：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 284" role="img" aria-label="重试翻序时间轴：seq=1 批次 190ms 时失败一次，退避后重试到 444ms 才落盘；seq=2 在 244ms、seq=3 在 246ms 一路绿灯先落，日志顺序变成 2、3、1" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq6As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">注入一次可重试的失败：第一批翻车，后两批超车</text>
<line class="grid" x1="300" y1="40" x2="300" y2="170" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<line class="grid" x1="346" y1="80" x2="346" y2="170" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<line class="grid" x1="513" y1="40" x2="513" y2="170" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<text class="ts" x="20" y="59" font-size="12" fill="#6b675e">批 seq=1</text>
<rect class="bar" x="140" y="44" width="160" height="20" fill="#2b2a26"/>
<path class="flc" d="M294 48 L306 60 M306 48 L294 60" fill="none" stroke="#b03a2e" stroke-width="2"/>
<line class="grid" x1="300" y1="54" x2="505" y2="54" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.8"/>
<rect class="fill-c" x="505" y="48" width="10" height="12" fill="#b03a2e"/>
<text class="ts" x="400" y="40" text-anchor="middle" font-size="12" fill="#6b675e">失败一次，退避 300ms 重试</text>
<text class="tc" x="513" y="36" text-anchor="middle" font-size="12" fill="#b03a2e">444ms 才落盘</text>
<text class="ts" x="20" y="99" font-size="12" fill="#6b675e">批 seq=2</text>
<rect class="bar" x="140" y="84" width="205" height="20" fill="#2b2a26"/>
<text class="ts" x="353" y="99" font-size="12" fill="#6b675e">244ms，一路绿灯</text>
<text class="ts" x="20" y="139" font-size="12" fill="#6b675e">批 seq=3</text>
<rect class="bar" x="140" y="124" width="207" height="20" fill="#2b2a26"/>
<text class="ts" x="355" y="139" font-size="12" fill="#6b675e">246ms，一路绿灯</text>
<line class="fl" x1="140" y1="170" x2="600" y2="170" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As2)"/>
<text class="ts" x="140" y="190" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="300" y="190" text-anchor="middle" font-size="12" fill="#6b675e">190ms</text>
<text class="ts" x="513" y="190" text-anchor="middle" font-size="12" fill="#6b675e">444ms</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">日志：</text>
<text class="ts" x="132" y="212" text-anchor="middle" font-size="12" fill="#6b675e">offset 0</text>
<text class="ts" x="200" y="212" text-anchor="middle" font-size="12" fill="#6b675e">offset 1</text>
<text class="ts" x="268" y="212" text-anchor="middle" font-size="12" fill="#6b675e">offset 2</text>
<rect class="bx-q" x="100" y="220" width="64" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="132" y="240" text-anchor="middle" font-size="14" fill="#2b2a26">seq 2</text>
<rect class="bx-q" x="168" y="220" width="64" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="200" y="240" text-anchor="middle" font-size="14" fill="#2b2a26">seq 3</text>
<rect class="bx-sick" x="236" y="220" width="64" height="32" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="268" y="240" text-anchor="middle" font-size="12" fill="#b03a2e">seq 1</text>
<text class="tc" x="320" y="240" font-size="12" fill="#b03a2e">一条不丢，时序翻掉</text>
<text class="ts" x="20" y="272" font-size="12" fill="#6b675e">把失败换成「压 400ms 再放行」，同一份结果：翻序不需要错误，只需要快慢不一致</text>
</svg>
</figure>

连故障都不需要。把注入换成「第一个请求压 400ms 再放行」，模拟一批在途变慢（事件循环卡顿、GC、随便什么原因），后面两批照样超车：

```text
[190ms] 注入：第一个 Produce 请求压 400ms（seq=1 那批在途变慢）
[213ms] seq=2 的 send 完成
[228ms] seq=3 的 send 完成
[592ms] seq=1 的 send 完成

日志顺序：offset0=seq2  offset1=seq3  offset2=seq1
```

同一份结果。翻序不需要错误，只需要快慢不一致。顺手一个边角发现：kafkajs 里三个 `send` 并发发出、谁都不 await，连调用顺序都不保（有一轮实测落日志 1、3、2），它的 send 是全异步的，谁先组好请求谁先上线；Java 客户端的 `send()` 在调用线程里同步入队，调用顺序就是入队顺序。跨客户端差异记一笔。

谁该为这个洞负责？默认值给了答案的一半：Java 客户端从 3.0 起 `enable.idempotence` 默认 true，重试翻序出厂就堵上；kafkajs 的 `idempotent` 默认 false，裸 producer 就是上面这个翻序形态。我实验用的正是 kafkajs 的默认形态。

## 二、幂等 producer 怎么堵住这个洞

同样的 400ms 延迟注入，producer 换成 `idempotent: true`，其他一概不动：

```text
[587ms] seq=1 的 send 完成
[589ms] seq=2 的 send 完成
[590ms] seq=3 的 send 完成

日志顺序：offset0=seq1  offset1=seq2  offset2=seq3
```

保住了。seq=2 和 seq=3 乖乖排队 400ms，等慢的那批落完才走。kafkajs 的做法简单粗暴，源码注释写得明白：幂等生产需要每个 broker 一把互斥锁，把带序列号的请求串行化。保序是用串行换来的。Java 客户端的路不一样：不锁，靠 PID 加每分区序列号，broker 端卡门，在途最多 5 批、乱序的序列号直接拒收，两家殊途同归。序列号怎么发、僵尸实例怎么围栏，幂等生产者那篇专门拆，这里只确认一件事：**`max.in.flight` 条目里 "if retries are disabled or if enable.idempotence is set to true, ordering will be preserved" 那句是真的**，保序的两条路，要么放弃重试，要么开幂等。

保序现场的样子：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 288" role="img" aria-label="幂等 producer 保序时间轴：同样的 400ms 延迟注入，seq=2 和 seq=3 排队等慢批次落盘，三批在 587ms 起按 1、2、3 顺序落地，日志顺序保住" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同样压 400ms，idempotent=true：后两批排队等慢的那批</text>
<text class="ts" x="20" y="59" font-size="12" fill="#6b675e">批 seq=1</text>
<rect class="bar" x="140" y="44" width="133" height="20" fill="#2b2a26"/>
<rect class="fill-c" x="273" y="44" width="278" height="20" fill="#b03a2e"/>
<text class="tc" x="412" y="38" text-anchor="middle" font-size="12" fill="#b03a2e">被压 400ms</text>
<text class="ts" x="20" y="99" font-size="12" fill="#6b675e">批 seq=2</text>
<line class="grid" x1="140" y1="94" x2="545" y2="94" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.8"/>
<rect class="bar" x="545" y="84" width="10" height="20" fill="#2b2a26"/>
<text class="ts" x="345" y="78" text-anchor="middle" font-size="12" fill="#6b675e">排队：kafkajs 等每 broker 一把互斥锁，Java 靠序列号卡门</text>
<text class="ts" x="20" y="139" font-size="12" fill="#6b675e">批 seq=3</text>
<line class="grid" x1="140" y1="134" x2="549" y2="134" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.8"/>
<rect class="bar" x="549" y="124" width="11" height="20" fill="#2b2a26"/>
<line class="flk" x1="140" y1="170" x2="600" y2="170" stroke="#2b2a26" stroke-width="1.2"/>
<line class="axis" x1="140" y1="164" x2="140" y2="176" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="551" y1="164" x2="551" y2="176" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="140" y="192" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="551" y="192" text-anchor="middle" font-size="12" fill="#6b675e">587ms 起，三批按序落地</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">日志：</text>
<text class="ts" x="132" y="212" text-anchor="middle" font-size="12" fill="#6b675e">offset 0</text>
<text class="ts" x="200" y="212" text-anchor="middle" font-size="12" fill="#6b675e">offset 1</text>
<text class="ts" x="268" y="212" text-anchor="middle" font-size="12" fill="#6b675e">offset 2</text>
<rect class="bx-q" x="100" y="220" width="64" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="132" y="240" text-anchor="middle" font-size="14" fill="#2b2a26">seq 1</text>
<rect class="bx-q" x="168" y="220" width="64" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="200" y="240" text-anchor="middle" font-size="14" fill="#2b2a26">seq 2</text>
<rect class="bx-q" x="236" y="220" width="64" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="268" y="240" text-anchor="middle" font-size="14" fill="#2b2a26">seq 3</text>
<text class="tc" x="320" y="240" font-size="12" fill="#b03a2e">保住了，代价是串行</text>
<text class="ts" x="20" y="272" font-size="12" fill="#6b675e">边界：没发出去就失败的批次会让出序列号，后发的顶上空号先走，幂等也翻（实测 2、3、1）</text>
</svg>
</figure>

再给两条诚实的边界，都是实测出来的。

边界一：把注入换回「请求没发出去就失败一次」，幂等 producer **也翻了**（日志 2、3、1）。原因在序列号的管理上：kafkajs 对发出去之前就失败的批次会把序列号退回，后发的批次顶上空号先走，重试的那批最后拿新号落盘。幂等 producer 钉死的是「已发放序列号的相对顺序」，你调用 send 的先后如果没变成序列号的先后，它不管。业务时序从头到尾没人担保，担保的边界要看清。

边界二：broker 给抢跑批次的拒绝回执叫 OUT_OF_ORDER_SEQUENCE_NUMBER（code 45），Java 客户端把它当可重试错误，等前序落地自然恢复；kafkajs 的错误表里标的是不可重试，直接失败给应用层。同一个 broker 行为，两个客户端两种后续，跨客户端差异再记一笔。

这个洞到此算堵上了：Java 默认堵好，kafkajs 一行配置。下面两个洞没有配置可开。

## 三、多实例，各发各的

场景：同一条业务线的 seq=1..10，奇数号由实例 A 发、偶数号由实例 B 发，就像同一条流水线的两班倒，请求打到了两个 pod 上。topic 单分区、key 固定 u1，跨分区因素排除在外；两个实例各自顺序发、每条都成功：

```text
消费者到达顺序：1 3 5 7 9 2 4 6 8 10
seq=2 业务上是第 2 个事件，实际第 6 个到达
```

实例 A 手快，5 条奇数连发先落进日志；实例 B 晚启动 50ms，5 条偶数全部排在后面。单分区、全成功、一条不丢，业务时序照样翻。日志忠实记录的是**两个独立写作者的到达顺序**，不是他们各自业务线上的发生顺序。

两条支流汇进一根日志：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="多实例各发各的：实例 A 连发 5 条奇数先落进日志，晚启动 50ms 的实例 B 的 5 条偶数全排后面，到达顺序 1 3 5 7 9 2 4 6 8 10，seq=2 业务上第 2 个、实际第 6 个到达" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq6As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">单分区、key 固定 u1：两个实例，一根日志</text>
<text class="ts" x="60" y="40" font-size="12" fill="#6b675e">实例 A · 奇数号，手快先连发 5 条</text>
<rect class="bx" x="60" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="82" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">1</text>
<rect class="bx" x="108" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="130" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">3</text>
<rect class="bx" x="156" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="178" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">5</text>
<rect class="bx" x="204" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="226" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">7</text>
<rect class="bx" x="252" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="274" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">9</text>
<text class="ts" x="340" y="40" font-size="12" fill="#6b675e">实例 B · 偶数号，晚启动 50ms</text>
<rect class="bx" x="340" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="362" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">2</text>
<rect class="bx" x="388" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="410" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">4</text>
<rect class="bx" x="436" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="458" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">6</text>
<rect class="bx" x="484" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="506" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">8</text>
<rect class="bx" x="532" y="48" width="44" height="28" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="554" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">10</text>
<line class="fl" x1="180" y1="80" x2="180" y2="150" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As3)"/>
<line class="fl" x1="460" y1="80" x2="460" y2="150" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq6As3)"/>
<text class="ts" x="192" y="120" font-size="12" fill="#6b675e">先落</text>
<text class="ts" x="472" y="120" font-size="12" fill="#6b675e">全排在后面</text>
<rect class="bx-q" x="60" y="156" width="540" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="89" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">1</text>
<text class="t" x="143" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">3</text>
<text class="t" x="197" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">5</text>
<text class="t" x="251" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">7</text>
<text class="t" x="305" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">9</text>
<text class="tc" x="359" y="180" text-anchor="middle" font-size="12" fill="#b03a2e">2</text>
<text class="t" x="413" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">4</text>
<text class="t" x="467" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">6</text>
<text class="t" x="521" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">8</text>
<text class="t" x="575" y="180" text-anchor="middle" font-size="14" fill="#2b2a26">10</text>
<line class="flc" x1="359" y1="200" x2="359" y2="214" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="359" y="230" text-anchor="middle" font-size="12" fill="#b03a2e">seq=2：业务上第 2 个事件，实际第 6 个到达</text>
<text class="ts" x="20" y="256" font-size="12" fill="#6b675e">单分区、全成功、一条不丢：只要一根日志有多个写作者，「谁先写」就由各自的时钟和网络决定</text>
</svg>
</figure>

再跑一轮把节奏排好：A 每 20ms 发一条，B 偏移 10ms 也每 20ms 一条，到达顺序恰好 1 到 10。别把这个读成保序，节奏是我人为排的，改成上面那种突发连发立刻就塌。单分区多写者的顺序是运气，不是保证。

这个洞也不是 Kafka 特有的：教具时代 RabbitMQ 一根队列多个 producer，调用顺序同样没人保。只要一根日志有多个写作者，「谁先写」就由各自的时钟、启动时机和网络状况决定，这是物理事实，不是哪家实现的缺陷。补救也不在 broker 端：消息里带上业务时间戳或序列号，消费端按业务时间合并重建顺序，和上一篇给加分区劈历史开的药方是同一张；或者把同一条业务线的写入收敛到单一实例去，代价是可用性和吞吐，一般不划算。

## 四、跨分区，根本没有时序

第三个洞不用做新实验，证据前两篇已经摆好：30 条消息进 3 个分区，各分区内有序、全局交错（分区与键篇的实测）；加分区之后 u5 后写的 seq=2 比先写的 seq=1 早 4 秒被处理完（同一篇的破序现场）。

这里只补一条更根上的：就算让一个消费者独占全部分区，它也读不出一条全局时间线。offset 是分区内各编各的号，分区间不可比；时间戳各批各打，没有全局时钟；poll 按分区的批次返回，先读完哪个分区取决于抓取顺序。「全局第 5 条消息」这个东西不存在，旅程篇说过的话，在这里显出第二层意思：不光位置要说成（分区, offset）的元组，**先后也是**，问「哪条消息先发生」，得先说清楚「在哪个分区里」，跨分区的问题日志不回答。跨分区的顺序只能在消费端重建，按消息里的事件时间归并。事件时间、落盘时间、消费时间这三层时间轴怎么量、读数又怎么骗人，收官的延迟测量篇拆。

## 五、全局有序的成本

真想要全局全序，物理形态只有一条路：单分区。成本两头都摆出来。

写入端，同一个容器、50000 条一轮、5000 条一批分十批顺序发、三轮取最快：

```text
1 分区：              582ms  ≈ 8.6 万条/秒
3 分区（无 key）：    324ms  ≈15.4 万条/秒
3 分区（固定 key）：  610ms  ≈ 8.2 万条/秒
```

第三行最扎眼：topic 开了 3 个分区，key 全是 u1，所有消息挤进同一个分区，吞吐当场跌回单分区水平。并行的上限由分区数设定，能用掉多少由 key 的分布决定，上一篇 p2 全程空着是同一件事的另一面。分流比单分区快 1.8 倍，这个单节点容器拆不干净里面多少是客户端分批编码、多少是 broker 端三根日志并行追加，方向足够清楚：写这一侧，单分区大约折损一半吞吐。

消费端不用重测，上一篇的竞速还热着：9000 条、每条 1ms 处理，3 个消费者分 3 个分区 6.4 秒排空，单分区加到几个人都是 13 秒上下，多出来的人分不到分区。单分区把消费并行度钉死在 1。MySQL 复制篇的读者会有既视感：从库的并行重演按主库的并发模样分组（LOGICAL_CLOCK），主库单线程写出的串行事务流，从库开 4 个 worker 也只能排队。同一堵墙在两个世界里各立了一次：**串行流的并行度就是 1，下游加多少人都改不了**。

还有两笔不显示数字的成本：单分区是单一故障域，它的 leader 挂了整个 topic 停写，有几个副本也只有一个在干活（副本篇展开）；单日志是热点归宿，热 key 的流量全砸在一块盘的一组副本上。全局全序是用最贵的结构买最强的语义，而多数业务其实只要「同一个用户的事情有序」「同一笔订单的状态机有序」，实体级顺序就够了，那正是 key 和分区免费送的档位。

把这一篇的秤收回来，顺序的承诺是一级一级变窄的：

- **分区日志内的 offset 顺序**：无条件成立，追加日志的事实，谁也翻不了案；
- **单个生产者的写入顺序**：幂等开着，重试不翻序（Java 默认开，kafkajs 要自己开）；
- **多个生产者的业务时序**：没人保，带业务时间戳自己重建；
- **跨分区**：没有时序，按事件时间自己归并。

这个收窄的阶梯：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 258" role="img" aria-label="顺序承诺的四级阶梯：分区日志内 offset 顺序无条件成立；单个生产者写入顺序要幂等开着；多生产者业务时序没人保，要带业务时间戳自己重建；跨分区没有时序，按事件时间自己归并。每往外一步承诺弱一级，消费端多认领一级责任" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq6Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">四级承诺，从日志事实到无人担保</text>
<rect class="bx-q" x="30" y="40" width="520" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="50" y="65" font-size="14" fill="#2b2a26">分区日志内的 offset 顺序</text>
<text class="ts" x="530" y="65" text-anchor="end" font-size="12" fill="#6b675e">无条件成立</text>
<rect class="bx" x="70" y="88" width="440" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="90" y="113" font-size="14" fill="#2b2a26">单个生产者的写入顺序</text>
<text class="ts" x="490" y="113" text-anchor="end" font-size="12" fill="#6b675e">幂等开着才不翻</text>
<rect class="bx" x="110" y="136" width="360" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="130" y="161" font-size="14" fill="#2b2a26">多个生产者的业务时序</text>
<text class="ts" x="450" y="161" text-anchor="end" font-size="12" fill="#6b675e">没人保，带业务时间戳</text>
<rect class="bx-gone" x="150" y="184" width="280" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="170" y="209" font-size="14" fill="#2b2a26">跨分区</text>
<text class="ts" x="410" y="209" text-anchor="end" font-size="12" fill="#6b675e">没有时序，按事件时间归并</text>
<path class="flc" d="M590 46 V216" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq6Ac1)"/>
<text class="tc" transform="rotate(90 612 131)" x="612" y="131" text-anchor="middle" font-size="12" fill="#b03a2e">一级一级变窄</text>
<text class="ts" x="30" y="246" font-size="12" fill="#6b675e">业务要的多半是实体级有序：key 选好，分区数定好，那一档是免费的</text>
</svg>
</figure>

每往外一步，承诺弱一级，消费端多认领一级责任。工程上的问题从来不是「怎么让 Kafka 全局有序」，而是「业务到底需要多大范围的有序」，答案十有八九是实体级，key 选好，分区数定好，剩下的是消费端自己的功课。

到这儿，分区在我们的实验里始终是一根日志：单节点，单副本，写完就在那。生产上每根日志背后站着几个副本，leader 挂了谁接班、没 fsync 的数据（日志段篇说过默认不等 fsync）还在不在、ISR 缩水之后写入会不会被拒、unclean 选举丢不丢消息。下一篇把 3-broker 集群搭起来，挨个拔电源。

（实验环境同前三篇：apache/kafka:4.3.1 单容器，kafkajs 2.2.4。故障与延迟是注入的：monkey-patch kafkajs 的 Broker.prototype.produce，只对第一个请求抛一次 retriable 错误或压 400ms，其余请求正常放行，手法与完整输出都在实验笔记里。两个坑记一下：kafkajs 的发送层只重试 e.retriable 为 true 的错误，我第一版注入的普通 Error 被当场 bail，seq=1 根本没发出去，日志只剩两条，差点以为自己发现了丢消息；吞吐对比第一轮用单个巨型 send 发 50000 条，读出「单分区 12.4 秒对 3 分区 2.8 秒」的 4.4 倍假差距，拆开查才发现 kafkajs 单巨型批的编码超线性退化（1 万条 234ms、2 万条 1627ms），单批超过 1MB 还会撞 broker 的 MESSAGE_TOO_LARGE，改成 5000 条分批发才回到 1.8 倍的真实差距。吞吐对比要分批发，永远。）
