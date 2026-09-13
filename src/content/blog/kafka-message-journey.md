---
title: 一条消息的旅程：Kafka 第一眼中的另一套世界观
description: 消息队列系列第三篇，Kafka 主线开篇。基础两篇用 RabbitMQ 拼出的直觉，到这里几乎全要重审：同一条消息，RabbitMQ 眼里是投递出去就没了的包裹，Kafka 眼里是日志里追加的一行。实测对照：同 key 恒落同一分区（u1→p1、u2→p0），offset 是分区内各编各的编号；kill 消费者没有 unacked 回收这回事，同组重启从上次提交的位移继续，第 3 条会再来一遍，而且重启后等了 29.6 秒才拿到分区，组在等前任的会话超时；毒消息没有 DLX 可指，重试是消费端自己 seek 回拨（8 秒 1318 次、身后饿死），死信要拿 DLQ topic 自己拼；20000 条 1.7 秒灌进日志，无人消费时一个字也不少，消费不删除，积压叫 lag（中途快照 LAG 8600，排空后归零）。交换机、TTL、推模型都不存在，broker 只管把日志写对，「队列」的每一条语义都变成了要自己拼的积木。
pubDate: 2026-10-13
category: mq
tags: [Kafka, 消息队列, 分布式]
---

基础篇结束时说过：同样的三个场景，Kafka 没有一页答案是相同的。这一篇把容器起起来验证这句话。环境是 apache/kafka:4.3.1，KRaft 单节点，一条 docker run，没有 ZooKeeper。实验跑完，最先注意到的是名字全变了：积压叫 lag，进度叫位移，死信没有现成机制、要自己搭。

基础两篇的教具是 RabbitMQ，因为经典队列的语义在那里全是开箱即用的开关。开关背后的世界观是「快递」：消息是一件包裹，投给消费者，签收（ack）即销毁，处理不了的转死信。Kafka 是一个日志（commit log），世界观完全不同：消息的动词从「投递」换成「追加」，消费者的角色从收件人换成读者，拿着一个位置标记来读日志。这一篇沿着一条消息走完整条链路，每一站都和教具对照。

两套世界观摆在一起：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="两种世界观对比：RabbitMQ 里消息经交换机路由进队列，推给消费者，签收后销毁；Kafka 里消息追加进分区日志，消费者自己 poll 拉取，自己提交位移，日志读完原地不动" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq3As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq3Ai1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-i" d="M0 0 L8 4 L0 8 Z" fill="#2b2a26"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">RabbitMQ：签收之后销毁，旅程到此为止</text>
<rect class="bx" x="30" y="40" width="90" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="75" y="65" text-anchor="middle" font-size="14" fill="#2b2a26">生产者</text>
<rect class="bx" x="170" y="40" width="110" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="225" y="65" text-anchor="middle" font-size="14" fill="#2b2a26">交换机</text>
<rect class="bx-q" x="330" y="40" width="110" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="385" y="58" text-anchor="middle" font-size="14" fill="#2b2a26">队列</text>
<rect class="msg" x="352" y="64" width="8" height="8" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="372" y="64" width="8" height="8" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="392" y="64" width="8" height="8" fill="#a29d90" opacity="0.65"/>
<rect class="bx" x="490" y="40" width="110" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="545" y="65" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<line class="fl" x1="120" y1="60" x2="164" y2="60" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As1)"/>
<line class="fl" x1="280" y1="60" x2="324" y2="60" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As1)"/>
<line class="fl" x1="440" y1="60" x2="484" y2="60" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As1)"/>
<text class="tc" x="545" y="100" text-anchor="middle" font-size="12" fill="#b03a2e">签收（ack）后销毁</text>
<text class="ts" x="20" y="164" font-size="12" fill="#6b675e">Kafka：消息是追加进日志的一行，消费不删除</text>
<rect class="bx" x="30" y="180" width="90" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="75" y="205" text-anchor="middle" font-size="14" fill="#2b2a26">生产者</text>
<line class="fl" x1="120" y1="200" x2="164" y2="200" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As1)"/>
<text class="ts" x="142" y="192" text-anchor="middle" font-size="12" fill="#6b675e">追加</text>
<rect class="bx-q" x="170" y="180" width="280" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="msg" x="182" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="212" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="242" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="272" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="302" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="332" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="362" y="195" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="460" y="196" font-size="12" fill="#6b675e">读完日志原地不动，</text>
<text class="ts" x="460" y="212" font-size="12" fill="#6b675e">随时可以再读一遍</text>
<rect class="bx" x="240" y="248" width="150" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="315" y="271" text-anchor="middle" font-size="14" fill="#2b2a26">消费者（某个组）</text>
<line class="flk" x1="280" y1="248" x2="280" y2="228" stroke="#2b2a26" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#mq3Ai1)"/>
<text class="ts" x="272" y="242" text-anchor="end" font-size="12" fill="#6b675e">poll</text>
<path class="fill-c" d="M410 220 L405 230 L415 230 Z" fill="#b03a2e"/>
<text class="ts" x="420" y="232" font-size="12" fill="#6b675e">位移：读到哪了</text>
</svg>
</figure>

