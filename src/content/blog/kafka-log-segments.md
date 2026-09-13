---
title: 追加的纪律：日志段、稀疏索引与按段删除
description: 消息队列系列第四篇。上一篇消息落进了分区拿到 offset，这一篇下到磁盘看它长什么样。kafka-dump-log 翻开二进制：一次 send 的 5 条消息是一个 batch（count=5、crc 校验、producerId -1 预告着幂等生产者）；1.2MB 灌出三段 0/5/22，文件名就是 baseOffset；.index 看着 10MB 实占 0 磁盘块，预分配稀疏文件，滚动时才 truncate 落地；稀疏索引 16 条 entry（offset↔position），查找是二分加短扫，对照 B+ 树的三层随机 I/O，顺序追加连「找」都省了；timeindex 让「把位点拨回昨天 14:00」变成一次索引查询；删除的粒度是整段 unlink 而不是记录，retention 60 秒过期后段还躺在那，因为清理线程 5 分钟才巡一次。MySQL 系列从 B+ 树的随机写讲起，这篇从另一头讲：追加。
pubDate: 2026-10-16
category: mq
tags: [Kafka, 消息队列, 存储]
---

```text
$ kafka-dump-log.sh --files kseg-0/00000000000000000000.log
baseOffset: 0 lastOffset: 4 count: 5 baseSequence: 0 lastSequence: 4
producerId: -1 partitionLeaderEpoch: 0 position: 0
CreateTime: 1789143164710 size: 296 magic: 2
compresscodec: none crc: 4059270002 isvalid: true
```

这几行不是日志正文，是这批消息的批次头（batch header）。上一篇的旅程只走到「落进某个分区、拿到一个 offset」的表层；这一篇下到磁盘，看消息以什么形态存在、怎么被找到、又怎么「被删除」。MySQL 系列第一篇从 B+ 树开始：为了找到一页数据要层层下降、随机 I/O。这篇从反面开始：Kafka 连「找」这个动作都省了，因为日志只追加，队尾永远在文件的末尾。

工具是 Kafka 自带的 `kafka-dump-log`，直接把二进制翻译成人话。实验环境是一个 1MB 滚动的小段 topic（细节在实验笔记里），下面按顺序过一遍挖出来的东西。

## 一、batch：落盘的最小单位

生产者发消息不是一条一条写的。`producer.send` 会在客户端攒批：逗留几毫秒（`linger.ms`），或者攒够一定体积（`batch.size`），就打包发走。实测最直观：一个 `send` 带五条消息，dump 出来是**一行**：

```text
baseOffset: 0 lastOffset: 4 count: 5 ... position: 0 size: 296
compresscodec: none crc: 4059270002 isvalid: true
```

`count: 5`，五条消息挤在同一个 batch 里，共享一个批次头。把上面 dump 出来的那几行逐个字段过一遍，有几个后面会反复用到：

- **baseOffset / lastOffset**：这批消息占的 offset 区间，[0, 4]。区间的存在意味着 offset 的分配单位其实是 batch，leader 给整个 batch 一个起点，区间内的每条顺次编号。
- **position**：这个 batch 在日志**文件**里的字节偏移，这里是 0，因为它是第一条。下一节就用上这个字段。
- **size**：整批 296 字节，含消息体和批次头的全部开销。
- **crc**：整批的校验和，broker 写入时算一遍，消费端读出时再算一遍，对不上就是传输/磁盘损坏；`isvalid: true` 是 dump 工具替你比过之后的结论。binlog 事件同样带 CRC32 校验，日志型存储的标配。
- **producerId: -1**：生产者还没有身份。它变成正整数的那天，幂等生产者就开了，幂等生产者那篇会回到这个 -1。
- **partitionLeaderEpoch: 0**：这批写入时的分区领袖任期。副本篇会重点讲它，此刻只是头里安静的一个字段。
- **compresscodec: none**：这批没压缩。生产者可以在客户端把 batch 整体压缩，broker 原样落盘。注意压缩的单位是 batch 不是消息，这也是攒批的又一个理由。

**消息在磁盘上的真实形态不是一条条记录，而是一批批的压缩包**。这也解释了上一篇灌压实验 20000 条 1.7 秒的一个侧面：攒批不只减少请求次数，还把每条消息的元数据开销摊薄进了批次头。

