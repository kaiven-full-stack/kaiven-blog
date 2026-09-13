---
title: 上岗人数：副本、ISR 与那场 unclean 选举
description: 消息队列系列第七篇。搭起 3 控制器加 3 broker 的集群挨个拔电源。SIGKILL 一个 follower，控制器等满 9 秒 broker 心跳会话才 fence，ISR 从 3 缩到 2，窗口内 acks=all 的写入慢 4.7 秒但零丢失；优雅停机走 controlled shutdown，收缩只要 2 秒。SIGKILL leader，控制器约 9 秒后直接从 ISR 里指定新 leader，数据面无投票，producer 视角故障窗 8171 毫秒、同一条消息重发成功，老 leader 重启后以 follower 身份归队。杀两台让 ISR 跌破 min.insync.replicas=2，acks=all 当场拒收 NOT_ENOUGH_REPLICAS，acks=1 十五毫秒成功；同机三副本实测 3000 条 acks=0/1/all 各 23/32/45 毫秒。unclean 选举全程实测：独苗 leader 带着 150 条已 ack 的消息下线，陈旧副本只有前 50 条，控制器默认拒绝立它、标出 ELR 等正确的人，分区离线；手动触发 unclean 后 latest 回到 50，丢 100 条，新消息复用丢失段的 offset，带着全部 150 条的原副本归队即被 leader epoch 截断成 53。
pubDate: 2026-10-27
category: mq
tags: [Kafka, 消息队列, 分布式]
---

上一篇结尾留了四个问题：leader 挂了谁接班、没 fsync 的数据还在不在、ISR 缩水之后写入会不会被拒、unclean 选举丢不丢消息。这一篇把真集群搭起来，用拔电源的方式逐个回答。

环境先交代：六个容器，三个控制器（KRaft 元数据面）加三个 broker（数据面），都是 apache/kafka:4.3.1。为什么不像单节点那样三合一？因为实验要同时杀两个 broker，合一模式下三节点杀两个，控制器仲裁（3 票剩 1 票）会跟着陪葬，元数据面先瘫，谁来主持选举？分离部署，数据面死绝了控制面还站得住。宿主机经 localhost:9092/9093/9094 连三个 broker，容器间走内部网络。

## 一、队伍与花名册

建一个 topic：1 个分区、3 副本（RF=3）、`min.insync.replicas=2`，describe 出来：

```text
$ kafka-topics.sh --describe --topic krep
Topic: krep  PartitionCount: 1  ReplicationFactor: 3  Configs: min.insync.replicas=2
    Topic: krep  Partition: 0  Leader: 2  Replicas: 2,3,1  Isr: 2,3,1
```

这几列就是副本世界的全部组织架构。Replicas 是编制：三个副本，各自住在不同 broker 的盘上，每个都是一份完整的日志（日志段篇那套段文件、索引、timeindex，按副本各来一份）。Leader 是唯一受理写入的人；follower 不受理写入、默认也不服务读取，它们的全部工作是持续从 leader 拉日志抄进自己的盘。复制的本质就是两个永不停机的消费者，读到什么就落盘什么。

Isr 是花名册：in-sync replicas，跟得上队伍的人。跟得上的判据是 `replica.lag.time.max.ms`（默认 30 秒），一个 follower 超过 30 秒没追上 leader 的进度就被除名，追回来再入册。花名册之外还有一条水位线：leader 本地写到哪叫 LEO（log end offset），对外承认到哪叫**高水位（HW）**，取花名册内所有副本 LEO 的最小值。消费者只能读到高水位；高水位以上的部分，哪怕就躺在 leader 盘上，也算未提交。

