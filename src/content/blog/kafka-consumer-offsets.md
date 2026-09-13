---
title: 位移也是一条日志：__consumer_offsets、压实与提交时机
description: 消息队列系列第九篇，把上一篇结尾点名的 __consumer_offsets 翻开。组的坐标先钉死：复刻 Java 的 String.hashCode，组名哈希定位到 50 个分区之一，那个分区的 leader 就是协调者，15 个活组逐一核对 describe 的 COORDINATOR 列全命中，边界组名 polygenelubricants 的 hashCode 恰是 Integer.MIN_VALUE，源码用 Utils.abs 特判成 0 落进分区 0。再用 kafka-dump-log 把日志挖开：组的花名册（generation、成员、分配）和位移提交是同一分区里两种记录，提交是追加不是覆盖，同 key 提交四次就留四条。cleanup.policy=compact 让 cleaner 只留每个 key 的最新值，实测 4 个段压成 1 个、只剩 5 条记录，旧 generation、被顶替的位移、删组的墓碑一并清掉。提交时机决定生死：同一个崩溃点，先处理后提交重复 3 条丢 0（at-least-once），先提交后处理丢 2 条重复 0、排空后 LAG 归零消息却回不来，autoCommit 间隔 1 秒重复 13 条。最后杀掉协调者：服务端 12 秒选出新 leader，kafkajs 客户端要 70.6 秒才从重试耗尽与重启退避里爬出来，进度零丢失、重复 6 条，新 leader 上 dump 出该组 202 条提交一条不少。
pubDate: 2026-11-03
category: mq
tags: [Kafka, 消息队列, 分布式]
---

上一篇结尾把 `__consumer_offsets` 点了名，说这一篇把它翻开。留下的两个问题是同一个答案：组的协调者是哪台 broker，组提交的位移又存在哪。都指向这个内部 topic。组名哈希到它的 50 个分区之一，那个分区的 leader 出任协调者，组的进度就提交在那个分区里。这一篇一步步来：先钉死组的坐标，再把日志的内容挖出来看，接着看 cleaner 怎么把它压实，用三次崩溃量出提交时机的结局，最后杀掉协调者，看进度丢不丢。

这一篇靠两件工具：kafka-dump-log 把二进制日志里的记录挖成人能读的样子，kafkajs 的消费者负责制造真实的提交和崩溃。集群沿用前面几篇那一套，三个控制器搭三个 broker。

## 一、组的坐标

上一篇第一节贴过一行 describe 输出，COORDINATOR 那列写着 kafka3:29092 (3)。当时只说了一句「哪台 broker 当协调者由组名哈希决定，留到下一篇」，现在兑现。

规则一句话：组名做哈希，对 50 取模（`__consumer_offsets` 固定 50 个分区），落到某个分区，那个分区的 leader broker 就是这个组的协调者。我在脚本里复刻 Java 的 `String.hashCode`（`h = 31*h + c`，按 32 位有符号回绕），取绝对值再模 50，把集群里 15 个活着的组（含上一篇的 g-848、g-static、g-java-eager）逐个算出分区，对照 describe 的 COORDINATOR 列：15/15 全命中。

50 个分区摊在 3 台 broker 上（实测 leader 分布 17/16/17），不同组的协调者自然落在不同机器，管花名册的负担被均摊，没有哪台 broker 当所有组的协调者。这是把 `__consumer_offsets` 切成 50 份的第二个用意：头一个是用分区做并行与复制的单位，这一个是把协调者这个角色摊薄。

