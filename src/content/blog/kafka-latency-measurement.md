---
title: 别信第一份读数：端到端延迟、p99 与 coordinated omission
description: 消息队列系列第十一篇，收官，把延迟这台仪器本身拆开。端到端是三层时间轴：事件、落盘、消费。默认 CreateTime 的 timestamp 是 producer 客户端的钟，实测与发送时刻差 0.3ms，拿它当落盘时间是假的；换 LogAppendTime 由 broker 打点，同机实测事件到落盘 avg 0.8ms、落盘到消费 1.9ms、端到端 2.7ms，意图十万条每秒的灌流压上来端到端涨 6 倍。平均值说谎有实锤：一轮被百万条积压污染的测量里 avg 是 244ms、p50 是 0、p99 是 3582ms，平均值落在双峰之间的山谷里，谁也不描述。coordinated omission 用一场 2 秒停顿做对照实验：docker pause 冻住分区 leader，闭环发压报 p99=4ms、216 个采样位无声消失，开环报 p99=1844ms、217 条遭殃样本，相差 461 倍，丢掉的位置恰好就是遭殃的那批。官方 perf-test 同场批判：全力档 24570 条每秒和 avg 1797ms 印在同一行，41% 负载 p99 是 84ms、81% 是 160ms、饱和是 2787ms，p50 却从 4ms 只挪到 5ms，尾巴先报警；acks=1 全力是 acks=all 的 2.2 倍；consumer-perf-test 冷读与热读差距被客户端瓶颈遮到只剩百分之二十几，两次热读之间反而差 29%。
pubDate: 2026-11-10
category: mq
tags: [Kafka, 消息队列, 分布式]
---

上一篇结尾说，数据面的骨架拆完了，还剩最后一件事没量：这一路走下来到底多快，端到端延迟怎么测才不骗自己。这一篇是系列的收官，把刀对准读数本身。先给一条消息立三层时间轴，顺手抓出两个假时间戳；再看平均值在双峰分布面前怎么说谎；然后制造一场 2 秒的系统停顿，用闭环和开环两种发压方式去量同一场事故，p99 差出 461 倍；最后把 Kafka 自带的压测工具请上台，看被引用最多的那个数字，怎么在同一行里藏着 2 秒的排队。

舞台还是三个控制器加三个 broker 那套集群，工具全换成打点用的：毫秒级计时的 kafkajs 脚本、docker pause、容器里的官方 perf-test。

## 一、三层时间轴

「端到端延迟」从哪一刻算到哪一刻？一条消息的生命里至少有三个值得打点的时刻：事件发生（业务系统产出这条数据）、broker 落盘（记录追加进日志）、消费到手（消费者的回调拿到它）。三个时刻分属三个进程、三个时钟，怎么对齐是第一道坎。

Kafka 的消息自带一个 timestamp，默认由 `message.timestamp.type=CreateTime` 决定：producer 客户端打的。我拿它和发送时刻的墙钟对了一下，差 0.3ms，就是客户端自己的钟。拿这个字段当「落盘时间」去减事件时间，算出来的是客户端内部两个打点之间的间隔，网络、排队、broker 全被抹掉了。这是个假落盘时间，而且假得很自然，字段名就叫 timestamp，不查配置没人知道它是谁打的。

换成 `LogAppendTime`，timestamp 改由 broker 在追加日志时打，落盘时刻才是真的。代价是丢了真实的事件时间（业务发生时刻只能自己塞进消息体带上）。所以三层时间轴的第一课是时钟选择：CreateTime 是生产者的钟，LogAppendTime 是 broker 的钟，消费打点是消费者的钟，跨钟相减的前提是钟齐（跨机器就得防 NTP 偏差；我的实验室容器和宿主共享内核时钟，可以直接减）。