## 第一站：发送，没有交换机只有分区

RabbitMQ 里生产者把消息交给交换机，交换机按路由键决定去哪些队列，发布订阅的拓扑在交换机这一层。Kafka 里没有这个角色：生产者直接面对 topic，而一个 topic 是一组分区，不是一根队列。

发 8 条消息到 3 分区的 `korders`：6 条带 key（u1/u2/u3 各两次）、2 条不带。消费者把每条落地的全字段打出来：

```text
topic=korders  partition=1  offset=0  key=u1
topic=korders  partition=1  offset=1  key=u3
topic=korders  partition=1  offset=2  key=u1
topic=korders  partition=1  offset=3  key=u3
topic=korders  partition=1  offset=4  key=∅（无 key）
topic=korders  partition=0  offset=0  key=u2
topic=korders  partition=0  offset=1  key=u2
topic=korders  partition=0  offset=2  key=∅（无 key）
```

两件事要注意。第一，**同 key 恒落同一分区**：u1 两次都在 p1，u2 两次都在 p0。分区器对 key 做哈希（murmur2）再对分区数取模，key 相同，落点就相同。这是 Kafka 顺序性的地基，是写进文档的承诺。加分区会打破它：取模的分母变了，同 key 不再恒落同一分区，分区与键那篇会实测。第二，**offset 是分区内的编号，各分区各编各的**：p1 有自己的 0–4，p0 有自己的 0–2，互不干扰。全局第 5 条消息这种东西不存在，「一条消息的位置」要说成「p1 的 offset 4」，一个二元组。