定位规则摊开是一条流水线：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 278" role="img" aria-label="组名到协调者的哈希流水线：组名经 String.hashCode（h=31h+c 按 32 位有符号回绕）、Utils.abs 取绝对值（MIN_VALUE 特判归 0）、模 50 落到 __consumer_offsets 的某个分区，该分区的 leader broker 出任这个组的协调者；15 个活组对照 describe 的 COORDINATOR 列全部命中；50 个分区的 leader 摊在 3 台 broker 上，实测分布 17/16/17" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq9As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">组名到协调者：一条哈希流水线</text>
<rect class="bx-q" x="20" y="44" width="104" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="72" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">组名</text>
<text class="ts" x="72" y="86" text-anchor="middle" font-size="12" fill="#6b675e">g-java-eager</text>
<line class="fl" x1="124" y1="72" x2="146" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq9As1)"/>
<rect class="bx" x="150" y="44" width="104" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="202" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">hashCode</text>
<text class="ts" x="202" y="86" text-anchor="middle" font-size="12" fill="#6b675e">h=31h+c 回绕</text>
<line class="fl" x1="254" y1="72" x2="276" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq9As1)"/>
<rect class="bx" x="280" y="44" width="104" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="332" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">Utils.abs</text>
<text class="ts" x="332" y="86" text-anchor="middle" font-size="12" fill="#6b675e">MIN_VALUE 特判</text>
<line class="fl" x1="384" y1="72" x2="406" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq9As1)"/>
<rect class="bx" x="410" y="44" width="104" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="462" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">% 50</text>
<text class="ts" x="462" y="86" text-anchor="middle" font-size="12" fill="#6b675e">落进 0..49</text>
<line class="fl" x1="514" y1="72" x2="536" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq9As1)"/>
<rect class="bx-q" x="540" y="44" width="104" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="592" y="66" text-anchor="middle" font-size="14" fill="#2b2a26">分区 leader</text>
<text class="tc" x="592" y="86" text-anchor="middle" font-size="12" fill="#b03a2e">= 组的协调者</text>
<text class="ts" x="20" y="130" font-size="12" fill="#6b675e">集群里 15 个活组对照 describe 的 COORDINATOR 列：15/15 全命中</text>
<text class="ts" x="20" y="162" font-size="12" fill="#6b675e">50 个分区摊在 3 台 broker 上（实测 leader 分布 17/16/17）</text>
<rect class="bx-q" x="60" y="172" width="160" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="140" y="189" text-anchor="middle" font-size="12" fill="#6b675e">kafka1</text>
<rect class="bx-q" x="250" y="172" width="160" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="330" y="189" text-anchor="middle" font-size="12" fill="#6b675e">kafka2</text>
<rect class="bx-q" x="440" y="172" width="160" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="520" y="189" text-anchor="middle" font-size="12" fill="#6b675e">kafka3</text>
<text class="ts" x="60" y="224" font-size="12" fill="#6b675e">一个组的协调者在哪台机器，只由组名决定</text>
<text class="tc" x="520" y="224" text-anchor="middle" font-size="12" fill="#b03a2e">g-java-eager 的协调者在这</text>
<text class="ts" x="20" y="262" font-size="12" fill="#6b675e">一次哈希定下组的坐标：组名一换，落点就换</text>
</svg>
</figure>

边界上有个坑值得记。Java 的 `String.hashCode` 返回 32 位有符号整数，最负的那个值是 `Integer.MIN_VALUE`（-2147483648），而 `Math.abs` 面对它有个出了名的毛病：绝对值超出正数范围，返回的还是 MIN_VALUE 本身，仍是负数，直接取模会得到负的分区号。Kafka 源码用自己的 `Utils.abs` 兜住，注释写得明白，遇到 MIN_VALUE 返回 0。偏偏真有一个字符串命中这个值，就是经典测试用例 `polygenelubricants`。我拿它当组名建了个消费者，hashCode 算出来正是 -2147483648，`Utils.abs` 归 0，落进分区 0，describe 显示协调者是 kafka2（恰是分区 0 的 leader），入组 Stable，消费正常。一个数学上会捅出负分区的输入，被一行特判接住了。

顺带验证了一件更朴素的事：进度是数据，不是内存。整个集群重启（docker compose 把六个容器重新拉起）之后，这些老组一个不少，提交的位移原样都在。因为 `__consumer_offsets` 自己就是被持久化、被复制的日志，机器重启对它不过是一次重放。

## 二、翻开日志

先看这份日志的规格。`kafka-topics --describe` 加上 broker 配置拼出来：

```text
Topic: __consumer_offsets  PartitionCount: 50  ReplicationFactor: 3
  Configs: cleanup.policy=compact, segment.bytes=104857600,
           min.insync.replicas=1, compression.type=producer
offsets.retention.minutes=10080 (7天)
offsets.retention.check.interval.ms=600000 (10分钟)
```

每个字段都有说法。50 分区、RF=3、segment.bytes 是 100MB（比常规 topic 的 1GB 默认小一个量级，因为它写得勤、段不该太大）。最关键的是 `cleanup.policy=compact`：常规 topic 是 delete（日志段篇讲的那套，到期或超量整段砍掉），它是 compact，另一种完全不同的清理方式，第三节展开。

再用 kafka-dump-log 把某个分区的内容挖出来：

```text
$ kafka-dump-log.sh --files 00000000000000000000.log --offsets-decoder
```

`--offsets-decoder` 是钥匙，它把二进制记录按 `__consumer_offsets` 的专用格式解析。挖出来是两种记录。

第一种 key 的 type=2，是组的元数据，也就是协调者管的那份花名册：

```text
key:     {"type":"2","data":{"group":"g-dump"}}
payload: {"version":"3","data":{"protocolType":"consumer","generation":1,
  "protocol":"RoundRobinAssigner","leader":"mq-lab-ea2a...",
  "members":[{"memberId":"mq-lab-ea2a...","clientId":"mq-lab",
    "clientHost":"/172.24.0.1","sessionTimeout":30000,
    "subscription":{"topics":["kofs"]},
    "assignment":{"assignedPartitions":[{"topic":"kofs","partitions":[0,1,2]}]}}]}}
```

