---
title: 那 29.6 秒的等待：消费者组、心跳与 rebalance
description: 消息队列系列第八篇，把旅程篇那次 29.6 秒的等待拆开。组成员猝死不留尸身，协调者只能等会话超时到期：kafkajs 默认 30 秒，实测 kill 到接管完成 36.6 秒，会话改 8 秒就只要 11.6 秒，等待期间死者的分区无主、lag 白涨；Java 客户端默认 45 秒，还不许 KIP-848 组的成员自己改。组的解剖实测：经典协议里分配算法由一个叫组 leader 的客户端成员算，协调者只主持，8 人抢 6 分区恰好 2 人空手，逐个退场触发连环再平衡搅了 40 秒。rebalance 三种走法：eager 全组停工，实测加一人、两个老成员各停 3.6 与 2.6 秒；cooperative 只动该动的，日志原话 need to revoke partitions [kgrp-2]，没动的四个分区全程不被触碰；KIP-848 把分配挪到服务端，成员按任期号对账，describe 里显示 uniform，但猝死照样等满服务端会话。static membership 是另一条路：group.instance.id 把席位钉死，SIGKILL 后重启 1.3 秒拿回原分区，任期号没变，搭档全程零事件。
pubDate: 2026-10-30
category: mq
tags: [Kafka, 消息队列, 分布式]
---

副本篇结尾说，刀要落到消费端了。这一篇拆的是消费者组：分区怎么分工、人死了怎么办、为什么旅程篇里那个重启的消费者等了 29.6 秒才拿到分区。那个数字当时只给了一句解释（在等前任的会话超时），这次把它拆到毫秒。

实验环境还是那套 3 控制器 + 3 broker 的集群。工具换了两副面孔：kafkajs 的消费者（脚本编排、毫秒打点），和容器里的 Java console-consumer（有些机制只有 Java 客户端有，后面会说）。

## 一、组的解剖

先看一个组稳定时长什么样。官方 CLI 的 describe 输出：

```text
$ kafka-consumer-groups.sh --describe --state --group g-java-eager
GROUP           COORDINATOR (ID)     ASSIGNMENT-STRATEGY  STATE    #MEMBERS
g-java-eager    kafka3:29092  (3)    range                Stable   3
```

三个角色都在这一行里。**协调者（coordinator）**是一台普通 broker（这里是 3 号），每个组一个，管花名册、主持再平衡、看住会话时钟；哪台 broker 当协调者由组名哈希决定，这件事牵出一个有意思的机制，留到下一篇。**成员**是各个消费者进程。**分配策略**（range）决定谁拿哪些分区。

分配策略这一栏值得多看一眼，因为它暴露了经典协议最特别的设计：**分配算法不在 broker 上，在客户端里**。实测 kafkajs 的入组事件带一个 isLeader 标记：被选为「组 leader」的成员负责收集全组订阅、跑分配算法、把结果交回协调者分发，协调者只主持点名。这是经典协议的固定分工，Java 客户端同理。算法因此可以换：kafkajs 2.2.4 只带 roundRobin 一种（分区与键篇竞速实验里 3000/3000/3000 的交错形态就是它分的）；Java 客户端默认清单是 [Range, CooperativeSticky]，全组成员协商后取第一个共同的，实测协商结果是 range。

分工的形状实测两种。6 个分区 3 个成员，roundRobin 分成交错的 [2,5]、[1,4]、[0,3]；8 个成员抢 6 个分区，恰好 2 人空手，入组事件里 assigned=[]，一条消息也轮不到。这就是分区与键篇那句「一个分区至多分给组内一个消费者」的现场：分区的消费权在组内是独占的，人比分区多，多出来的就是观众。为什么必须独占？两个人同读一个分区，位移该记谁的、顺序谁来保，全都说不清；独占是这个体系里最便宜的一致性。

