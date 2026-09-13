---
title: 一个命令没走完，所有人都在门外：Redis 的线程与事件循环
description: 一条慢 Lua 脚本占住主线程，五条微秒级 GET 却各自等了几秒。本文把隔离实验当作现场，从事件循环、I/O 线程与后台任务一路调查到 SLOWLOG、BGSAVE 和 lazyfree，弄清 Redis“单线程”这个说法究竟指什么。现场搭在一只关闭持久化的 7.4.11 隔离容器里。
pubDate: 2026-09-05
category: redis
tags: [Redis, 数据库]
---

隔离容器里的 Redis，client A 开始执行一段要跑约 2.8 秒的 Lua 脚本；100 毫秒后 client B 发出 `GET k1`，又过 400 毫秒 client C 也发出 `GET k1`。两条微秒级的读命令各自等了两秒上下，最后和 A 几乎在同一毫秒收到回复。

B 和 C 没有读取 A 的键，也没有等待 A 持有的锁。它们只是来到同一扇门前，而门里那条命令还没有走完。

现场是我在隔离的 Redis 容器里故意搭出来的，与任何生产事故无关：持久化关闭，只有一个预先写好的短字符串；A 的脚本除了空转什么也不做，唯一目的就是占住那张执行命令的椅子。实验结束以后，容器和数据一并删除。

“Redis 是单线程的”可以解释这份记录，却只解释了一半。Redis 进程里一直有后台线程，Redis 6.0 以后还可以启用 I/O 线程，RDB 与 AOF 重写又会 `fork` 子进程。真正始终串行的是关键的一段：**键空间命令由主线程执行。**

本文以 Redis 7.4.11 为准，实验使用官方同版本镜像完成。线程名称、函数路径和默认配置都按这个版本描述；历史版本若有差异，会单独说明。

## 现场是我们自己搭的

测试实例只监听本机端口，关闭 RDB 自动保存与 AOF，并把慢日志和延迟监控打开：

```sh
docker run -d --name redis-event-loop \
  -p 127.0.0.1:6390:6379 \
  redis:7.4.11 \
  --save "" \
  --appendonly no \
  --slowlog-log-slower-than 10000 \
  --latency-monitor-threshold 100
```

先写一个普通键：

```text
127.0.0.1:6390> SET k1 value
OK
```

然后校准一段只消耗 CPU、不读写数据的 Lua 循环。五亿次迭代在这台机器上大约需要 2.8 秒：

```text
127.0.0.1:6390> EVAL \
  "local x=0 for i=1,500000000 do x=x+i end return x" 0
(integer) 125000000067108896
```

迭代次数不是可移植的时间单位。换一颗处理器、换一种虚拟化环境，结果都会变化。复现实验时应先从较小次数开始校准，也可以用更短的脚本；这里保留的是它造成的队头形状，不是“2.8 秒”这个常数。

测试没有使用 `DEBUG SLEEP`。Redis 7.x 默认禁用调试命令，刻意打开它反而给实验增加了无关配置。忙循环足以制造一个可见、可重复、只发生在隔离实例中的慢执行段。

## 线程名册：不止一个人，只有一个柜台

即使没有开启 I/O 多线程，Redis 7.4.11 进程也不只有一个线程。后台 I/O，也就是源码里的 bio，固定有三类工人：

- 后台关闭文件描述符；
- 为 AOF 执行后台 `fsync`；
- 释放交给 lazyfree 的对象。

若配置 `io-threads 4`，还会多出三个 I/O 工作线程——编号 0 由主线程自己承担，所以总共不是额外增加四个。

因此，“Redis 只有一个线程”这句话不够准确。更准确的版本是：Redis 有多个线程和子进程协助工作，但普通数据命令的检查与执行，仍由主线程串行完成。

后台线程之所以能并行，是因为它们接手的工作已经被划出关键数据路径。lazyfree 可以释放一份已经从键空间摘下的对象，AOF 线程可以把此前写出的数据刷到磁盘；它们不能和主线程同时执行两条会修改同一个数据库的命令。

这张分工表是全文的地基：多线程存在，不等于命令并行。

## 事件循环不是后台服务，它就是主线程的日程表