这支队伍和它的水位线，画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 336" role="img" aria-label="一分区三副本的组织架构：producer 写入 leader，两个 follower 持续拉抄；ISR 花名册框住跟得上的副本；leader 的 LEO 是本地写到哪，高水位 HW 取花名册内最短的 LEO，消费者只能读到 HW" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq7As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一个分区 × 3 副本的队伍</text>
<rect class="bx" x="30" y="80" width="110" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="85" y="99" text-anchor="middle" font-size="14" fill="#2b2a26">producer</text>
<text class="ts" x="85" y="117" text-anchor="middle" font-size="12" fill="#6b675e">acks: 0 / 1 / all</text>
<line class="fl" x1="140" y1="102" x2="182" y2="102" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq7As1)"/>
<rect class="bx-gone" x="170" y="44" width="460" height="252" rx="6" fill="none" stroke="#a29d90" stroke-dasharray="6 4"/>
<text class="ts" x="178" y="38" font-size="12" fill="#6b675e">ISR 花名册：跟得上的在册，追不上除名，追回来再入册</text>
<text class="t" x="190" y="80" font-size="14" fill="#2b2a26">broker2 · leader（唯一受理写入）</text>
<rect class="bx-q" x="190" y="88" width="240" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="msg" x="200" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="230" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="260" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="290" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="320" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="360" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="390" y="100" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<line class="flc" x1="350" y1="84" x2="350" y2="128" stroke="#b03a2e" stroke-width="2"/>
<line class="flk" x1="430" y1="84" x2="430" y2="128" stroke="#2b2a26" stroke-width="2"/>
<text class="tc" x="356" y="142" font-size="12" fill="#b03a2e">HW：队伍承认到哪</text>
<text class="ts" x="436" y="110" font-size="12" fill="#6b675e">LEO：leader 本地写到哪</text>
<text class="ts" x="286" y="160" text-anchor="middle" font-size="12" fill="#6b675e">HW 与 LEO 之间：躺在盘上，也算未提交</text>
<text class="ts" x="190" y="180" font-size="12" fill="#6b675e">broker1 · follower：不断从 leader 拉日志抄进自己的盘</text>
<rect class="bx-q" x="190" y="188" width="160" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="msg" x="200" y="197" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="230" y="197" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="260" y="197" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="290" y="197" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="320" y="197" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<line class="flk" x1="350" y1="184" x2="350" y2="222" stroke="#2b2a26" stroke-width="2"/>
<text class="tc" x="356" y="207" font-size="12" fill="#b03a2e">它的 LEO 是花名册里最短的：HW 取的就是这个最小值</text>
<text class="ts" x="190" y="246" font-size="12" fill="#6b675e">broker3 · follower</text>
<rect class="bx-q" x="190" y="254" width="200" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="msg" x="200" y="263" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="230" y="263" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="260" y="263" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="290" y="263" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="320" y="263" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="350" y="263" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<line class="flk" x1="390" y1="250" x2="390" y2="288" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="396" y="273" font-size="12" fill="#6b675e">LEO：追过了 HW</text>
<text class="ts" x="20" y="320" font-size="12" fill="#6b675e">min.insync.replicas 给 acks=all 设底线：花名册人数低于它，写入直接拒收（默认 1，要自己配成 2）</text>
</svg>
</figure>

写入的持久性由 acks 旋钮决定：0 不等任何回执，1 只等 leader，all（即 -1）等花名册全员。两家客户端的默认值都取最稳那档：Java 客户端 acks 默认 all，kafkajs 默认 -1。`min.insync.replicas` 再给 all 设一道底线：花名册人数低于它，acks=all 的写入直接拒收。下面把每个零件都拔一遍电源。

## 二、拔电源

先杀一个 follower（`docker kill`，SIGKILL，等价于拔电源）。宿主机每秒轮询一次分区元数据：

```text
[+ 0.0s] leader=2  isr=[1,2,3]
[+ 9.5s] leader=2  isr=[2,1]    ← 收缩
```