把组的零件摆在一处：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 380" role="img" aria-label="组的解剖：成员先发 JoinGroup，协调者主持点名并选出组 leader，组 leader 在客户端跑分配算法后交回，协调者用 SyncGroup 分发；分配形状一为 6 分区 3 成员 roundRobin 交错，各持 [2,5] [1,4] [0,3]；分配形状二为 8 成员 6 分区，恰好 2 人空手，入组事件里 assigned 为空" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq8As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">组的解剖：谁主持点名，谁算分配，分出来什么形状</text>
<rect class="bx-q" x="20" y="60" width="110" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="75" y="80" text-anchor="middle" font-size="14" fill="#2b2a26">成员 ×N</text>
<text class="ts" x="75" y="98" text-anchor="middle" font-size="12" fill="#6b675e">消费者进程</text>
<rect class="bx" x="230" y="60" width="150" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="305" y="80" text-anchor="middle" font-size="14" fill="#2b2a26">协调者</text>
<text class="ts" x="305" y="98" text-anchor="middle" font-size="12" fill="#6b675e">某台 broker · 每组一个</text>
<rect class="bx-q" x="520" y="60" width="120" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="580" y="80" text-anchor="middle" font-size="14" fill="#2b2a26">组 leader</text>
<text class="ts" x="580" y="98" text-anchor="middle" font-size="12" fill="#6b675e">被选出的那个成员</text>
<line class="fl" x1="130" y1="72" x2="226" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As1)"/>
<text class="ts" x="178" y="52" text-anchor="middle" font-size="12" fill="#6b675e">① JoinGroup 点名</text>
<line class="fl" x1="380" y1="72" x2="516" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As1)"/>
<text class="ts" x="448" y="52" text-anchor="middle" font-size="12" fill="#6b675e">② 选定组 leader</text>
<line class="fl" x1="520" y1="96" x2="384" y2="96" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As1)"/>
<text class="ts" x="452" y="128" text-anchor="middle" font-size="12" fill="#6b675e">③ 分配结果交回</text>
<line class="fl" x1="230" y1="96" x2="134" y2="96" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As1)"/>
<text class="ts" x="190" y="128" text-anchor="middle" font-size="12" fill="#6b675e">④ SyncGroup 分发</text>
<text class="tc" x="20" y="156" font-size="12" fill="#b03a2e">算盘在成员手里：协调者只主持点名，分配结果由组 leader 算好交回</text>
<text class="ts" x="20" y="188" font-size="12" fill="#6b675e">分配形状一：6 分区 3 成员，roundRobin 交错</text>
<rect class="bx-q" x="20" y="198" width="76" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="58" y="217" text-anchor="middle" font-size="12" fill="#6b675e">p0</text>
<rect class="bx-q" x="108" y="198" width="76" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="146" y="217" text-anchor="middle" font-size="12" fill="#6b675e">p1</text>
<rect class="bx-q" x="196" y="198" width="76" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="234" y="217" text-anchor="middle" font-size="12" fill="#6b675e">p2</text>
<rect class="bx-q" x="284" y="198" width="76" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="322" y="217" text-anchor="middle" font-size="12" fill="#6b675e">p3</text>
<rect class="bx-q" x="372" y="198" width="76" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="410" y="217" text-anchor="middle" font-size="12" fill="#6b675e">p4</text>
<rect class="bx-q" x="460" y="198" width="76" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="498" y="217" text-anchor="middle" font-size="12" fill="#6b675e">p5</text>
<text class="ts" x="58" y="244" text-anchor="middle" font-size="12" fill="#6b675e">成员3</text>
<text class="ts" x="146" y="244" text-anchor="middle" font-size="12" fill="#6b675e">成员2</text>
<text class="ts" x="234" y="244" text-anchor="middle" font-size="12" fill="#6b675e">成员1</text>
<text class="ts" x="322" y="244" text-anchor="middle" font-size="12" fill="#6b675e">成员3</text>
<text class="ts" x="410" y="244" text-anchor="middle" font-size="12" fill="#6b675e">成员2</text>
<text class="ts" x="498" y="244" text-anchor="middle" font-size="12" fill="#6b675e">成员1</text>
<text class="ts" x="548" y="204" font-size="12" fill="#6b675e">成员1 [2,5]</text>
<text class="ts" x="548" y="220" font-size="12" fill="#6b675e">成员2 [1,4]</text>
<text class="ts" x="548" y="236" font-size="12" fill="#6b675e">成员3 [0,3]</text>
<text class="ts" x="20" y="280" font-size="12" fill="#6b675e">分配形状二：8 个成员，6 个分区</text>
<rect class="bx-q" x="20" y="290" width="64" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="52" y="307" text-anchor="middle" font-size="12" fill="#6b675e">成员1</text>
<rect class="bx-q" x="92" y="290" width="64" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="124" y="307" text-anchor="middle" font-size="12" fill="#6b675e">成员2</text>
<rect class="bx-q" x="164" y="290" width="64" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="196" y="307" text-anchor="middle" font-size="12" fill="#6b675e">成员3</text>
<rect class="bx-q" x="236" y="290" width="64" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="268" y="307" text-anchor="middle" font-size="12" fill="#6b675e">成员4</text>
<rect class="bx-q" x="308" y="290" width="64" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="340" y="307" text-anchor="middle" font-size="12" fill="#6b675e">成员5</text>
<rect class="bx-q" x="380" y="290" width="64" height="26" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="412" y="307" text-anchor="middle" font-size="12" fill="#6b675e">成员6</text>
<rect class="bx-gone" x="452" y="290" width="64" height="26" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="tc" x="484" y="307" text-anchor="middle" font-size="12" fill="#b03a2e">空手</text>
<rect class="bx-gone" x="524" y="290" width="64" height="26" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="tc" x="556" y="307" text-anchor="middle" font-size="12" fill="#b03a2e">空手</text>
<text class="ts" x="20" y="340" font-size="12" fill="#6b675e">多出来的两个拿着空分配（assigned=[]），在旁边看着</text>
<text class="ts" x="20" y="366" font-size="12" fill="#6b675e">分配算法可以换：kafkajs 只带 roundRobin，Java 默认协商出 range，独占的规矩不变</text>
</svg>
</figure>

