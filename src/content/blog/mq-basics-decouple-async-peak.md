---
title: 一条同步调用链的崩溃现场：解耦、异步、削峰到底买到了什么
description: 消息队列系列第一篇。下单接口同步调库存、通知、积分三个下游，积分一家病了（2 秒 + 10% 失败），每单 RT 从 30ms 涨到 2029ms。三个下游只病了一个，整个接口为什么跟着垮？本篇用 RabbitMQ 做教具，把「解耦、异步、削峰」三个被写烂的词还原成看得见的实验现象：积分摘出调用链后下单 21ms 收工；kill 掉 worker 下单照样 10/10，消息在队列里等它复活；1000 单 13ms 灌入，单 worker 52 秒、三个 worker 18 秒排空。顺带跑发布订阅与竞争消费、推与拉，最后整理哪些情况下不该用 MQ。
pubDate: 2026-10-06
category: mq
tags: [消息队列, RabbitMQ, 架构]
---

下单接口本来每单 30 毫秒收工。然后积分服务病了：每个请求 2 秒起步，还有 10% 直接返回 500。于是下单接口每单涨到 2029 毫秒，用户点了下单要转圈三秒，偶尔还报错。库存没病，通知没病，下单服务自己也没病，整条链路却垮了，因为下单在同步等待一个病了的下游。

MySQL 系列沿着一条 SQL 沉进过 InnoDB 的存储层，这个系列沿着一条消息走进消息队列。第一篇先不谈消息队列，先把它要治的病用实验造出来。

## 实验一：三个下游只病了一个，整个接口为什么跟着垮

用 Node 写一个最朴素的下单 handler，同步调用三个下游，各自 10ms。三个 10ms 串起来，每单 30ms，健康：

```js
async function placeOrder(order) {
  await callInventory();  // 10ms
  await callNotify();     // 10ms
  await callPoints();     // 10ms —— 病了之后：2000ms + 10% 失败
  return '下单成功';
}
```

然后让积分服务「病」了：每个请求睡 2 秒，10% 概率抛 500。跑十单：

```text
#01 ✓  2022ms
#02 ✗  2031ms  ← 积分服务 500
#03 ✓  2031ms
...
#10 ✓  2031ms
→ 9/10 成功 | 平均 2029ms/单

── 积分健康 × 3 单（对照）──
→ 3/3 成功 | 平均 30ms/单
```

时间都花在哪了，两种情况画出来：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 214" role="img" aria-label="串联调用耗时对比：健康时库存、通知、积分各 10ms，总耗时 30ms；积分病了之后 2000ms 一段把总耗时推到 2029ms" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">健康</text>
<rect class="bx" x="20" y="34" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="85" y="57" text-anchor="middle" font-size="14" fill="#2b2a26">库存 10ms</text>
<rect class="bx" x="150" y="34" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="215" y="57" text-anchor="middle" font-size="14" fill="#2b2a26">通知 10ms</text>
<rect class="bx" x="280" y="34" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="57" text-anchor="middle" font-size="14" fill="#2b2a26">积分 10ms</text>
<path class="fl" d="M20 79 V85 H410 V79" fill="none" stroke="#6b675e" stroke-width="1.6"/>
<text class="ts" x="215" y="104" text-anchor="middle" font-size="12" fill="#6b675e">总耗时 30ms</text>
<text class="tc" x="20" y="126" font-size="12" fill="#b03a2e">积分病了</text>
<rect class="bx" x="20" y="134" width="130" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="85" y="159" text-anchor="middle" font-size="14" fill="#2b2a26">库存 10ms</text>
<rect class="bx" x="150" y="134" width="130" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="215" y="159" text-anchor="middle" font-size="14" fill="#2b2a26">通知 10ms</text>
<rect class="bx-sick" x="280" y="134" width="300" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="430" y="152" text-anchor="middle" font-size="14" fill="#2b2a26">积分 2000ms</text>
<text class="tc" x="430" y="168" text-anchor="middle" font-size="12" fill="#b03a2e">另有 10% 直接 500</text>
<path class="fl" d="M20 182 V188 H580 V182" fill="none" stroke="#6b675e" stroke-width="1.6"/>
<text class="ts" x="300" y="207" text-anchor="middle" font-size="12" fill="#6b675e">总耗时 2029ms，是上一行的 68 倍</text>
</svg>
</figure>

