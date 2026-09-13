---
title: ack 的那一声：重投、毒消息与死信
description: 消息队列系列第二篇。上一篇的消费者处理完就 ack，一切都按剧本走；这一篇处理三种意外：消费者崩溃、消息本身有毒、同一条消息来两遍。broker 只认一句「我做完了」：kill 前队列总数 4、unacked 1，kill 后 4、0，没 ack 的那条回到队头，一条不丢；崩溃之后只有「已投递未 ack」的那条 redelivered=true。毒消息配上 requeue=true 是死循环：4 秒被重投 26,100 次，身后 5 条正常消息一条没动；nack(requeue=false) 把它送进死信交换机，orders.dead 里的 x-death 记着死因和来路。prefetch 不限流时慢消费者囤 10 条、5.03 秒才收工，限到 1 只要 0.51 秒，节流阀同时决定了崩溃时重复处理的范围。at-least-once 为什么是常态、幂等为什么是必修、exactly-once 为什么接近幻觉，最后对照 MySQL 第八篇：同一个「做到一半谁说了算」，那边由 binlog 裁决，这边宁可重投。
pubDate: 2026-10-09
category: mq
tags: [消息队列, RabbitMQ, 可靠性]
---

上一篇的消费者都是处理完就 ack，一切都按剧本走。这一篇处理三种意外：消费者崩了，消息怎么办；消息本身有毒，怎么办；同一条消息来了两遍，业务数据怎么办。三个答案分别是重投、死信、幂等，合起来叫投递语义。

## ack：消费者的一句「我做完了」

先接上第一篇实验三留下的细节：worker 被杀掉的瞬间，它手里可能还捏着一条已投出、没处理完的消息。现在把那一刻放大。5 条消息进 points 队列，worker 2 秒一条，第 3 秒杀掉（`rabbitmqctl` 的 `messages` 列是 ready + unacked 的总数，`messages_unacknowledged` 单列）：

```text
--- kill 前 ---
points   4   1     ← 总数 4（5 − 已完成的 1），其中 1 条已投出、未 ack
--- kill 后 1.5 秒 ---
points   4   0     ← 总数还是 4，unacked 归零
worker 已完成条数：1
```

总数没变，一条没丢；变的是那 1 条 unacked：broker 发现连接断了，把它放回队列重新等人领。

收回的依据是消息在 broker 眼里的三种状态：ready（在队列里等人领）、unacked（已投给某个消费者、等 ack）、acked（ack 回来，当场删除）。第三种状态的转移权在消费者手里：处理完成，回一个 basicAck，broker 才删。ack 协议就这一句话：**投递不等于完成，ack 才算**。

另一档是 `consume` 传 `noAck: true`：投递瞬间即删除，连 ack 都省了。快是真快，崩了消息就没了，那是 at-most-once，只适合日志采集这类丢了也无所谓的场景。这篇的脚本全部 `noAck: false`，要的就是 broker 不收到 ack 不删消息的固执。

这三种状态和转移路径，画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 235" role="img" aria-label="消息在 broker 里的三种状态：ready 在队列等人领，投递后变 unacked，收到 ack 即删除；unacked 期间连接断开则放回队列重投，标记 redelivered；noAck 模式下投递瞬间即删除" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq2As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq2Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
<marker id="mq2Af1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-f" d="M0 0 L8 4 L0 8 Z" fill="#a29d90"/></marker>
</defs>
<path class="grid" d="M105 90 V56 H555 V84" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.8" marker-end="url(#mq2Af1)"/>
<text class="ts" x="330" y="46" text-anchor="middle" font-size="12" fill="#6b675e">另一档 noAck=true：投递瞬间即删除，没有 ack 这一步</text>
<rect class="bx-q" x="40" y="90" width="130" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="105" y="112" text-anchor="middle" font-size="14" fill="#2b2a26">ready</text>
<text class="ts" x="105" y="130" text-anchor="middle" font-size="12" fill="#6b675e">在队列里等人领</text>
<rect class="bx" x="260" y="90" width="150" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="335" y="112" text-anchor="middle" font-size="14" fill="#2b2a26">unacked</text>
<text class="ts" x="335" y="130" text-anchor="middle" font-size="12" fill="#6b675e">已投给消费者，等 ack</text>
<rect class="bx-gone" x="500" y="90" width="110" height="52" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="555" y="112" text-anchor="middle" font-size="14" fill="#2b2a26">删除</text>
<text class="ts" x="555" y="130" text-anchor="middle" font-size="12" fill="#6b675e">ack 收到，当场删</text>
<line class="fl" x1="170" y1="116" x2="252" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As1)"/>
<text class="ts" x="211" y="106" text-anchor="middle" font-size="12" fill="#6b675e">投递</text>
<line class="fl" x1="410" y1="116" x2="492" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As1)"/>
<text class="ts" x="451" y="106" text-anchor="middle" font-size="12" fill="#6b675e">ack</text>
<path class="flc" d="M335 142 V198 H105 V150" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq2Ac1)"/>
<text class="tc" x="220" y="220" text-anchor="middle" font-size="12" fill="#b03a2e">连接断（崩溃或心跳判死）：放回队列，redelivered=true</text>
</svg>
</figure>