一个 batch 的结构，画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 226" role="img" aria-label="batch 结构：一个批次头带五条消息记录，头里记着 baseOffset 0、lastOffset 4、count 5、size 296 字节、crc 校验和 producerId -1，offset 在区间内顺次编号" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一次 send 的 5 条消息：磁盘上是同一个 batch，共享一个批次头</text>
<rect class="bx-q" x="40" y="40" width="580" height="112" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx" x="56" y="52" width="150" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="131" y="72" text-anchor="middle" font-size="14" fill="#2b2a26">批次头</text>
<text class="ts" x="131" y="90" text-anchor="middle" font-size="12" fill="#6b675e">baseOffset 0, lastOffset 4</text>
<text class="ts" x="131" y="106" text-anchor="middle" font-size="12" fill="#6b675e">count 5 · size 296B</text>
<text class="ts" x="131" y="122" text-anchor="middle" font-size="12" fill="#6b675e">crc · producerId -1</text>
<rect class="bx" x="222" y="52" width="60" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="252" y="90" text-anchor="middle" font-size="14" fill="#2b2a26">#0</text>
<text class="ts" x="252" y="112" text-anchor="middle" font-size="12" fill="#6b675e">消息</text>
<rect class="bx" x="290" y="52" width="60" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="320" y="90" text-anchor="middle" font-size="14" fill="#2b2a26">#1</text>
<text class="ts" x="320" y="112" text-anchor="middle" font-size="12" fill="#6b675e">消息</text>
<rect class="bx" x="358" y="52" width="60" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="388" y="90" text-anchor="middle" font-size="14" fill="#2b2a26">#2</text>
<text class="ts" x="388" y="112" text-anchor="middle" font-size="12" fill="#6b675e">消息</text>
<rect class="bx" x="426" y="52" width="60" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="456" y="90" text-anchor="middle" font-size="14" fill="#2b2a26">#3</text>
<text class="ts" x="456" y="112" text-anchor="middle" font-size="12" fill="#6b675e">消息</text>
<rect class="bx" x="494" y="52" width="60" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="524" y="90" text-anchor="middle" font-size="14" fill="#2b2a26">#4</text>
<text class="ts" x="524" y="112" text-anchor="middle" font-size="12" fill="#6b675e">消息</text>
<text class="ts" x="330" y="172" text-anchor="middle" font-size="12" fill="#6b675e">count: 5，offset 0–4 在这一个区间里顺次编号</text>
<text class="ts" x="20" y="194" font-size="12" fill="#6b675e">offset 的分配单位是 batch：leader 给整批一个起点，区间内每条顺次编号</text>
<text class="ts" x="20" y="212" font-size="12" fill="#6b675e">压缩的单位也是 batch：compresscodec 作用在整批，不在单条消息</text>
</svg>
</figure>

## 二、日志段：文件名就是坐标

一批 296 字节不足以看清存储的骨架。往同一个分区灌 1.2MB（20 条 60KB 的大消息，每条独占一个 batch），然后看日志目录：

```text
00000000000000000000.log    296 B
00000000000000000005.log    1,046,018 B
00000000000000000022.log    184,593 B
```

三个文件，三个**日志段（segment）**。规则一目了然：段写满 1MB（我们配的 `segment.bytes`）就滚动，开新段；**文件名是 20 位零填充的数字，就是这个段的起始 offset**。`...005` 段从 offset 5 开始，装到 21；`...022` 从 22 开始，是当前正在写的活跃段（active segment）。

这三个段在日志目录里的样子：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 192" role="img" aria-label="日志段目录视图：三个段文件 000、005、022，文件名就是各自段的起始 offset，前两段已封板只读，022 是正在写的活跃段，每段旁边配 index 和 timeindex 文件" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq4As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">灌进 1.2MB，滚出三个段：文件名就是该段的起始 offset</text>
<rect class="bx" x="40" y="44" width="170" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="125" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">…000.log</text>
<text class="ts" x="125" y="88" text-anchor="middle" font-size="12" fill="#6b675e">offset 0–4</text>
<text class="ts" x="125" y="106" text-anchor="middle" font-size="12" fill="#6b675e">296 B · 已封板只读</text>
<rect class="bx" x="240" y="44" width="170" height="84" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="325" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">…005.log</text>
<text class="ts" x="325" y="88" text-anchor="middle" font-size="12" fill="#6b675e">offset 5–21</text>
<text class="ts" x="325" y="106" text-anchor="middle" font-size="12" fill="#6b675e">1,046,018 B · 已封板只读</text>
<rect class="bx-q" x="440" y="44" width="170" height="84" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="525" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">…022.log</text>
<text class="ts" x="525" y="88" text-anchor="middle" font-size="12" fill="#6b675e">offset 22–24</text>
<text class="tc" x="525" y="106" text-anchor="middle" font-size="12" fill="#b03a2e">活跃段：正在写</text>
<line class="fl" x1="210" y1="86" x2="234" y2="86" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq4As1)"/>
<line class="fl" x1="410" y1="86" x2="434" y2="86" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq4As1)"/>
<text class="ts" x="125" y="146" text-anchor="middle" font-size="12" fill="#6b675e">…000.index / .timeindex</text>
<text class="ts" x="325" y="146" text-anchor="middle" font-size="12" fill="#6b675e">…005.index / .timeindex</text>
<text class="ts" x="525" y="146" text-anchor="middle" font-size="12" fill="#6b675e">…022.index / .timeindex</text>
<text class="ts" x="330" y="176" text-anchor="middle" font-size="12" fill="#6b675e">段写满 segment.bytes=1MB 就滚动开新段；正在写的只有活跃段，旧段只读</text>
</svg>
</figure>