每单 RT 从 30ms 涨到 2029ms，翻了 68 倍，成功率掉到 9/10。下单代码一行没改，库存和通知一点没慢。同步调用是串联的：总耗时等于各环节之和，最慢的那一环决定整条链的快慢。还有看不见的成本：下单服务的连接和线程被 2 秒一个的请求占着，流量一大，本身健康的库存、通知调用也开始排队。**下游的病会顺着同步调用链传染上来**。

真实世界里的「积分服务病了」可以是任何原因：一次慢查询、一次 GC 停顿、依赖的依赖抖了一下。下游迟早会病，要回答的问题是：它病的时候，上游跟不跟着垮。

## 把「现在就要」和「必须做」拆开

回头看那 2029ms 花在哪：库存 10ms、通知 10ms、积分 2000ms。下单接口对积分的真实需求是「这单的积分必须记上」，但没有要求必须现在记上：

- 库存必须现在扣，不然超卖；
- 通知最好现在发，用户在等确认页；
- 积分？晚几秒到账，用户根本感知不到。

「必须做」但不「现在就要」的事，天然适合异步化：下单接口发一条「订单已成立」的消息出去，就返回成功；积分服务自己从队列里取消息，按自己的节奏记账。消息队列（Message Queue，MQ）就是干这件事的中间人：生产者把消息交给它存着，消费者什么时候来取、取多快，生产者不用关心。

把「发消息代替调用」这个动作画出来，前后接线是这样的：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 306" role="img" aria-label="改造前后接线对比：改造前下单串行调库存、通知、积分才返回；改造后下单只调库存和通知即返回，订单已成立变成消息进 points 队列，由还病着的积分 worker 消费" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mqArrSoft1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">改造前：串行调用，等所有人干完才返回</text>
<rect class="bx" x="20" y="38" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="48" y="61" text-anchor="middle" font-size="14" fill="#2b2a26">用户</text>
<rect class="bx" x="118" y="38" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="146" y="61" text-anchor="middle" font-size="14" fill="#2b2a26">下单</text>
<rect class="bx" x="216" y="38" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="244" y="61" text-anchor="middle" font-size="14" fill="#2b2a26">库存</text>
<rect class="bx" x="314" y="38" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="342" y="61" text-anchor="middle" font-size="14" fill="#2b2a26">通知</text>
<rect class="bx-sick" x="412" y="38" width="56" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="440" y="61" text-anchor="middle" font-size="14" fill="#2b2a26">积分</text>
<rect class="bx" x="510" y="38" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="538" y="61" text-anchor="middle" font-size="14" fill="#2b2a26">返回</text>
<line class="fl" x1="76" y1="56" x2="112" y2="56" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="174" y1="56" x2="210" y2="56" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="272" y1="56" x2="308" y2="56" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="370" y1="56" x2="406" y2="56" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="468" y1="56" x2="504" y2="56" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<text class="tc" x="440" y="92" text-anchor="middle" font-size="12" fill="#b03a2e">2000ms 一条，另有 10% 报 500</text>
<text class="ts" x="20" y="146" font-size="12" fill="#6b675e">改造后：积分摘出调用链，换队列接住</text>
<rect class="bx" x="20" y="160" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="48" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">用户</text>
<rect class="bx" x="118" y="160" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="146" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">下单</text>
<rect class="bx" x="216" y="160" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="244" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">库存</text>
<rect class="bx" x="314" y="160" width="56" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="342" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">通知</text>
<rect class="bx" x="412" y="160" width="70" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="447" y="183" text-anchor="middle" font-size="14" fill="#2b2a26">返回 ✓</text>
<line class="fl" x1="76" y1="178" x2="112" y2="178" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="174" y1="178" x2="210" y2="178" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="272" y1="178" x2="308" y2="178" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<line class="fl" x1="370" y1="178" x2="406" y2="178" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<path class="fl" d="M146 196 V250 H274" fill="none" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<text class="ts" x="152" y="242" font-size="12" fill="#6b675e">发「订单已成立」</text>
<text class="ts" x="138" y="226" text-anchor="end" font-size="12" fill="#6b675e">下单是生产者</text>
<rect class="bx-q" x="280" y="228" width="150" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="355" y="247" text-anchor="middle" font-size="14" fill="#2b2a26">points 队列</text>
<rect class="msg" x="317" y="254" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="339" y="254" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="361" y="254" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="383" y="254" width="10" height="10" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="355" y="290" text-anchor="middle" font-size="12" fill="#6b675e">broker 把消息存着</text>
<line class="fl" x1="430" y1="250" x2="466" y2="250" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft1)"/>
<text class="ts" x="448" y="242" text-anchor="middle" font-size="12" fill="#6b675e">拉</text>
<rect class="bx-sick" x="472" y="232" width="120" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="532" y="255" text-anchor="middle" font-size="14" fill="#2b2a26">积分 worker</text>
<text class="tc" x="532" y="290" text-anchor="middle" font-size="12" fill="#b03a2e">消费者，还病着：2000ms 一条</text>
</svg>
</figure>