Redis 的事件循环实现在 `ae.c`。`aeMain()` 不断调用 `aeProcessEvents()`，一轮大致经历：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 298" role="img" aria-label="ae 事件循环的环形日程：beforeSleep 收尾后进入 epoll 等待就绪事件，醒来经过 afterSleep，处理可读可写的文件事件（命令执行就发生在这段），再处理到期的时间事件 serverCron，然后进入下一轮；整个环由主线程一个人走完" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red1As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">aeProcessEvents() 的一轮：五站环形，单人走完</text>
<rect class="bx" x="270" y="36" width="150" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="52" text-anchor="middle" font-size="12" fill="#2b2a26">beforeSleep</text>
<text class="ts" x="345" y="68" text-anchor="middle" font-size="10" fill="#6b675e">发出回复、写 AOF</text>
<rect class="bx-q" x="462" y="100" width="170" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="547" y="118" text-anchor="middle" font-size="12" fill="#2b2a26">epoll 等待就绪</text>
<text class="ts" x="547" y="136" text-anchor="middle" font-size="10" fill="#6b675e">收一份就绪 fd 名单</text>
<rect class="bx" x="450" y="204" width="140" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="520" y="226" text-anchor="middle" font-size="12" fill="#2b2a26">afterSleep</text>
<rect class="bx-q" x="150" y="200" width="190" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="245" y="218" text-anchor="middle" font-size="12" fill="#2b2a26">处理文件事件</text>
<text class="tc" x="245" y="236" text-anchor="middle" font-size="10" fill="#b03a2e">命令执行发生在这段</text>
<rect class="bx" x="30" y="100" width="180" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="120" y="118" text-anchor="middle" font-size="12" fill="#2b2a26">处理时间事件</text>
<text class="ts" x="120" y="136" text-anchor="middle" font-size="10" fill="#6b675e">serverCron：过期、统计、复制</text>
<line class="fl" x1="420" y1="62" x2="470" y2="96" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As1)"/>
<line class="fl" x1="555" y1="144" x2="535" y2="200" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As1)"/>
<line class="fl" x1="450" y1="222" x2="344" y2="222" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As1)"/>
<line class="fl" x1="160" y1="200" x2="128" y2="152" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As1)"/>
<line class="fl" x1="200" y1="100" x2="266" y2="70" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As1)"/>
<text class="ts" x="345" y="150" text-anchor="middle" font-size="12" fill="#6b675e">事件循环</text>
<text class="ts" x="345" y="168" text-anchor="middle" font-size="12" fill="#6b675e">就是主线程本人</text>
<text class="ts" x="20" y="284" font-size="12" fill="#6b675e">环上没有并行车道：每一站都由主线程亲自走完，才轮到下一站</text>
</svg>
</figure>

在 Linux 上，底层通常是 epoll。它能同时观察大量连接，告诉 Redis 哪些 socket 已经可读、哪些已经可写。但 epoll 只交一份就绪名单，不替 Redis 执行名单里的命令。

Redis 的时间事件也不等于另一个定时线程。7.4.11 中真正注册到 ae 循环的时间事件是 `serverCron`；它运行在同一个主线程上，默认 `hz` 为 10，并可根据客户端数量动态提高频率。过期篇讲过的主动过期，以及统计更新、复制维护等周期工作，都要在这份日程里取得执行机会。

文件事件不是并行处理，时间事件也不能抢占正在执行的回调。一条命令若在主线程里跑了两秒，这两秒内，下一轮事件循环不会凭空开始。

**事件循环不是站在主线程旁边指挥交通的人，它就是主线程本人。**

## 一条 GET 要过几道门

从客户端发出 `GET k1` 到收到回复，主要路径可以压缩成七步：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="一条 GET 的七步梯子：内核收下 TCP 数据，epoll 报告可读，readQueryFromClient 读取输入，processInputBuffer 解析 RESP，processCommand 完成认证 ACL 淘汰等检查，call 调用命令实现真正碰键空间，addReply 组装回复再由 writeToClient 写回" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red1As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">从发出 GET k1 到收到回复的七道门</text>
<line class="fl" x1="70" y1="40" x2="70" y2="196" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As2)"/>
<rect class="bx" x="90" y="36" width="420" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="50" font-size="11" fill="#6b675e">① 内核收下 TCP 数据</text>
<rect class="bx" x="90" y="58" width="420" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="72" font-size="11" fill="#6b675e">② epoll 报告连接可读</text>
<rect class="bx" x="90" y="80" width="420" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="94" font-size="11" fill="#6b675e">③ readQueryFromClient 读取输入</text>
<rect class="bx" x="90" y="102" width="420" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="116" font-size="11" fill="#6b675e">④ processInputBuffer 解析 RESP</text>
<rect class="bx" x="90" y="124" width="420" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="138" font-size="11" fill="#6b675e">⑤ processCommand：认证、ACL、淘汰、忙脚本……一排检查</text>
<rect class="bx-sick" x="90" y="146" width="420" height="20" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="100" y="160" font-size="11" fill="#b03a2e">⑥ call：调用命令实现，真正碰键空间的一段</text>
<rect class="bx" x="90" y="168" width="420" height="20" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="100" y="182" font-size="11" fill="#6b675e">⑦ addReply 组装回复，writeToClient 写回</text>
<text class="ts" x="530" y="50" font-size="10" fill="#6b675e">内核与 epoll</text>
<text class="ts" x="530" y="116" font-size="10" fill="#6b675e">主线程</text>
<text class="tc" x="530" y="160" font-size="10" fill="#b03a2e">最不能并行</text>
<text class="ts" x="20" y="212" font-size="12" fill="#6b675e">SLOWLOG 计时的只有第 ⑥ 段：门外排队的时长不进日志</text>
</svg>
</figure>