为什么是 9.5 秒，不是 30 秒的落后超时？因为死的是进程，不是网速。broker 每 2 秒向控制器送一次心跳（`broker.heartbeat.interval.ms=2000`），心跳断满 9 秒（`broker.session.timeout.ms=9000`），控制器宣布它死亡（fence），顺手把它从各分区的 ISR 里除名。30 秒的 `replica.lag.time.max.ms` 管的是另一种人：进程活着、心跳照发、数据就是拉不动的慢副本。两条检测路径，两种时延，9.5 秒这个数就是心跳会话超时的形状。

对照组值得记：`docker stop`（优雅停机）后收缩只用了约 2 秒。优雅停机走 controlled shutdown，副本退出前主动向控制器报备，不用等人发现心跳没了。同一件事差出五倍时延，滚动重启和真拔电源在时间轴上是两种事件。

三种时延放在同一根标尺上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="除名的三条路径：SIGKILL 拔电源走心跳会话超时 9.5 秒收缩，优雅停机主动报备只要 2 秒，进程活着但拉不动数据的慢副本要等 30 秒落后超时" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同是「把副本请出花名册」，三条检测路径，三种时延</text>
<text class="ts" x="20" y="59" font-size="12" fill="#6b675e">SIGKILL（真拔电源）</text>
<rect class="bar" x="200" y="44" width="127" height="20" fill="#2b2a26"/>
<text class="tc" x="335" y="59" font-size="12" fill="#b03a2e">9.5s：心跳断满 9 秒，控制器 fence</text>
<text class="ts" x="20" y="95" font-size="12" fill="#6b675e">docker stop（优雅停机）</text>
<rect class="bar" x="200" y="80" width="27" height="20" fill="#2b2a26"/>
<text class="ts" x="235" y="95" font-size="12" fill="#6b675e">≈2s：controlled shutdown 主动报备</text>
<text class="ts" x="20" y="131" font-size="12" fill="#6b675e">进程活着，数据拉不动</text>
<rect class="bar" x="200" y="116" width="400" height="20" fill="#2b2a26"/>
<text class="onbar" x="400" y="131" text-anchor="middle" font-size="12" fill="#f6f3ec">30s：replica.lag.time.max.ms 落后除名</text>
<text class="ts" x="20" y="164" font-size="12" fill="#6b675e">前两条走心跳会话，第三条走进度检查：进程死了，比网慢被发现得更快</text>
</svg>
</figure>

收缩窗口里写入不断。ISR 只剩 2 人时发 100 条 acks=all（min.insync.replicas=2，正好踩线）：成功，但耗时 4.7 秒，写入在等花名册落定。follower 重启后约 4.4 秒追平归队，ISR 回到 [1,2,3]。全程 leader 没动，消费端对账 303 条 seq 连续，零丢失。

再杀 leader。producer 视角（每 300ms 发一条）和元数据视角同时记录：

```text
[+0.9s]  ✗ 首次报错：Connection error（缓存的元数据还指着死 leader）
…持续报错 8.2 秒，每条都重试 2 次后失败…
[+9.1s]  ✓ 恢复：同一条 seq=1018 重发成功
[+9.4s]  元数据：leader 2→3，isr=[1,3]
```

故障窗 8171 毫秒，三个看点。

其一，**选举没有投票**。控制器直接从 ISR 里指定 broker3 上岗，数据面没有任何一轮征求副本意见的往返。对照 Redis 哨兵篇：哨兵切主要过两道多数票（先凑 quorum 同意主库真死了，哨兵之间再选出执行者），Kafka 把投票挪到了楼上：KRaft 控制器自身是个三节点 Raft 仲裁（实测仲裁 leader 是节点 103），fence 谁、立谁都要先过控制器的 Raft 日志。数据面不投票，是因为投票已经在元数据面发生过了。