打点实测。t0 在发送前，t1 在 send 的 ack 回来时（acks=all，这一刻意味着 ISR 全员复制、高水位越过），t2 在消费者 eachMessage 拿到时。单分区 RF=3，每 50ms 一条发 200 条，空闲状态：

```text
生产段 (t0→t1)  avg 3.4ms   p99 5ms   max 19ms
消费段 (t1→t2)  avg -0.2ms  p99 0ms   max 26ms
端到端 (t0→t2)  avg 3.2ms   p99 5ms   max 45ms
```

消费段的平均值是负的。别慌，这不是灵异事件：高水位一推进，数据同时对消费者的长轮询 fetch 和生产者的 ack 可见，两边的回调谁先进事件循环纯看操作系统调度，同机毫秒级的事。这个负号的真正价值是提醒你：**段的边界是观察者划的，不是物理划的**，当读数已经贴近观察方式的噪声底，再往下拆就没有意义了。

LogAppendTime 下的真三层（新建 topic 重测，排除历史数据干扰）：

```text
事件 → 落盘（broker 钟）  avg 0.8ms  p99 2ms
落盘 → 消费              avg 1.9ms  p99 5ms
```

对照上面还有个细节：生产段（到 ack）avg 2.9ms，而事件到落盘只有 0.8ms，差的约 2ms 是 ISR 副本追平、高水位推进、ack 回程。副本篇那句「ack 成功不等于立刻可读」反过来也成立：拿到 ack 的时刻，本来就晚于落盘的时刻，中间隔着一整支队伍的确认。

把四层刻度画在同一根时间轴上（空闲实测的均值，示意不按比例）：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="一条消息的时间轴：t0 事件发生（生产者钟），0.8ms 后 broker 落盘（LogAppendTime，broker 钟），生产段到 ack 回来共 2.9ms（含副本追平与高水位推进），t2 消费到手端到端 3.2ms；消费段实测均值为负 0.2ms" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一条消息、四个刻度、三种钟（空闲档实测均值，示意不按比例）</text>
<line class="axis" x1="60" y1="96" x2="616" y2="96" stroke="#6b675e" stroke-width="1.2"/>
<circle cx="90" cy="96" r="4.5" fill="#2b2a26"/>
<circle cx="250" cy="96" r="4.5" fill="#b03a2e"/>
<circle cx="470" cy="96" r="4.5" fill="#2b2a26"/>
<circle cx="540" cy="96" r="4.5" fill="#2b2a26"/>
<text class="t" x="90" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">t0 事件发生</text>
<text class="ts" x="90" y="82" text-anchor="middle" font-size="11" fill="#6b675e">生产者的钟</text>
<text class="tc" x="250" y="66" text-anchor="middle" font-size="12" fill="#b03a2e">落盘</text>
<text class="ts" x="250" y="82" text-anchor="middle" font-size="11" fill="#6b675e">broker 的钟（LogAppendTime）</text>
<text class="t" x="470" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">ack 回来</text>
<text class="ts" x="470" y="82" text-anchor="middle" font-size="11" fill="#6b675e">HW 已越过</text>
<text class="t" x="548" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">t2 消费到手</text>
<text class="ts" x="548" y="82" text-anchor="middle" font-size="11" fill="#6b675e">消费者的钟</text>
<path class="fl" d="M90 116 v8 M90 120 H250 M250 116 v8" fill="none" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="170" y="136" text-anchor="middle" font-size="11" fill="#6b675e">事件→落盘 0.8ms</text>
<path class="fl" d="M250 144 v8 M250 148 H540 M540 144 v8" fill="none" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="395" y="164" text-anchor="middle" font-size="11" fill="#6b675e">落盘→消费 1.9ms</text>
<path class="flk" d="M90 172 v8 M90 176 H470 M470 172 v8" fill="none" stroke="#2b2a26" stroke-width="1.6"/>
<text class="t" x="280" y="192" text-anchor="middle" font-size="11" fill="#2b2a26">生产段（t0→ack）2.9ms ＝ 落盘 0.8 ＋ 副本追平与 ack 回程 ≈2</text>
<path class="flc" d="M90 200 v8 M90 204 H540 M540 200 v8" fill="none" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="315" y="220" text-anchor="middle" font-size="11" fill="#b03a2e">端到端 e2e 3.2ms</text>
<text class="ts" x="20" y="242" font-size="11" fill="#6b675e">消费段（ack→到手）实测 avg -0.2ms：HW 一推进两边同时可见，谁的回调先进事件循环看操作系统</text>
<text class="ts" x="20" y="259" font-size="11" fill="#6b675e">默认 CreateTime 的 timestamp 打在 t0 旁（客户端钟），拿它当落盘时间，网络和 broker 全被抹掉</text>
</svg>
</figure>