`processCommand()` 远不只是查一张命令表。认证、ACL、Cluster 重定向、内存淘汰、只读副本限制、持久化错误、加载状态和忙脚本检查，都可能在真正执行前发生。通过检查以后，`call()` 才同步调用命令实现。

`GET` 的返回值通常也不会当场直接写进 socket。`addReply*()` 先把它放入客户端输出缓冲区；本轮结束前的 `beforeSleep()` 或后续可写事件，再由 `writeToClient()` 发出。为避免一个巨大回复长期占住写路径，Redis 对单个客户端每轮写出量还有预算限制。

所以“一条命令”并不是从 socket 读到 socket 写的一次原子系统调用。它经过收包、解析、检查、执行、组装与回写。**其中真正碰键空间、也最不能并行的，是中间的命令执行段。**

## epoll 能同时看见，不等于 Redis 能同时办理

I/O 多路复用解决的是“怎样用少量线程等很多连接”，不解决“怎样同时执行很多命令”。

假设一万个客户端都保持长连接。Redis 不必为每个连接分配一个阻塞线程；epoll 会在状态变化时批量报告就绪 fd。这让“等待”很便宜，也让 Redis 可以快速轮转大量短命令。

但若三个客户端同时有完整命令到达，主线程仍要按某个顺序处理：

```text
client A: 查找、执行、生成回复
client B: 查找、执行、生成回复
client C: 查找、执行、生成回复
```

通常每条命令都很短，队列快得几乎看不见，于是串行执行呈现出高并发效果。一旦 A 执行的是遍历整个键空间的 `KEYS *`、复杂 `SORT`、大集合聚合、长 Lua 脚本，或者同步释放一个巨型对象，B 和 C 的等待就显形了。

高并发来自高效轮转，不来自键空间命令同时运行。

## 原子性，是排队换来的

串行并不只有代价。Redis 的许多命令之所以天然原子，正是因为执行期间没有另一条普通命令插进来。

```text
INCR counter
```

读取旧值、加一、写回，可以作为一个完整命令走完。Lua 脚本和 `MULTI/EXEC` 也利用同一事实：脚本里的若干 `redis.call()`，或 `EXEC` 中排队的命令，会在一个执行单元中连续完成，不让其他客户端穿插修改数据。

这让数据结构实现免去了大量细粒度锁，也让命令语义容易推理。但原子性的另一面是独占：不被别人插队，等于自己结束以前别人不能进来。

`EXEC` 并不会把十条重命令变轻。源码里它仍是在一个循环中逐条调用 `call()`，中间不回到普通事件循环。Lua 也不会因为把逻辑搬进服务器就获得免费算力。原子性和队头阻塞来自同一个机制。

## 五条 GET，在同一毫秒获释

现在回到开头的现场。

连接 A 在约 2.8 秒内执行忙循环。另有五个独立连接，分别在脚本开始后的约 100、500、1000、1500 与 2000 毫秒发出 `GET k1`。本次实验记录如下：

```text
Lua       +0ms 发出       +2798ms 返回
GET #1  +100ms 发出       +2798ms 返回
GET #2  +500ms 发出       +2798ms 返回
GET #3 +1000ms 发出       +2798ms 返回
GET #4 +1500ms 发出       +2798ms 返回
GET #5 +2000ms 发出       +2798ms 返回
```

换成等待时间，是一道整齐的阶梯：

