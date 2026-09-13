---
title: 让重复消失：幂等生产者、事务与 exactly-once 的边界
description: 消息队列系列第十篇，兑现上一篇结尾那个问题：能不能让 broker 自己把重复消掉。答案分两半。幂等生产者治生产端重试的重复，机制是 PID 加每分区序列号，注入一次「已落盘但 ack 丢失」逼它重试同一批，关幂等消费端收到 [1,1,2,3] 重复一条，开幂等收到 [1,2,3]，broker 认出重复序列号不再落。事务治消费-处理-生产那个窗口，把写输出和提交消费位移绑成一个原子步：一个事务里 send 十条加 sendOffsets，提交后 read_committed 一次全见、消费位移原子推进到 10；abort 或 producer 崩溃超时，输出对 read_committed 一条不可见、位移不前进，重处理不留重复，dump-log 里那条 endTxnMarker ABORT 控制记录就是凭证。事务协调者住在 __transaction_state（50 分区 RF=3 compact，min.insync 比位移日志更严=2），transactional.id 哈希定位，和组协调者同一套。僵尸围栏实测：两个生产者共用一个 transactional.id，后来者初始化把前任 epoch 顶掉，前任提交被拒 PRODUCER_FENCED，日志里同一个 PID 的 epoch 从 0 跳到 2。exactly-once 的边界与价钱也量了：只在 Kafka 到 Kafka 内部成立，外部 sink 要自己幂等；一个不提交的事务把 LSO 钉死，read_committed 连后面已提交的普通消息都读不到；单个大事务和普通发送同量级，可二十个小事务背靠背要十三秒，全耗在 CONCURRENT_TRANSACTIONS 重试上，单个 id 就是串行点。
pubDate: 2026-11-06
category: mq
tags: [Kafka, 消息队列, 分布式]
---

上一篇结尾留了个问题：「处理过但没提交」和「提交了但没处理」这两种窗口造成的重复，能不能甩给 broker，让它自己消掉。这一篇回答。答案是分两半的：生产端重试造成的重复，幂等生产者来治；消费-处理-生产那个窗口的重复，事务来治。两个机制合起来，才凑成 Kafka 口中的 exactly-once。但幂等、事务、exactly-once 这几个词都带边界和价钱，这一篇一并量出来。

环境还是前面几篇那套集群，三个控制器搭三个 broker。工具是 kafkajs 的生产者与消费者，外加容器里的 Java console-consumer 做交叉验证，因为这轮又踩到一个 kafkajs 与 Java 行为对不上的地方，后面会说。

## 一、两种重复

先把「重复」这个词拆成两种，它们的来源不同，药也不同。

第一种在**生产端**。生产者发一批消息，broker 落了盘，可回执（ack）在网络里丢了。生产者没收到回执，以为失败，重试同一批。broker 这边没有任何记性的话，会把这批再落一遍，于是同一条消息出现两次。这种重复生产者自己看不见（它以为第一次失败了），只有下游消费者数出两条才知道。

第二种在**消费端**，就是上一篇拆了整整一节的那个窗口。消费者读一条、处理一条、再提交位移，处理与提交是两个独立动作，中间崩了，重启后要么重放处理过的（先处理后提交，偏重复），要么跳过没处理的（先提交后处理，偏丢失）。把它放到一条「读 topic A、算一下、写 topic B」的流水线里，就更麻烦：写 B 和提交 A 的位移如果分两步，崩在中间，要么 B 写重复了，要么 A 的进度丢了。