投票发生在楼上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 306" role="img" aria-label="两层结构：楼上元数据面是三个 KRaft 控制器组成的 Raft 仲裁，fence 谁立谁先过控制器日志；楼下数据面是三个 broker，每 2 秒送心跳上楼，上岗授权下楼，数据面自己不投票" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq7Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
<marker id="mq7As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">数据面不投票：投票在楼上已经发生过了</text>
<rect class="bx" x="40" y="44" width="580" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="60" y="66" font-size="14" fill="#2b2a26">楼上 · 元数据面：KRaft 控制器 Raft 仲裁</text>
<rect class="bx-q" x="80" y="76" width="150" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="155" y="96" text-anchor="middle" font-size="12" fill="#6b675e">控制器 101</text>
<rect class="bx-q" x="250" y="76" width="150" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="325" y="96" text-anchor="middle" font-size="12" fill="#6b675e">控制器 102</text>
<rect class="bx-q" x="420" y="76" width="150" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="495" y="96" text-anchor="middle" font-size="12" fill="#b03a2e">控制器 103 · 仲裁 leader</text>
<rect class="bx" x="40" y="186" width="580" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="60" y="208" font-size="14" fill="#2b2a26">楼下 · 数据面：三个 broker，其中一个是 leader</text>
<rect class="bx-q" x="80" y="218" width="150" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="155" y="238" text-anchor="middle" font-size="12" fill="#6b675e">broker 1</text>
<rect class="bx-q" x="250" y="218" width="150" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="325" y="238" text-anchor="middle" font-size="12" fill="#6b675e">broker 2</text>
<rect class="bx-q" x="420" y="218" width="150" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="495" y="238" text-anchor="middle" font-size="12" fill="#6b675e">broker 3</text>
<line class="fl" x1="200" y1="186" x2="200" y2="134" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq7As4)"/>
<text class="ts" x="192" y="164" text-anchor="end" font-size="12" fill="#6b675e">心跳：每 2 秒一次</text>
<line class="flc" x1="460" y1="128" x2="460" y2="180" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq7Ac1)"/>
<text class="tc" x="468" y="160" font-size="12" fill="#b03a2e">fence / 上岗授权（LeaderAndIsr）</text>
<text class="ts" x="20" y="292" font-size="12" fill="#6b675e">fence 谁、立谁都先过控制器的 Raft 日志：LeaderAndIsr 出自唯一的笔，被 fence 的 broker 收不到上岗授权</text>
</svg>
</figure>

其二，producer 看到的 9 秒不是「集群不可用」，是「地址簿过期」。kafkajs 报的是 Connection error：它按缓存里的地址往死 leader 发请求，元数据刷新后立刻找到新 leader，之前失败的那条原样重发成功。acks=all 之下这个窗口一条不丢，丢的是 8 秒的可用性。

这 8 秒窗口的形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="producer 视角的故障窗时间轴：t=0 SIGKILL leader，0.9 秒起持续报错 8171 毫秒，因为缓存的地址簿还指着死 leader；9.1 秒元数据刷新后同一条 seq=1018 重发成功，一条不丢" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq7As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">SIGKILL leader 之后，producer 视角（每 300ms 发一条）</text>
<rect class="bx-sick" x="110" y="88" width="451" height="24" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="335" y="80" text-anchor="middle" font-size="12" fill="#b03a2e">持续报错 8171ms：地址簿还指着死 leader，每条重试 2 次后失败</text>
<line class="flk" x1="60" y1="66" x2="60" y2="116" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="66" y="62" font-size="12" fill="#6b675e">t=0 SIGKILL leader</text>
<line class="flc" x1="561" y1="66" x2="561" y2="116" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="555" y="62" text-anchor="end" font-size="12" fill="#b03a2e">9.1s 恢复：同一条 seq=1018 重发成功</text>
<line class="fl" x1="60" y1="100" x2="628" y2="100" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq7As2)"/>
<text class="ts" x="60" y="122" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="110" y="122" text-anchor="middle" font-size="12" fill="#6b675e">0.9s 首次报错</text>
<text class="ts" x="561" y="122" text-anchor="middle" font-size="12" fill="#6b675e">9.1s</text>
<text class="ts" x="628" y="142" text-anchor="end" font-size="12" fill="#6b675e">9.4s：元数据刷新，leader 2→3，重发立刻找到新地址</text>
<text class="ts" x="20" y="166" font-size="12" fill="#6b675e">窗口里丢的是可用性，不是数据：acks=all 之下，恢复后原样重发即可</text>
</svg>
</figure>