成员名单、任期号（generation）、分配算法、谁是组 leader、每个成员分到哪些分区，上一篇 describe --members 看到的东西，底层就是这样一条记录。每次 rebalance 追加一条新的 generation 记录，任期号单调递增。

第二种 key 的 type=1，才是位移提交：

```text
key:     {"type":"1","data":{"group":"g-dump","topic":"kofs","partition":1}}
payload: {"version":"4","data":{"offset":5,"leaderEpoch":-1,"metadata":"",
  "commitTimestamp":1789274345382,"topicId":"K3C_ny5nS-qWDtBWViH1TQ"}}
```

key 是 (组, topic, 分区) 三元组，value 是它读到了哪（offset）外带提交时间戳。消费者调一次 commitOffsets，协调者就往 `__consumer_offsets` 的对应分区追加一条这样的记录。

两种记录并排看，一个组的完整生命史就浮出来了，全在同一个分区里：先来一条 gen0 空组，有人入组来一条 gen1（带 members），中间穿插位移提交，成员走光来一条 gen2（members 空），组被删或过期来一条收尾。组的生死，在这份日志里是一串逐条追加的事件，这里没有「改写某一行的某个字段」这种操作。

提交即追加这一点要单独敲实。我让一个组对同一个 (kofs, partition 0) 先后提交了 offset 5、10、15，挖出来同一个 key 底下这几次提交各占一条独立记录，各有各的 offset 和 commitTimestamp。旧记录不被覆盖，就待在原地，新记录追加在后头。日志的定义就是这个：只追加，不改写。协调者读的时候只认每个 key 最新的那条，这件事交给第三节的 cleaner。

生命史在日志里的形状：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="__consumer_offsets 同一分区里的两种记录按追加顺序排列：type=2 的组元数据记录 generation、成员与分配（gen0 空组、gen1 带成员、gen2 人走光），type=1 的位移提交记录（组、topic、分区）读到了哪个 offset；同一个 key 先后提交 offset 5、10、15 各占一条独立记录，追加而不覆盖" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq9As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">日志里的生命史：两种记录交错追加</text>
<text class="ts" x="14" y="44" font-size="12" fill="#6b675e">早</text>
<line class="fl" x1="40" y1="52" x2="40" y2="236" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq9As2)"/>
<text class="ts" x="14" y="256" font-size="12" fill="#6b675e">晚</text>
<rect class="bx" x="60" y="48" width="64" height="24" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="92" y="64" text-anchor="middle" font-size="12" fill="#6b675e">type=2</text>
<text class="ts" x="136" y="64" font-size="12" fill="#6b675e">gen 0：空组（还没有成员）</text>
<rect class="bx" x="60" y="82" width="64" height="24" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="92" y="98" text-anchor="middle" font-size="12" fill="#6b675e">type=2</text>
<text class="ts" x="136" y="98" font-size="12" fill="#6b675e">gen 1：members、分配、谁是组 leader</text>
<rect class="bx-q" x="60" y="116" width="64" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="92" y="132" text-anchor="middle" font-size="12" fill="#6b675e">type=1</text>
<text class="ts" x="136" y="132" font-size="12" fill="#6b675e">(g-dump, kofs, p0) → offset 5</text>
<rect class="bx-q" x="60" y="150" width="64" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="92" y="166" text-anchor="middle" font-size="12" fill="#6b675e">type=1</text>
<text class="ts" x="136" y="166" font-size="12" fill="#6b675e">(g-dump, kofs, p0) → offset 10</text>
<rect class="bx-q" x="60" y="184" width="64" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="92" y="200" text-anchor="middle" font-size="12" fill="#6b675e">type=1</text>
<text class="ts" x="136" y="200" font-size="12" fill="#6b675e">(g-dump, kofs, p0) → offset 15</text>
<rect class="bx" x="60" y="218" width="64" height="24" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="92" y="234" text-anchor="middle" font-size="12" fill="#6b675e">type=2</text>
<text class="ts" x="136" y="234" font-size="12" fill="#6b675e">gen 2：人走光（members 空）</text>
<path class="flc" d="M350 118 h8 v88 h-8" fill="none" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="366" y="158" font-size="12" fill="#b03a2e">同一个 key 提交三次</text>
<text class="tc" x="366" y="176" font-size="12" fill="#b03a2e">就留三条记录</text>
<text class="ts" x="20" y="282" font-size="12" fill="#6b675e">key 说清这条记录是谁的，payload 说清发生了什么；旧值谁来打扫，是下一节 cleaner 的事</text>
</svg>
</figure>

末尾还有个批次头字段值得扫一眼，partitionLeaderEpoch，和日志段篇批次头里那个同名。它记这批记录是在该分区第几任 leader 手下写的，集群重启、leader 换人，都会让它往上跳，痕迹全留在这里。

## 三、压实：50 个分区为什么不撑爆