入组和退场都不便宜。每加一个成员，全组重排一次：kafkajs 实测每一轮约 4.6 秒（新成员的入组耗时），老成员重新拿分配只要 9-13 毫秒，大头花在等全员到齐的点名环节。退场更热闹：实验脚本收尾时逐个 disconnect 八个成员，每走一个人触发一轮全组再平衡，日志里连环搅了七轮、每轮间隔约 5 秒。优雅退出（LeaveGroup）不用等会话超时，但再平衡本身一次都省不掉。这个「谁都别想置身事外」的毛病，第三节有药。

## 二、那 29.6 秒的等待

旅程篇的实验：消费者处理到第 3 条被 kill，同组重启，等了 29.6 秒才拿到分区。现在把等待拆开。

组成员靠两套时钟活着。**心跳**：kafkajs 默认每 3 秒向协调者报一次平安（Java 客户端同为 3 秒）。**会话**：协调者给每个成员记一个倒计时，kafkajs 默认 30 秒（Java 默认 45 秒，运行时配置实读），心跳每来一次就续满。进程猝死时不会有任何告别，心跳直接停，协调者分不清「死了」和「网络抖了一下」，唯一的判据就是倒计时走完。

实测这个等待。两个成员稳定消费一个 6 分区 topic（每 200ms 一条流量），SIGKILL 掉成员 A，盯着 B 什么时候接管：

```text
默认会话（30s）：kill → B 接管完成  36620ms
会话调成 8s   ：kill → B 接管完成  11622ms
```

公式浮出水面：**等待 ≈ 会话超时 + 一轮再平衡**（再平衡那几秒见第三节）。旅程篇的 29.6 秒是同款：重启的新成员入组时，前任的席位还挂在花名册上等倒计时走完，组不敢把人分出去。

等待期间发生什么也要看清：死者名下的 3 个分区无主，没人读，lag 只涨不消；活成员自己的分区照常消费（B 全程处理了 310 条，没受牵连）。所以这个旋钮的两端都有价：会话调短，检测快，但一次长 GC、一段网络抖动就可能把活人踢出组，触发一轮白白的再平衡；会话调长，稳，但真出事时无主时间也长。哨兵篇的 down-after-milliseconds 是同款旋钮，连纠结的姿势都一样。