落点和编号，画出来：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 288" role="img" aria-label="分区与键：生产者发 8 条消息，分区器对 key 做 murmur2 哈希再对分区数取模，u1 恒落 p1，u2 恒落 p0，每个分区内 offset 各自从 0 编号" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq3As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="20" y="120" width="110" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="75" y="140" text-anchor="middle" font-size="14" fill="#2b2a26">生产者</text>
<text class="ts" x="75" y="158" text-anchor="middle" font-size="12" fill="#6b675e">6 条带 key · 2 条不带</text>
<rect class="bx" x="180" y="120" width="120" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="240" y="140" text-anchor="middle" font-size="14" fill="#2b2a26">分区器</text>
<text class="ts" x="240" y="158" text-anchor="middle" font-size="12" fill="#6b675e">murmur2(key) % 3</text>
<line class="fl" x1="130" y1="144" x2="174" y2="144" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As2)"/>
<line class="fl" x1="300" y1="134" x2="352" y2="60" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As2)"/>
<line class="fl" x1="300" y1="144" x2="352" y2="128" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As2)"/>
<line class="fl" x1="300" y1="154" x2="352" y2="198" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As2)"/>
<text class="t" x="345" y="63" text-anchor="end" font-size="14" fill="#2b2a26">p0</text>
<rect class="bx-q" x="360" y="40" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="382" y="56" text-anchor="middle" font-size="14" fill="#2b2a26">u2</text>
<text class="ts" x="382" y="70" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<rect class="bx-q" x="408" y="40" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="430" y="56" text-anchor="middle" font-size="14" fill="#2b2a26">u2</text>
<text class="ts" x="430" y="70" text-anchor="middle" font-size="12" fill="#6b675e">1</text>
<rect class="bx-q" x="456" y="40" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="478" y="56" text-anchor="middle" font-size="14" fill="#2b2a26">∅</text>
<text class="ts" x="478" y="70" text-anchor="middle" font-size="12" fill="#6b675e">2</text>
<text class="t" x="345" y="133" text-anchor="end" font-size="14" fill="#2b2a26">p1</text>
<rect class="bx-q" x="360" y="110" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="382" y="126" text-anchor="middle" font-size="14" fill="#2b2a26">u1</text>
<text class="ts" x="382" y="140" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<rect class="bx-q" x="408" y="110" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="430" y="126" text-anchor="middle" font-size="14" fill="#2b2a26">u3</text>
<text class="ts" x="430" y="140" text-anchor="middle" font-size="12" fill="#6b675e">1</text>
<rect class="bx-q" x="456" y="110" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="478" y="126" text-anchor="middle" font-size="14" fill="#2b2a26">u1</text>
<text class="ts" x="478" y="140" text-anchor="middle" font-size="12" fill="#6b675e">2</text>
<rect class="bx-q" x="504" y="110" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="526" y="126" text-anchor="middle" font-size="14" fill="#2b2a26">u3</text>
<text class="ts" x="526" y="140" text-anchor="middle" font-size="12" fill="#6b675e">3</text>
<rect class="bx-q" x="552" y="110" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="574" y="126" text-anchor="middle" font-size="14" fill="#2b2a26">∅</text>
<text class="ts" x="574" y="140" text-anchor="middle" font-size="12" fill="#6b675e">4</text>
<text class="t" x="345" y="203" text-anchor="end" font-size="14" fill="#2b2a26">p2</text>
<rect class="bx-q" x="360" y="180" width="270" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="495" y="203" text-anchor="middle" font-size="12" fill="#6b675e">空着：这 8 条没有落这儿的</text>
<text class="ts" x="20" y="250" font-size="12" fill="#6b675e">u1 恒落 p1、u2 恒落 p0：key 相同，落点就相同</text>
<text class="ts" x="20" y="270" font-size="12" fill="#6b675e">offset 各分区各编各的：p1 编自己的 0–4，p0 编自己的 0–2</text>
</svg>
</figure>

发布订阅在 Kafka 里靠**消费组**：三个组各自订阅同一个 topic，互不干扰，各自记录进度。RabbitMQ 里一份事实三家消费，靠交换机绑三个队列；Kafka 把拓扑从「消息的拓扑」（交换机怎么路由）挪到了「消费者的拓扑」（组怎么分工），消息本身不知道也不关心谁在读它。

## 第二站：存储，消费不删除

对照实验四：RabbitMQ 灌完 1000 条，UI 上看队列深度，worker 排空后深度归零，消费即删除。同样的事在 Kafka 里跑：20000 条一次 `producer.send` 灌进 `kflood`：

```text
→ 灌入 20000 条用时 1658ms（含建连；≈12000 条/秒）
```

灌完那一刻日志末端 offset 是 20000，没有消费者，一个字也没被「取走」。**删除不归消费管，归保留策略管**：按时间（默认 7 天）或大小截断最老的段。消费者读完，日志原地不动；第二天新起一个组从 offset 0 开始拉，还能把昨天的消息全部重读一遍。消息在 Kafka 里是可重放的记录，不是送出即销毁的包裹。