常规 topic 到期或超量就把最老的段整段砍掉，这是 delete，日志段篇讲过。`__consumer_offsets` 用的是另一种，compact（压实）：cleaner 线程扫描日志，对每个 key 只保留最新的那条值，更早的同 key 记录一律删掉。

为什么这里非得 compact？因为这份日志里的记录，含义是「当前读到了哪」，一路怎么读上来的轨迹没有价值。某个 (组, topic, 分区) 只关心它最新的 offset，5、10、15 里只有 15 算数，前两条被顶替之后就可以扔。delete 按时间砍，会误伤某个 key 仅有的那条当前记录；compact 按 key 砍，恰好留住每个 key 的最新值。状态型的数据（位移、组元数据）配 compact，事件型的数据（业务消息）配 delete，这是两种清理策略的分水岭。

我实测了一把压实的效果。让一个组对同一个 (topic, 分区) 连着提交几轮：offset 5、10、15 提交上去（kafkajs 的 autoCommit 还会在每个批末多补一条重复的 15，这是个坑，末尾讲），再来一轮又提交 20、25、30，同一个 key 底下摞了六个版本；混上 rebalance 的几代元数据、删组的一条墓碑，日志长到 4 个段，光头一个段里这个组就占了 20 条记录。然后把 cleaner 的出手条件调到最松：动态改这个 topic 的 segment.ms 到 1000（每秒滚段），min.cleanable.dirty.ratio 到 0（脏比阈值归零），min.compaction.lag.ms 到 0（压实延迟归零），再用一个新组入组把老段从活动滚成非活动。等几秒再挖：

```text
压实前：4 个段（光头段就 20 条本组记录）
压实后：1 个段，5 条记录
```

规律清清楚楚。每个 (组, topic, 分区) 的 key 只剩最新那条 offset（=30），早先的 5、10、15、20、25 全删；组元数据的 key 只剩最新一代，旧 generation 全删；两个组各留一条最新元数据。4 个段并成 1 个，5 条记录里是三个分区各自的最新位移，加两个组各自的最新一代。丢掉的全是被顶替的旧值。

压实前 4 个段，压实后 1 个段：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 286" role="img" aria-label="压实前后对比：压实前日志有 4 个段，同一个 key 底下摞着 offset 5、10、15、15、20、25 的旧版本，还有旧代元数据和删组墓碑；cleaner 扫过之后只剩 1 个段 5 条记录，每个 key 只留最新一条：p0 的 30、p1 和 p2 各自的最新位移、两个组各自的最新一代" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq9Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">压实前后：4 个段并成 1 个段</text>
<text class="ts" x="20" y="52" font-size="12" fill="#6b675e">压实前：4 个段（光头一个段就有 20 条本组记录）</text>
<rect class="msg" x="20" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="40" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">5</text>
<rect class="msg" x="63" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="83" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">10</text>
<rect class="msg" x="106" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="126" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">15</text>
<rect class="msg" x="149" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="169" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">15</text>
<line class="fl" x1="190" y1="58" x2="190" y2="90" stroke="#6b675e" stroke-width="1"/>
<rect class="msg" x="192" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="212" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">20</text>
<rect class="msg" x="235" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="255" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">25</text>
<rect class="bar" x="278" y="60" width="40" height="28" fill="#2b2a26"/>
<text class="onbar" x="298" y="79" text-anchor="middle" font-size="12" fill="#f6f3ec">30</text>
<rect class="msg" x="321" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="341" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">旧代</text>
<line class="fl" x1="362" y1="58" x2="362" y2="90" stroke="#6b675e" stroke-width="1"/>
<rect class="msg" x="364" y="60" width="40" height="28" fill="#a29d90" opacity="0.65"/>
<text class="t" x="384" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">旧代</text>
<rect class="bx-gone" x="407" y="60" width="40" height="28" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="427" y="79" text-anchor="middle" font-size="12" fill="#6b675e">墓碑</text>
<rect class="bar" x="450" y="60" width="40" height="28" fill="#2b2a26"/>
<text class="onbar" x="470" y="79" text-anchor="middle" font-size="12" fill="#f6f3ec">p1</text>
<rect class="bar" x="493" y="60" width="40" height="28" fill="#2b2a26"/>
<text class="onbar" x="513" y="79" text-anchor="middle" font-size="12" fill="#f6f3ec">p2</text>
<line class="fl" x1="534" y1="58" x2="534" y2="90" stroke="#6b675e" stroke-width="1"/>
<rect class="bar" x="536" y="60" width="40" height="28" fill="#2b2a26"/>
<text class="onbar" x="556" y="79" text-anchor="middle" font-size="12" fill="#f6f3ec">最新代</text>
<text class="ts" x="590" y="79" font-size="12" fill="#6b675e">…</text>
<rect class="msg" x="20" y="104" width="12" height="12" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="38" y="114" font-size="12" fill="#6b675e">被顶替的旧值（清掉）</text>
<rect class="bar" x="180" y="104" width="12" height="12" fill="#2b2a26"/>
<text class="ts" x="198" y="114" font-size="12" fill="#6b675e">最新值（留下）</text>
<rect class="bx-gone" x="300" y="104" width="12" height="12" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="318" y="114" font-size="12" fill="#6b675e">墓碑（&lt;DELETE&gt;）</text>
<line class="flc" x1="330" y1="128" x2="330" y2="156" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq9Ac1)"/>
<text class="tc" x="344" y="150" font-size="12" fill="#b03a2e">cleaner：同 key 的旧记录一律删掉</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">压实后：1 个段，5 条记录</text>
<rect class="bar" x="20" y="186" width="104" height="28" fill="#2b2a26"/>
<text class="onbar" x="72" y="205" text-anchor="middle" font-size="12" fill="#f6f3ec">p0 = 30</text>
<rect class="bar" x="132" y="186" width="104" height="28" fill="#2b2a26"/>
<text class="onbar" x="184" y="205" text-anchor="middle" font-size="12" fill="#f6f3ec">p1 最新</text>
<rect class="bar" x="244" y="186" width="104" height="28" fill="#2b2a26"/>
<text class="onbar" x="296" y="205" text-anchor="middle" font-size="12" fill="#f6f3ec">p2 最新</text>
<rect class="bar" x="356" y="186" width="104" height="28" fill="#2b2a26"/>
<text class="onbar" x="408" y="205" text-anchor="middle" font-size="12" fill="#f6f3ec">组A 最新代</text>
<rect class="bar" x="468" y="186" width="104" height="28" fill="#2b2a26"/>
<text class="onbar" x="520" y="205" text-anchor="middle" font-size="12" fill="#f6f3ec">组B 最新代</text>
<text class="ts" x="20" y="240" font-size="12" fill="#6b675e">丢掉的全是被顶替的旧值：旧代、被超过的位移、清完历史的墓碑</text>
<text class="ts" x="20" y="272" font-size="12" fill="#6b675e">位移是状态，不是轨迹：日志再长，也压得回一小把当前值</text>
</svg>
</figure>