其三，**没有官复原职**。老 leader 重启归队，身份是 follower，leader 还是 broker3。Kafka 不做自动回切，队伍的稳定优先于谁本该在位。

顺带兑现分区与键篇的一句话：控制器的负担随分区数涨。这次只有一个分区，规模效应量不出来；能确认的是流程，控制器 fence 一个 broker 时，要为它当 leader 的每个分区改写一条元数据日志里的 LeaderAndIsr 记录，分区越多，一次拔电源要重选的越多。规模数字不编，有真集群再量。

## 三、拒收与旋钮

一次杀两台（SIGKILL kafka1、kafka2），只剩 leader broker3，花名册收缩到 [3]，低于 min.insync.replicas=2。这时发 acks=all：

```text
✗ KafkaJSProtocolError: Messages are rejected since there are fewer
  in-sync replicas than required       （NOT_ENOUGH_REPLICAS，code 19）
```

拒收，客户端还把它当可重试错误磨了 13 秒才放弃。同一批消息改 acks=1：15 毫秒成功。同一个集群状态，旋钮当场改判：宁可写不进去，还是先写进去再说。

旋钮的价格也量一下（三 broker 同机、3000 条 × 6 批顺序发、3 轮取最快）：

```text
acks=0   ：23ms ≈ 13.0 万条/秒   不等任何回执
acks=1   ：32ms ≈  9.4 万条/秒   等 leader 一人
acks=all ：45ms ≈  6.7 万条/秒   等 ISR 两人（min.insync=2）
```

三台「机器」在同一台宿主机上，网络往返趋近于零，绝对差距被压得很扁，生产上跨机架跨机房时 all 与 1 的差距会拉开。方向是实打实的：等的确认越多越慢，也越稳。

MySQL 读者认得这道题。复制篇实测过半同步：主库每笔提交等至少一个从库 ACK，常态代价 22 毫秒；从库失联后，提交等满 3 秒超时，然后**半同步静默降级成异步**，写入照常受理，丢失窗口悄悄变宽。副本不够时，MySQL 半同步的默认姿态是降级保可用，Kafka 的 min.insync 姿态是拒收，把问题显式地扔回给应用。Redis 则是第三种默认：主从异步复制，姿态等价于 acks=0，主库写完就应答。没有谁对谁错，但你得知道自己用的那个默认值是什么：降级丢数据不报错，拒收报错不丢数据，异步两头都不打扰你。

还有个容易被略过的细节，这轮实验顺手抓到了。acks=1 发成功的那 100 条，在 ISR 只剩新 leader 一人的窗口里确实进了 leader 的日志（本地写到 offset 403），可对外的 latest 却停在 303，直到 follower 归队追平才涨回 403。latest 就是高水位：新当选 leader 的水位停在当选那一刻，不随本地写入立刻前进。**ack 成功不等于立刻可读**，acks=1 保的是「leader 收到了」，高水位管的是「队伍承认了」，两者之间还隔着一段路。

还要说破一件事：Kafka 的默认配置并不自动等于稳。acks 默认 all 不假，但 `min.insync.replicas` 默认是 1：花名册缩到只剩 leader 时，all 悄悄退化成 1。下一节那 100 条只存在一份的消息，就是这组默认配置的产物。要拒收保护，min.insync.replicas=2 得自己配。

## 四、那场 unclean 选举

前面的实验有个共同前提：数据始终都在，最坏的代价是可用性。这回让数据真死一次，全程四步，每一步都有读数。