```text
GET #1  等待约 2695ms
GET #2  等待约 2295ms
GET #3  等待约 1795ms
GET #4  等待约 1295ms
GET #5  等待约  795ms
```

五条 `GET` 的服务端执行只需微秒级，却都在 Lua 结束的同一毫秒附近得到回复。越晚到的等待越短，所有人的放行点却相同，这是队头阻塞最清楚的签名。

发出点和放行点摆上同一条时间轴：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="队头阻塞甘特图：EVAL 忙循环从 0 占到 2798 毫秒；五条 GET 分别在 100、500、1000、1500、2000 毫秒发出，各自等待 2695 到 795 毫秒不等，全部在 2798 毫秒的同一放行点获释，形成一道整齐的阶梯" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一张椅子，六个人：发出时刻不同，放行时刻相同</text>
<rect class="bx-sick" x="70" y="44" width="540" height="18" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="340" y="57" text-anchor="middle" font-size="11" fill="#b03a2e">EVAL 忙循环：占住执行席位 2798ms</text>
<rect class="bx" x="89" y="70" width="521" height="16" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="97" y="82" font-size="10" fill="#6b675e">#1 +100ms 发出 · 等 2695ms</text>
<rect class="bx" x="166" y="92" width="444" height="16" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="174" y="104" font-size="10" fill="#6b675e">#2 +500ms 发出 · 等 2295ms</text>
<rect class="bx" x="263" y="114" width="347" height="16" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="271" y="126" font-size="10" fill="#6b675e">#3 +1000ms 发出 · 等 1795ms</text>
<rect class="bx" x="359" y="136" width="251" height="16" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="367" y="148" font-size="10" fill="#6b675e">#4 +1500ms · 等 1295ms</text>
<rect class="bx" x="456" y="158" width="154" height="16" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="464" y="170" font-size="10" fill="#6b675e">#5 +2000ms · 等 795ms</text>
<line class="flk" x1="610" y1="38" x2="610" y2="184" stroke="#2b2a26" stroke-width="2"/>
<text class="tc" x="604" y="34" text-anchor="end" font-size="11" fill="#b03a2e">+2798ms：同一毫秒放行</text>
<line class="axis" x1="70" y1="200" x2="620" y2="200" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="70" y="218" text-anchor="middle" font-size="11" fill="#6b675e">0</text>
<text class="ts" x="205" y="218" text-anchor="middle" font-size="11" fill="#6b675e">700</text>
<text class="ts" x="340" y="218" text-anchor="middle" font-size="11" fill="#6b675e">1400</text>
<text class="ts" x="475" y="218" text-anchor="middle" font-size="11" fill="#6b675e">2100</text>
<text class="ts" x="610" y="218" text-anchor="middle" font-size="11" fill="#6b675e">2800ms</text>
<text class="ts" x="20" y="248" font-size="12" fill="#6b675e">阶梯的形状就是队头阻塞：每条灰杠都是干等，服务端执行只占末尾一瞬</text>
</svg>
</figure>

具体毫秒数由机器和调度决定，不应写进容量承诺。但形状不会变：主线程一旦进入命令实现，普通客户端不能从旁边另开一扇门。

Redis 对长脚本有一项特殊缓解。`busy-reply-threshold` 默认 5000 毫秒；脚本超过阈值后，会周期性调用 `processEventsWhileBlocked()`，让 `SCRIPT KILL`、`SHUTDOWN NOSAVE` 等允许在忙状态执行的命令获得处理机会，同时对大多数其他命令返回 `BUSY`。这不是把脚本迁到后台，更不是到了五秒自动杀掉脚本。超时以前仍然黑屏；超时以后只是开了一扇紧急处置窗口。

普通慢命令如 `KEYS` 不会获得这条特殊路径。

## 被阻塞的客户端，不一定阻塞服务器

`BLPOP` 看起来是另一个反例：客户端可以等待三十秒，Redis 为什么没有停三十秒？

```text
client A> BLPOP empty:list 30
```

因为 `BLPOP` 不会在命令实现里睡眠。Redis 记录“这个客户端正在等某个列表”，把它移出普通命令处理状态，然后继续服务其他连接：

```text
client B> PING
PONG
```

等列表有元素或超时到达，Redis 再把 A 放回待处理队列并生成回复。等待发生在客户端状态上，不是主线程的调用栈里。

这一区别可以压缩成两行：

```text
Lua 忙循环：服务器正在执行，所有客户端等服务器
BLPOP：      客户端被登记为等待，服务器继续执行别人
```