墓碑也在这里说清。删一个组，`kafka-consumer-groups --delete` 不是物理抹掉记录，是给这个组的每个 key 追加一条 payload 为 `<DELETE>`（valueSize 为 -1）的墓碑。实测删一个组，4 条墓碑落在同一批里：3 条对它的 3 个 (topic, 分区) 位移 key，1 条对组元数据 key。cleaner 下一轮扫到墓碑，把这个 key 的历史连同墓碑一起清掉。墓碑自己也不会立刻消失，delete.retention.ms 默认 24 小时，留够时间让其他副本和下游消费者看到这个删除标记，之后才彻底蒸发。

压实还有个磁盘占用的现实数字。`__consumer_offsets` 的每个段文件，除了 .log 本体，还配 .index 和 .timeindex 两个预分配索引，各占满 10MB。我那个 .log 本体只有 2989 字节的分区，du 出来目录接近 20MB，全被两个预分配索引吃掉。小分区的磁盘开销大头在索引不在数据，这跟日志段篇讲的稀疏索引是同一套文件，只是这里数据太少，索引的固定开销显了出来。

Redis 那边有个对照。AOF 篇讲过 AOF 重写：把累积的命令流重写成一份等价于当前数据的最小命令集，被覆盖的中间命令全丢。和这里的 compact 是一个思路，日志记的是状态怎么变过来的，长到一定程度就把它压成最新状态，过程扔掉，结果留下。

组的进度本身也有保留期。offsets.retention.minutes 默认 7 天，一个组空了之后，它的位移记录再留 7 天才清（检查间隔实测 10 分钟一轮）。空组且从没提交过位移的，实测几分钟内就被墓碑清掉，没东西可留，走得干脆；有位移的组要等满 7 天。

## 四、提交的时机：同一个崩溃点，三种结局

位移存在哪、怎么压实看完了，回到提交这个动作本身。消费者处理一条消息，和提交这条消息的位移，两个动作谁先谁后，决定了崩溃之后的结局。这一节用三个场景把它钉死，它们共用一个崩溃点。

编排是这样：kwin 单分区 RF=3，发 100 条编号 1 到 100 的消息，worker 逐条处理、每条 50ms、把处理过的编号写进一个本地文件（就叫已处理清单），清单到 33 行时父进程给 worker 一个 SIGKILL（等价拔电源，没有 LeaveGroup，没有告别提交），然后同组重启排空，最后拿已处理清单和应处理的 1..100 核对。

场景 A，先处理后提交。worker 每处理一条写清单，每满 5 条提交一次位移。崩溃那一刻 broker 侧的状态：

```text
GROUP        TOPIC  PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
g-win-A-...  kwin   0          30              100             70
```