为什么要把一根连续的日志切成段？三个理由，每个都对应后面的一节：

1. **删除需要单位**。retention 到期删的是段文件，不是单条记录，第五节展开。
2. **索引需要粒度**。稀疏索引挂在段上，一段一套，下一节细讲。
3. **写热点隔离**。正在写的只有 active 段，旧段从此只读，可以被页缓存好好利用，也可以整体搬走。

给 MySQL 读者一个对照：InnoDB 的表空间里也有「段」（segment），叶子段、非叶子段、回滚段，段下面是区（extent）、区下面是页。同一个字，两种用途：InnoDB 用段把随机写聚成连续分配，Kafka 用段把顺序写切成可删除的单元。一边为「找到」服务，一边为「删除」服务。

## 三、稀疏索引：二分，然后短扫

消息都在段文件里了，消费时要按 offset 定位，总不能从 position 0 顺序扫到底。答案在每个段旁边的 `.index` 文件，dump 出来：

```text
Dumping kseg-0/00000000000000000005.index
offset: 6  position: 61530
offset: 7  position: 123060
offset: 8  position: 184590
...
offset: 21 position: 984487
```

十六行，每行 8 字节：4 字节 offset，4 字节 position。这就是稀疏索引：不是每条消息都有索引条目。我们配了 `index.interval.bytes=64`（每写 64 字节日志记一条）加 60KB 大消息，所以每条都显影出来；生产默认是 4096 字节，同样这批消息大约每十五条才一行，大部分消息在索引里没有条目。

查找 offset=9 的消息走三步：①定目标段，对文件名二分（`...005` ≤ 9 < `...022`）；②段内对索引二分，找到 `offset: 9 position: 246120`；③从 position 246120 开始顺序扫描，在下一条索引条目覆盖的范围内找到精确位置。第三步是稀疏索引的精髓：允许索引不精确，因为日志本身有序且连续，扫几条消息的代价是常数，换来索引体积缩小一个数量级。