**第一步，造一个独苗。**新 topic `kunclean`（RF=3，min.insync.replicas=1）。写入 50 条，三副本人手一份。然后优雅停掉两个 follower（花名册 2 秒缩到 [3]），再写 100 条：acks=all、花名册正好 1 人、min.insync=1，规则全满足，13 毫秒成功，latest 到 150，消费端读得到。此刻这 100 条消息（seq 51..150）在全世界只有一份，躺在 broker3 的盘上。

**第二步，全灭。**停掉 broker3。三个 broker 全部下线，只剩三个控制器守着元数据。produce 连接被拒，分区悬空。

**第三步，错的人回来了。**启动 broker1，那个早被除名的副本，盘里只有前 50 条。查元数据：

```text
Topic: kunclean  Partition: 0  Leader: none  Replicas: 3,1,2
    Isr:      Elr: 3    LastKnownElr: 3
```

Leader: none，ISR 空。控制器明知 broker1 活着，就是不让它上岗：它不在最后的花名册里，立它等于承认那 100 条没了。注意 Elr 这个字段，4.x 的新机制（KIP-966，Eligible Leader Replicas）：ISR 清空时，控制器记得哪些副本「保证拥有到高水位的数据」，把他们列为候补，宁可空位等这些人回来。Elr: 3，正是带着全部 150 条下线的 broker3。系统的默认立场写在这个字段里：**宁可停摆等对的人，不立错的人**。此时 produce 被拒（LEADER_NOT_AVAILABLE，"There is no leader for this topic-partition"），可用性归零，丢失也归零。

**第四步，立错的人。**逃生配置叫 `unclean.leader.election.enable`，默认 false，打开后控制器才允许从花名册之外选一个活人上岗。实测这个配置的脾气：动态改完等了 4.7 分钟没有自动选举，重启 broker1 触发重新注册也没反应（文档里有个 5 分钟的巡逻间隔 `unclean.leader.election.interval.ms=300000`，本轮没等到它的点），最后用专用 CLI 手动触发，立刻生效：

```text
$ kafka-leader-election.sh --topic kunclean --partition 0 --election-type UNCLEAN
Successfully completed leader election (UNCLEAN) for partitions kunclean-0

Topic: kunclean  Partition: 0  Leader: 1  Isr: 1
```

对账开始。生产端曾拿到 150 条的成功 ack；集群现在 latest=50，消费端实收恰好 seq 1..50，连续无缺口；**100 条正式丢失**。再写 3 条新消息（seq 901..903），latest 变成 53：丢失消息占过的 offset 坐标 50、51、52 被新消息顶替。丢失不是一个空洞，是一次覆盖。

最后一步最冷。启动 broker3，它盘里还躺着完整的 150 条，ELR 名单上也有它的名字。结果：它以 follower 身份归队，ISR 变成 [1,3]，latest 依然是 53。它本地那 100 条在新 leader 的任期号下被截断了，就是日志段篇批次头里那个安静的字段 partitionLeaderEpoch：队伍只认 broker1 的任期，旧任期的数据再完整也一律砍掉。三方对账收口：发出且 ack 150 条，可读 53 条（含新写 3 条），丢 100 条，且最后一份副本被物理清零。unclean 选举不是暴露丢失，是执行丢失。