CURRENT-OFFSET=30，broker 只认到 30，可清单已经写到 33。重启后从提交的 30 续读，31、32、33 被第二遍处理。核对结果：重复 3 条（seq 31、32、33），丢失 0 条。这就是 at-least-once 的标准形态，清单跑在提交前面，中间那段处理过但没提交的，崩溃后重来一遍。

场景 B，先提交后处理。worker 反过来，每满 5 条先把这 5 条的位移提交出去（告诉 broker 这 5 条读完了），再回头逐条处理。崩溃那一刻：

```text
GROUP        TOPIC  PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
g-win-B-...  kwin   0          35              100             65
```

CURRENT-OFFSET=35，跑在已处理的 33 前面。重启后从 35 续读，seq 34、35 这两条提交了却没处理的被直接跳过，永远不会有人再读它们。核对结果：丢失 2 条（seq 34、35），重复 0 条。更阴的是排空之后 LAG 归零，broker 认为这个组把 100 条读得干干净净，可那 2 条没了就是没了。提交把「已读」谎报成了「已处理」，这是 at-most-once 的代价。

场景 C，kafkajs 的 autoCommit。不手动提交，交给客户端定时自动提交，间隔设 1 秒。崩溃时 CURRENT-OFFSET=20，LAG=80。重启后 seq 21 到 33 共 13 条重来，丢失 0 条。autoCommit 的重复窗口等于提交间隔，间隔越长，崩一次重放的越多。

同一个崩溃点（清单第 33 行），三种提交策略，三种结局：A 重复 3 丢失 0，B 丢失 2 重复 0，C 重复 13 丢失 0。窗口的方向和大小全看提交相对处理落在哪，没有玄学。先处理后提交偏重复（at-least-once），先提交后处理偏丢失（at-most-once），两头不可兼得。

三个提交点摆在同一根标尺上：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 298" role="img" aria-label="同一个崩溃点的三种提交策略数轴对比：都在处理到 seq 33 那一刻被 SIGKILL；策略 C autoCommit 提交点 20，重启后重放 21 到 33 共 13 条重复；策略 A 先处理后提交提交点 30，重放 31 到 33 共 3 条重复；策略 B 先提交后处理提交点 35，重启后跳过 34、35 共 2 条丢失；提交点在处理点左侧偏重复，右侧偏丢失，缺口长度决定条数" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq9As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">都崩在「处理到 seq 33」这一刻，区别只在提交点落在 33 的哪一侧</text>
<text class="tc" x="487" y="44" text-anchor="middle" font-size="12" fill="#b03a2e">SIGKILL：已处理到 33</text>
<line class="flc" x1="487" y1="48" x2="487" y2="212" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="60" y="64" font-size="12" fill="#6b675e">C autoCommit 提交点=20：重放 21..33，共 13 条（重复）</text>
<rect class="bx-sick" x="117" y="72" width="370" height="14" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="60" y="100" font-size="12" fill="#6b675e">A 先处理后提交 提交点=30：重放 31..33，共 3 条（重复）</text>
<rect class="bx-sick" x="402" y="108" width="85" height="14" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<line class="axis" x1="60" y1="170" x2="628" y2="170" stroke="#6b675e" stroke-width="1.2" marker-end="url(#mq9As3)"/>
<line class="fl" x1="117" y1="170" x2="117" y2="176" stroke="#6b675e" stroke-width="1.6"/>
<line class="fl" x1="260" y1="170" x2="260" y2="176" stroke="#6b675e" stroke-width="1.6"/>
<line class="fl" x1="402" y1="170" x2="402" y2="176" stroke="#6b675e" stroke-width="1.6"/>
<line class="fl" x1="544" y1="170" x2="544" y2="176" stroke="#6b675e" stroke-width="1.6"/>
<text class="ts" x="117" y="190" text-anchor="middle" font-size="12" fill="#6b675e">20</text>
<text class="ts" x="260" y="190" text-anchor="middle" font-size="12" fill="#6b675e">25</text>
<text class="ts" x="402" y="190" text-anchor="middle" font-size="12" fill="#6b675e">30</text>
<text class="ts" x="544" y="190" text-anchor="middle" font-size="12" fill="#6b675e">35</text>
<rect class="bx-sick" x="487" y="198" width="57" height="14" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="60" y="232" font-size="12" fill="#6b675e">B 先提交后处理 提交点=35：跳过 34、35 共 2 条丢失，永远没人再读</text>
<text class="ts" x="20" y="258" font-size="12" fill="#6b675e">提交点在 33 左侧：处理过没提交，重启后重放（重复）；在右侧：提交过没处理，重启后跳过（丢失）</text>
<text class="ts" x="20" y="284" font-size="12" fill="#6b675e">缺口 = 提交点与处理点之间的距离：方向决定重复还是丢失，长度决定多少条</text>
</svg>
</figure>