解耦、异步、削峰这三个被写烂的词，就是这一个动作在三个方向上的收益。下面每个词配一个实验。

## 实验二：异步，RT 与下游脱钩

环境是 RabbitMQ 4.x 的 Docker 容器，仅作教具，复现说明放在文末。把积分摘出调用链：下单只同步调库存和通知，然后往 `points` 队列发一条 JSON 消息。积分 worker 从队列消费，注意它还病着，还是 2 秒一条：

```text
── 异步下单 × 10 单（积分已摘出调用链，改为发消息）──
#01 ✓   21ms  （积分消息已入队，还没做）
#02 ✓   21ms  （积分消息已入队，还没做）
...
→ 10/10 成功 | 平均 21ms/单 | 总耗时 0.2s
```

每单 RT 从 2029ms 回到 **21ms**，而积分 worker 还是 2 秒一条。30ms 变 21ms 来自少了一次同步调用，是小头；大头是**下单的响应时间从此与积分的耗时无关**：进出队列是毫秒级的事，2 秒的病被留在了队列的另一头。

异步的收益是响应时间里只剩下必须同步等的部分。代价也要写全：积分从「下单后 10ms 完成」变成「下单后平均 2 秒、排队长的时候更晚完成」。下单快了，换来的是积分最终一致：它不再和下单同一瞬间完成，只是早晚会完成。对这个场景，划得来。

## 实验三：解耦，下游的生死不再决定上游的生死

异步解决「病了拖慢我」，解耦解决更进一步的问题：病了会不会弄死我。

worker 还在消费（依旧 2 秒一条），先正常下一轮单，10/10 成功。然后 Ctrl-C 把 worker 杀掉，模拟积分服务整个挂了，再下一轮单：

```text
→ 10/10 成功 | 平均 21ms/单 | 总耗时 0.2s
```

下单照样全部成功。那 10 条积分消息在队列里，深度涨到了 10：

```text
$ docker exec rabbitmq rabbitmqctl list_queues name messages
points   10
```

消息在队列里等。worker 重启，2 秒一条、10 条、约 20 秒排空，一条没丢：

```text
[worker-1] ✓ orderId=7（2000ms 处理完，已 ack）
[worker-1] ✓ orderId=8（2000ms 处完，已 ack）
...
points   0
```

（Ctrl-C 的瞬间，worker 手里可能还捏着一条收到但没处理完的消息，它会回到队列。为什么不丢也不乱，是 ack 与重投的机制，第二篇专门拆。）