四步和各自的读数，摆在一起：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 424" role="img" aria-label="unclean 选举四步：先停两个 follower 造独苗，150 条里后 100 条只有一份；再停 broker3 全灭；启动只有前 50 条的 broker1，控制器拒绝立它，Leader none，ELR 记着 broker3；手动 unclean 后 latest 回 50，丢 100 条，新消息复用 offset 50 到 52，broker3 归队后被 leader epoch 截断成 53" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq7As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">那场 unclean 选举：四步，每步都有读数</text>
<text class="ts" x="20" y="60" font-size="12" fill="#6b675e">① 造独苗：停两个</text>
<text class="ts" x="20" y="78" font-size="12" fill="#6b675e">follower，再写 100 条</text>
<rect class="bx-gone" x="100" y="44" width="60" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="130" y="68" text-anchor="middle" font-size="12" fill="#6b675e">b1</text>
<rect class="bx-gone" x="170" y="44" width="60" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="200" y="68" text-anchor="middle" font-size="12" fill="#6b675e">b2</text>
<text class="ts" x="165" y="100" text-anchor="middle" font-size="12" fill="#6b675e">已停 · 盘里只有前 50</text>
<text class="ts" x="240" y="38" font-size="12" fill="#6b675e">broker3 · leader，latest=150</text>
<rect class="bx-q" x="240" y="44" width="380" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="msg" x="250" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="280" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="310" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="340" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="380" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="410" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="440" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="470" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="500" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="530" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="560" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="590" y="58" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<line class="flc" x1="370" y1="40" x2="370" y2="88" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="305" y="104" text-anchor="middle" font-size="12" fill="#6b675e">前 50（3 份）</text>
<text class="tc" x="495" y="104" text-anchor="middle" font-size="12" fill="#b03a2e">后 100 条：全世界只有一份</text>
<text class="ts" x="20" y="140" font-size="12" fill="#6b675e">② 全灭：再停 broker3</text>
<rect class="bx-gone" x="100" y="124" width="60" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="130" y="148" text-anchor="middle" font-size="12" fill="#6b675e">b1</text>
<rect class="bx-gone" x="170" y="124" width="60" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="200" y="148" text-anchor="middle" font-size="12" fill="#6b675e">b2</text>
<rect class="bx-gone" x="240" y="124" width="60" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="270" y="148" text-anchor="middle" font-size="12" fill="#6b675e">b3</text>
<text class="ts" x="320" y="142" font-size="12" fill="#6b675e">三个 broker 全下线，只剩三个控制器守着元数据</text>
<text class="ts" x="320" y="160" font-size="12" fill="#6b675e">produce 被拒：分区悬空</text>
<text class="ts" x="20" y="212" font-size="12" fill="#6b675e">③ 错的人回来了：</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">启动 broker1</text>
<rect class="bx" x="100" y="196" width="140" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="170" y="218" text-anchor="middle" font-size="12" fill="#6b675e">broker1 活着</text>
<text class="ts" x="170" y="236" text-anchor="middle" font-size="12" fill="#6b675e">盘里只有前 50</text>
<text class="tc" x="260" y="216" font-size="12" fill="#b03a2e">Leader: none，ISR 空：控制器拒绝立它</text>
<text class="ts" x="260" y="234" font-size="12" fill="#6b675e">Elr: 3，带着全部 150 条的 broker3 在候补名单上</text>
<text class="tc" x="260" y="252" font-size="12" fill="#b03a2e">宁可停摆等对的人，不立错的人</text>
<text class="ts" x="20" y="302" font-size="12" fill="#6b675e">④ 立错的人：手动</text>
<text class="ts" x="20" y="320" font-size="12" fill="#6b675e">UNCLEAN 选举</text>
<rect class="bx-q" x="100" y="286" width="140" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="170" y="310" text-anchor="middle" font-size="12" fill="#6b675e">broker1 · leader</text>
<rect class="bx-q" x="260" y="286" width="140" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx-sick" x="400" y="286" width="24" height="40" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="330" y="342" text-anchor="middle" font-size="12" fill="#6b675e">前 50 条</text>
<text class="tc" x="432" y="304" font-size="12" fill="#b03a2e">新 3 条：offset 50–52 被顶替</text>
<text class="tc" x="432" y="322" font-size="12" fill="#b03a2e">latest=53 · 100 条正式丢失</text>
<line class="fl" x1="170" y1="326" x2="170" y2="360" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq7As3)"/>
<rect class="bx" x="100" y="366" width="140" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="170" y="390" text-anchor="middle" font-size="12" fill="#6b675e">broker3 归队 · follower</text>
<text class="tc" x="260" y="390" font-size="12" fill="#b03a2e">盘里完整的 150 条被 leader epoch 截断成 53：最后一份副本物理清零</text>
</svg>
</figure>