幂等生产者治第一种，事务治第二种。下面分开拆。
两个窗口的形状：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 344" role="img" aria-label="两种重复的两个窗口：窗口一在生产端，批次已落盘成功但 ack 在网络里丢失，producer 重试同一批，没有记性的 broker 再落一遍，消费端看到两条相同消息，药是幂等生产者；窗口二在消费端，处理与提交是两步，写 B 之后提交 A 位移之前崩溃会重放写重，反过来的顺序崩溃则永远跳过丢失，药是事务把两步焊成一个原子步" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq10As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq10Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">两种重复，两个窗口，两味药</text>
<text class="t" x="20" y="56" font-size="14" fill="#2b2a26">窗口一 · 生产端：落盘成功了，回执丢了</text>
<rect class="bx-q" x="30" y="72" width="130" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="95" y="94" text-anchor="middle" font-size="14" fill="#2b2a26">producer</text>
<text class="ts" x="95" y="114" text-anchor="middle" font-size="12" fill="#6b675e">没收到 ack</text>
<text class="ts" x="95" y="132" text-anchor="middle" font-size="12" fill="#6b675e">以为失败了</text>
<rect class="bx" x="340" y="72" width="150" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="415" y="94" text-anchor="middle" font-size="14" fill="#2b2a26">broker</text>
<text class="ts" x="415" y="114" text-anchor="middle" font-size="12" fill="#6b675e">已经落盘 ✓</text>
<text class="ts" x="415" y="132" text-anchor="middle" font-size="12" fill="#6b675e">重试的批：再落一遍</text>
<line class="fl" x1="160" y1="86" x2="336" y2="86" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As1)"/>
<text class="ts" x="248" y="78" text-anchor="middle" font-size="12" fill="#6b675e">批（seq=n）</text>
<line class="fl" x1="340" y1="110" x2="164" y2="110" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq10As1)"/>
<text class="tc" x="248" y="104" text-anchor="middle" font-size="12" fill="#b03a2e">ack ✗ 丢在网络里</text>
<line class="flc" x1="160" y1="136" x2="336" y2="136" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq10Ac1)"/>
<text class="tc" x="248" y="164" text-anchor="middle" font-size="12" fill="#b03a2e">重试同一批 seq=n</text>
<text class="ts" x="510" y="94" font-size="12" fill="#6b675e">消费端</text>
<text class="tc" x="510" y="114" font-size="12" fill="#b03a2e">看到两条相同消息</text>
<rect class="bar" x="510" y="126" width="130" height="22" fill="#2b2a26"/>
<text class="onbar" x="575" y="141" text-anchor="middle" font-size="12" fill="#f6f3ec">药：幂等生产者</text>
<text class="t" x="20" y="200" font-size="14" fill="#2b2a26">窗口二 · 消费端：处理与提交是两步</text>
<rect class="bx-q" x="30" y="212" width="96" height="28" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="78" y="230" text-anchor="middle" font-size="12" fill="#6b675e">读 topic A</text>
<line class="fl" x1="126" y1="226" x2="142" y2="226" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As1)"/>
<rect class="bx-q" x="146" y="212" width="96" height="28" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="194" y="230" text-anchor="middle" font-size="12" fill="#6b675e">逐条处理</text>
<line class="fl" x1="242" y1="226" x2="258" y2="226" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As1)"/>
<rect class="bx-q" x="262" y="212" width="104" height="28" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="314" y="230" text-anchor="middle" font-size="12" fill="#6b675e">写 topic B</text>
<line class="fl" x1="366" y1="226" x2="392" y2="226" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As1)"/>
<line class="flc" x1="380" y1="204" x2="380" y2="248" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3"/>
<text class="tc" x="380" y="198" text-anchor="middle" font-size="12" fill="#b03a2e">崩在中间</text>
<rect class="bx-q" x="396" y="212" width="128" height="28" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="460" y="230" text-anchor="middle" font-size="12" fill="#6b675e">提交 A 的位移</text>
<rect class="bar" x="548" y="212" width="92" height="28" fill="#2b2a26"/>
<text class="onbar" x="594" y="230" text-anchor="middle" font-size="12" fill="#f6f3ec">药：事务</text>
<text class="ts" x="30" y="270" font-size="12" fill="#6b675e">写 B 之后、提交 A 之前崩：重启后重放，B 被多写一份（重复）</text>
<text class="ts" x="30" y="292" font-size="12" fill="#6b675e">两步反过来，提交 A 之后、写 B 之前崩：重启后跳过，这条永远丢了（丢失）</text>
<text class="ts" x="20" y="328" font-size="12" fill="#6b675e">两个窗口的根源相同：落盘、回执、处理、提交，这些事件默认绑不成一步</text>
</svg>
</figure>

## 二、幂等生产者：PID 与序列号

顺序篇讲过幂等生产者的保序：kafkajs 用每 broker 一把互斥锁把带序列号的请求串行化，Java 用 PID 加序列号让 broker 卡门，乱序的直接拒。那讲的是同一套机制的「保序」面，这一节讲它的「去重」面。

机制一句话：开了幂等（`enable.idempotence`，Java 3.0 起默认 true；kafkajs 是 `idempotent`，默认 false），生产者先向协调者领一个 **PID**（producer id），之后发往每个分区的每一批都带一个递增的**序列号**。broker 端为每个 (PID, 分区) 记住见过的最大序列号，重试的批次带着同一个序列号回来，broker 一比对，发现是重复，回一个 DUPLICATE_SEQUENCE_NUMBER，但**不再落第二遍**。

实测把这件事逼出来。注入手法沿用顺序篇那套（monkey-patch 客户端的 produce），但这次改一步：让第一批**先真的 append 成功、再对生产者抛一个可重试的错**，模拟「broker 落了盘，ack 丢在路上」。生产者于是重试同一批。单分区 topic，发 seq=1、2、3，只对 seq=1 那批注入：