下面看崩溃时这套规则的实际表现。

## 崩溃之后：只有一条回来了

5 条编号消息，消费者正经消费：第 1、2 条处理完、ack；第 3 条处理到一半，进程直接 `exit`：

```text
✓ 第 1 条处理完（已 ack）
✓ 第 2 条处理完（已 ack）
!! 第 3 条：处理到一半 —— 进程崩溃（还没来得及 ack）
```

崩溃后队列里剩 3 条（5 减去已 ack 删除的 2 条）。换一个收尾消费者把它们清掉，打印每条的 redelivered 标记：

```text
第 3 条  redelivered=true  ←—— 崩溃窗口里没 ack 的那条，回来了
第 4 条  redelivered=false
第 5 条  redelivered=false
```

只有第 3 条。第 1、2 条 ack 过了，永久删除，回不来；第 4、5 条压根没被投出去，原地躺着，连「重投」都轮不到。**崩溃窗口就是「已投递、未 ack」的那一条**：它被放回队列原来的位置（这里就是队头），收尾消费者领到的顺序还是 3、4、5，一条不乱。

崩溃前后各看一眼队列：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 312" role="img" aria-label="崩溃前后的队列快照：崩溃前 worker 正在处理第 3 条，已投递未 ack，队列里是第 4、5 条；崩溃后 worker 消失，broker 把第 3 条放回队头并标记 redelivered，第 4、5 条原地未动" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq2Ac2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="26" font-size="12" fill="#6b675e">崩溃瞬间：#1、#2 已 ack 删除，#3 在 worker 手里</text>
<rect class="bx-sick" x="40" y="38" width="250" height="48" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="165" y="58" text-anchor="middle" font-size="14" fill="#2b2a26">worker</text>
<text class="tc" x="165" y="76" text-anchor="middle" font-size="12" fill="#b03a2e">正处理 #3：已投递，未 ack</text>
<text class="ts" x="40" y="120" font-size="12" fill="#6b675e">队列（ready）：</text>
<rect class="bx-q" x="150" y="100" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="172" y="123" text-anchor="middle" font-size="14" fill="#2b2a26">#4</text>
<rect class="bx-q" x="202" y="100" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="224" y="123" text-anchor="middle" font-size="14" fill="#2b2a26">#5</text>
<line class="flc" x1="60" y1="150" x2="60" y2="176" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq2Ac2)"/>
<text class="tc" x="74" y="168" font-size="12" fill="#b03a2e">#3 回到队头（redelivered=true）</text>
<text class="ts" x="20" y="200" font-size="12" fill="#6b675e">崩溃 1.5 秒后：broker 收回 #3，放回队列</text>
<rect class="bx-gone" x="40" y="210" width="250" height="40" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="165" y="234" text-anchor="middle" font-size="12" fill="#6b675e">worker 没了（连接断开）</text>
<text class="ts" x="40" y="286" font-size="12" fill="#6b675e">队列（ready）：</text>
<rect class="bx-sick" x="150" y="266" width="44" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="172" y="289" text-anchor="middle" font-size="14" fill="#2b2a26">#3</text>
<rect class="bx-q" x="202" y="266" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="224" y="289" text-anchor="middle" font-size="14" fill="#2b2a26">#4</text>
<rect class="bx-q" x="254" y="266" width="44" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="276" y="289" text-anchor="middle" font-size="14" fill="#2b2a26">#5</text>
</svg>
</figure>