查找的三步，每步一张：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 318" role="img" aria-label="稀疏索引查找 offset=9 的三步：先对段文件名二分定位到 005 段，再对段内 index 二分命中 offset 9 对应 position 246120，最后从该 position 顺序短扫找到精确位置" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq4Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">查 offset=9 的消息</text>
<rect class="bx" x="40" y="48" width="80" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="68" text-anchor="middle" font-size="12" fill="#6b675e">…000</text>
<rect class="bx-q" x="130" y="48" width="80" height="32" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">…005</text>
<rect class="bx" x="220" y="48" width="80" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="260" y="68" text-anchor="middle" font-size="12" fill="#6b675e">…022</text>
<line class="flc" x1="130" y1="86" x2="210" y2="86" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="320" y="68" font-size="12" fill="#6b675e">① 对文件名二分定段：5 ≤ 9 &lt; 22，命中 …005.log</text>
<rect class="bx" x="40" y="112" width="104" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="92" y="128" text-anchor="middle" font-size="12" fill="#6b675e">offset 6</text>
<text class="ts" x="92" y="144" text-anchor="middle" font-size="12" fill="#6b675e">pos 61530</text>
<rect class="bx" x="152" y="112" width="104" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="204" y="128" text-anchor="middle" font-size="12" fill="#6b675e">offset 7</text>
<text class="ts" x="204" y="144" text-anchor="middle" font-size="12" fill="#6b675e">pos 123060</text>
<rect class="bx" x="264" y="112" width="104" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="316" y="128" text-anchor="middle" font-size="12" fill="#6b675e">offset 8</text>
<text class="ts" x="316" y="144" text-anchor="middle" font-size="12" fill="#6b675e">pos 184590</text>
<rect class="bx-q" x="376" y="112" width="104" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="428" y="128" text-anchor="middle" font-size="14" fill="#2b2a26">offset 9</text>
<text class="t" x="428" y="144" text-anchor="middle" font-size="14" fill="#2b2a26">pos 246120</text>
<rect class="bx" x="488" y="112" width="104" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="540" y="128" text-anchor="middle" font-size="12" fill="#6b675e">offset 10</text>
<text class="ts" x="540" y="144" text-anchor="middle" font-size="12" fill="#6b675e">pos 307650</text>
<line class="flc" x1="376" y1="158" x2="480" y2="158" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="40" y="176" font-size="12" fill="#6b675e">② 段内对 .index 二分：命中 offset: 9, position: 246120</text>
<path class="fill-c" d="M185 194 L180 204 L190 204 Z" fill="#b03a2e"/>
<text class="tc" x="185" y="190" text-anchor="middle" font-size="12" fill="#b03a2e">position 246120</text>
<rect class="bx-q" x="40" y="204" width="580" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="msg" x="192" y="218" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="msg" x="228" y="218" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<rect class="fill-c" x="264" y="218" width="10" height="12" fill="#b03a2e"/>
<rect class="msg" x="300" y="218" width="10" height="12" fill="#a29d90" opacity="0.65"/>
<text class="ts" x="318" y="228" font-size="12" fill="#6b675e">offset 9 的精确位置</text>
<line class="flc" x1="190" y1="256" x2="296" y2="256" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#mq4Ac1)"/>
<text class="ts" x="244" y="274" text-anchor="middle" font-size="12" fill="#6b675e">③ 顺序短扫，就几条</text>
<text class="ts" x="40" y="300" font-size="12" fill="#6b675e">索引允许不精确：日志有序且连续，短扫的代价是常数，换来索引体积缩小一个数量级</text>
</svg>
</figure>

拿 B+ 树对照：B+ 树是为随机点查造的多级目录，三层下降三次随机 I/O；稀疏索引是为有序追加造的一级路标，数据物理上已经排好序，索引只需要偶尔立块牌子。MySQL 读者还会想起索引的另一种形态：InnoDB 的 change buffer（缓冲池篇拆过）在为「不必现在找」打时间差，Kafka 干脆取消了「找」。数据结构长成什么样，取决于数据怎么被访问。

两个边角发现顺手记下。其一：`.index` 文件 `ls -la` 显示 10MB，`du` 实占 0 磁盘块，是预分配的稀疏文件，滚动关闭时才 truncate 到实际内容（活跃段索引 10MB、老段索引 0~128B，都见过实物）。这样避免频繁扩文件，也说明了「索引有上限、稀疏是必需品」。其二：段的第一条消息（baseOffset）不占索引条目，position 0 是隐含的起点，条目从第二条开始记，这也是 5 号段索引从 offset 6 开始的原因。

## 四、timeindex：时间旅行

每个段还有第三个文件 `.timeindex`，dump 出来是另一种映射：

```text
Dumping kseg-0/00000000000000000005.timeindex
timestamp: 1789143192614  offset: 6
timestamp: 1789143192622  offset: 7
...
```

timestamp ↔ offset。它服务的查询是「给我昨天 14:00 之后的消息」。官方 CLI 一行验证，按某个历史时刻要位点：

```text
$ kafka-get-offsets.sh --topic kseg --time 1789143192614
kseg:0:6
```

返回 offset 6：那个时刻的第一条消息。时间旅行的工程形态就是它：「把消费组重置到事故发生前」。这在 RabbitMQ 里没有对应物（消息送走就没了，没有历史可回），在 Kafka 里是一次 timeindex 查询加一次位移重置。日志存的不只是消息，是带时间轴的历史。这也解释了上一节稀疏索引为什么可以粗：这段历史反正会按时间窗整段截断，索引没必要比数据活得精细。