```text
关幂等（plain）：消费端实收 [1, 1, 2, 3]   seq=1 出现 2 次（broker 把重试的批又落了一遍）
开幂等（idem） ：消费端实收 [1, 2, 3]      seq=1 出现 1 次（broker 认出重复序列号，没再落）
```

一次注入，两种结局，差别只在 producer 开没开幂等。再把开幂等时的日志用 kafka-dump-log 翻开，批次头上能看到这套机制的字段：

```text
producerId=2000  producerEpoch=0  baseSequence=0
producerId=2000  producerEpoch=0  baseSequence=1
producerId=2000  producerEpoch=0  baseSequence=2
```

PID 是这个生产者的身份，序列号逐批递增（关幂等时这两个字段都是 -1，broker 无从去重）。producerEpoch 这一栏现在恒为 0，等第四节讲事务时它会动起来。
去重发生在 broker 比对序列号那一步：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 332" role="img" aria-label="幂等去重时序：PID 2000 的 producer 发批次 baseSeq=0，broker 落盘并记住这个 PID 这个分区见过的最大序列号；ack 在网络里丢失，producer 重试同一批，broker 比对发现序列号重复，回 DUPLICATE_SEQUENCE_NUMBER 不再落第二遍；消费端实收对比：关幂等收到 1、1、2、3，seq=1 出现两次；开幂等收到 1、2、3" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq10As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq10Ac2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">PID + 序列号：broker 的记性怎么长出来</text>
<rect class="bx-q" x="30" y="44" width="130" height="150" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="95" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">producer</text>
<text class="ts" x="95" y="88" text-anchor="middle" font-size="12" fill="#6b675e">PID=2000</text>
<text class="ts" x="95" y="106" text-anchor="middle" font-size="12" fill="#6b675e">开着幂等</text>
<rect class="bx" x="440" y="44" width="180" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="530" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">broker</text>
<text class="ts" x="530" y="88" text-anchor="middle" font-size="12" fill="#6b675e">按 (PID, 分区) 记</text>
<text class="ts" x="530" y="106" text-anchor="middle" font-size="12" fill="#6b675e">见过的最大序列号</text>
<line class="fl" x1="160" y1="76" x2="436" y2="76" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As2)"/>
<text class="ts" x="298" y="68" text-anchor="middle" font-size="12" fill="#6b675e">① 批 baseSeq=0（msg seq=1），落盘</text>
<line class="fl" x1="440" y1="108" x2="164" y2="108" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq10As2)"/>
<text class="tc" x="298" y="100" text-anchor="middle" font-size="12" fill="#b03a2e">② ack ✗ 丢在网络里</text>
<line class="flc" x1="160" y1="140" x2="436" y2="140" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq10Ac2)"/>
<text class="tc" x="298" y="132" text-anchor="middle" font-size="12" fill="#b03a2e">③ 以为失败，重试同一批 baseSeq=0</text>
<line class="fl" x1="440" y1="172" x2="164" y2="172" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As2)"/>
<text class="ts" x="298" y="164" text-anchor="middle" font-size="12" fill="#6b675e">④ 比对发现重复：DUPLICATE_SEQUENCE_NUMBER</text>
<text class="tc" x="298" y="188" text-anchor="middle" font-size="12" fill="#b03a2e">不再落第二遍</text>
<text class="ts" x="20" y="226" font-size="12" fill="#6b675e">同一次注入，消费端实收：</text>
<text class="ts" x="20" y="252" font-size="12" fill="#6b675e">关幂等</text>
<rect class="bx-q" x="100" y="236" width="48" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="124" y="252" text-anchor="middle" font-size="12" fill="#6b675e">1</text>
<rect class="bx-sick" x="152" y="236" width="48" height="24" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="176" y="252" text-anchor="middle" font-size="12" fill="#b03a2e">1</text>
<rect class="bx-q" x="204" y="236" width="48" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="228" y="252" text-anchor="middle" font-size="12" fill="#6b675e">2</text>
<rect class="bx-q" x="256" y="236" width="48" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="280" y="252" text-anchor="middle" font-size="12" fill="#6b675e">3</text>
<text class="tc" x="324" y="252" font-size="12" fill="#b03a2e">seq=1 出现两次：重试的批又落了一遍</text>
<text class="ts" x="20" y="286" font-size="12" fill="#6b675e">开幂等</text>
<rect class="bx-q" x="100" y="270" width="48" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="124" y="286" text-anchor="middle" font-size="12" fill="#6b675e">1</text>
<rect class="bx-q" x="152" y="270" width="48" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="176" y="286" text-anchor="middle" font-size="12" fill="#6b675e">2</text>
<rect class="bx-q" x="204" y="270" width="48" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="228" y="286" text-anchor="middle" font-size="12" fill="#6b675e">3</text>
<text class="ts" x="324" y="286" font-size="12" fill="#6b675e">重试的那批被认出来了，没再落盘</text>
<text class="ts" x="20" y="318" font-size="12" fill="#6b675e">有记性的 broker：同一个 PID 同一个序列号，第二次来只回执不落盘</text>
</svg>
</figure>