对比实验一：同样是积分挂掉 20 秒，同步链里下单成功率一路归零；换成队列，下单毫无感觉，积分服务恢复后把积压的消息补做完。「订单已成立」从一次函数调用的参数，变成了积分服务自己来取的一条消息。上游不再需要知道下游是谁、在不在、快不快，它只管把事实发出去。哪天积分要重写、要停机维护、要灰度切流量，下单服务一行代码都不用动。

顺带把发布订阅也跑了，它是解耦的自然延伸。RabbitMQ 在这里多出一个角色：交换机（exchange）。生产者把消息交给交换机，由交换机决定投给哪些绑定了它的队列；这个实验用的类型叫 fanout，收到一条就给每个绑定的队列各复制一份。一个 `order.events` 交换机，库存、积分、通知三家各自持有一个独立队列绑上去。发一个「订单已成立」事件：

```text
[库存] 收到 #1 订单已成立
[积分] 收到 #1 订单已成立
[通知] 收到 #1 订单已成立
...（5 个事件，三家各收 5 条）
```

同一个事实，三家各自消费，互不知晓。下游从「被调用」变成「订阅事实」：加第四个下游（比如风控）就是新开一个队列绑上去，上游零改动。RabbitMQ 也有点对点的玩法：两家消费者共享同一个队列竞争消费，5 条消息 A 拿 2 条、B 拿 3 条，一条只给一家，实验四里多 worker 排空靠的就是它。发布订阅是一份事实多家各自消费，点对点是一堆任务多家分摊；同一个交换机，区别只在队列怎么开。两种接线放一起：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 412" role="img" aria-label="发布订阅与竞争消费拓扑：fanout 交换机把一条事件复制给三个绑定队列，三家各收 5 条；同一个队列的两个消费者把 5 条消息分摊成 2 条和 3 条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mqArrSoft2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="26" font-size="12" fill="#6b675e">发布订阅：一份事实，绑定的每家各得一份</text>
<rect class="bx" x="30" y="104" width="120" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="90" y="127" text-anchor="middle" font-size="14" fill="#2b2a26">order.events</text>
<text class="ts" x="90" y="146" text-anchor="middle" font-size="12" fill="#6b675e">交换机</text>
<rect class="bx-q" x="250" y="44" width="100" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="300" y="67" text-anchor="middle" font-size="14" fill="#2b2a26">库存队列</text>
<rect class="bx-q" x="250" y="112" width="100" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="300" y="135" text-anchor="middle" font-size="14" fill="#2b2a26">积分队列</text>
<rect class="bx-q" x="250" y="180" width="100" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="300" y="203" text-anchor="middle" font-size="14" fill="#2b2a26">通知队列</text>
<rect class="bx" x="430" y="44" width="140" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="500" y="67" text-anchor="middle" font-size="14" fill="#2b2a26">库存服务（收到 5 条）</text>
<rect class="bx" x="430" y="112" width="140" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="500" y="135" text-anchor="middle" font-size="14" fill="#2b2a26">积分服务（收到 5 条）</text>
<rect class="bx" x="430" y="180" width="140" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="500" y="203" text-anchor="middle" font-size="14" fill="#2b2a26">通知服务（收到 5 条）</text>
<line class="fl" x1="150" y1="130" x2="244" y2="62" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<line class="fl" x1="150" y1="130" x2="244" y2="130" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<line class="fl" x1="150" y1="130" x2="244" y2="198" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<line class="fl" x1="350" y1="62" x2="424" y2="62" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<line class="fl" x1="350" y1="130" x2="424" y2="130" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<line class="fl" x1="350" y1="198" x2="424" y2="198" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<text class="ts" x="20" y="272" font-size="12" fill="#6b675e">竞争消费：一堆任务，一条消息只给一家</text>
<rect class="bx-q" x="30" y="300" width="170" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="115" y="320" text-anchor="middle" font-size="14" fill="#2b2a26">同一个队列</text>
<rect class="msg" x="66" y="330" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="88" y="330" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="110" y="330" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="132" y="330" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="154" y="330" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="bx" x="330" y="280" width="160" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="410" y="303" text-anchor="middle" font-size="14" fill="#2b2a26">消费者 A · 拿到 2 条</text>
<rect class="bx" x="330" y="356" width="160" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="410" y="379" text-anchor="middle" font-size="14" fill="#2b2a26">消费者 B · 拿到 3 条</text>
<line class="fl" x1="200" y1="324" x2="324" y2="298" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
<line class="fl" x1="200" y1="324" x2="324" y2="374" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mqArrSoft2)"/>
</svg>
</figure>