这次查询的路径：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 172" role="img" aria-label="时间旅行路径：拿昨天 14:00 的时间戳查 timeindex 得到 offset 6，消费者把位移重置到 6 从那里继续读；已 unlink 的段救不回来" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq4As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">「把消费组重置到昨天 14:00」的工程形态：一次索引查询，加一次位移重置</text>
<rect class="bx" x="30" y="60" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="95" y="86" text-anchor="middle" font-size="14" fill="#2b2a26">昨天 14:00</text>
<line class="fl" x1="160" y1="82" x2="196" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq4As3)"/>
<text class="ts" x="178" y="74" text-anchor="middle" font-size="12" fill="#6b675e">查</text>
<rect class="bx-q" x="202" y="60" width="140" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="272" y="79" text-anchor="middle" font-size="14" fill="#2b2a26">.timeindex</text>
<text class="ts" x="272" y="95" text-anchor="middle" font-size="12" fill="#6b675e">timestamp ↔ offset</text>
<line class="fl" x1="342" y1="82" x2="378" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq4As3)"/>
<text class="ts" x="360" y="74" text-anchor="middle" font-size="12" fill="#6b675e">得到</text>
<rect class="bx" x="384" y="60" width="100" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="434" y="86" text-anchor="middle" font-size="14" fill="#2b2a26">offset 6</text>
<line class="fl" x1="484" y1="82" x2="520" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq4As3)"/>
<text class="ts" x="502" y="74" text-anchor="middle" font-size="12" fill="#6b675e">重置</text>
<rect class="bx" x="526" y="60" width="110" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="581" y="79" text-anchor="middle" font-size="14" fill="#2b2a26">消费者</text>
<text class="ts" x="581" y="95" text-anchor="middle" font-size="12" fill="#6b675e">从 6 继续读</text>
<text class="ts" x="330" y="136" text-anchor="middle" font-size="12" fill="#6b675e">时间旅行只在保留期内有效：被 unlink 的段，timeindex 也救不回来</text>
<text class="ts" x="330" y="158" text-anchor="middle" font-size="12" fill="#6b675e">RabbitMQ 里没有对应物：消息送走就没了，没有历史可回</text>
</svg>
</figure>

## 五、删除：按段，而且不着急

retention 配了 60 秒。灌完消息等 60 秒、80 秒、100 秒，段文件一动不动。过期和删除是两件事，中间隔着一个周期任务：broker 的清理线程默认每 5 分钟（`log.retention.check.interval.ms`）巡一遍日志目录，发现段的整体时间戳过了保留期，才把它标记删除：改名 `.deleted`，再等一个删除延迟（默认 60 秒），才真正 unlink。60 秒的 retention 撞上 5 分钟的巡逻周期，具体什么时候删由巡逻决定。这个设计是故意的：删除要和读写竞争磁盘 IO，Kafka 把它安排成不慌不忙的后台任务。

这条延迟画在时间轴上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="删除时间线：retention 60 秒到期时段文件不动，清理线程每 5 分钟巡一遍，发现过期才改名 .deleted，再等 60 秒删除延迟才真正 unlink，earliest 从 0 跳到 25" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="mq4As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">retention 60 秒，删除却不准时：过期和删除是两件事</text>
<line class="fl" x1="40" y1="120" x2="612" y2="120" stroke="#6b675e" stroke-width="1.6" marker-end="url(#mq4As2)"/>
<line class="axis" x1="80" y1="112" x2="80" y2="128" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="100" text-anchor="middle" font-size="12" fill="#6b675e">灌完，三个段</text>
<text class="ts" x="80" y="146" text-anchor="middle" font-size="12" fill="#6b675e">t=0</text>
<line class="flc" x1="220" y1="112" x2="220" y2="128" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="220" y="100" text-anchor="middle" font-size="12" fill="#b03a2e">retention 60s 到期</text>
<text class="ts" x="220" y="146" text-anchor="middle" font-size="12" fill="#6b675e">段还躺着，一动不动</text>
<line class="axis" x1="380" y1="112" x2="380" y2="128" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="380" y="100" text-anchor="middle" font-size="12" fill="#6b675e">清理线程巡到了</text>
<text class="ts" x="380" y="146" text-anchor="middle" font-size="12" fill="#6b675e">改名 .deleted</text>
<line class="axis" x1="520" y1="112" x2="520" y2="128" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="520" y="100" text-anchor="middle" font-size="12" fill="#6b675e">再等 60 秒删除延迟</text>
<text class="tc" x="520" y="146" text-anchor="middle" font-size="12" fill="#b03a2e">unlink，整段消失</text>
<text class="ts" x="330" y="180" text-anchor="middle" font-size="12" fill="#6b675e">清理线程 5 分钟才巡一遍：什么时候真删，由巡逻决定，不由 retention 决定</text>
<text class="ts" x="330" y="200" text-anchor="middle" font-size="12" fill="#6b675e">消费者能感知的全部变化：earliest 从 0 跳到 25</text>
</svg>
</figure>