这正是投递语义篇那个结论的现场版：at-least-once 是常态默认，因为重复的代价远小于丢失。重复可以在消费端用幂等兜住（去重表、版本号、或操作本身就幂等），丢失的消息找不回来。所以几乎每个客户端的默认都是先处理后提交，场景 B 的先提交是个反面写法，得刻意写成那样才会踩到。

消费端这套还能和 MySQL 的 GTID 复制对上看。从库断了几天重连，怎么知道从哪继续？老办法靠人工指定 binlog 文件名加偏移，指错就出事。GTID 的办法是从库报上自己的 gtid_executed（已收货清单），主库拿自己的已发货清单求差集，从差集开始发，全程不用人工指位点。消费者位移是同一个思路：组把已提交位移（已收货清单）报上来，重启后 broker 就知道从哪接着发。换机器、换进程都不影响，因为进度写在日志里，不在某个消费者的内存里。两个世界的「已收货清单」，一个叫 gtid_executed，一个叫 committed offset。

## 五、协调者之死：进度写在日志里，日志有三个副本

前四节都默认协调者活着。这一节杀掉它，看组的进度丢不丢。

编排：kfail 单分区 RF=3，发 200 条，worker 每条 100ms 逐条处理并逐条提交（最保守的先处理后提交，窗口最小）。我特意挑了一个协调者不落在 kfail 分区 leader 上的组名，把「数据面 leader 死」和「协调者死」两种死法隔开，这一节只看后者。已处理清单到 50 条时 docker kill 协调者 broker（SIGKILL），父进程每秒问一次 CLI，看这个组对应的 `__consumer_offsets` 分区的 leader 什么时候换人。

```text
服务端接管：kill 后 12.0s，__consumer_offsets-13 新 leader = kafka1
客户端恢复：kill 后 70.6s，第一次提交成功（其间 consumer 崩溃重启、重入组 2 次）
进度核对：200/200 全覆盖，重复 6 条（seq 50 到 55），丢失 0 条
```

服务端接管的 12.0 秒，拆开是熟面孔：9 秒的 broker 心跳会话判死（副本篇 ISR 收缩那把同款尺子），控制器从 ISR 里指定新 leader，新 leader 把这个分区的日志从头重放一遍、重建内存态（源码里 CoordinatorLoaderImpl 干的就是这件事）。选举不在数据面投票，票已经在楼上控制器的 Raft 仲裁里投过，这也是副本篇的老结论。重放日志重建状态这件事，MySQL 那边 InnoDB 崩溃恢复篇也讲过：重启后重演 redo 把没落盘的数据补回来。两边是同一个套路，状态以日志形式持久化，恢复靠重放日志。

客户端恢复比服务端慢得多，实测 70.6 秒。kafkajs 对死协调者的提交请求先连接被拒，反复重试到 KafkaJSNumberOfRetriesExceeded，整个 consumer 崩溃，随后自动重启，重新 FindCoordinator、重入组（GROUP_JOIN 实测两次），直到 kill 后 70.6 秒才有第一次提交成功。服务端其实早就就绪了，大头耗在客户端的重试退避和重启上。这个差距要记住：协调者故障时组恢复得多快，往往不取决于 broker 切换多快，取决于客户端库的重试策略多拗。

两条泳道各自的速度：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 258" role="img" aria-label="杀掉协调者 broker 之后的双泳道时间轴：服务端泳道 9 秒 broker 心跳会话判死，控制器从 ISR 指定新 leader，12.0 秒重放日志后新 leader 上岗；客户端泳道提交被拒、重试到耗尽、consumer 崩溃重启、重新找协调者、重入组两次，70.6 秒才有第一次提交成功；进度核对 202 条提交一条不少、重复 6 条、丢失 0 条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">杀掉协调者：两条泳道，两种速度</text>
<text class="ts" x="74" y="42" font-size="12" fill="#6b675e">t=0 docker kill 协调者 broker（SIGKILL）</text>
<line class="flk" x1="68" y1="48" x2="68" y2="158" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="20" y="83" font-size="12" fill="#6b675e">服务端</text>
<rect class="bx" x="68" y="70" width="65" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="133" y="70" width="21" height="20" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<line class="flc" x1="154" y1="56" x2="154" y2="98" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="160" y="63" font-size="12" fill="#b03a2e">12.0s 新 leader 上岗</text>
<text class="ts" x="68" y="110" font-size="12" fill="#6b675e">9s 心跳会话判死 → 控制器从 ISR 指定新 leader，重放日志重建状态</text>
<text class="ts" x="20" y="143" font-size="12" fill="#6b675e">客户端</text>
<rect class="bx-sick" x="68" y="130" width="508" height="20" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<line class="flc" x1="576" y1="122" x2="576" y2="158" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="570" y="118" text-anchor="end" font-size="12" fill="#b03a2e">70.6s 第一次提交成功</text>
<text class="ts" x="76" y="170" font-size="12" fill="#6b675e">提交被拒 → 重试到耗尽 → consumer 崩溃重启 → 重新 FindCoordinator → 重入组（实测 2 次）</text>
<path class="flc" d="M154 184 v8 H576 v-8" fill="none" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="365" y="212" text-anchor="middle" font-size="12" fill="#b03a2e">12.0s 对 70.6s：断层在客户端库，不在集群</text>
<text class="ts" x="20" y="244" font-size="12" fill="#6b675e">进度核对：202 条提交一条不少，重复 6 条（seq 50..55），丢失 0 条</text>
</svg>
</figure>