加压之后三层一起变胖。背景灌流的意图速率提到每秒 10 万条（超过集群实测容量，副本篇量过 acks=all 约 6.7 万条/秒），前景同样每 50ms 一条：端到端 avg 18.8ms、p99 45ms、max 95ms，是空闲时的 6 倍。排队不挑段，生产段和消费段一起涨。

## 二、平均值说谎

一轮被事故污染的测量，成了这一节最好的教材。做 LogAppendTime 那轮时，topic 里还压着上一轮灌流留下的约百万条背景消息，测量消息排在积压后面。消费段的读数长这样：

```text
avg 240.8ms   p50 0ms   p90 627ms   p99 3579ms   max 4023ms
```

avg 244ms，这个数字谁也不描述：一半的消息瞬间到手（p50=0），另一半排队排到 3 秒开外。双峰分布里，平均值落在两座峰之间的山谷上，是个不存在的读者读到的不存在的延迟。从此立个规矩：拿到任何延迟数字，先问分布长什么样，再看统计量。

把这轮的分布画出来（按实测量级示意）：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 272" role="img" aria-label="积压污染那轮的延迟分布示意图：左侧一座高瘦的峰，约一百条消息几乎零延迟到手；右侧一片矮而宽的山包，延迟散布到 4 秒；平均值 244ms 的竖线落在两峰之间的山谷里，那里没有任何样本" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">被积压污染那轮的消费段延迟分布：两座峰，一条落在山谷里的平均值</text>
<line class="axis" x1="70" y1="40" x2="70" y2="212" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="212" x2="616" y2="212" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bar" x="84" y="56" width="30" height="156" fill="#2b2a26"/>
<rect class="bar" x="118" y="150" width="14" height="62" fill="#2b2a26"/>
<rect class="bar" x="300" y="192" width="26" height="20" fill="#2b2a26"/>
<rect class="bar" x="332" y="182" width="26" height="30" fill="#2b2a26"/>
<rect class="bar" x="364" y="166" width="26" height="46" fill="#2b2a26"/>
<rect class="bar" x="396" y="152" width="26" height="60" fill="#2b2a26"/>
<rect class="bar" x="428" y="140" width="26" height="72" fill="#2b2a26"/>
<rect class="bar" x="460" y="146" width="26" height="66" fill="#2b2a26"/>
<rect class="bar" x="492" y="160" width="26" height="52" fill="#2b2a26"/>
<rect class="bar" x="524" y="176" width="26" height="36" fill="#2b2a26"/>
<rect class="bar" x="556" y="190" width="26" height="22" fill="#2b2a26"/>
<line class="spine" x1="216" y1="46" x2="216" y2="212" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="5 4"/>
<text class="tc" x="222" y="58" font-size="12" fill="#b03a2e">avg=244ms：山谷里没有任何样本</text>
<text class="ts" x="99" y="46" text-anchor="middle" font-size="11" fill="#6b675e">p50=0</text>
<text class="ts" x="441" y="128" text-anchor="middle" font-size="11" fill="#6b675e">p90=627ms · p99=3579ms · max=4023ms</text>
<text class="ts" x="70" y="232" font-size="11" fill="#6b675e">0</text>
<text class="ts" x="596" y="232" font-size="11" fill="#6b675e">延迟 → 4s</text>
<text class="ts" x="20" y="254" font-size="11" fill="#6b675e">左峰：追平之后到的消息，瞬间到手；右山包：排在积压后面的消息，延迟≈排空时间</text>
</svg>
</figure>