redelivered 这个标记不能拿来当去重的依据。文档明确说它是 best-effort 的提示而非承诺，某些投递路径下会缺失。它可以用来观察（实验里它精确标出了那条），不能用来做业务判断。去重要靠幂等，两节之后讲到。

## 宁可重投：broker 裁决不了的歧义

「只有一条回来」而不是「丢一条」，是 broker 唯一能做的选择。消息投出去之后，broker 和消费者之间只剩一根连接。「消费者崩在处理之前」，该重投；「消费者处理完了、ack 在路上丢了」，重投就是重复。这两种情况在 broker 眼里一模一样，区分它们需要看到消费者内部，broker 做不到。这是分布式系统的老歧义，两将军问题的那一层。

两种情况摆在一起，broker 看到的画面没有区别：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 330" role="img" aria-label="broker 无法区分的两种情况：消费者崩在处理之前，重投是对的；消费者处理完了但 ack 丢在半路，重投就是重复。broker 看到的都是连接断开加一条未 ack，只能选择重投，这就是 at-least-once 的来历" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq2As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq2Ac3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="26" font-size="12" fill="#6b675e">情况一：消费者崩在处理之前</text>
<rect class="bx" x="40" y="38" width="100" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="90" y="63" text-anchor="middle" font-size="14" fill="#2b2a26">broker</text>
<rect class="bx-sick" x="430" y="38" width="150" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="505" y="63" text-anchor="middle" font-size="14" fill="#2b2a26">消费者（崩了）</text>
<line class="fl" x1="140" y1="50" x2="422" y2="50" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As2)"/>
<text class="ts" x="281" y="42" text-anchor="middle" font-size="12" fill="#6b675e">#3 已投出</text>
<line class="flc" x1="422" y1="66" x2="148" y2="66" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq2Ac3)"/>
<path class="flc" d="M279 60 L291 72 M291 60 L279 72" fill="none" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="285" y="90" text-anchor="middle" font-size="12" fill="#6b675e">ack 没能发出</text>
<text class="ts" x="40" y="110" font-size="12" fill="#6b675e">#3 一步没做：重投是对的，补做一遍就齐了</text>
<text class="ts" x="20" y="146" font-size="12" fill="#6b675e">情况二：消费者处理完了，ack 丢在半路</text>
<rect class="bx" x="40" y="158" width="100" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="90" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">broker</text>
<rect class="bx" x="430" y="158" width="150" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="505" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">消费者（做完了 ✓）</text>
<line class="fl" x1="140" y1="170" x2="422" y2="170" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As2)"/>
<text class="ts" x="281" y="162" text-anchor="middle" font-size="12" fill="#6b675e">#3 已投出</text>
<line class="flc" x1="422" y1="186" x2="148" y2="186" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq2Ac3)"/>
<path class="flc" d="M279 180 L291 192 M291 180 L279 192" fill="none" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="285" y="210" text-anchor="middle" font-size="12" fill="#6b675e">ack 丢在半路</text>
<text class="ts" x="40" y="230" font-size="12" fill="#6b675e">#3 已经做过一遍：再投一次，就是重复一遍</text>
<rect class="bx-q" x="40" y="254" width="520" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="300" y="278" text-anchor="middle" font-size="14" fill="#2b2a26">broker 看到的两种情况一模一样：连接断了，#3 没 ack</text>
<text class="tc" x="300" y="298" text-anchor="middle" font-size="12" fill="#b03a2e">区分不了，只能选重投：宁可重复，不可丢失</text>
</svg>
</figure>

MySQL 系列第八篇《提交的那一停》里见过同一道题的另一个答案。那边 kill -9 之后，引擎已 prepare、binlog 已落盘、客户端的 ack 未发出，MySQL 用内部两阶段提交把裁决权收进 binlog：binlog 落盘了就算提交，日志说了算。RabbitMQ 这边裁决不了，于是选了相反的方向：**宁可重复，不可丢失**。歧义交给重投兜底，去重的责任落到消费者头上。

这就是 at-least-once（至少一次）的来历。多做的那一遍没有人批准，它是 broker 在两种无法区分的情况里选了不丢数据所付的代价。