## 实验四：削峰，把峰值搬进队列

第三种病：下游不病，流量病。秒杀、整点抢券，瞬时一万单，积分服务每秒只能消化 20 单。

先把消费者停掉（这次要看的是队列本身），瞬时灌 1000 单：

```text
── 削峰：1000 单瞬时灌入（此刻没有消费者）──
→ 灌入 1000 条用时 13ms（≈76000 单/秒）
→ 最慢一单的入队等待 0.7ms
```

1000 条消息 13 毫秒全部入队，最慢一单的入队等待 0.7ms，上游没有任何一单被下游的消化速率拖住。Management UI 的 points 队列页上，深度曲线此刻是一根 1000 的尖峰。如果这是同步链，实验一已经演示过后果：第 N 单要等前面所有单的 2 秒，RT 曲线飙升，连接池先爆。

现在开一个 worker（这次病好了，50ms 一条），1000 条用了 52 秒。再开两个 worker，三个共享队列竞争消费：

```text
TRIPLE-DRAIN: 18s split=334/333/333
```

18 秒排空，三个 worker 均分 334/333/333。流量峰值被搬进了队列，摊平成下游消化得起的平均速率：上游照常放行，下游按自己的节奏干活，中间的队列就是那个缓冲。

队列深度从头到尾的样子：13ms 灌进去的 1000 条是一根几乎竖直的尖峰，然后是两种排空斜坡：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 372" role="img" aria-label="队列深度曲线：13ms 灌入 1000 条形成瞬时尖峰，1 个 worker 52 秒排空，3 个 worker 18 秒排空" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="tc" x="70" y="20" font-size="12" fill="#b03a2e">13ms 灌入 1000 条：最左边那根竖直的尖峰</text>
<line class="axis" x1="70" y1="34" x2="70" y2="310" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="310" x2="616" y2="310" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="64" y1="34" x2="70" y2="34" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="64" y1="172" x2="70" y2="172" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="73" y1="310" x2="73" y2="316" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="249" y1="310" x2="249" y2="316" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="583" y1="310" x2="583" y2="316" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="58" y="38" text-anchor="end" font-size="12" fill="#6b675e">1000</text>
<text class="ts" x="58" y="176" text-anchor="end" font-size="12" fill="#6b675e">500</text>
<text class="ts" x="58" y="314" text-anchor="end" font-size="12" fill="#6b675e">0</text>
<text class="ts" transform="rotate(-90 22 172)" x="22" y="172" text-anchor="middle" font-size="12" fill="#6b675e">队列深度（条）</text>
<text class="ts" x="73" y="332" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<text class="ts" x="249" y="332" text-anchor="middle" font-size="12" fill="#6b675e">18s</text>
<text class="ts" x="583" y="332" text-anchor="middle" font-size="12" fill="#6b675e">52s</text>
<line class="grid" x1="249" y1="260" x2="249" y2="310" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<line class="grid" x1="583" y1="260" x2="583" y2="310" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<line class="spine" x1="73" y1="310" x2="73" y2="34" stroke="#b03a2e" stroke-width="3.5"/>
<line class="curve-s" x1="73" y1="34" x2="583" y2="310" stroke="#6b675e" stroke-width="2"/>
<line class="curve-k" x1="73" y1="34" x2="249" y2="310" stroke="#2b2a26" stroke-width="2.2"/>
<line class="curve-s" x1="150" y1="352" x2="180" y2="352" stroke="#6b675e" stroke-width="2"/>
<text class="ts" x="188" y="356" font-size="12" fill="#6b675e">1 个 worker · 52 秒排空</text>
<line class="curve-k" x1="382" y1="352" x2="412" y2="352" stroke="#2b2a26" stroke-width="2.2"/>
<text class="t" x="420" y="356" font-size="14" fill="#2b2a26">3 个 worker · 18 秒排空</text>
</svg>
</figure>