这一轮还白送了一个更重要的结论：**积压是端到端延迟的第一项**。消费速度追得上时，积压秒融，延迟回到毫秒级；一旦落后，每条新消息都排在长队末尾，端到端约等于排空时间，broker 自身再快也没用。旅程篇灌压实验里那个涨到 8600 的 LAG，换个角度就是延迟读数，只是当时没这么叫它。

为什么盯着 p99、p99.9 而不是平均值，还有个结构性原因：扇出放大。一个用户请求在后端调 10 个服务，每个服务的 p99 是 1%，这个请求撞上至少一次慢调用的概率就接近 10%；调 100 个，几乎必中。你的服务对上游是 p99，串进别人的扇出里就成了别人的常态。尾延迟不会待在尾部，它会顺着调用链往上爬。

## 三、消失的样本

现在做这一篇的正题实验。造一场所有人都能感知的系统停顿：单分区 topic，`docker pause` 冻住分区 leader 整 2 秒。在途请求挂起、新请求排队，这是真故障的最小模型（客户端侧注入延迟只能拖慢单个请求，造不出这种全员排队，所以必须停真 broker）。发压节奏 10ms 一条、共 20 秒，应发 2000 个采样位。两种发压方式各跑一遍，停顿都发生在第 5 秒。

闭环：发一条、等 ack、再按节奏发下一条。这是最常见的写法，主流压测工具的线程模型就是这样（一个线程等到响应才发下一个）。读数：

```text
实得样本 1784 / 2000，216 个采样位消失
p50=2ms  p90=3ms  p99=4ms  p99.9=17ms  max=1965ms
超过 100ms 的样本：1 个
```

除了 max，岁月静好。可系统明明停顿了 2 秒。发生了什么：停顿期间，闭环发压器自己也卡住了，它在等那条在途消息的 ack（等了 1965ms），等待期间一条新消息都没发。后面 216 个本该发出去的采样位，从来没有出发，它们的延迟也就从来没进过任何统计。

开环：按钟点发车，不等上一条的 ack，延迟从「意图发出时刻」起算。读数：

```text
实得样本 1975 / 2000
p50=2ms  p90=278ms  p99=1844ms  p99.9=1991ms  max=1998ms
超过 100ms 的样本：217 个，超过 1 秒的：115 个
```

同一场 2 秒停顿：闭环报 p99=4ms，开环报 p99=1844ms，差 461 倍。更说明问题的是两个数字的咬合：闭环丢掉的 216 个采样位，和开环里超过 100ms 的 217 条样本，几乎一一对应。**丢掉的样本，恰好就是遭殃的样本。**