补一个实现细节：RabbitMQ 不靠定时器重投，它把 unacked 一直捏在手里，直到连接断开（消费者崩溃，或心跳超时被判死）才放回队列。换句话说，**hang 死不 ack 的消费者会捏着消息不放**，这个细节在 prefetch 那节还会再出现。

## 幂等：消费端的必修课

代价什么时候兑现？崩溃窗口里的那条回来了，第二次处理如果执行的是「积分 +100」，用户就多拿 100。重复不止来自崩溃：网络抖动让 ack 晚到、连接被心跳判死、生产端没收到确认而重发（生产端这篇不展开），每一件都在制造重复。消费端有三档解法：

1. **天然幂等**：把操作写成结果态，别写增量态。「积分余额设为 1100」天然幂等，「积分 +100」天然不幂等。能 set 就别 add，能 upsert 就别 insert。
2. **去重表**：消息带唯一 ID，消费前先查这个 ID 处理过没有；查、插、业务写入必须放进**同一个数据库事务**，否则去重记录和业务效果又可能一有一没有。
3. **版本/条件更新**：`UPDATE ... WHERE version = n`，重复到来时条件不匹配，天然空转。

还有一个容易忽视的时间维度：重投可能隔很久才来，队列积压半小时、消费者下线一周后复活都有可能。去重记录的生命周期必须盖住消息可能重投的整个时间窗，设 10 分钟过期的去重表等于没设。MySQL 复制那边的 GTID 是同一道题的数据库版：从库重放 binlog 前先看这个 GTID 执行过没有，重放与确认同样要幂等地对上。

## 毒消息：消费者没崩，消息本身病了

崩溃是消费者的事故；另一种事故是消息自带的：payload 格式坏了，谁处理谁抛异常。消费端的本能反应是「失败了就 nack 重回队列再试一次」（`requeue=true`）。对瞬态失败这是对的：网络抖一下、下游 503，重投一次就过。对毒消息，这是死循环。实测：毒消息排在最前，身后 5 条正常消息，消费者带着「失败就 requeue」的逻辑跑 4 秒：

```text
4 秒内正常消息处理数：0
☠ 毒消息第 26100 次被投回来…（永远处理不完）
```

双重灾难：同一条消息 4 秒被空转重投 2.6 万次（真实的毒消息每次要烧些 CPU 才失败，循环会慢一点，但照样无限）；身后 5 条正常消息一条没动，毒消息霸住队头，整个队列就是死的。broker 没有任何错：它不看消息内容，「没 ack 就重投」是它唯一的规则。**区分瞬态失败和永久失败，是消费端的责任**，broker 替你分不了。

这个死循环的样子：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 260" role="img" aria-label="毒消息死循环：毒消息卡在队头，消费者碰到它就抛异常，nack 加 requeue 又把它送回队头，4 秒空转 26100 次，身后 5 条正常消息一条没动" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq2Ac4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<rect class="bx" x="250" y="26" width="160" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="46" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<text class="ts" x="330" y="64" text-anchor="middle" font-size="12" fill="#6b675e">碰到毒消息就抛异常</text>
<path class="flc" d="M95 166 V50 H242" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq2Ac4)"/>
<text class="ts" x="168" y="42" text-anchor="middle" font-size="12" fill="#6b675e">投递</text>
<path class="flc" d="M330 74 V130 H115 V162" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq2Ac4)"/>
<text class="tc" x="225" y="122" text-anchor="middle" font-size="12" fill="#b03a2e">nack(requeue=true)，回队头</text>
<text class="tc" x="424" y="100" font-size="12" fill="#b03a2e">4 秒空转 26,100 次</text>
<text class="ts" x="340" y="160" font-size="12" fill="#6b675e">orders 队列（队头在左）</text>
<rect class="bx-sick" x="60" y="170" width="70" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="95" y="197" text-anchor="middle" font-size="14" fill="#2b2a26">☠ 毒</text>
<rect class="bx-q" x="138" y="170" width="70" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="173" y="197" text-anchor="middle" font-size="14" fill="#2b2a26">正常 1</text>
<rect class="bx-q" x="216" y="170" width="70" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="251" y="197" text-anchor="middle" font-size="14" fill="#2b2a26">正常 2</text>
<rect class="bx-q" x="294" y="170" width="70" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="329" y="197" text-anchor="middle" font-size="14" fill="#2b2a26">正常 3</text>
<rect class="bx-q" x="372" y="170" width="70" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="407" y="197" text-anchor="middle" font-size="14" fill="#2b2a26">正常 4</text>
<rect class="bx-q" x="450" y="170" width="70" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="485" y="197" text-anchor="middle" font-size="14" fill="#2b2a26">正常 5</text>
<text class="ts" x="320" y="242" text-anchor="middle" font-size="12" fill="#6b675e">身后 5 条正常消息一条没动：毒消息霸住队头，整个队列是死的</text>
</svg>
</figure>