两条诚实的边界。其一，幂等去重的范围是**单个生产者、它自己重试的那一批**：同一个 PID 重发同一序列号才去重。你要是业务上故意把同一条消息发两次（两次调用、两个序列号），或者两个生产者各发一条内容相同的，幂等管不着，那是业务重复，得靠消费端幂等兜（投递语义篇的老结论）。其二，幂等只保证单分区内的去重与顺序，跨分区的原子性是另一回事，那是下一节事务的活。

## 三、事务：把输出和位移绑成一个原子步

现在回到上一篇那个窗口。消费-处理-生产这条流水线，问题的根子是「写输出」和「提交消费位移」是两个分开的动作，中间能崩。事务的办法是把它们焊成一个原子步：要么一起生效，要么一起作废。

kafkajs 的写法是 `producer.transaction()` 开一个事务对象，往里 `send` 输出、`sendOffsets` 把消费位移也纳进来，最后 `commit` 或 `abort`。实测一遍：从 topic ktxn-in 读 10 条，一个事务里把转换后的 10 条写进 ktxn-out，同时用 sendOffsets 把消费组在 ktxn-in 的位移提交到 10，然后 commit：

```text
read_committed 看 ktxn-out：10 条 [100,200,...,1000]   全见
消费组 g-txn 在 ktxn-in 的位移：CURRENT-OFFSET=10  LAG=0   原子推进
```

输出和位移一起生效了。再把 commit 换成 abort，同样的流程：

```text
read_committed 看 ktxn-out：0 条
消费组 g-txn 在 ktxn-in 的位移：（组无位移记录，没推进）
```

两个都不作数。这就是关掉上一篇那个窗口的正解：写 B 和提交 A 的位移同生同死，崩在中间不会有「B 写了但 A 没提交」或反过来的半拉子状态。

abort 之后那 10 条去哪了？翻开 ktxn-out 的日志，它们物理上还在，只是被盖了个戳：

```text
baseOffset=0   producerId=2001  isTransactional=true  isControl=false   （10 条数据）
baseOffset=10  producerId=2001  isTransactional=true  isControl=true    endTxnMarker: ABORT
```

事务的数据批次带着 `isTransactional=true`，末尾跟一条 `isControl=true` 的**控制记录**，里面写着 endTxnMarker 是 COMMIT 还是 ABORT。read_committed 的消费者读日志时，遇到 ABORT 标记就把这一整个事务的数据跳过，遇到 COMMIT 才放行。**写了不等于提交了**，提交与否由这条控制记录说了算。