两种发压方式并排摆开，一个圆点代表一个采样位：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 292" role="img" aria-label="同一场 2 秒停顿下两种发压方式的对照：闭环行的点在停顿区整段消失，216 个采样位从未出发，只有停顿开始时那一个 1965ms 的样本留下痕迹，p99 报 4ms；开环行的点铺满全程，停顿区及其后约 217 个样本标成朱砂色，p99 报 1844ms" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">同一场 2 秒停顿，两份成绩单（横轴：发压 20 秒）</text>
<rect class="bx" x="233" y="66" width="49" height="146" fill="#ece9e2" stroke="none" opacity="0.55"/>
<text class="ts" x="257" y="56" text-anchor="middle" font-size="11" fill="#6b675e">docker pause leader 2 秒</text>
<text class="t" x="24" y="104" font-size="12" fill="#2b2a26">闭环</text>
<path d="M110 100 H228" stroke="#2b2a26" stroke-width="5" stroke-dasharray="0 11" stroke-linecap="round" fill="none"/>
<circle cx="232" cy="100" r="4.5" fill="#b03a2e"/>
<path d="M288 100 H600" stroke="#2b2a26" stroke-width="5" stroke-dasharray="0 11" stroke-linecap="round" fill="none"/>
<rect class="bx-gone" x="236" y="90" width="48" height="20" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="298" y="132" font-size="11" fill="#6b675e">216 个采样位从未出发，延迟没人记录</text>
<text class="tc" x="228" y="132" text-anchor="end" font-size="11" fill="#b03a2e">唯一的证据：max=1965ms</text>
<text class="ts" x="600" y="78" text-anchor="end" font-size="12" fill="#6b675e">闭环成绩单：p50=2ms，p99=4ms</text>
<text class="t" x="24" y="184" font-size="12" fill="#2b2a26">开环</text>
<path d="M110 180 H600" stroke="#2b2a26" stroke-width="5" stroke-dasharray="0 11" stroke-linecap="round" fill="none"/>
<path d="M233 180 H295" stroke="#b03a2e" stroke-width="5" stroke-dasharray="0 11" stroke-linecap="round" fill="none"/>
<text class="ts" x="298" y="212" font-size="11" fill="#6b675e">朱砂点：超过 100ms 的 217 条（其中 115 条超过 1 秒），排队全被记下</text>
<text class="tc" x="600" y="158" text-anchor="end" font-size="12" fill="#b03a2e">开环成绩单：p50=2ms，p99=1844ms</text>
<text class="ts" x="110" y="234" font-size="11" fill="#6b675e">0</text>
<text class="ts" x="233" y="234" text-anchor="middle" font-size="11" fill="#6b675e">5s</text>
<text class="ts" x="282" y="234" text-anchor="middle" font-size="11" fill="#6b675e">7s</text>
<text class="ts" x="600" y="234" text-anchor="end" font-size="11" fill="#6b675e">20s</text>
<text class="ts" x="20" y="258" font-size="11" fill="#6b675e">闭环丢的 216 位 ≈ 开环遭殃的 217 条：系统卡住时发压器跟着卡住，最慢的样本整体消失</text>
<text class="ts" x="20" y="278" font-size="11" fill="#6b675e">开环也少了 25 位：解冻瞬间两百个 ack 回调挤爆事件循环，发压器自己也是测量系统的一部分</text>
</svg>
</figure>

这就是 coordinated omission（协同遗漏）：发压器和被测系统耦合，系统慢下来，发压器跟着慢下来，最慢的那批样本从数据里整体消失。它偏偏在系统出状况时发作，也就是说，你的延迟报表恰好在最需要真实数字的时刻撒谎。闭环压测的 p99 好看，不是因为系统好，是因为遭殃的那批请求根本没被发出去，连发声的渠道都没有。

修法两条。其一，发压改开环：按预定时刻表发车，不管上一条回没回。其二，打点按意图时间：计划 t 时刻发的那条，延迟就从 t 起算，哪怕它实际排队到 t+2s 才发出去，HDR Histogram 一类工具的校正思路就是这个。顺带一个诚实的脚注：开环这轮也只拿到 1975/2000，少的 25 个是发压器自己的调度漂移，解冻瞬间两百个 ack 回调挤爆事件循环，setTimeout 都会迟到。发压器也是测量系统的一部分，它的病也要计入读数。

## 四、官方那只压测表

kafka-producer-perf-test 是被引用最多的数字来源。全力档（`--throughput -1`，20 万条 512 字节，3 分区 RF=3）：

```text
200000 records sent, 24570 records/sec (12.00 MB/sec),
1797.11 ms avg latency, 2845.00 ms max latency,
1974 ms 50th, 2635 ms 95th, 2787 ms 99th, 2838 ms 99.9th
```