这段等待花在哪，画开看：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 316" role="img" aria-label="猝死到接管完成的时间轴：t=0 SIGKILL 成员 A，心跳停止，协调者等满 30 秒会话倒计时才判死，再走一轮约 6.6 秒的再平衡，36.6 秒时 B 接管 A 的 3 个分区；等待期间死者的分区无主、lag 只涨不消，B 自己的分区照常消费；会话调成 8 秒后接管只要 11.6 秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq8As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">从猝死到接管完成：36.6 秒花在哪</text>
<text class="ts" x="66" y="58" font-size="12" fill="#6b675e">t=0 SIGKILL A：心跳到此为止</text>
<line class="flk" x1="60" y1="64" x2="60" y2="132" stroke="#2b2a26" stroke-width="2"/>
<rect class="bx-sick" x="60" y="92" width="442" height="18" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx" x="502" y="92" width="98" height="18" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="66" y="84" font-size="12" fill="#b03a2e">会话倒计时 30s：分不清「死了」还是「网络抖了一下」</text>
<text class="ts" x="596" y="84" text-anchor="end" font-size="12" fill="#6b675e">一轮再平衡 ≈6.6s</text>
<line class="fl" x1="60" y1="101" x2="628" y2="101" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As2)"/>
<line class="fl" x1="502" y1="86" x2="502" y2="116" stroke="#6b675e" stroke-width="1.6"/>
<text class="ts" x="502" y="132" text-anchor="middle" font-size="12" fill="#6b675e">30s 倒计时走完，判死</text>
<line class="flc" x1="600" y1="64" x2="600" y2="132" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="594" y="58" text-anchor="end" font-size="12" fill="#b03a2e">36.6s B 接管 A 的 3 个分区</text>
<rect class="bx-sick" x="60" y="150" width="540" height="16" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="60" y="184" font-size="12" fill="#b03a2e">这期间 A 名下 3 个分区无主：没人读，lag 只涨不消</text>
<rect class="bx-q" x="60" y="196" width="540" height="16" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="60" y="230" font-size="12" fill="#6b675e">B 自己的分区照常消费：全程处理 310 条，没受牵连</text>
<line class="fl" x1="60" y1="246" x2="60" y2="272" stroke="#6b675e" stroke-width="1.6"/>
<line class="flc" x1="231" y1="246" x2="231" y2="272" stroke="#b03a2e" stroke-width="1.6"/>
<rect class="bx-sick" x="60" y="252" width="118" height="14" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx" x="178" y="252" width="53" height="14" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="60" y="290" font-size="12" fill="#6b675e">会话调成 8s：11.6 秒（11622ms）接管完成，再平衡只占约 3.6 秒</text>
<text class="ts" x="20" y="308" font-size="12" fill="#6b675e">会话每调短一秒，无主窗口就少一秒，GC 或网络抖动误踢活人的风险就多一分</text>
</svg>
</figure>

还有第二条被踢出组的路，跟心跳无关：**max.poll.interval.ms**（实测 Java 客户端默认 300000，5 分钟）。心跳线程是独立的，处理线程卡死 5 分钟不回来 poll，成员照样被判定僵尸踢出。两套时钟各管一摊：心跳管连接活着，poll 间隔管人在干活。这条时钟本轮没能实测（实验室的容器只有 JRE，写不了一个卡住的处理者；kafkajs 又没把参数暴露出来），机制按配置与文档记在这，数字不编。

## 三、rebalance 的三种走法

「再平衡」这个词听起来温和，实际上按协议不同，动静差出几个量级。

**第一种：eager，全组停工。**默认走法。任何成员变动，协调者宣布再平衡，全员先把手里的分区**全部**交回（不管这次变动跟你有没有关系），重新点名，组 leader 重算分配，再发还。stop-the-world 的名字就是这么来的：世界停住，等重新分完。实测（kafkajs，6 分区 2 人稳定消费、流量不断，加入第三人）：

```text
重分配总耗时 5205ms
老成员 A：处理停顿 3631ms   老成员 B：停顿 2629ms
（正常节奏下每条消息间隔约 600ms）
```

Java 客户端的日志给出另一份证据：eager 组重分配后，成员名下**每个**分区都重新初始化消费位点（连没换手的分区也重打一遍 Setting offset）。分区与键篇竞速实验里建组 15 秒、计数歪斜 3062/5622/316 的现场，根子也是它。

**第二种：cooperative，只动该动的。**增量式再平衡，Java 客户端显式指定 CooperativeStickyAssignor 启用（默认协商不到它，kafkajs 没有这个分配器）。同样的第三人入组，日志换了一副面孔：

```text
c1: Request joining group due to: need to revoke partitions [kgrp-2] ... and re-join
c2: Request joining group due to: need to revoke partitions [kgrp-5] ... and re-join
c3: Adding newly assigned partitions: [kgrp-2, kgrp-5]
```

c1 只交出一个 kgrp-2，c2 只交出一个 kgrp-5，各自手里没动的分区**全程不被触碰**：日志里没有它们的位点重置，消费不中断。代价是流程分两段（先收要挪的、再发给新主），实测约 3 秒，但这 3 秒里只有 2 个分区在过户，不是 6 个全停。