什么时候有人会按它？数据可重建的时候：日志流、埋点、上游还能重放的事件源，停摆的代价大于丢一段数据的代价。交易类的数据、任何重放不回来的东西，永远别按，正确的姿势是把 RF 和 min.insync.replicas 配够，让「等对的人」撑得久一点。这是业务判断，Kafka 只负责把两种结局都摆在明处。

## 五、被裁剪的共识

收个尾，给这套东西定个性。ISR + min.insync + acks=all 看着像共识，细看不是标准共识：没有每条消息的投票往返，花名册成员动态进出，min.insync=2 在 RF=3 下恰好是多数派，配成 1 就是独裁。它裁掉的正是每条消息一轮往返的代价：leader 单方面定顺序，花名册只异步确认进度，日志段篇那百万级顺序写的吞吐才保得住。

正确性靠两条纪律兜底。其一，ack 出去的数据至少在 min.insync 份日志里（注意是写进日志，不是 fsync：日志段篇说过 Kafka 默认不等刷盘，持久性赌的是「多台机器同时掉电」比「一台掉电」罕见几个量级）。其二，选举只从花名册（或 ELR）里挑，新 leader 必然拥有全部已提交数据，unclean 那扇门不开，「立错人丢数据」就不在事故清单上。脑裂则由楼上防住：控制器仲裁保证任何时刻只有一个活跃控制器，LeaderAndIsr 记录出自唯一的笔，被 fence 的 broker 收不到上岗授权，写入全拒（第三节实测过拒收的样子）。

真共识在楼上：KRaft 控制器的每个决定都要过三节点 Raft 仲裁的日志，任期号围栏掉过期的控制器。数据面把共识裁剪成花名册换吞吐，控制面把共识武装到牙齿保正确，这是 Kafka 对「不逐条投票，正确性从哪来」的回答。Raft 本身点到为止，不展开。

四个问题的答案齐了：leader 挂了，控制器从花名册里指定接班人，实测 9 秒上下，producer 重发即可，一条不丢；没 fsync 的数据靠花名册里其他机器的副本兜底，高水位以内安全，以外自认；ISR 缩水跌破 min.insync.replicas 后，acks=all 拒收、acks=1 照写；unclean 选举丢消息，实测丢 100 条，连原副本都会被截断。一个分区到这儿不再是一根日志，是一支有花名册、有任期号、有水位的队伍：leader 收写，follower 抄写，ISR 记谁跟上了，高水位记读到哪安全，acks 与 min.insync 定可用性和持久性怎么互换，unclean 定什么时候认输。

到现在为止刀都落在 broker 身上。下一站轮到消费端：组里死掉一个成员，分区怎么重新分工，旅程篇实测过的那次 29.6 秒等待在等什么，stop-the-world 的老协议和 KIP-848 的新协议差多少。消费者组与 rebalance 那篇，接着杀。

（实验环境：apache/kafka:4.3.1，docker compose 起 3 控制器 + 3 broker（控制器堆 256m、broker 堆 512m），compose 文件与全部脚本在实验室里，宿主机侧 kafkajs 2.2.4，容器内 CLI 走内部监听器。四个坑记一下：4.x 里元数据工具改名 kafka-metadata-quorum.sh，老名字 kafka-metadata.sh 没了；kafkajs 的 fetchTopicOffsets 返回里 low 才是 earliest、high 是 latest，offset 字段是 high 的遗留别名，我拿它当 earliest 读出过「日志里 0 条」的鬼故事，用 Java CLI 交叉验证才破案；分区离线时 kafkajs 的 admin 接口会直接抛 LEADER_NOT_AVAILABLE，轮询工具要包 try/catch；unclean 的自动触发时点指望不上，演示和事故处理都备着 kafka-leader-election.sh 这条手动路径。）