被人引用的通常是前半行：两万四千条每秒。同一行的后半截写着：平均延迟 1797ms。全力模式把所有消息尽可能快地塞进生产者队列，排在队尾的那条要等将近 2 秒才拿到 ack。这个吞吐数字是**用秒级排队换来的容量上限**，不是任何稳态下的表现，把它和延迟一起读才是一份完整证词。

三档负载排开，是一条教科书的排队拐点曲线：

```text
10k/s（41% 负载）：avg 7.7ms    p50 4ms     p99 84ms
20k/s（81% 负载）：avg 39ms     p50 5ms     p99 160ms
全力  （饱和）  ：avg 1797ms   p50 1974ms  p99 2787ms
```

负载从 41% 加到 81%，p50 只挪了 1ms，avg 已经大了 5 倍、p99 大了 2 倍；越过饱和点，全线起飞。**尾巴总是先报警，p50 最后一个知道。**这是盯 p99/p99.9 的又一个理由，也是容量规划要留水位线的实证依据。

把三档读数画成两条曲线：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 282" role="img" aria-label="排队拐点曲线图：横轴负载，纵轴延迟；p50 曲线在 41% 负载时 4ms、81% 时 5ms，几乎贴地，饱和后陡升到 1974ms；p99 曲线从 84ms 到 160ms 再到 2787ms，一路先报警；平均值三档是 7.7、39、1797ms" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">producer-perf-test 三档负载：p50 贴地装睡，p99 先拉警报（纵轴压缩，以标注数字为准）</text>
<line class="axis" x1="70" y1="44" x2="70" y2="214" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="214" x2="616" y2="214" stroke="#6b675e" stroke-width="1.2"/>
<line class="grid" x1="271" y1="50" x2="271" y2="214" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<line class="grid" x1="467" y1="50" x2="467" y2="214" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<line class="grid" x1="585" y1="50" x2="585" y2="214" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<text class="ts" x="271" y="232" text-anchor="middle" font-size="11" fill="#6b675e">41% 负载</text>
<text class="ts" x="467" y="232" text-anchor="middle" font-size="11" fill="#6b675e">81% 负载</text>
<text class="ts" x="585" y="232" text-anchor="middle" font-size="11" fill="#6b675e">饱和（全力）</text>
<path class="curve-s" d="M70 190 L271 172 L467 148 C 520 128, 552 76, 585 54" fill="none" stroke="#b03a2e" stroke-width="2"/>
<path class="curve-k" d="M70 203 L271 202 L467 200 C 528 197, 556 132, 585 78" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle cx="271" cy="172" r="4" fill="#b03a2e"/>
<circle cx="467" cy="148" r="4" fill="#b03a2e"/>
<circle cx="585" cy="54" r="4" fill="#b03a2e"/>
<circle cx="271" cy="202" r="4" fill="#2b2a26"/>
<circle cx="467" cy="200" r="4" fill="#2b2a26"/>
<circle cx="585" cy="78" r="4" fill="#2b2a26"/>
<text class="tc" x="279" y="170" font-size="11" fill="#b03a2e">p99 84ms</text>
<text class="tc" x="475" y="146" font-size="11" fill="#b03a2e">p99 160ms</text>
<text class="tc" x="577" y="50" text-anchor="end" font-size="11" fill="#b03a2e">p99 2787ms</text>
<text class="ts" x="279" y="212" font-size="11" fill="#6b675e">p50 4ms</text>
<text class="ts" x="475" y="210" font-size="11" fill="#6b675e">p50 5ms</text>
<text class="t" x="577" y="94" text-anchor="end" font-size="11" fill="#2b2a26">p50 1974ms</text>
<line class="curve-k" x1="84" y1="252" x2="112" y2="252" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="118" y="256" font-size="11" fill="#6b675e">p50</text>
<line class="curve-s" x1="164" y1="252" x2="192" y2="252" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="198" y="256" font-size="11" fill="#6b675e">p99</text>
<text class="ts" x="248" y="256" font-size="11" fill="#6b675e">平均值三档：7.7 → 39 → 1797ms</text>
<text class="ts" x="20" y="276" font-size="11" fill="#6b675e">过了 81% 那道膝，队列常驻，每条消息都排进上一条的等待后面：延迟换了一种物理状态</text>
</svg>
</figure>