producer 崩溃也是同一个结局，实测过：开事务写 5 条，然后不给 commit 也不给 abort，直接硬退出（等价拔电源），把事务超时设成 10 秒。等过了超时再查，read_committed 看 ktxn-out 是 0 条，日志里那条控制记录是 endTxnMarker: ABORT。producer 死了没人提交，事务协调者到点自动把它 abort 掉，效果和手动 abort 一模一样。上一篇那个「崩在窗口里」的场景，放到事务里就是：崩溃 → 超时 abort → 输出不可见、位移没推进 → 重新消费一遍，不留重复。
三条路落到日志上，形状一致：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 324" role="img" aria-label="事务的结构：一个事务里 send 把转换后的 10 条写进 ktxn-out，sendOffsets 把 g-txn 组在 ktxn-in 的位移推到 10；commit 让两者一起生效，abort 让两者都不作数，producer 崩溃由协调者超时自动 abort。ktxn-out 日志上数据批带 isTransactional 物理落盘，末尾控制记录决定可见性：endTxnMarker 为 COMMIT 时 read_committed 放行 10 条，为 ABORT 时 read_committed 整段跳过看到 0 条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq10As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq10Ac3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">输出与位移装进同一个盒子，算不算数看日志末尾那条记录</text>
<text class="tc" x="38" y="44" font-size="12" fill="#b03a2e">一个事务</text>
<rect class="bx-gone" x="30" y="52" width="360" height="92" rx="6" fill="none" stroke="#a29d90" stroke-dasharray="6 4"/>
<rect class="bx-q" x="46" y="62" width="328" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="210" y="81" text-anchor="middle" font-size="12" fill="#6b675e">send：转换后的 10 条写进 ktxn-out</text>
<rect class="bx-q" x="46" y="100" width="328" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="210" y="119" text-anchor="middle" font-size="12" fill="#6b675e">sendOffsets：g-txn 在 ktxn-in 的位移推到 10</text>
<line class="fl" x1="390" y1="70" x2="428" y2="70" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As3)"/>
<text class="ts" x="436" y="74" font-size="12" fill="#6b675e">commit：一起生效</text>
<line class="flc" x1="390" y1="98" x2="428" y2="98" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq10Ac3)"/>
<text class="tc" x="436" y="102" font-size="12" fill="#b03a2e">abort：都不作数</text>
<line class="flc" x1="390" y1="126" x2="428" y2="126" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq10Ac3)"/>
<text class="tc" x="436" y="130" font-size="12" fill="#b03a2e">崩溃：协调者到点自动 abort</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">ktxn-out 的日志：数据批（isTransactional=true）物理都在，算不算数看末尾</text>
<rect class="msg" x="20" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="39" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="58" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="77" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="96" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="115" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="134" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="153" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="172" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="191" y="188" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="bar" x="218" y="188" width="160" height="24" fill="#2b2a26"/>
<text class="onbar" x="298" y="204" text-anchor="middle" font-size="12" fill="#f6f3ec">控制记录：COMMIT</text>
<line class="fl" x1="378" y1="200" x2="412" y2="200" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq10As3)"/>
<text class="ts" x="420" y="204" font-size="12" fill="#6b675e">read_committed 放行：10 条全见</text>
<rect class="msg" x="20" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="39" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="58" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="77" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="96" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="115" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="134" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="153" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="172" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="191" y="224" width="16" height="24" fill="#a29d90" opacity="0.65"/>
<rect class="bx-sick" x="218" y="224" width="160" height="24" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="298" y="240" text-anchor="middle" font-size="12" fill="#b03a2e">控制记录：ABORT</text>
<line class="flc" x1="378" y1="236" x2="412" y2="236" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq10Ac3)"/>
<text class="tc" x="420" y="240" font-size="12" fill="#b03a2e">read_committed 跳过：0 条</text>
<text class="ts" x="20" y="278" font-size="12" fill="#6b675e">数据批早就落了盘；末尾那条控制记录说算数才算数，位移跟着一起生效或作废</text>
<text class="ts" x="20" y="310" font-size="12" fill="#6b675e">commit、abort、崩溃超时，三条路都终结在同一条控制记录上：原子步的实物形态</text>
</svg>
</figure>

事务协调者住在哪？和上一篇的组协调者是亲兄弟。它有自己的内部 topic `__transaction_state`，规格和 `__consumer_offsets` 高度相似：50 个分区、RF=3、cleanup.policy=compact，定位方式也是拿 transactional.id 哈希取模 50、那个分区的 leader 出任协调者（源码里 `TransactionStateManager.partitionFor` 就是 `Utils.abs(transactionalId.hashCode) % 50`，和组协调者一行代码的套路）。一处不同值得记：`__transaction_state` 的 `min.insync.replicas=2`，而位移日志是 1。事务状态关系到「这批到底算不算数」，持久性要求比「读到哪了」更硬，底线相应抬高了一格。

事务提交本质是一种两阶段：先把这次要写的分区都登记到这个事务上，再由协调者给所有相关分区同时写一条 COMMIT 控制记录，全生效或全不生效。MySQL 的 binlog 与 redo 两阶段提交是同一类思路，都是为「几件事捆成一件、要么全成要么全不成」多付一轮协调。这轮协调就是正确性的价钱，提交篇算过一次，这里再算一次。

这里插一个跨客户端的坑，又是 kafkajs 和 Java 对不上。abort 之后那 10 条物理记录，用 Java console-consumer 加 `--isolation-level read_uncommitted` 去读，能看见（read_uncommitted 的定义就是全可见，包括未提交和已 abort 的）；可同样的 read_uncommitted 换成 kafkajs 的消费者，返回 0 条。查下来是 kafkajs 在客户端侧把 aborted 事务的记录过滤掉了，两种隔离级都过滤，没遵守 read_uncommitted「全可见」的约定。跨客户端差异的清单再添一笔（之前记过的：console 工具的 --property 静默失效、autoCommit 塞错位置被忽略、OUT_OF_ORDER_SEQUENCE 的可重试标记两家相反）。要看 aborted 记录，信 Java，别信 kafkajs。

## 四、僵尸围栏：一个 id 只认一个写者

事务能 abort、能崩溃自动作废，靠的是 transactional.id 这个稳定身份：producer 重启后用同一个 id，就能接上或清理它没完成的事务。但稳定的身份带来一个新问题：要是同一个 transactional.id 被两个 producer 实例同时用呢？老实例没死透（卡在网络分区里、或者一场长 GC 里），新实例已经起来了，两个都拿着同一个 id 往日志里写，谁算数？

Kafka 的答案是**围栏**（fencing），机制还是那个 producerEpoch。每次用某个 transactional.id 初始化，协调者就把这个 id 对应的 epoch 加一，发给新实例。老实例手里的 epoch 成了旧值，它再想提交，broker 直接拒。