日志和它的读者们：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 205" role="img" aria-label="日志与读者：同一条日志，昨天的组已读到末端 20000，第二天新起的组从 offset 0 重新读一遍；最老的段由保留策略截断，新消息从右端继续追加" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq3As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-gone" x="60" y="60" width="100" height="44" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="110" y="52" text-anchor="middle" font-size="12" fill="#6b675e">最老的段：被保留策略截断</text>
<rect class="bx-q" x="160" y="60" width="420" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="370" y="52" text-anchor="middle" font-size="12" fill="#6b675e">20000 条，一条不少</text>
<rect class="msg" x="175" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="215" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="255" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="295" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="335" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="375" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="415" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="455" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="495" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="535" y="76" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<line class="fl" x1="580" y1="82" x2="616" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As3)"/>
<text class="ts" x="598" y="72" text-anchor="middle" font-size="12" fill="#6b675e">继续追加</text>
<path class="bar" d="M560 104 L555 114 L565 114 Z" fill="#2b2a26"/>
<line class="fl" x1="560" y1="114" x2="560" y2="122" stroke="#6b675e" stroke-width="1.6"/>
<rect class="bx" x="470" y="124" width="170" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="555" y="141" text-anchor="middle" font-size="14" fill="#2b2a26">组 g-flood</text>
<text class="ts" x="555" y="157" text-anchor="middle" font-size="12" fill="#6b675e">CURRENT-OFFSET 20000</text>
<path class="fill-c" d="M170 104 L165 114 L175 114 Z" fill="#b03a2e"/>
<line class="fl" x1="170" y1="114" x2="170" y2="122" stroke="#6b675e" stroke-width="1.6"/>
<rect class="bx" x="60" y="124" width="200" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="160" y="141" text-anchor="middle" font-size="14" fill="#2b2a26">第二天新起的组</text>
<text class="ts" x="160" y="157" text-anchor="middle" font-size="12" fill="#6b675e">从 offset 0 开始，重读一遍</text>
<text class="ts" x="330" y="190" text-anchor="middle" font-size="12" fill="#6b675e">消费不删除：每个组各有一个进度，互不干扰</text>
</svg>
</figure>

这一条是日志世界观的根：MySQL 的 binlog 也是这个立场，事件追加进日志，谁消费、消费几遍、什么时候消费，日志本身不关心（MySQL 复制篇里从库拿着位点重放，和消费者拿着位移拉取是同一个动作）。区别在 binlog 是数据库的内部组件，Kafka 把日志本身做成了产品。

## 第三站：消费，拉、位移、没有 ack

RabbitMQ 的消费者签收：broker 推消息过来，处理完回 ack，broker 销毁。Kafka 的消费者自己 poll，自己记读到哪了（位移 offset），处理完自己把位移**提交**回去。存位移的地方本身也是 Kafka 里一个普通的 topic（`__consumer_offsets`），后面有专门一篇拆它。

崩溃场景在两个世界里长什么样。基础篇第二篇里：消费者处理到一半 kill，broker 发现连接断了，把 unacked 那条收回队列重新投，状态由 broker 管。Kafka 里做同一个实验：消费 `kwork`，每条处理完就提交位移，第 3 条处理完、提交之前，kill：

```text
✓ 第 1 条处理完（已提交位移 1）
✓ 第 2 条处理完（已提交位移 2）
!! 第 3 条：处理完了，但提交之前 —— 进程崩溃（位移还停在第 2 条）
```

同组重启：

```text
第 3 条  ←—— 又来了（崩溃前处理过、没来得及提交的那条）
第 4 条 … 第 10 条
```

第 3 条重来了，但这不叫「重投」。没有 unacked 名单，也没有回收动作：日志原地不动，重启的消费者只是从上次提交的位移继续读。broker 全程不知道你处理没处理、处理到哪，它只认你提交上来的位移。崩溃窗口从「已投递未 ack 的那几条」变成了「处理了但还没提交位移的那些条」，保证语义的责任从 broker 挪到了消费者自己。