配置换了就是另一个世界。同一只工具，acks=1 全力档跑出 53691 条/秒，是 acks=all 那轮的 2.2 倍（副本篇三档 23/32/45ms 的同方向放大版，延迟依旧秒级，排队主导）；topic 换成单分区 RF=1，能跑到 77930 条/秒。所以任何吞吐数字的前提是一整串配置：分区数、副本数、acks、消息大小、客户端、批量参数，跨配置的数字互相没有可比性。默认配置也值得扒一遍：源码核实，ProducerPerformance 只设序列化器和 client.id，其余全用 KafkaProducer 默认值，也就是 acks=all、幂等开启、无压缩、随机 payload。「笔记本单机跑出几十万条每秒」的标题，先得交代它改了哪几个默认值。

消费端的另一半用 kafka-consumer-perf-test。写一个 244MB 的 topic（50 万条 512 字节），先热读（刚写完，数据还在页缓存里），再往磁盘 dd 一个 4GB 的文件把页缓存挤掉，冷读，再读一遍：

```text
热读 #1：123.5 MB/s     冷读（驱逐后）：116.4 MB/s     热读 #2：158.9 MB/s
```

两个发现，都不太浪漫。其一，冷热差距最大只有 27%，页缓存效应被遮住了：NVMe 顺序读本来就快，单消费者客户端自己先到瓶颈，仪器成了被测系统的一部分。内核页缓存篇说过 write() 返回了数据还在内存里，这里补上消费端的下半句：读没读中页缓存，读数会漂，但漂移幅度取决于你的瓶颈在盘上还是在客户端。其二，两次热读差了 29%（123.5 对 158.9），同配置同数据同机器。单次运行的读数下不了任何结论，至少跑三轮，看方差再看均值。

三轮读数立成柱子，效应和方差的大小关系一目了然：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 258" role="img" aria-label="三轮 consumer-perf-test 条形图：热读第一轮 123.5 MB/s，驱逐页缓存后冷读 116.4 MB/s，再热读 158.9 MB/s；两次热读之间差 29%，比冷热之间的差距还大" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">同一个 244MB 的 topic 读三轮：方差比效应大</text>
<line class="axis" x1="90" y1="200" x2="600" y2="200" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bar" x="130" y="83" width="76" height="117" fill="#2b2a26"/>
<rect class="bar" x="310" y="90" width="76" height="110" fill="#2b2a26"/>
<rect class="bar" x="490" y="50" width="76" height="150" fill="#2b2a26"/>
<text class="onbar" x="168" y="103" text-anchor="middle" font-size="12" fill="#f6f3ec">123.5</text>
<text class="onbar" x="348" y="110" text-anchor="middle" font-size="12" fill="#f6f3ec">116.4</text>
<text class="onbar" x="528" y="70" text-anchor="middle" font-size="12" fill="#f6f3ec">158.9</text>
<text class="ts" x="168" y="220" text-anchor="middle" font-size="11" fill="#6b675e">热读 #1（刚写完）</text>
<text class="ts" x="348" y="220" text-anchor="middle" font-size="11" fill="#6b675e">冷读（dd 4GB 驱逐后）</text>
<text class="ts" x="528" y="220" text-anchor="middle" font-size="11" fill="#6b675e">热读 #2</text>
<text class="ts" x="100" y="220" text-anchor="end" font-size="11" fill="#6b675e">MB/s</text>
<path class="flc" d="M168 74 v-8 H528 v8" fill="none" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="348" y="58" text-anchor="middle" font-size="11" fill="#b03a2e">同配置的两次热读：差 29%</text>
<text class="ts" x="348" y="86" text-anchor="middle" font-size="11" fill="#6b675e">冷热差 ≤27%</text>
<text class="ts" x="20" y="244" font-size="11" fill="#6b675e">页缓存的效应被客户端瓶颈压扁，反而淹在轮与轮的抖动里：先量方差，再谈效应</text>
</svg>
</figure>