实测全程。P1 用 transactional.id=txn-fence 开事务、写 5 条、不提交（模拟它卡住了）；P2 用**同一个 id** 上线初始化；然后让 P1 回来提交：

```text
P2 初始化：先撞 CONCURRENT_TRANSACTIONS（P1 的事务还挂着），重试后协调者发新 epoch，P1 被围栏
P1 提交被拒，报错原文：
  "Producer attempted an operation with an old epoch. Either there is a newer
   producer with the same transactionalId, or the producer's transaction has
   been expired by the broker"
P2 正常提交自己的事务
read_committed 实收：只有 P2 的记录，P1 那 5 条 0 次出现
```

P1 那 5 条随它被围栏的事务一起作废了。翻开日志，epoch 的演进写得清清楚楚，三批记录共用同一个 PID：

```text
producerId=2002  epoch=0  数据批         （P1 写的 5 条）
producerId=2002  epoch=1  ABORT 标记      （围栏把 P1 的事务作废）
producerId=2002  epoch=2  数据批 + COMMIT （P2 写的，正常提交）
```

同一个 transactional.id 映射到同一个 PID（2002），epoch 区分世代。新 epoch 一出现，旧 epoch 的写作者就被踢出局，它没提交的事务被 abort。这套「用一个单调递增的编号围栏掉过期写作者」的把戏，副本篇见过：老 leader 归队，它旧任期号（leader epoch）下的数据被新任期截断。producer epoch 和 leader epoch 是同一个模式的两处应用，谁编号旧谁作废。
围栏的全过程：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 276" role="img" aria-label="僵尸围栏全过程：P1 用 transactional.id txn-fence 初始化拿到 PID 2002 epoch 0，写 5 条后卡住不提交；P2 用同一个 id 初始化，先撞 CONCURRENT_TRANSACTIONS，重试后协调者发新 epoch，P1 回来提交被拒 PRODUCER_FENCED，P2 的数据批加 COMMIT 正常提交；日志里同一个 PID 三批记录：epoch 0 数据批作废，epoch 1 ABORT 标记，epoch 2 数据批加 COMMIT" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq10Ac4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">两个 producer 共用一个 transactional.id：epoch 说了算</text>
<text class="ts" x="20" y="66" font-size="12" fill="#6b675e">P1</text>
<rect class="bx-q" x="56" y="50" width="150" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="131" y="66" text-anchor="middle" font-size="12" fill="#6b675e">init：epoch 0</text>
<rect class="bx" x="214" y="50" width="110" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="269" y="66" text-anchor="middle" font-size="12" fill="#6b675e">写 5 条</text>
<rect class="bx-sick" x="332" y="50" width="150" height="24" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="407" y="66" text-anchor="middle" font-size="12" fill="#b03a2e">卡住，不提交</text>
<text class="tc" x="500" y="58" font-size="12" fill="#b03a2e">提交：被拒</text>
<text class="ts" x="500" y="74" font-size="12" fill="#6b675e">PRODUCER_FENCED</text>
<text class="ts" x="20" y="116" font-size="12" fill="#6b675e">P2</text>
<rect class="bx-q" x="214" y="100" width="170" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="299" y="116" text-anchor="middle" font-size="12" fill="#6b675e">同一个 id 初始化</text>
<rect class="bx-q" x="392" y="100" width="120" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="452" y="116" text-anchor="middle" font-size="12" fill="#6b675e">拿到新 epoch</text>
<rect class="bar" x="520" y="100" width="120" height="24" fill="#2b2a26"/>
<text class="onbar" x="580" y="116" text-anchor="middle" font-size="12" fill="#f6f3ec">数据 + COMMIT</text>
<path class="flc" d="M452 96 V88 H494" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq10Ac4)"/>
<text class="ts" x="214" y="142" font-size="12" fill="#6b675e">先撞 CONCURRENT_TRANSACTIONS（P1 的事务还挂着），重试后拿到新 epoch</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">日志里同一个 PID 2002 的三批记录：</text>
<rect class="msg" x="20" y="186" width="180" height="26" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="110" y="228" text-anchor="middle" font-size="12" fill="#6b675e">epoch 0 · P1 数据批（作废）</text>
<rect class="bx-sick" x="208" y="186" width="160" height="26" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="288" y="228" text-anchor="middle" font-size="12" fill="#6b675e">epoch 1 · ABORT 标记</text>
<rect class="bar" x="376" y="186" width="200" height="26" fill="#2b2a26"/>
<text class="ts" x="476" y="228" text-anchor="middle" font-size="12" fill="#6b675e">epoch 2 · P2 数据批 + COMMIT</text>
<text class="ts" x="20" y="262" font-size="12" fill="#6b675e">P1 那 5 条在 read_committed 里出现 0 次：围栏不用锁，编号本身就是锁</text>
</svg>
</figure>