`INFO clients` 的 `blocked_clients` 和 `CLIENT LIST` 中的阻塞标志用于观察后一种状态。它们不能直接回答“主线程此刻是否被一条 CPU 密集命令卡住”，因为真正被慢命令挡在 socket 后面的普通客户端，未必已经进入 Redis 的 blocked-client 数据结构。

**客户端在等，与服务器在等，是两种完全不同的等待。**

## I/O 线程多开的是收发窗口，不是执行柜台

Redis 6.0 引入可选 I/O 线程。7.4.11 中 `io-threads` 默认是 1，也就是不创建额外 I/O 工作者；取值只能在启动时配置，运行中 `CONFIG SET io-threads 4` 会被拒绝，因为它是不可变配置。

写方向上，I/O 线程可以并行调用 `writeToClient()`；若同时开启 `io-threads-do-reads yes`，它们还能读 socket 并解析 RESP。关键边界写在读路径里：I/O 线程一旦解析出完整命令，就把客户端标为待执行，等待主线程接手。它们不调用真正的命令函数，也不修改数据集。

可以画成两条并行车道，最后汇入同一个柜台：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="I/O 线程并行车道：三个 I/O 工作线程各自读包解析 RESP，把完整命令标为待执行，三条车道汇入同一个主线程柜台逐条执行命令；执行席位不随线程数增加" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red1As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">io-threads 4：三条车道并行收发，柜台仍然只有一个</text>
<rect class="bx" x="30" y="50" width="230" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="145" y="72" text-anchor="middle" font-size="11" fill="#6b675e">I/O thread 1 · 读包、解析 RESP</text>
<rect class="bx" x="30" y="100" width="230" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="145" y="122" text-anchor="middle" font-size="11" fill="#6b675e">I/O thread 2 · 读包、解析 RESP</text>
<rect class="bx" x="30" y="150" width="230" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="145" y="172" text-anchor="middle" font-size="11" fill="#6b675e">I/O thread 3 · 读包、解析 RESP</text>
<line class="fl" x1="260" y1="68" x2="416" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As4)"/>
<line class="fl" x1="260" y1="118" x2="416" y2="118" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As4)"/>
<line class="fl" x1="260" y1="168" x2="416" y2="130" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red1As4)"/>
<text class="ts" x="338" y="98" text-anchor="middle" font-size="10" fill="#6b675e">命令解析完，标为待执行</text>
<rect class="bx-sick" x="420" y="88" width="210" height="60" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="525" y="112" text-anchor="middle" font-size="13" fill="#2b2a26">主线程柜台</text>
<text class="ts" x="525" y="132" text-anchor="middle" font-size="11" fill="#6b675e">逐条执行命令，唯一席位</text>
<text class="ts" x="20" y="214" font-size="12" fill="#6b675e">车道再宽，柜台只有一个：执行席位不随线程数增加</text>
<text class="ts" x="20" y="234" font-size="12" fill="#6b675e">写回方向同理：writeToClient 可以并行，命令函数不行</text>
</svg>
</figure>

我用 `io-threads 4` 和 `io-threads-do-reads yes` 重建测试容器，再跑同一段 Lua 与三个 `GET` 探针。结果仍是一道阶梯：三条 `GET` 都在脚本结束附近返回。

这不是 I/O 多线程失效。瓶颈根本不在收包、解析或回包，而在主线程正在执行 Lua。更多收发窗口可以改善网络密集场景的吞吐，不能让 `KEYS`、`SORT` 或 Lua 在第二颗核心上并行执行。

I/O 线程也不是一直忙。待写客户端不足一定数量时，Redis 会退回单线程路径并挂起工作线程，避免调度成本超过收益。官方配置注释因此建议先确认网络 I/O 已经饱和，并为主线程留出核心，而不是把线程数照着 CPU 数量填满。多开窗口以前，先找到堵在哪一道门。

## 一只大集合，DEL 和 UNLINK 给出两条时间线

慢命令不一定在做复杂计算，也可能只是清理内存。

隔离实例里创建两个各含两百万成员的 Set，内存占用各约 92MB。对第一只执行 `DEL`，对第二只执行 `UNLINK`。本次结果：

| 观察项 | `DEL` | `UNLINK` |
| --- | ---: | ---: |
| 命令执行时间 | 约 228ms | 约 22μs |
| 同期 GET | 等到删除结束 | 未见同类阻塞 |
| 对象释放 | 返回前完成 | 后台约 300ms 内逐步完成 |
| `lazyfree_pending_objects` | 0 | 返回后短暂为 1 |