再看删除的单位。等清理周期过去（实测等了 400 秒）：

```text
$ ls kseg-0/
00000000000000000025.log   0 B     ← 只剩它：滚动产生的新活跃段

$ kafka-get-offsets.sh --topic kseg --time earliest
kseg:0:25                          ← earliest 从 0 跳到 25

$ kafka-get-offsets.sh --topic kseg --time 1789143192614
（空）                              ← 那段历史已经不存在了
```

`...000`、`...005`、`...022` 三个段连同索引整体消失。earliest 跳到 25 是消费者能感知到的全部变化：试图从更早的 offset 读，会收到越界错误而不是数据。最后那个空返回说明：时间旅行只在保留期内有效，timeindex 再精妙也救不回已经被 unlink 的段，能重放多久的历史由 retention 配置决定。

没有「删除 offset 7 那条消息」这回事：记录级删除在日志模型里不存在，删除的粒度是文件。这也解释了上一篇留下的一个问题：为什么毒消息不能从队列里摘掉，只能抄送进 DLQ topic？因为「队列里的那条消息」物理上是某个段文件中间的几十个字节，动它等于重写整个段，而日志只追加、不回改。想「删」只有两条路：整段删掉，或者从消费者视角跳过（DLQ 就是制度化的跳过）。

MySQL 读者此刻应该有既视感：binlog 的 purge 也是整文件（`bin.000004` 过期整体删除），redo 在 checkpoint 之外的部分也按块废弃，日志型存储的 GC 单位从来不是记录。B+ 树表才能 `DELETE FROM t WHERE id=7`，因为页内本来就在原地改。删除语义跟着存储结构走，不跟着 SQL 走。

## 六、顺序写省掉了什么

最后把 position 排一排，这列数字很能说明问题：

```text
batch 1  position: 0
batch 2  position: 61530
batch 3  position: 123060
batch 4  position: 184590
...（等差，一路加到底）
```

每个 batch 的起点 = 上一个的起点 + 上一个的 size。没有空洞，没有跳跃，也不用「找」。对比 MySQL 的写路径：一笔 INSERT 要先按 B+ 树找到页（三次随机读）、改页、写 redo，可能还有 change buffer 参与，这些都是为点查和原地改付出的开销，页与 B+ 树篇、缓冲池篇、提交篇分别拆过。Kafka 的写路径只有一句话：**把这一批字节 append 到活跃段末尾**。位置计算是加法，磁头不动，页缓存顺序刷。百万级条/秒的吞吐没有什么魔法，全是访问模式给的。

还有两件事这篇没展开。一是 fsync：`log.flush.interval.messages` 默认无限大，Kafka 默认不等每条消息 fsync，落盘节奏交给 OS 页缓存，持久性靠副本兜底（多台机器同时坏掉的概率，比一台机器掉电小几个量级）。MySQL 读者会想起双 1 的纪律和那篇《提交的那一停》：两个系统对同一块磁盘的掉电风险，给出了完全不同的保险方案。Kafka 敢这么做的底气在副本与 ISR，副本篇展开。二是读老数据走页缓存：活跃段在缓存里热着，老段逐渐被挤到冷的区域，冷热分层没写一行代码就发生了。MySQL 为了这个分级造了一整套 LRU 变体（young/old 子链、中点插入），缓冲池篇拆过，两边对照着读正好。

一条消息的完整履历到这里拼齐了：它属于一个 batch，batch 落在一个段里，段的文件名就是起始 offset，旁边配着稀疏索引和 timeindex，到期时整段删除。但这一切都发生在单个分区里：三段文件、一套索引，都属于同一个分区。

分区自己是从哪来的？上一篇提过一句没展开：分区器对 key 做 murmur2 哈希再对分区数取模。这个除法里埋着下一批问题：分区数怎么定、中途加一个分区会发生什么、同 key 恒落同一分区的承诺在那一刻怎么破。下一篇：分区与键。

（实验环境同上一篇：apache/kafka:4.3.1 单容器，工具 kafka-dump-log 和 kafka-get-offsets 全在镜像里。两个工具坑记一下：4.3 的 dump-log 已经不认 `--index`/`--timeindex` 这些老 flag，直接 `--files xxx.index`，它按文件类型自己认；segment.bytes 的合法下限是 1MB，别像我一样想用 512B 的小段偷懒，被 broker 一口回绝。）