顺带对照另一种事务的形状。Redis 的 MULTI/EXEC 也叫事务，走法完全不同：MULTI 把命令排队，EXEC 一口气执行，中途某条出错也不回滚、其余照跑；要防并发得配 WATCH，盯住一个 key，EXEC 之前它被人动过就整个作废，这是乐观锁。Kafka 的事务能真 abort（把没提交的写整体作废），还能用 epoch 主动围栏僵尸写者。一个是「先执行、冲突了就丢弃」，一个是「先围栏、可中止、原子提交」，都叫事务，保证的形状差很远。

## 五、exactly-once 的边界与价钱

幂等生产者去重、事务把输出和位移绑成原子、epoch 围栏僵尸，三样凑齐，就是 Kafka 宣传的 exactly-once。但这个词有两处必须说破：边界在哪，价钱多少。

**先说边界。**Kafka 的 exactly-once 只在 **Kafka 到 Kafka 内部**成立：读一个 topic、处理、写另一个 topic、提交位移，这一圈全在 Kafka 里，事务能把它们绑成原子，read_committed 的消费者看到的恰好是不重不漏的一遍。一旦这条流水线的终点是 Kafka 之外（写数据库、调外部接口、发另一套消息系统），事务的手就伸不过去了：Kafka 能让「写 B + 提交 A 位移」原子，但没法让「写外部数据库 + 提交 A 位移」原子，那是两个系统，得靠外部 sink 自己幂等或上真正的分布式两阶段提交。所以「exactly-once」准确的叫法是「Kafka 内部的 exactly-once 处理与投递」，出了 Kafka 边界，重复的责任又回到你手上，和投递语义篇的结论接上。

**再说价钱。**第一笔最隐蔽：read_committed 会被一个没提交的事务挡住。消费者设成 read_committed 后，只能读到一条叫 **LSO**（last stable offset，最后稳定位移）的线以下，而 LSO 卡在最早那个还没结束的事务的第一条记录处。实测：开一个事务写 M1（offset 0）挂着不提交，这时另一个普通生产者写 M2、M3（offset 1、2）并已提交，HW 到了 3：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="一个开放事务钉住 LSO 的日志状态：offset 0 是事务 T 的第一条记录 M1 未提交，offset 1 和 2 是普通消息 M2、M3 已提交，HW 到 3，但 LSO 钉在 0；read_committed 只能读 LSO 以下看到 0 条，连已提交的 M2、M3 都读不到；read_uncommitted 能读到 HW 看到 3 条；事务提交后 LSO 跳到 3，read_committed 一次看到 3 条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一个开放事务把 LSO 钉在原地</text>
<text class="tc" x="66" y="48" font-size="12" fill="#b03a2e">LSO=0：卡在最早那个未结束事务的第一条记录</text>
<line class="flc" x1="60" y1="52" x2="60" y2="110" stroke="#b03a2e" stroke-width="2"/>
<rect class="bx-sick" x="60" y="64" width="120" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="120" y="82" text-anchor="middle" font-size="12" fill="#b03a2e">M1</text>
<text class="tc" x="120" y="98" text-anchor="middle" font-size="12" fill="#b03a2e">事务 T 开放 · 未提交</text>
<rect class="bx-q" x="184" y="64" width="120" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="244" y="82" text-anchor="middle" font-size="12" fill="#6b675e">M2</text>
<text class="ts" x="244" y="98" text-anchor="middle" font-size="12" fill="#6b675e">普通 · 已提交</text>
<rect class="bx-q" x="308" y="64" width="120" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="368" y="82" text-anchor="middle" font-size="12" fill="#6b675e">M3</text>
<text class="ts" x="368" y="98" text-anchor="middle" font-size="12" fill="#6b675e">普通 · 已提交</text>
<line class="flk" x1="428" y1="52" x2="428" y2="110" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="434" y="64" font-size="12" fill="#6b675e">HW=3</text>
<text class="ts" x="120" y="124" text-anchor="middle" font-size="12" fill="#6b675e">offset 0</text>
<text class="ts" x="244" y="124" text-anchor="middle" font-size="12" fill="#6b675e">offset 1</text>
<text class="ts" x="368" y="124" text-anchor="middle" font-size="12" fill="#6b675e">offset 2</text>
<text class="ts" x="20" y="156" font-size="12" fill="#6b675e">read_committed：只能读 LSO 以下 → 看到 0 条</text>
<text class="tc" x="380" y="156" font-size="12" fill="#b03a2e">连已提交的 M2、M3 都读不到</text>
<text class="ts" x="20" y="182" font-size="12" fill="#6b675e">read_uncommitted：能读到 HW → 看到 3 条</text>
<text class="ts" x="20" y="208" font-size="12" fill="#6b675e">事务 T 提交后：LSO 跳到 3，read_committed 解锁，一次看到 3 条</text>
<text class="ts" x="20" y="240" font-size="12" fill="#6b675e">HW 与 LSO 之间那段，就是「已提交但不可见」区：M2、M3 正卡在缝里</text>
</svg>
</figure>