这些数字只描述本次机器。集合编码、成员数量、内存分配器和系统负载都会改变绝对值，但两条路径的职责没有改变。

`DEL` 默认从键空间摘除条目，并在主线程同步释放值。两百万成员意味着大量引用计数和内存释放操作，于是其他连接一同等待。`UNLINK` 也先在主线程把键从数据库移除，却把足够重的值对象交给 bio lazyfree 线程；客户端很快得到回复，内存则在后台稍后下降。

“异步删除”仍有边界。Redis 会估算对象释放成本，当前 lazyfree 阈值是 64；小对象即使走 `UNLINK` 语义，也可能在主线程同步释放，因为排队到后台反而更贵。`DEL` 是否默认采用 lazyfree 还受 `lazyfree-lazy-user-del` 控制，默认关闭。

`UNLINK` 没有消灭释放成本，只把它从主线程移到了另一条时间线上。

两条时间线并排：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="DEL 与 UNLINK 的甘特对照：DEL 在主线程同步释放两百万成员耗约 228 毫秒，同期 GET 等到删除结束；UNLINK 主线程只花约 22 微秒摘键立即回复，值对象交给 bio lazyfree 线程在后台约 300 毫秒内逐步释放，同期 GET 未见阻塞" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一只两百万成员的 Set（约 92MB），两种删法</text>
<text class="t" x="20" y="58" font-size="12" fill="#2b2a26">DEL</text>
<rect class="bx-sick" x="110" y="44" width="228" height="18" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="346" y="58" font-size="11" fill="#b03a2e">主线程同步释放 ≈228ms</text>
<text class="ts" x="110" y="80" font-size="10" fill="#6b675e">同期 GET：等到删除结束才获释</text>
<text class="t" x="20" y="112" font-size="12" fill="#2b2a26">UNLINK</text>
<rect class="bar" x="110" y="100" width="4" height="18" fill="#2b2a26"/>
<text class="ts" x="122" y="114" font-size="11" fill="#6b675e">主线程摘键 ≈22μs，立刻回复</text>
<rect class="bx" x="114" y="126" width="300" height="18" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="122" y="140" font-size="11" fill="#6b675e">bio lazyfree 线程：后台逐步释放 ≈300ms</text>
<text class="ts" x="424" y="140" font-size="10" fill="#6b675e">同期 GET：未见同类阻塞</text>
<line class="axis" x1="110" y1="170" x2="500" y2="170" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="110" y="188" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="210" y="188" text-anchor="middle" font-size="10" fill="#6b675e">100</text>
<text class="ts" x="310" y="188" text-anchor="middle" font-size="10" fill="#6b675e">200</text>
<text class="ts" x="410" y="188" text-anchor="middle" font-size="10" fill="#6b675e">300ms</text>
<text class="ts" x="20" y="214" font-size="12" fill="#6b675e">228ms 里执行席位被删除独占；22μs 之后席位就让给了下一条命令</text>
<text class="ts" x="20" y="232" font-size="12" fill="#6b675e">内存曲线也跟着换时间线：回复先到，占用后降</text>
</svg>
</figure>

## 后台线程能搬走什么，不能搬走什么

bio 的三名工人适合处理可以延后、也不再需要碰活跃键空间的任务。

后台关闭文件不会改变数据库内容；AOF `everysec` 模式可以让 bio 线程执行 `fsync`；lazyfree 接到的对象已经和键空间断开。这些工作都有一个共同点：主线程先完成决定，再把后续劳动移交出去。

AOF 仍有容易说错的边界。默认 `appendfsync everysec` 时，`fsync` 在后台线程，AOF 的 `write(2)` 仍由主线程执行；磁盘或内核回写很慢时，主线程照样可能卡在写入。若配置 `appendfsync always`，连 `fdatasync` 也在主线程执行，每次写命令都要承担同步落盘的代价。

不能搬走的是必须在一致键空间上做出的决定：命令检查、读写数据、内存淘汰、同步删除、脚本与事务执行。把它们随意发给多个线程，锁、版本与冲突处理就会重新进入设计。

单线程模型不是 Redis 没有学会创建线程，而是它选择把关键状态转换留在一条时间线上。

## BGSAVE 的后台，始于一次前台 fork

`BGSAVE` 名字里有“后台”，却不是从第一个 CPU 周期起就与主线程无关。