进度核对的结论很硬：kill 前提交到 seq 49，重启后从 50 续，重复 6 条（seq 50 到 55，崩溃瞬间在途、提交没落地的那批），丢失 0 条，200 条全覆盖。

最关键的一步是去新 leader 上核对。在接管过来的 kafka1 上 dump `__consumer_offsets-13` 的日志，这个组的位移提交记录共 202 条全在，kill 之前提交上去的那批一条不少。协调者死了，进度分毫未损。原因很朴素：`__consumer_offsets` 是 RF=3，协调者只是它某个分区的 leader，这份日志同时躺在另外两台 broker 的盘上，leader 死了，控制器立另一个副本上岗，新 leader 重放日志，把已提交的位移全部恢复出来，接着当协调者。这是副本篇那套 ISR 机制在「组进度」上的直接兑现：位移也是一条日志，是日志就享受副本、高水位、选举那一整套。

说到高水位，顺带把位移提交的持久性档位讲清。协调者写位移记录到 leader 副本（源码里是 appendRecordsToLeader，requiredAcks=1、origin 标成 COORDINATOR），但提交的成功响应不立刻返回给客户端，它被挂起，一直等到高水位越过这条记录，也就是 ISR 全员都复制了它，才放行。所以一次被 ack 的提交，即便协调者下一秒就死，也不会丢，它已经在 ISR 所有机器上了。这正是 kafka-104 里 kill 前那 49 条提交能在新 leader 上原样找到的原因。副本篇说过，ack 成功只代表 leader 收到了，要高水位越过才算队伍承认，位移提交一样受这条线约束。

## 六、用自己的引擎存自己

把五节拧成一句：消费者组的「读到哪了」本身就是一条 Kafka 日志。组名哈希定它落在 `__consumer_offsets` 50 个分区的哪一个，那个分区的 leader 出任协调者；组的花名册和位移提交是同一分区里追加的两种记录，提交只追加不改写，cleaner 的 compact 只留每个 key 的最新值，50 个分区因此不会被提交历史撑爆；提交的时机决定崩溃后是重复还是丢失，先处理后提交偏重复、先提交后处理偏丢失，窗口大小等于提交与处理的间距；这条日志 RF=3，协调者死了换个副本重放它，进度分毫不损。

日志段篇给日志的全部家当，段、索引、批次、任期号、复制、高水位，`__consumer_offsets` 一样不落全享受，只不过它存的记录是各个组的阅读进度，业务消息换成了元数据。Kafka 用自己的存储引擎存自己的状态，这大概是整个设计里最自洽的一处。

第四节的重复、第五节的 6 条重复，都指向同一个缺口：只要处理与提交没法粘成一个原子步，at-least-once 的重复就除不掉，消费端得靠幂等兜底。那能不能让 broker 自己把「处理过但没提交」和「提交了但没处理」这两种窗口造成的重复消掉？下一篇讲幂等生产者和事务，以及 exactly-once 的真实边界和它的价钱。

（环境和上一篇同一套集群，宿主侧 kafkajs 2.2.4，容器内靠 kafka-dump-log 和几个 CLI 工具。源码结论对的是 apache/kafka:4.3.1：GroupCoordinatorService.partitionFor 用 Utils.abs 取 hashCode 的模（MIN_VALUE 特判归 0），协调者提交走 CoordinatorPartitionWriter 调 appendRecordsToLeader，靠高水位监听器延迟响应。四个工具坑记一下，第一个差点让我误判：kafkajs 的 autoCommit 是 consumer.run() 的参数，塞进 kafka.consumer() 工厂会被静默忽略，和上一篇 Java console 的 --property 坑同一家族。我头一轮以为关了自动提交，其实默认开着，批末它会把同一个 offset 再自动提交一次，日志里同 key 同值出现两条，差点当成 broker 重复写。其二，consumer.run() 立即返回不阻塞，worker 子进程得用别的办法挂住事件循环（我用空闲检测退场），否则 run 完就 exit，消费者还没拉到消息就被杀。其三，__consumer_offsets 的 segment.bytes 在 4.x 最小 1MB，想逼它滚段做压实别指望缩小段，改用 segment.ms 按秒滚，并注意每个段配两个 10MB 预分配索引。其四，eachMessage 回调里 partition 字段在顶层参数上，写成 message.partition 会拿到 undefined，提交直接报 Invalid partition。）