两种协议摆在同一张桌上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="eager 与 cooperative 两种协议在第三人入组时的动静对比：eager 下 6 个分区全部交回，老成员 A 停顿 3631 毫秒、B 停顿 2629 毫秒，重分配总耗时 5205 毫秒；cooperative 下 c1 只交 kgrp-2、c2 只交 kgrp-5，c3 新得这两个，没动的 4 个分区全程不被触碰、位点不重置，过户实测约 3 秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同样是第三人入组，谁停谁不停</text>
<text class="t" x="20" y="56" font-size="14" fill="#2b2a26">eager（默认）：全员先交回一切</text>
<rect class="bx-gone" x="20" y="68" width="64" height="24" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="52" y="85" text-anchor="middle" font-size="12" fill="#6b675e">p0</text>
<rect class="bx-gone" x="92" y="68" width="64" height="24" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="124" y="85" text-anchor="middle" font-size="12" fill="#6b675e">p1</text>
<rect class="bx-gone" x="164" y="68" width="64" height="24" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="196" y="85" text-anchor="middle" font-size="12" fill="#6b675e">p2</text>
<rect class="bx-gone" x="236" y="68" width="64" height="24" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="268" y="85" text-anchor="middle" font-size="12" fill="#6b675e">p3</text>
<rect class="bx-gone" x="308" y="68" width="64" height="24" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="340" y="85" text-anchor="middle" font-size="12" fill="#6b675e">p4</text>
<rect class="bx-gone" x="380" y="68" width="64" height="24" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="412" y="85" text-anchor="middle" font-size="12" fill="#6b675e">p5</text>
<text class="tc" x="460" y="77" font-size="12" fill="#b03a2e">全部交回</text>
<text class="tc" x="460" y="93" font-size="12" fill="#b03a2e">哪怕跟你无关</text>
<line class="axis" x1="140" y1="103" x2="628" y2="103" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="20" y="122" font-size="12" fill="#6b675e">老成员 A</text>
<rect class="bar" x="140" y="109" width="335" height="18" fill="#2b2a26"/>
<text class="onbar" x="307" y="122" text-anchor="middle" font-size="12" fill="#f6f3ec">停顿 3631ms</text>
<text class="ts" x="20" y="146" font-size="12" fill="#6b675e">老成员 B</text>
<rect class="bar" x="140" y="133" width="242" height="18" fill="#2b2a26"/>
<text class="onbar" x="261" y="146" text-anchor="middle" font-size="12" fill="#f6f3ec">停顿 2629ms</text>
<line class="flc" x1="620" y1="103" x2="620" y2="157" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="614" y="172" text-anchor="end" font-size="12" fill="#b03a2e">重分配总耗时 5205ms</text>
<text class="ts" x="20" y="172" font-size="12" fill="#6b675e">正常节奏每 600ms 一条消息</text>
<text class="t" x="20" y="204" font-size="14" fill="#2b2a26">cooperative：只动该动的</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">c1</text>
<rect class="bx-q" x="48" y="214" width="76" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="86" y="230" text-anchor="middle" font-size="12" fill="#6b675e">kgrp-0</text>
<rect class="bx-q" x="132" y="214" width="76" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="170" y="230" text-anchor="middle" font-size="12" fill="#6b675e">kgrp-1</text>
<rect class="bx-sick" x="216" y="214" width="76" height="24" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="254" y="230" text-anchor="middle" font-size="12" fill="#b03a2e">kgrp-2</text>
<text class="ts" x="20" y="262" font-size="12" fill="#6b675e">c2</text>
<rect class="bx-q" x="48" y="246" width="76" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="86" y="262" text-anchor="middle" font-size="12" fill="#6b675e">kgrp-3</text>
<rect class="bx-q" x="132" y="246" width="76" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="170" y="262" text-anchor="middle" font-size="12" fill="#6b675e">kgrp-4</text>
<rect class="bx-sick" x="216" y="246" width="76" height="24" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="254" y="262" text-anchor="middle" font-size="12" fill="#b03a2e">kgrp-5</text>
<text class="ts" x="316" y="230" font-size="12" fill="#6b675e">没动的 4 个分区全程不被触碰：</text>
<text class="ts" x="316" y="246" font-size="12" fill="#6b675e">位点不重置，消费不中断</text>
<text class="ts" x="20" y="294" font-size="12" fill="#6b675e">c3</text>
<rect class="bx-q" x="48" y="278" width="76" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="86" y="294" text-anchor="middle" font-size="12" fill="#b03a2e">kgrp-2</text>
<rect class="bx-q" x="132" y="278" width="76" height="24" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="170" y="294" text-anchor="middle" font-size="12" fill="#b03a2e">kgrp-5</text>
<text class="ts" x="232" y="294" font-size="12" fill="#6b675e">c3 新得：过户的只有 2 个分区，实测约 3 秒</text>
<text class="ts" x="20" y="328" font-size="12" fill="#6b675e">全组停工是协议的动静，不是再平衡的必然代价：增量可以边跑边过户</text>
</svg>
</figure>