（一个计数坑：我第一版只 grep 了日志行数，得到「1494 次」；后来才想起脚本每 20 次才打印一行，真实次数 26,100，差了 17 倍。数日志之前，先弄清日志是怎么打的。）

## 死信：把「处理不了」变成一个地方

永久失败的正确去向是 `nack(requeue=false)`，不回队头。它去哪由队列声明时的 `x-dead-letter-exchange` 参数决定：被拒绝且不重回队列的消息，转发到这个交换机绑定的队列。同一个机制还管另外两种情况：消息 TTL 到期、队列超过 max-length 溢出。死信的原因不止「被拒」。

把上一节的场景摆正（毒消息混在正常消息中间），消费者按「正常就 ack、毒就送死信」处理：

```text
✓ orderId=1..5 处理完成（已 ack）
☠ orderId=666 处理失败（毒消息）→ 不重回队列，送死信交换机

orders.main   0
orders.dead   1
```

死信其实是转存：消息带着 x-death 头去另一个队列等人处理。

```json
[
  {
    "count": 1,
    "reason": "rejected",
    "queue": "orders.main",
    "time": 1789141743,
    "exchange": "",
    "routing-keys": ["orders.main"]
  }
]
```

死因、来自哪个队列、第几次死（同一条反复进死信会累加），人工处理死信时全用得上。Management UI 里点进 orders.dead 还能把消息取出来看正文。

至此 retry 的梯度凑齐了：瞬态失败**立刻重投**（便宜但危险），永久失败**进死信**（安全但没人自动救），中间常用的一档是**延迟重试**：TTL 队列配 DLX 回流，消息在 30 秒、2 分钟、10 分钟的等待队列里逐级退避，全失败才落死信。在 RabbitMQ 里，这套东西是拿参数拼出来的模式。Kafka 连 DLX 都没有，死信要拿 topic 自己搭，到那边再对比。