Redis 先在主线程调用 `fork()`。子进程诞生以后负责遍历内存、编码并写出 RDB，父进程恢复服务。但创建子进程本身需要复制页表和内核元数据；实例越大，`fork` 越可能形成可见停顿。

实验向实例写入约 627MB 数据，触发 `BGSAVE`。本次观察：

```text
latest_fork_usec:14374
RDB 子进程落盘：约 1.6s
```

在最初十几毫秒的 `fork` 窗口内，两个 `GET` 探针都延迟到主线程恢复后返回；落盘开始以后，后续 `GET` 恢复正常。于是“后台保存”应拆成两段：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="BGSAVE 两段泳道：主线程先同步 fork 约 14 毫秒（画幅放大），期间两个 GET 探针被延迟；fork 返回后主线程恢复服务，子进程在另一条泳道上并发写 RDB 约 1.6 秒，此后的 GET 正常" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">BGSAVE 的两段：前台 14ms，后台 1.6s（横轴非线性，fork 段放大）</text>
<text class="t" x="20" y="62" font-size="12" fill="#2b2a26">主线程</text>
<rect class="bx-sick" x="110" y="48" width="60" height="20" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="140" y="62" text-anchor="middle" font-size="10" fill="#b03a2e">fork 14ms</text>
<rect class="bx-q" x="170" y="48" width="440" height="20" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="390" y="62" text-anchor="middle" font-size="10" fill="#6b675e">恢复服务：后续 GET 正常</text>
<text class="t" x="20" y="112" font-size="12" fill="#2b2a26">子进程</text>
<rect class="bx-gone" x="110" y="98" width="60" height="20" rx="2" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="140" y="112" text-anchor="middle" font-size="10" fill="#6b675e">还不存在</text>
<rect class="bx" x="170" y="98" width="440" height="20" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="390" y="112" text-anchor="middle" font-size="10" fill="#6b675e">遍历内存、编码、写 RDB ≈1.6s（与父进程并发）</text>
<line class="flc" x1="140" y1="30" x2="140" y2="136" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3"/>
<text class="tc" x="146" y="90" font-size="10" fill="#b03a2e">窗口内两个 GET 探针被延迟到 fork 返回后</text>
<text class="ts" x="110" y="152" font-size="11" fill="#6b675e">0</text>
<text class="ts" x="170" y="152" font-size="11" fill="#6b675e">14ms</text>
<text class="ts" x="610" y="152" text-anchor="end" font-size="11" fill="#6b675e">≈1.6s</text>
<text class="ts" x="20" y="180" font-size="12" fill="#6b675e">latest_fork_usec 量的是第一段；COW 的账挂在第二段：父进程写越猛，复制页越多</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">实例 627MB 时 fork 用了 14374μs：停顿随实例大小水涨船高</text>
</svg>
</figure>

写时复制又引入第二份成本。子进程存活期间，父进程若修改某个共享内存页，操作系统要复制该页；写流量越大，额外内存与复制开销越高。透明大页还可能放大复制粒度，因此 Redis 7.4 默认尝试禁用 THP，并在延迟诊断中给出相应警告。

`INFO persistence` 的 `latest_fork_usec`、`current_cow_size` 与上次 RDB 的 COW 数据，比一句“BGSAVE 在后台，不阻塞”更接近真实情况。

## SLOWLOG 记的是执行时间，不是排队时间

把慢日志阈值临时设为 0，让所有命令都留下记录，再重跑 Lua 与几个 `GET`：

```text
id   duration         command
8    2747229μs        EVAL local x=0 ...
9          2μs        GET k1
11         0μs        GET k1
```

客户端看到的 `GET` 延迟超过两秒，`SLOWLOG` 却只记 0 到 2 微秒。这不是统计错误。慢日志主要测量 `call()` 中命令实现的执行时间，不包含命令在前面排队的时间，也不等于客户端从写请求到收回复的完整耗时。

它还不包含协议解析、socket 读写、`beforeSleep()` 中的 AOF 写入、`fork` 停顿和过期循环。阻塞型命令有额外统计路径，但不能因此把普通命令的排队时间也算进去。

甚至在 Lua 正忙时，另一个客户端发出的 `SLOWLOG LEN` 自己也会排队。它终于得到执行时，现场可能已经结束；而慢 Lua 的记录要等 `call()` 返回以后才完整写入。

慢日志擅长回答“哪条命令占用了主线程很久”，不擅长回答“某个客户端从网络端到端一共等了多久”。门里办事的时间它记得清楚，门外每个人的等候时间它不登记。