**第三种：KIP-848，把算法也搬上楼。**前两种都是经典协议：客户端点名、客户端算分配、几轮往返。新协议把这三件事全挪到服务端：成员不再发 JoinGroup/SyncGroup，只定期发一种 ConsumerGroupHeartbeat，协调者在服务端算好分配（默认分配器叫 uniform），成员拿到后按**任期号**对账。Java 客户端日志里干活的类都换了名字：

```text
ConsumerMembershipManager: Reconciling assignment with local epoch 2
```

没有「(Re-)joining group」，没有全组点名的等待，扩容缩容都是一次 epoch 递增加一次定向交接。CLI 也看得见区别：describe 里经典组的 ASSIGNMENT-STRATEGY 显示 range 或 cooperative-sticky，848 组显示 uniform。实测第三人入组，从进程拉起到全组分配落定约 15 秒，其中约 10 秒是 JVM 冷启动，协议往来本身只占零头。

但新协议不是万能药，两处实测要说清。其一，**死亡判定没有变快**：kill 一个成员，其余成员约 45 秒后才接管（等服务端会话超时，默认 45 秒），和经典协议等同一个量级；848 优化的是接管动作（定向、无全组往返），不是发现速度。其二，会话时长不再归客户端管：给 848 组的成员设 session.timeout.ms，客户端直接拒绝启动，报错原文 "session.timeout.ms cannot be set when group.protocol=CONSUMER"，生杀大权收归服务端配置。

两代协议的往来形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="经典协议与 KIP-848 的往来形状对比：经典协议里成员发 JoinGroup，协调者主持点名并选出组 leader，组 leader 算好分配交回，再由 SyncGroup 分发给全员，四步往返；KIP-848 里成员只定期发 ConsumerGroupHeartbeat，协调者在服务端算好分配（默认 uniform），响应里带着分配和任期号，成员按 epoch 对账" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq8As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">两代协议：点名与算盘放在哪</text>
<text class="t" x="20" y="56" font-size="14" fill="#2b2a26">经典协议：客户端点名，客户端算分配</text>
<rect class="bx-q" x="30" y="76" width="110" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="85" y="96" text-anchor="middle" font-size="14" fill="#2b2a26">成员 ×N</text>
<text class="ts" x="85" y="114" text-anchor="middle" font-size="12" fill="#6b675e">消费者进程</text>
<rect class="bx" x="250" y="76" width="140" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="320" y="96" text-anchor="middle" font-size="14" fill="#2b2a26">协调者</text>
<text class="ts" x="320" y="114" text-anchor="middle" font-size="12" fill="#6b675e">主持点名 · 等全员到齐</text>
<rect class="bx-q" x="500" y="76" width="130" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="565" y="96" text-anchor="middle" font-size="14" fill="#2b2a26">组 leader</text>
<text class="ts" x="565" y="114" text-anchor="middle" font-size="12" fill="#6b675e">成员之一</text>
<line class="fl" x1="140" y1="88" x2="246" y2="88" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As3)"/>
<text class="ts" x="193" y="70" text-anchor="middle" font-size="12" fill="#6b675e">① JoinGroup</text>
<line class="fl" x1="390" y1="88" x2="496" y2="88" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As3)"/>
<text class="ts" x="443" y="70" text-anchor="middle" font-size="12" fill="#6b675e">② 选定组 leader</text>
<line class="fl" x1="500" y1="112" x2="394" y2="112" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As3)"/>
<text class="ts" x="447" y="142" text-anchor="middle" font-size="12" fill="#6b675e">③ 分配结果交回</text>
<line class="fl" x1="250" y1="112" x2="144" y2="112" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As3)"/>
<text class="ts" x="197" y="142" text-anchor="middle" font-size="12" fill="#6b675e">④ SyncGroup 分发</text>
<text class="tc" x="20" y="168" font-size="12" fill="#b03a2e">任何变动都要走一遍这四步：点名等全员到齐，重发时全组停着</text>
<text class="t" x="20" y="196" font-size="14" fill="#2b2a26">KIP-848：点名、算分配、分发全搬去服务端</text>
<rect class="bx-q" x="30" y="214" width="160" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="234" text-anchor="middle" font-size="14" fill="#2b2a26">成员 ×N</text>
<text class="ts" x="110" y="252" text-anchor="middle" font-size="12" fill="#6b675e">不再发 Join/Sync</text>
<rect class="bx" x="430" y="214" width="190" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="525" y="234" text-anchor="middle" font-size="14" fill="#2b2a26">协调者（服务端）</text>
<text class="ts" x="525" y="252" text-anchor="middle" font-size="12" fill="#6b675e">算好分配 · 默认 uniform</text>
<line class="fl" x1="190" y1="226" x2="426" y2="226" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As3)"/>
<text class="ts" x="308" y="218" text-anchor="middle" font-size="12" fill="#6b675e">ConsumerGroupHeartbeat 定期送</text>
<line class="fl" x1="430" y1="250" x2="194" y2="250" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq8As3)"/>
<text class="ts" x="312" y="278" text-anchor="middle" font-size="12" fill="#6b675e">响应带着分配 + 任期号（epoch）</text>
<text class="ts" x="20" y="300" font-size="12" fill="#6b675e">成员按 epoch 对账：没有全组点名的等待，定向交接在一次心跳往来里完成</text>
<text class="ts" x="20" y="328" font-size="12" fill="#6b675e">四步变一次心跳：点名、计算、分发三件事都住到了楼上</text>
</svg>
</figure>