死信转存和延迟重试的梯度，各一张：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 348" role="img" aria-label="死信转存与延迟重试梯度：nack 且不重回队列的消息经死信交换机转进 orders.dead，x-death 头记录死因和来路；延迟重试用 30 秒、2 分钟、10 分钟的 TTL 队列逐级回流重试，全部失败才落死信" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq2As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="mq2Ac5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">永久失败：nack(requeue=false)，转存死信</text>
<rect class="bx-q" x="30" y="38" width="140" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="100" y="65" text-anchor="middle" font-size="14" fill="#2b2a26">orders.main</text>
<rect class="bx" x="230" y="38" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="295" y="57" text-anchor="middle" font-size="14" fill="#2b2a26">死信交换机</text>
<text class="ts" x="295" y="74" text-anchor="middle" font-size="12" fill="#6b675e">DLX，参数指定</text>
<rect class="bx-sick" x="420" y="38" width="150" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="495" y="65" text-anchor="middle" font-size="14" fill="#2b2a26">orders.dead</text>
<line class="fl" x1="170" y1="60" x2="222" y2="60" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As3)"/>
<text class="ts" x="196" y="50" text-anchor="middle" font-size="12" fill="#6b675e">nack</text>
<line class="fl" x1="360" y1="60" x2="412" y2="60" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As3)"/>
<text class="ts" x="386" y="50" text-anchor="middle" font-size="12" fill="#6b675e">转发</text>
<text class="ts" x="495" y="104" text-anchor="middle" font-size="12" fill="#6b675e">x-death 头记着死因和来路：</text>
<text class="ts" x="495" y="120" text-anchor="middle" font-size="12" fill="#6b675e">reason=rejected，queue=orders.main</text>
<text class="ts" x="20" y="168" font-size="12" fill="#6b675e">常用的中间档：延迟重试，TTL 队列配 DLX 逐级回流</text>
<rect class="bx-q" x="20" y="184" width="110" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="75" y="211" text-anchor="middle" font-size="14" fill="#2b2a26">orders.main</text>
<rect class="bx" x="170" y="184" width="110" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="225" y="203" text-anchor="middle" font-size="14" fill="#2b2a26">等 30 秒</text>
<text class="ts" x="225" y="220" text-anchor="middle" font-size="12" fill="#6b675e">再试一次</text>
<rect class="bx" x="320" y="184" width="110" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="375" y="203" text-anchor="middle" font-size="14" fill="#2b2a26">等 2 分钟</text>
<text class="ts" x="375" y="220" text-anchor="middle" font-size="12" fill="#6b675e">再试一次</text>
<rect class="bx" x="470" y="184" width="110" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="525" y="203" text-anchor="middle" font-size="14" fill="#2b2a26">等 10 分钟</text>
<text class="ts" x="525" y="220" text-anchor="middle" font-size="12" fill="#6b675e">再试一次</text>
<line class="fl" x1="130" y1="206" x2="162" y2="206" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As3)"/>
<line class="fl" x1="280" y1="206" x2="312" y2="206" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As3)"/>
<line class="fl" x1="430" y1="206" x2="462" y2="206" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq2As3)"/>
<path class="fl" d="M225 228 V252 H75 V236" fill="none" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#mq2As3)"/>
<text class="ts" x="150" y="270" text-anchor="middle" font-size="12" fill="#6b675e">到期经 DLX 回流主队列，再试</text>
<path class="flc" d="M525 228 V282" fill="none" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq2Ac5)"/>
<text class="tc" x="515" y="262" text-anchor="end" font-size="12" fill="#b03a2e">三档全失败，才落死信</text>
<rect class="bx-sick" x="450" y="290" width="150" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="525" y="315" text-anchor="middle" font-size="14" fill="#2b2a26">orders.dead</text>
</svg>
</figure>

## prefetch：推模型的节流阀

RabbitMQ 是推模型：broker 主动投递，节奏它定。消费者手里唯一的闸门叫 prefetch：等 ack 期间最多让我攒几条。做个对比：两个消费者一快（10ms/条）一慢（500ms/条），共 20 条消息：

```text
PREFETCH 不限：总耗时 5.03s（快 10 条 / 慢 10 条）
PREFETCH=1  ：总耗时 0.51s（快 19 条 / 慢 1 条）
```

十倍差距。不限流时，20 条在投递瞬间被一口气推光、近似均分：快的消费者 100ms 做完自己的 10 条，然后干等慢的串行磨完 10 × 500ms，分配在投递那一刻就一次性定死了。`prefetch=1` 把分配推迟到「谁空了谁再领」：快的领走 19 次，慢的整个实验只捞到 1 条。快的多干活，总耗时 0.51 秒，基本就是慢消费者那一条 500ms 消息的处理时间。