## 四把尺子，不能互相代替

调查 Redis 延迟，至少需要把几类观测放在一起。

`SLOWLOG` 给出具体慢命令；默认阈值是 10000 微秒，也就是 10 毫秒，默认最多保留 128 条。调成 0 可以短时记录所有命令做实验，但在繁忙生产实例上会快速覆盖，也不该长期这样使用。

`INFO commandstats` 汇总每种命令的调用次数、总执行微秒数和平均执行时间。实验中，被阻塞数秒的 `GET` 仍显示平均不到一微秒，因为它统计的也是服务端执行段。

`INFO latencystats` 默认开启命令延迟直方图，给出 p50、p99 与 p99.9。7.4.11 的直方图上限约为一秒，实验中实际约 2.8 秒的 EVAL 在高分位落到约一秒的最高桶；超长命令会被截在顶端，不能从这个值还原真实时长。

`LATENCY LATEST`、`HISTORY` 与 `DOCTOR` 记录 `command`、`fork`、`aof-write`、`expire-cycle` 等不同事件。它需要先设置非零的 `latency-monitor-threshold`，默认 0 表示关闭。一次长 Lua 在实验中留下 `command` 事件，BGSAVE 则分别留下 `fork` 和命令相关事件。

还应有客户端侧延迟。只有客户端或代理知道请求何时发出、回复何时真正到达，也只有它能把排队、网络和回包算在一起。`redis-cli --latency` 可做即时探针，`--intrinsic-latency` 测的则是运行 Redis 那台机器本身的调度抖动，两者也不是同一把尺子。

可以按问题选工具：

| 要回答的问题 | 主要证据 |
| --- | --- |
| 哪条命令执行得久 | `SLOWLOG`、`INFO commandstats` |
| 哪类命令的分位数异常 | `INFO latencystats` |
| 是命令、fork、AOF 还是过期循环产生尖峰 | `LATENCY LATEST/HISTORY/DOCTOR` |
| 哪些客户端被登记为阻塞或输出积压 | `INFO clients`、`CLIENT LIST` |
| 用户实际等了多久 | 客户端、代理与链路指标 |
| 宿主机本身能否稳定调度 | `redis-cli --intrinsic-latency` |

`MONITOR` 能看到实时命令流，却会为每条命令做格式化和复制，并推送给每个监视客户端。观察工具本身也会占用主线程和输出缓冲，不适合作为生产环境的常驻录像机。

一把尺子上的“快”，不能替另一把尺子证明没有等待。

## “单线程”到底指什么

现场记录可以归成五条结论。

Redis 不是只有一个线程：bio、可选 I/O 工作线程和持久化子进程都真实存在，“单线程”若不加限定，会把它们全部抹掉。键空间命令仍由主线程串行执行：I/O 线程可以读包、解析和回包，不能执行命令；Lua、`KEYS`、`SORT`、集合聚合与同步释放大对象，仍会占住唯一执行位置。I/O 多路复用不等于并行执行：epoll 可以一次报告很多连接就绪，却不会替 Redis 同时修改多个数据结构，它让等待连接便宜，不让慢命令消失。阻塞客户端不等于阻塞服务器：`BLPOP` 把客户端登记为等待，主线程继续轮转；忙 Lua 把主线程留在调用栈里，所有普通客户端一起等。后台工作也有前台边界：`UNLINK` 先在主线程摘键，再后台释放；`BGSAVE` 先同步 `fork`，再由子进程写盘；AOF everysec 把 `fsync` 交给 bio，`write` 仍在主线程。每个“后台”都该追问从哪一步开始。

理解这些边界以后，Redis 的快不再是一句“因为单线程所以没有锁”。更完整的说法是：短命令在单一主线程上高效轮转，网络与可延后的工作尽量外移，以简单的一致性模型换取很高吞吐；代价是任何没有被切短、让出或外移的长工作，都会把自己的时长摊给门外所有连接。

门外的人等的是那张唯一的执行席位，与 A 所操作的数据无关。席位空出的瞬间，几条微秒级命令鱼贯而过，于是它们在客户端留下了几秒延迟，在慢日志里却仍只有几微秒。现场是我们自己搭的，也是我们自己拆的；拆除以前，Lua 的执行时间、五条 GET 的放行点、`DEL` 与 `UNLINK` 的两条曲线、`fork` 的十几毫秒，都已经把线程边界写进记录。