把这次崩溃画在日志上：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="Kafka 崩溃窗口：第 3 条处理完但位移没提交，已提交位移停在 2；同组重启后从位移 2 继续读，第 3 条会再来一遍" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq3Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">第 3 条处理完、提交位移之前，kill</text>
<path class="flc" d="M254 32 H206 V40" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq3Ac1)"/>
<text class="tc" x="260" y="36" font-size="12" fill="#b03a2e">#3 会再来一遍</text>
<rect class="bx" x="40" y="44" width="60" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="70" y="70" text-anchor="middle" font-size="14" fill="#2b2a26">#1 ✓</text>
<rect class="bx" x="104" y="44" width="60" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="134" y="70" text-anchor="middle" font-size="14" fill="#2b2a26">#2 ✓</text>
<rect class="bx-sick" x="168" y="44" width="60" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="198" y="62" text-anchor="middle" font-size="14" fill="#2b2a26">#3</text>
<text class="tc" x="198" y="80" text-anchor="middle" font-size="12" fill="#b03a2e">没提交</text>
<rect class="bx-q" x="232" y="44" width="60" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="262" y="70" text-anchor="middle" font-size="14" fill="#2b2a26">#4</text>
<rect class="bx-q" x="296" y="44" width="60" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="326" y="70" text-anchor="middle" font-size="14" fill="#2b2a26">#5</text>
<rect class="bx-q" x="360" y="44" width="60" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="390" y="70" text-anchor="middle" font-size="14" fill="#2b2a26">#6</text>
<rect class="bx-q" x="424" y="44" width="60" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="454" y="70" text-anchor="middle" font-size="14" fill="#2b2a26">…</text>
<text class="ts" x="70" y="104" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="134" y="104" text-anchor="middle" font-size="12" fill="#6b675e">1</text>
<text class="ts" x="198" y="104" text-anchor="middle" font-size="12" fill="#6b675e">2</text>
<text class="ts" x="262" y="104" text-anchor="middle" font-size="12" fill="#6b675e">3</text>
<text class="ts" x="326" y="104" text-anchor="middle" font-size="12" fill="#6b675e">4</text>
<text class="ts" x="390" y="104" text-anchor="middle" font-size="12" fill="#6b675e">5</text>
<text class="ts" x="454" y="104" text-anchor="middle" font-size="12" fill="#6b675e">6</text>
<path class="fill-c" d="M168 108 L163 118 L173 118 Z" fill="#b03a2e"/>
<text class="tc" x="182" y="132" font-size="12" fill="#b03a2e">已提交位移 = 2：下一条要读的就是 #3</text>
<text class="ts" x="40" y="160" font-size="12" fill="#6b675e">同组重启的消费者从位移 2 继续读，没有回收动作，日志原地没动过</text>
</svg>
</figure>

顺带一个数字，当时在终端里愣了几秒才反应过来：重启的消费者等了 **29.6 秒**才拿到分区。原因是组里还挂着前任的「席位」，要等它的会话超时（kafkajs 默认 30 秒）到期，组才敢把分区分给继任。RabbitMQ 里连接一断消息立刻回收，秒级完成；Kafka 里换人接手是一整套协商，这就是 rebalance，消费者组那篇的主题，这次 30 秒等待就是它的一次现场。

毒消息的处理差别更大。RabbitMQ 有 DLX：`nack(requeue=false)`，一行配置的事。Kafka 没有对应物：broker 不看消息内容，不重投，也没有死信机制，失败处理是消费端自己的事。错误的做法是消费端自己把位移拨回去重试（`seek` 回这条）：

```text
8 秒内：毒消息抵达 1318 次（≈165 次/秒）
身后 2 条正常消息处理数：0——毒消息霸住位移，后面全部饿死
```

对照教具的 26,100 次/4 秒，Kafka 这边「慢」恰恰因为它不自动重投，每次重试都是消费端显式 seek 的。而且这个循环比 RabbitMQ 那边更难退出：重启消费者没用，位移还在那儿，回来还是这条。正确的做法是拼积木：catch 住，**把消息抄送进一个 DLQ topic**（死信队列从 broker 的机制变成一个命名约定），提交位移，继续前进：

```text
☠ 毒消息（offset=3）→ 抄送进 DLQ 主题，提交位移，继续前进
✓ seq=4（offset=4）处理完成
```

`kpoison.dlq` 里躺着那条 `{"seq":666,"poison":true}`，查看、重放、人工处理，全是普通的消息操作。到这里可以给两家做个总结：**RabbitMQ 把语义做成开关，Kafka 把语义做成积木**。开关开箱即用，但只有那几档；积木什么都能拼，但每一块都得自己搬。