客户端现状也要如实记：4.3 的 Java 客户端默认仍是 classic，启动横幅明说 KIP-848 已经 production-ready、要用就设 group.protocol=consumer；kafkajs 2.2.4 只实现了经典协议。跨客户端差异的名单再添一笔（之前出场过的：无 key 消息的落点策略、OUT_OF_ORDER_SEQUENCE 的可重试标记）。

## 四、把席位钉死：static membership

以上所有协议都把成员当匿名临时工：走了就是走了，回来算新人，全组重排。static membership 反着来，给成员发一个不变的工号（`group.instance.id`），席位跟人走：

```text
$ kafka-consumer-groups.sh --describe --members --group g-static
GROUP      CONSUMER-ID      GROUP-INSTANCE-ID  #PARTITIONS
g-static   m1-8e9574f5-…    m1                 3
g-static   m2-7282be27-…    m2                 3
```

实测全流程：m1、m2 各持 3 个分区稳定消费，SIGKILL m1，立刻带同一个 instance.id 重启。结果：

```text
kill → 重启完成、拿回原分区：1.3 秒（含 JVM 启动）
m1 日志：Skipped assignment for returning static leader at generation 2
m2 日志：全程零事件，没有 rebalance，它甚至不知道对面换过一次进程
```

对比第二节动态成员的 36.6 秒，差出 28 倍。原理一句话：静态成员死后席位保留一个会话时长（实测配置 30 秒），期间本人回来就原位复工，任期号（generation）都不加一；超过时限没回来，才按普通死亡处理、触发再平衡。