还有个列口径的坑：consumer-perf-test 同时输出 MB.sec 和 fetch.MB.sec，前者按全程均摊（把 rebalance 的 576ms 也算进去），后者只按抓取段，两个数差 30% 到 40%。同一只工具的两个口径，引用哪个是自由，但得知道引用的是哪个。MySQL 系列收官篇拆 performance_schema 的四层事件金字塔时遇到过同类事：仪器本来就是分层的，每层有自己的口径，数字的含义取决于你从哪一层取的。

## 五、每个读数都有坐标系

系列收官，把十一篇串回一条线。旅程篇跟了一条消息的全程，认识了 offset 和 lag；日志段篇拆了段、稀疏索引和按段删除；分区与键篇拆了分区器和顺序性与并行度的交换；顺序篇找到顺序承诺漏风的三处；副本篇拔电源看了 ISR、高水位和那场 unclean 选举；消费者组篇拆了心跳、会话和三种再平衡；位移篇翻开了 __consumer_offsets，发现组的进度也是一条日志；事务篇让重复消失，也标好了 exactly-once 的边界和价钱；这一篇把刀对准了读数自己。

翻来覆去其实是三件事。其一，Kafka 对几乎所有问题的答案都是「再来一条日志」：数据是日志，位移是日志，事务状态是日志，连集群元数据在 KRaft 里也是日志；看懂了追加、段、复制、压实这一套，就看懂了它的全部。其二，所有保证都有旋钮和价钱：acks 三档、min.insync、会话超时、幂等、事务、隔离级别，语义从来是选出来的，默认值只是别人替你选的位置。其三，所有读数都有坐标系：timestamp 用谁的钟、消费者站在 LSO 哪一侧、发压是开环还是闭环、吞吐数字是什么配置下跑的、跑了几轮。坐标系一抽掉，数字就变成修辞。

两个系列的收官选了同一个姿势。MySQL 那边走到最后一篇，拆的是观测系统本身；这边收笔，拆的是延迟读数。先拆产生读数的仪器，再去信读数，顺序不能反。

消息队列系列到这里完结：基础两篇，Kafka 九篇。全部实验的脚本和原始记录都在实验室里存着档，集群的六个容器也没停，哪天想复核文中任何一个数字，拉起来重跑就是。

（实验环境同前几篇的 3+3 集群，kafkajs 2.2.4 打点，容器内 perf-test 与 Java console 工具。四个坑记一下。其一，Node 的 process.hrtime 是开机起的单调钟，Date.now 和 message.timestamp 是墙钟，两种钟混着相减，我读出过 1.79 万亿毫秒的「延迟」，恰好等于本机 uptime，打点变量必须标清钟源。其二，测延迟的 topic 每轮必须重建或带 run id 过滤，往轮积压会整体污染消费段，本文第二节那份双峰数据就是这么来的，因祸得福，但当时并不知道。其三，docker pause 要冻分区 leader 本尊（先 describe 拿 leader），冻结期间 acks=all 的在途请求全体挂起才是想要的剧本；另外发压脚本别用 /tmp 存驱逐文件，tmpfs 吃的是内存。其四，producer-perf-test 的 --producer-props 已弃用（警告原文让你换 --command-property），和消费者组篇那个被静默忽略的 --property 是同一家族，这次好歹还给了一句警告。）