错误的做法和对的做法，各一张：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 330" role="img" aria-label="毒消息的两种处理：错误做法是 seek 把位移拨回去重试，毒消息 8 秒循环 1318 次，身后消息全部饿死；正确做法是 catch 住抄送进 DLQ topic，提交位移继续前进，后面的消息正常处理" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq3Ac2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
<marker id="mq3As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">错误：seek 把位移拨回去重试</text>
<rect class="bx" x="250" y="36" width="160" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="54" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<text class="ts" x="330" y="72" text-anchor="middle" font-size="12" fill="#6b675e">碰到就抛异常</text>
<path class="flc" d="M75 116 V58 H244" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq3Ac2)"/>
<text class="ts" x="160" y="50" text-anchor="middle" font-size="12" fill="#6b675e">投递</text>
<path class="flc" d="M330 80 V106 H95 V114" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq3Ac2)"/>
<text class="tc" x="212" y="100" text-anchor="middle" font-size="12" fill="#b03a2e">seek(offset=3)，拨回去重读</text>
<text class="tc" x="460" y="58" font-size="12" fill="#b03a2e">8 秒循环 1318 次</text>
<rect class="bx-sick" x="40" y="120" width="70" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="75" y="145" text-anchor="middle" font-size="14" fill="#2b2a26">☠ 毒</text>
<rect class="bx-q" x="118" y="120" width="64" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="150" y="145" text-anchor="middle" font-size="14" fill="#2b2a26">#4</text>
<rect class="bx-q" x="190" y="120" width="64" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="222" y="145" text-anchor="middle" font-size="14" fill="#2b2a26">#5</text>
<text class="ts" x="266" y="145" font-size="12" fill="#6b675e">身后一条没处理到：毒消息霸住位移</text>
<line class="grid" x1="20" y1="175" x2="640" y2="175" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">对：抄送 DLQ，提交位移，继续前进</text>
<rect class="bx" x="250" y="208" width="160" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="226" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<text class="ts" x="330" y="244" text-anchor="middle" font-size="12" fill="#6b675e">catch 住，抄送 DLQ</text>
<rect class="bx-q" x="480" y="208" width="150" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="555" y="226" text-anchor="middle" font-size="14" fill="#2b2a26">kpoison.dlq</text>
<text class="ts" x="555" y="244" text-anchor="middle" font-size="12" fill="#6b675e">普通 topic</text>
<line class="fl" x1="410" y1="230" x2="474" y2="230" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As4)"/>
<text class="ts" x="442" y="222" text-anchor="middle" font-size="12" fill="#6b675e">抄送</text>
<path class="fl" d="M75 272 V262 H280 V256" fill="none" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq3As4)"/>
<text class="ts" x="160" y="258" text-anchor="middle" font-size="12" fill="#6b675e">投递</text>
<rect class="bx-sick" x="40" y="276" width="70" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="75" y="301" text-anchor="middle" font-size="14" fill="#2b2a26">☠ 毒</text>
<rect class="bx-q" x="118" y="276" width="64" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="150" y="301" text-anchor="middle" font-size="14" fill="#2b2a26">#4 ✓</text>
<rect class="bx-q" x="190" y="276" width="64" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="222" y="301" text-anchor="middle" font-size="14" fill="#2b2a26">#5 ✓</text>
<text class="ts" x="266" y="301" font-size="12" fill="#6b675e">位移提交过去，后面正常往前走</text>
</svg>
</figure>

## 第四站：积压，它叫 lag

最后一个词。教具实验四里，1000 单灌进队列、消费者停着，UI 上看队列深度爬到 1000，worker 开起来看它排空。Kafka 版：20000 条灌进日志，消费者上线慢慢消化，另开一个终端用官方 CLI 盯着消费组：

```text
$ kafka-consumer-groups.sh --describe --group g-flood

GROUP    TOPIC    PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
g-flood  kflood   0          11400           20000           8600
...
g-flood  kflood   0          20000           20000           0
```