同一次 SIGKILL 的两种时间：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="同一次 SIGKILL 的两种时间对比：动态成员要 36.6 秒等满会话倒计时加一轮再平衡，静态成员带同一个 group.instance.id 重启，1.3 秒拿回原分区，任期号不加一，搭档全程零事件；席位在猝死后保留 30 秒，窗口内本人回来就原位复工，超过时限才按普通死亡触发再平衡" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一次 SIGKILL，动态成员与静态成员的两种时间</text>
<text class="ts" x="20" y="65" font-size="12" fill="#6b675e">动态成员</text>
<rect class="bar" x="180" y="52" width="440" height="18" fill="#2b2a26"/>
<text class="onbar" x="400" y="65" text-anchor="middle" font-size="12" fill="#f6f3ec">36.6s：等满会话倒计时 + 一轮再平衡</text>
<text class="ts" x="20" y="101" font-size="12" fill="#6b675e">静态成员</text>
<rect class="bar" x="180" y="88" width="16" height="18" fill="#2b2a26"/>
<text class="tc" x="206" y="101" font-size="12" fill="#b03a2e">1.3s：重启拿回原分区，搭档全程零事件</text>
<text class="tc" x="204" y="130" font-size="12" fill="#b03a2e">1.3s 本人回来：原位复工，generation 不加一</text>
<text class="ts" x="20" y="148" font-size="12" fill="#6b675e">席位去哪了：m1 猝死后，工号还在花名册上</text>
<line class="flk" x1="180" y1="150" x2="180" y2="186" stroke="#2b2a26" stroke-width="2"/>
<rect class="bx" x="180" y="156" width="360" height="24" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="360" y="172" text-anchor="middle" font-size="12" fill="#6b675e">空着但保留 · 不触发再平衡</text>
<line class="flc" x1="196" y1="156" x2="196" y2="136" stroke="#b03a2e" stroke-width="2"/>
<line class="flk" x1="540" y1="150" x2="540" y2="186" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="174" y="204" text-anchor="end" font-size="12" fill="#6b675e">t=0 SIGKILL m1</text>
<text class="ts" x="644" y="204" text-anchor="end" font-size="12" fill="#6b675e">超过 30s 没回来：才按普通死亡处理，触发再平衡</text>
<text class="ts" x="20" y="240" font-size="12" fill="#6b675e">36.6s 对 1.3s，差出 28 倍：工号没换，席位就没换，组里无感</text>
</svg>
</figure>

适应症清楚：成员名单本来就固定的场景，滚动重启、发版、K8s 里带稳定身份的 StatefulSet，重启不再引发全组地震。代价也清楚：真死了的时候，组会先把席位空等满一个会话时长，无主时间比动态模式更长；而且扩缩容（改名单）仍然要再平衡，钉死的只是「同一个人换一具进程躯体」这件事。

副本篇里 broker 的心跳会话是 9 秒，这边消费者的会话是 30 到 45 秒，static membership 干脆把判定权交给运维的显式声明。同一套「心跳加超时」的把戏，三个地方三种刻度，各自对着自己要防的事故。

把这一篇收拢：一个消费者组 = 一个协调者（某台 broker）+ 一份带席位的花名册 + 一个分配算法（在客户端或在服务端）+ 两套时钟（心跳对会话、poll 对 max.poll.interval）+ 三种再平衡走法（eager 全停、cooperative 增量、848 服务端定向）+ 一个钉席位的选项（static）。旅程篇的 29.6 秒、分区与键篇的建组 15 秒、这篇的 36.6 / 11.6 / 1.3 / 45 秒，全是这一套机件上不同位置的读数。

还剩一件事没拆：协调者凭什么知道「kafka3 号 broker 是 g-java-eager 的协调者」？组提交的位移又存在哪？答案是同一个：组名哈希到 `__consumer_offsets` 这个内部 topic 的 50 个分区之一，那个分区的 leader 就是协调者，组的位移就提交在那个分区里。记全组进度的载体本身就是一根 Kafka 日志（实测 50 分区、cleanup.policy=compact），而且还做了压实。下一篇把它翻开：位移也是一条日志。

（实验环境同上一篇的 3+3 集群，kafkajs 2.2.4 加容器内 Java console-consumer。三个工具坑，第一个差点毁掉整轮实验：4.3 的 console 工具里 consumer 的 `--property` 会被**静默忽略**（正确写法 `--command-property`，producer 侧对应 `--reader-property`），我第一轮设的 session=10s、CooperativeSticky 全没生效，跑出来的「cooperative 组」其实是 range，靠 describe 的 ASSIGNMENT-STRATEGY 列和运行时配置 dump 才抓到假实验；从此 Java 侧每个实验都先验配置 dump 再信结果，顺手还用正确参数复验了分区与键篇的跨语言落点（u2→p0、u1→p1，结论无恙）。其二，console 工具的日志级别默认 WARN，入组、revoke、reconcile 这些 INFO 事件要自己覆盖 log4j 配置才看得见。其三，容器里 pkill -f 的匹配串会命中自己所在的 bash -c 命令行，第一炮把自己 shell 杀了（exit 137），老办法：模式里加个方括号。）