一个卡住的事务，把 read_committed 的消费者堵在它第一条记录那里，后面哪怕全是已提交的普通消息也读不到，队头阻塞。所以事务的超时（transaction.timeout.ms）不能设太长，一个僵死的事务能堵住整条 read_committed 的读。

第二笔是吞吐。同样发 2000 条、单分区 RF=3、同机压缩看相对差，三种发法：

```text
普通生产者            ：约 120-205ms   ≈ 一万多条/秒
一个大事务装全部 2000 条：约  77-94ms   和普通同量级（事务固有开销淹在同机噪音里）
20 个小事务背靠背       ：约 12-14 秒   每事务 600-730ms
```

单个大事务不贵，和普通发送一个量级。贵的是第三行：二十个小事务连续提交，每个要六七百毫秒。拆开看，慢的不是提交本身（单独量一次 commit 才 3 到 11 毫秒），是每个新事务开头的 AddPartitionsToTxn 撞上 CONCURRENT_TRANSACTIONS，客户端退避重试（实测每轮约 270 到 545 毫秒）。根子在协调者按 transactional.id 串行化：上一个事务的状态没落定，下一个就进不来。**单个 transactional.id 是一个串行点**，和顺序篇里「单分区把并行度钉死在 1」是同一类墙。想要吞吐，就给不同的写作者分不同的 transactional.id，让它们各自独立串行；但 id 越多，`__transaction_state` 要管的状态也越多，代价又压回另一头。

## 六、重复没消失，是有人替你挡住了

把这一篇收一下。上一篇问能不能让 broker 自己消掉重复，答案是能，但分两种重复、用两套机制、各有边界。生产端重试的重复，幂等生产者用 PID 加序列号让 broker 认出来、不再落第二遍，实测关幂等收到 [1,1,2,3]、开幂等收到 [1,2,3]。消费-处理-生产窗口的重复，事务把写输出和提交位移绑成一个原子步，提交就都在、abort 或崩溃超时就都不在，read_committed 只看已提交的，日志里那条 endTxnMarker 控制记录是唯一的裁判。僵尸写者由 epoch 围栏，同一个 transactional.id 换了世代，旧的那代提交即被拒。

这些机制不是白来的。事务协调者自己也要一根日志（`__transaction_state`，和位移日志同款结构、更严的 min.insync），也要哈希定位、也要副本和高水位；read_committed 换来干净读，代价是被开放事务队头阻塞；单个 id 的串行化保住了事务边界，也钉死了这一路的并行度。重复没有凭空消失，是 broker 用 PID、序列号、epoch、控制记录、LSO 这一整套机件替你挡在了下游之前，而这套机件的运转成本，最后都摊在吞吐和延迟里。

到这儿，一条消息从生产、落盘、复制、分区、消费、提交位移到事务原子性，Kafka 数据面的骨架拆完了。还差最后一件事没量：这一路走下来到底多快，端到端延迟怎么测才不骗自己。收官篇处理的就是这个，事件时间、落盘时间、消费时间三层怎么对齐，p99 和平均值差在哪，还有一个叫 coordinated omission 的采样陷阱怎么把读数做得好看。

（实验环境同前几篇的 3+3 集群，kafkajs 2.2.4，容器内 Java console-consumer 做隔离级交叉验证。源码结论对的是 apache/kafka:4.3.1：事务协调者 `TransactionStateManager.partitionFor` 用 `Utils.abs(transactionalId.hashCode) % 50`，与组协调者同套路。四个坑记一下。其一，注入「重试」要让它先真 append 成功再抛可重试错，才逼得出 broker 端去重；发出去之前就抛错，broker 根本没落盘，去重无从发生（顺序篇注入的是前者之前的失败，测的是保序，这一篇要的是落盘后的重试）。其二，kafkajs 的 read_uncommitted 会过滤 aborted 事务记录，不遵守全可见语义，看 aborted 得用 Java console 的 --isolation-level。其三，事务 producer 要设 transactionTimeout，默认 60 秒，多步编排加上 console 读取很容易超时被协调者自动 abort，把实验搅成假崩溃。其四，量事务开销别拿「单 id 连续小事务」当代表值，那测的是 CONCURRENT_TRANSACTIONS 退避重试，不是事务本身；固有开销要用一个大事务量。）