实验四还暴露了一个性质：同一个队列的多个消费者是竞争关系（点对点），所以加 worker 能横向扩。52 秒到 18 秒不是严格的三倍速（有调度和衔接开销），但方向明确：消化速率不够就加消费者，上游无感。

还有一个容易忽视的事实：削掉的峰值没有消失，只是在排队。排在第 1000 位的消息，被处理时已是 18 秒之后（单 worker 是 52 秒）。下游限速 20 单/秒的话，一万单的峰值注定要 500 秒才能消化完。MQ 改变不了这个除法，它做到的是不把这 500 秒摊进用户的响应时间。

## 推与拉

还有一个没展开的机制：消息怎么从队列到消费者。RabbitMQ 用推：broker 主动把消息送进消费者的回调，节奏由 broker 定，消费者唯一的阀门是 prefetch（等 ack 期间最多推给我几条，第二篇细讲）。Kafka 反过来，用拉：消费者自己 poll，自己定节奏，读到哪自己记（位移）。推的好处是实时、省轮询；拉的好处是消费者按自己的能力取、批量拉取摊薄开销，进度这个概念也随之显式化。两家的分歧先记着，到 Kafka 第一篇现场对照。那篇里「队列」的行为也会大变：消息不再被消费掉，消费只是推进一个位移，删除按时间或大小截断。

两种送法画出来：

<figure class="mq-fig" data-pagefind-ignore>
<svg viewBox="0 0 640 280" role="img" aria-label="推与拉对比：RabbitMQ 由 broker 主动把消息推给消费者，Kafka 由消费者主动 poll 拉取消息" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mqArrInk1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-i" d="M0 0 L8 4 L0 8 Z" fill="#2b2a26"/></marker>
</defs>
<text class="ts" x="20" y="26" font-size="12" fill="#6b675e">推（RabbitMQ）：节奏在 broker 手里</text>
<rect class="bx-q" x="60" y="48" width="130" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="125" y="67" text-anchor="middle" font-size="14" fill="#2b2a26">队列</text>
<rect class="msg" x="96" y="74" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="120" y="74" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="144" y="74" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="bx" x="430" y="48" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="495" y="75" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<line class="flk" x1="190" y1="70" x2="424" y2="70" stroke="#2b2a26" stroke-width="2" marker-end="url(#mqArrInk1)"/>
<text class="ts" x="307" y="60" text-anchor="middle" font-size="12" fill="#6b675e">broker 主动把消息送进回调</text>
<text class="ts" x="307" y="92" text-anchor="middle" font-size="12" fill="#6b675e">唯一的阀门：prefetch</text>
<text class="ts" x="20" y="150" font-size="12" fill="#6b675e">拉（Kafka）：节奏在消费者手里</text>
<rect class="bx-q" x="60" y="170" width="130" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="125" y="190" text-anchor="middle" font-size="14" fill="#2b2a26">分区</text>
<rect class="msg" x="96" y="198" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="120" y="198" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="144" y="198" width="9" height="9" fill="#a29d90" opacity="0.65"/>
<rect class="bx" x="430" y="170" width="130" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="495" y="201" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<line class="flk" x1="190" y1="188" x2="424" y2="188" stroke="#2b2a26" stroke-width="2" marker-end="url(#mqArrInk1)"/>
<text class="ts" x="307" y="180" text-anchor="middle" font-size="12" fill="#6b675e">消息</text>
<line class="flk dash" x1="424" y1="212" x2="196" y2="212" stroke="#2b2a26" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#mqArrInk1)"/>
<text class="ts" x="307" y="244" text-anchor="middle" font-size="12" fill="#6b675e">poll 请求：何时拉、拉多少，消费者自己定</text>
<text class="ts" x="307" y="266" text-anchor="middle" font-size="12" fill="#6b675e">进度（位移）由消费者自己记</text>
</svg>
</figure>