两种分法放到时间轴上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 312" role="img" aria-label="prefetch 对比时间轴：不限流时 20 条消息在投递瞬间按 10 比 10 定死，快消费者 100ms 做完 10 条后干等，慢消费者磨 5 秒，总耗时 5.03 秒；限到 1 时谁空谁领，快的领走 19 条，慢的只领 1 条，总耗时 0.51 秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="26" font-size="12" fill="#6b675e">prefetch 不限：20 条在投递瞬间分光，10 / 10 定死</text>
<text class="ts" x="30" y="59" font-size="12" fill="#6b675e">快消费者（10ms/条）</text>
<rect class="bar" x="150" y="44" width="9" height="20" fill="#2b2a26"/>
<text class="ts" x="166" y="59" font-size="12" fill="#6b675e">10 条 100ms 做完，之后一直干等</text>
<text class="ts" x="30" y="91" font-size="12" fill="#6b675e">慢消费者（500ms/条）</text>
<rect class="bar" x="150" y="76" width="447" height="20" fill="#2b2a26"/>
<text class="onbar" x="373" y="90" text-anchor="middle" font-size="12" fill="#f6f3ec">10 条 × 500ms = 5 秒，一直在干</text>
<line class="axis" x1="150" y1="112" x2="600" y2="112" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="150" y="128" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="600" y="128" text-anchor="middle" font-size="12" fill="#6b675e">5.03s</text>
<text class="tc" x="375" y="146" text-anchor="middle" font-size="12" fill="#b03a2e">总耗时 5.03s：快的做完了，干等慢的磨完</text>
<text class="ts" x="20" y="178" font-size="12" fill="#6b675e">prefetch=1：同一时刻只飞 1 条，谁空了谁领</text>
<text class="ts" x="30" y="211" font-size="12" fill="#6b675e">快消费者（10ms/条）</text>
<rect class="bar" x="150" y="196" width="168" height="20" fill="#2b2a26"/>
<text class="ts" x="326" y="211" font-size="12" fill="#6b675e">领走 19 条，190ms 做完</text>
<text class="ts" x="30" y="243" font-size="12" fill="#6b675e">慢消费者（500ms/条）</text>
<rect class="bar" x="150" y="228" width="441" height="20" fill="#2b2a26"/>
<text class="onbar" x="370" y="242" text-anchor="middle" font-size="12" fill="#f6f3ec">只领到 1 条（500ms）</text>
<line class="axis" x1="150" y1="264" x2="600" y2="264" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="150" y="280" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="600" y="280" text-anchor="middle" font-size="12" fill="#6b675e">0.51s</text>
<text class="tc" x="375" y="298" text-anchor="middle" font-size="12" fill="#b03a2e">总耗时 0.51s：基本就是慢的那一条的处理时间</text>
</svg>
</figure>

prefetch 的本质是 inflight 上限，和 TCP 接收窗口、连接池大小是同一类机制：管道里同时飞几个，决定吞吐也决定公平。它和这一篇的主线还有一层联动：**prefetch=N 的消费者崩溃，最多 N 条 unacked 一起回队列，也就是最多 N 条重复处理**。节流阀同时划定了重复的爆炸半径：设小了每条消息一个来回，吞吐见顶；设大了负载不均，崩溃时要重放的消息也更多。教具里统一设 1，图个清楚。

（又一个坑：这个对比的 handler 必须串行，一条做完再做下一条。我第一版写成了并发 await，不限流攒下的 10 条被慢消费者并行消化，两种模式总耗时一模一样，对比直接消失。真实消费者多半串行，演示也得照这个来。）

## exactly-once 为什么接近幻觉

把三档语义摆全：at-most-once 绝不重复、可能丢；at-least-once 绝不丢、可能重复。第三档 exactly-once 不丢也不重复，为什么几乎没人真的有？

因为它要求「处理的副作用」和「确认消费」原子地一起发生。可副作用多半落在 MQ 之外的系统：数据库、HTTP 调用。要原子，就得把两边拉进同一笔事务：要么本地消息表这种重型套路，要么像 Kafka 事务那样，把消费位移和处理结果写进同一份日志。做不到这一步，「不丢不重复」就只是把歧义藏起来的说辞。工程上的共识朴素得多：**exactly-once = at-least-once + 幂等做扎实**，客气点的说法叫 effectively-once。Kafka 的事务机制想把这句话做成真的，到事务篇再看。

生产端这篇也没讲：消息怎么保证真进了 broker（confirm、持久化）、broker 自己挂了怎么办，一个字没提。那边的答案叫 acks 和 ISR，属于 Kafka 的地盘，教具篇不展开。

## at-least-once 是怎么凑成的

开头三种意外各有答案：崩了，没 ack 的重投；毒了，进死信；重复了，幂等兜底。合起来就是 at-least-once 的全貌：它不是哪个参数配出来的，而是「宁可重复，不可丢失」这个选择，加上把重复消化掉的一整套纪律。

下一篇换 Kafka，同样的三个场景重演一遍，答案全都不同：kill 消费者，没有 unacked 回队列这回事，接棒的消费者从上次提交的位移继续，连「重投」这个动作都不存在；毒消息没有 DLX 可以指，retry 和死信全要拿 topic 自己拼；积压不叫队列深度，叫 lag。RabbitMQ 把这些语义做成了 broker 的现成功能，Kafka 把它们拆散还给客户端。哪种更好，看过现场再说。

（环境与脚本沿用第一篇的容器，新增的死信检查脚本二十行，逻辑正文里都写了。）