积压不叫深度，叫 **lag**：日志末端 offset 减去消费组提交的 offset。语义上的差别比名字大：队列深度数的是「还没被取走的包裹」，lag 量的是「读者落在作者后面的距离」。前者消费完就归零，消息随之消失；后者只是暂时落后，日志里 20000 条一条不少，落后的部分随时可以补读，补完 lag 归零，消息还在日志里。

lag 在日志上的样子：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 190" role="img" aria-label="lag 的含义：日志末端 offset 是 20000，消费组提交到 11400，两者之差 8600 就是 lag；补读完成后 lag 归零，消息仍全部留在日志里" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq3Ac3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<rect class="bx-q" x="40" y="50" width="560" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="52" y="75" font-size="12" fill="#6b675e">0</text>
<text class="tc" x="359" y="34" text-anchor="middle" font-size="12" fill="#b03a2e">CURRENT-OFFSET 11400</text>
<line class="flc" x1="359" y1="42" x2="359" y2="98" stroke="#b03a2e" stroke-width="2"/>
<path class="fill-c" d="M359 98 L354 108 L364 108 Z" fill="#b03a2e"/>
<text class="t" x="600" y="34" text-anchor="end" font-size="14" fill="#2b2a26">LOG-END-OFFSET 20000</text>
<line class="flk" x1="600" y1="42" x2="600" y2="98" stroke="#2b2a26" stroke-width="2"/>
<path class="flc" d="M359 116 V128 M600 116 V128 M365 122 H592" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq3Ac3)"/>
<text class="tc" x="479" y="148" text-anchor="middle" font-size="12" fill="#b03a2e">LAG = 20000 - 11400 = 8600</text>
<text class="ts" x="320" y="176" text-anchor="middle" font-size="12" fill="#6b675e">补读完，lag 归零；20000 条仍然全在日志里</text>
</svg>
</figure>

排空速率也是消费端自己的事：教具里加 worker 是多几个人从同一个队列抢消息，Kafka 里加消费者是把分区重新分工。20 个消费者读 1 个分区，19 个闲着（一个分区至多分给组内一个消费者），消费者组篇会细讲。灌入速率和消费速率天然解耦，lag 就是两个速率之差的累积，监控它的曲线形状比盯任何一个绝对数字都有用。

## 四站走完：谁负责什么

| 教具（RabbitMQ） | Kafka |
|---|---|
| 交换机路由，队列存储 | topic 切分区，没有交换机 |
| 推模型，prefetch 节流 | 拉模型，poll 自己的节奏 |
| ack 签收，broker 销毁 | 提交位移，日志原地不动 |
| 崩溃 → unacked 回收 | 崩溃 → 从上次提交处续读 |
| DLX 死信，一行配置 | DLQ topic，自己拼 |
| 队列深度 | lag |
| TTL、重回队列、重试 | 全是消费端的积木 |

左边一列是 broker 的责任，右边一列是消费者的责任。两套分工谈不上谁好谁坏：RabbitMQ 把语义做进 broker，代价是语义只有那几档固定的；Kafka 把语义还给客户端，代价是自己搭积木，换来的是日志本身的能力：重放、多读者、按位点回到过去。这些在快递模型里根本造不出来。

一条消息的旅程到这儿只走完了表层：它落进了某个分区、拿到了一个 offset、被某个组读到。还有一整层没拆：这条消息在磁盘上的形态、「追加写」比数据库的随机写快几个数量级的原因、日志段和稀疏索引这些词对应的磁盘结构。

下一篇沉到存储层：日志段、索引，以及把顺序写用到极致的完整形态。MySQL 系列从 B+ 树的随机写开始，这个系列从 commit log 的顺序写开始，同一块磁盘的两种用法。

（实验环境：apache/kafka:4.3.1 KRaft 单容器，kafkajs 2.2.4。脚本几十行一个，仓库外维护，每个实验怎么跑正文里都随文讲了。踩了个坑要记下来：我为了「可重复跑」在脚本里删旧主题，kafkajs 的 deleteTopics 把数组当成了 options 传，抛错被空 catch 吞掉，主题根本没删成，毒消息实验的数据叠了三轮，才从 offset 不对劲里看出来。实验脚本里别留空 catch。）