## 什么时候不该用 MQ

解耦、异步、削峰听起来无所不能，但每一项收益都有对应的代价，前三个实验只演示了收益这一半：

1. 会排队、会延迟。异步把下游耗时从 RT 里拿掉，代价是下游的完成时间从「几十毫秒后」变成「队列排空之后」。积分晚几秒无所谓，支付扣款晚几秒、库存扣减晚几秒就是事故。必须当场拿到结果的调用就老老实实同步；异步化之前先确认：这个下游慢几秒，业务真的无感吗？
2. 最终一致，不是立等可取。下单返回成功不等于积分已记录。用户的下一步动作如果依赖这个状态（下单后立刻查积分余额），就会撞上不一致窗口。
3. 消息会丢、会重、会乱序。实验三的「一条没丢」有前提：队列持久化、消息落盘、worker 正确 ack。每个前提都够写一篇，第二篇就拆「没 ack 会怎样」，重复与乱序也在后面处理。
4. 多了一个要养的系统。broker 自己也是个服务：会挂（实验三里「上游无感」的前提是 broker 没挂）、要运维、要监控积压、要容量规划。队列深度也成了新的健康指标：积压 10 条是正常波动，积压一千万条是下游死了没人发现。

三种「看起来该用」其实不该的场景：

- 把 MQ 当 RPC 用：发一条消息，干等消费者处理完回一条。排队延迟和 broker 运维都付了，买到的还是同步调用的语义，不如直接调函数。
- 峰值本来就扛得住：日均流量很平，没有秒杀也没有整点尖峰。削峰是给峰值买保险，保费是排队延迟和最终一致；没有峰值，保险就白买了。
- 分布式单体里塞 MQ：所有服务还是拧在一起发版，中间只是多了个异步环节。故障没有消失，只是从「同步超时」变成「积压告警」，还更难查。

概括一下：MQ 买到的是「下游的病不再传染上游」，付出的是「下游的事从此刻完成变成早晚会完成」。前者是不是刚需，后者业务能不能接受，两个问题都有答案，再决定上不上。

## 环境：两段话的复现说明

教具是 RabbitMQ 4.x（Docker 官方 `rabbitmq:4-management` 镜像），脚本用 Node + amqplib。一条命令起容器，账号密码要自定义：默认的 `guest` 只允许 broker 自己眼中的 localhost 连接，端口映射过来的连接会被拒。

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=kaiven -e RABBITMQ_DEFAULT_PASS=xxx \
  rabbitmq:4-management
```

浏览器打开 `localhost:15672` 登录就是 Management UI。我的第一版脚本在这里栽了个跟头：实验二的 `points` 队列声明成了非持久化队列，RabbitMQ 4.x 直接拒绝，连接当场断开。4.x 起「非持久化 + 非独占」队列默认禁用（`transient_nonexcl_queues` 废弃），修法是把队列声明成 durable，实验数据里消息的落盘语义由此而来。这个默认值说明不同 MQ 对「消息放内存还是磁盘」的答案并不一样。Kafka 连「删除」的定义都不同，到那篇再看。

脚本（下单、worker、灌压）几十行一个，仓库外维护，思路都在正文里，随手就能复刻。

四个实验的收益来自同一个动作：把「订单已成立」从同步调用改成发消息。不改的代价实验一演示过了，30ms 涨到 2029ms、成功率 9/10；改了之后每单 21ms，下游挂掉上游照常，千单尖峰摊成 52 秒或 18 秒的平稳消化。不过这些实验都默认了一件事：消费者处理完就 ack。消息处理到一半消费者崩了，或者来了一条谁处理谁崩的毒消息，队列要靠重投、死信这些规则兜底；同一条消息被投递两遍时，业务还得自己保证不多做一遍。下一篇讲投递语义：at-least-once 为什么是常态，幂等为什么是消费端的必修课。
