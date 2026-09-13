---
title: 一套查得快，一套排得顺：zset 里的跳表与第二本字典
description: ZSCORE 走字典，ZRANK 走跳表，两条路在十万成员下同为 44 微秒上下。本文拆开 skiplist 编码的 zset：层高怎么由掷骰子决定、跨度怎么让排名变成一次爬楼、双索引各自的职责边界，以及 Redis 为什么用跳表而不用红黑树。延迟为裸 socket 单连接往返实测，环境是官方 Redis 7.4.11 容器。
pubDate: 2026-09-10
category: redis
tags: [Redis, 数据库]
---

上一篇结尾留了个扣子：zset 转成 skiplist 编码后，内部其实是两套结构，一个 dict 和一个跳表。同一份数据存了两份索引，听起来是浪费。可十万成员上的实测说两份索引都没闲着：`ZSCORE z m:9900`（成员排在第 9900 位）走字典，43.9 微秒；`ZRANK z m:9900` 走跳表，44.3 微秒。两条路一样快，走的却是完全不同的结构。

单索引做不到这件事。只有字典，按分数取排名要全表统计；只有有序数组，单点查询要扛住 O(log n) 之外的重排成本。**zset 的日常是「点查与范围各占一半」，所以它干脆两套都要。** 这一篇就把这两套结构拆开：跳表的层高怎么定，跨度（span）怎么把「排名」变成一次爬楼，字典那一份又在替谁省事，最后回答那个经典问题：为什么是跳表，不是红黑树。

实验在官方 Redis 7.4.11 容器中完成，延迟为裸 socket 单连接往返测量，源码名称以该版本为准。

## 先看跳表本身：一条带快车道的有序链表

跳表的起点是一条普通有序链表：查找从头走到尾，O(n)。跳表的想法是给一部分节点加「快车道」，从高层跳过大段中间节点，像地铁的快线越站：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 248" role="img" aria-label="三层跳表与查找 60 的路径：第 3 层只有 H 和 50 两站，从 H 跳到 50；第 2 层有 H、20、50、70，从 50 看下一站 70 越过目标，退回降层；第 1 层从 50 走到 60 命中。三大步加几次下探，代替单链表 6 步行走" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red5As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="red5Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">查找 60 的路径（朱砂）：高层大步跳，越过就降层</text>
<text class="ts" x="20" y="60" font-size="11" fill="#6b675e">第 3 层</text>
<text class="ts" x="20" y="112" font-size="11" fill="#6b675e">第 2 层</text>
<text class="ts" x="20" y="164" font-size="11" fill="#6b675e">第 1 层</text>
<rect class="bx" x="60" y="66" width="44" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="82" y="84" text-anchor="middle" font-size="11" fill="#6b675e">H</text>
<rect class="bx-q" x="372" y="66" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="394" y="84" text-anchor="middle" font-size="11" fill="#2b2a26">50</text>
<rect class="bx-gone" x="622" y="66" width="30" height="28" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<line class="fl" x1="104" y1="80" x2="368" y2="80" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As1)"/>
<line class="fl" x1="416" y1="80" x2="618" y2="80" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As1)"/>
<rect class="bx" x="60" y="118" width="44" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="82" y="136" text-anchor="middle" font-size="11" fill="#6b675e">H</text>
<rect class="bx-q" x="186" y="118" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="208" y="136" text-anchor="middle" font-size="11" fill="#2b2a26">20</text>
<rect class="bx-q" x="372" y="118" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="394" y="136" text-anchor="middle" font-size="11" fill="#2b2a26">50</text>
<rect class="bx-q" x="497" y="118" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="519" y="136" text-anchor="middle" font-size="11" fill="#2b2a26">70</text>
<line class="fl" x1="104" y1="132" x2="182" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As1)"/>
<line class="fl" x1="230" y1="132" x2="368" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As1)"/>
<line class="fl" x1="416" y1="132" x2="493" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As1)"/>
<rect class="bx" x="60" y="170" width="44" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="82" y="188" text-anchor="middle" font-size="11" fill="#6b675e">H</text>
<rect class="bx-q" x="123" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="145" y="188" text-anchor="middle" font-size="11" fill="#6b675e">10</text>
<rect class="bx-q" x="186" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="208" y="188" text-anchor="middle" font-size="11" fill="#6b675e">20</text>
<rect class="bx-q" x="248" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="270" y="188" text-anchor="middle" font-size="11" fill="#6b675e">30</text>
<rect class="bx-q" x="310" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="332" y="188" text-anchor="middle" font-size="11" fill="#6b675e">40</text>
<rect class="bx-q" x="372" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="394" y="188" text-anchor="middle" font-size="11" fill="#2b2a26">50</text>
<rect class="bx-q" x="435" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="457" y="188" text-anchor="middle" font-size="11" fill="#2b2a26">60</text>
<rect class="bx-q" x="497" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="519" y="188" text-anchor="middle" font-size="11" fill="#6b675e">70</text>
<rect class="bx-q" x="560" y="170" width="44" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="582" y="188" text-anchor="middle" font-size="11" fill="#6b675e">80</text>
<line class="fl" x1="104" y1="184" x2="119" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="fl" x1="167" y1="184" x2="182" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="fl" x1="230" y1="184" x2="244" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="fl" x1="292" y1="184" x2="306" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="fl" x1="354" y1="184" x2="368" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="fl" x1="416" y1="184" x2="431" y2="184" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As1)"/>
<line class="fl" x1="479" y1="184" x2="493" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="fl" x1="541" y1="184" x2="556" y2="184" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As1)"/>
<line class="flc" x1="104" y1="76" x2="364" y2="76" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac1)"/>
<text class="tc" x="230" y="68" text-anchor="middle" font-size="10" fill="#b03a2e">① 50 之前还能走</text>
<line class="flc" x1="394" y1="94" x2="394" y2="114" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac1)"/>
<line class="flc" x1="416" y1="128" x2="489" y2="128" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac1)"/>
<text class="tc" x="452" y="112" text-anchor="middle" font-size="10" fill="#b03a2e">② 70 过了，退回降层</text>
<line class="flc" x1="394" y1="146" x2="394" y2="166" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac1)"/>
<line class="flc" x1="416" y1="180" x2="429" y2="180" stroke="#b03a2e" stroke-width="2.4" marker-end="url(#red5Ac1)"/>
<text class="tc" x="452" y="216" text-anchor="middle" font-size="10" fill="#b03a2e">③ 第 1 层 50 → 60，命中</text>
<text class="ts" x="20" y="238" font-size="12" fill="#6b675e">快车道越高层越稀疏：第 3 层只有两站，第 1 层站站都停</text>
</svg>
</figure>

找 60：从最高层出发，50 之前还能走，50 之后下一站是 NULL，降层；第 2 层从 50 走到 70，过了，退回 50 降层；第 1 层从 50 走到 60，命中。整个过程走了 3 大步加几次层间下探，而不是 6 步单链行走。**层数堆到 log n 层，期望查找就是 O(log n)。**

每个节点几层，是插入时掷骰子决定的。Redis 的掷法（`zslRandomLevel`）：

```text
层 = 1
当 random() < 0.25：层 += 1     （每多一层，概率 1/4）
上限 32 层
```

四分之一的概率升一层，意味着每 4 个节点大约 1 个有第 2 层，每 16 个节点 1 个有第 3 层。十万成员的期望分布：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="十万成员跳表的层高期望分布条形图，条长按平方根刻度：至少 1 层的 100000 个，至少 2 层 25000 个，3 层 6250，4 层 1562，5 层 391，6 层 98，7 层 24，8 层 6 个，每升一层除以四" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">十万成员的层高期望分布（条长按平方根刻度：每升一层，人数除以 4）</text>
<text class="ts" x="20" y="57" font-size="11" fill="#6b675e">≥1 层</text>
<rect class="bar" x="110" y="44" width="430" height="16" fill="#2b2a26"/>
<text class="ts" x="118" y="57" font-size="10" fill="#f6f3ec">100,000 个（全体）</text>
<text class="ts" x="20" y="81" font-size="11" fill="#6b675e">≥2 层</text>
<rect class="bar" x="110" y="68" width="221" height="16" fill="#2b2a26"/>
<text class="onbar" x="118" y="81" font-size="10" fill="#f6f3ec">25,000</text>
<text class="ts" x="20" y="105" font-size="11" fill="#6b675e">≥3 层</text>
<rect class="bar" x="110" y="92" width="110" height="16" fill="#2b2a26"/>
<text class="onbar" x="118" y="105" font-size="10" fill="#f6f3ec">6,250</text>
<text class="ts" x="20" y="129" font-size="11" fill="#6b675e">≥4 层</text>
<rect class="bar" x="110" y="116" width="49" height="16" fill="#2b2a26"/>
<text class="ts" x="167" y="129" font-size="10" fill="#6b675e">1,562</text>
<text class="ts" x="20" y="153" font-size="11" fill="#6b675e">≥5 层</text>
<rect class="bar" x="110" y="140" width="28" height="16" fill="#2b2a26"/>
<text class="ts" x="146" y="153" font-size="10" fill="#6b675e">391</text>
<text class="ts" x="20" y="177" font-size="11" fill="#6b675e">≥6 层</text>
<rect class="bar" x="110" y="164" width="14" height="16" fill="#2b2a26"/>
<text class="ts" x="132" y="177" font-size="10" fill="#6b675e">98</text>
<text class="ts" x="20" y="201" font-size="11" fill="#6b675e">≥7 层</text>
<rect class="bar" x="110" y="188" width="7" height="16" fill="#2b2a26"/>
<text class="ts" x="125" y="201" font-size="10" fill="#6b675e">24</text>
<text class="ts" x="20" y="225" font-size="11" fill="#6b675e">≥8 层</text>
<rect class="bar" x="110" y="212" width="4" height="16" fill="#2b2a26"/>
<text class="ts" x="122" y="225" font-size="10" fill="#6b675e">6</text>
<text class="ts" x="380" y="153" font-size="12" fill="#6b675e">每升一层都要再掷一次骰子：</text>
<text class="ts" x="380" y="173" font-size="12" fill="#6b675e">升层概率 1/4，上限 32 层</text>
<text class="tc" x="380" y="201" font-size="12" fill="#b03a2e">极端退化在定义上存在、概率趋零：</text>
<text class="tc" x="380" y="221" font-size="12" fill="#b03a2e">Redis 用这一点换实现简单</text>
</svg>
</figure>

平均层高 1.33：跳表用三成多的额外指针，换回对数级的查找路径。后面的内存对比会验证这个数字。

骰子带来一个值得强调的性质：跳表的性能是概率性的期望，不是结构性的保证。极端情况下所有节点都掷出 1 层，跳表退化成链表，概率是 (3/4)^100000，物理上不会发生，但「期望 O(log n)」和红黑树「最坏 O(log n)」的措辞差异是真实存在的。Redis 接受这个交换，换来的是下面会看到的实现简单性。

## 跨度：把「排名」变成一次爬楼

Redis 的跳表和教科书版的最大差别，是每个前进指针旁边还存了一个**跨度**（span）：从当前节点跳到下一站，越过了多少个节点。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="带跨度的跳表：第 2 层每根指针旁标着 span，H 到 20 跨 2，20 到 50 跨 3，50 到 70 跨 2；查 60 的排名沿路累加跨度，H 到 20 加 2，20 到 50 加 3，降层后 50 到 60 加 1，累计 6 就是排名" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red5As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="red5Ac3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">每根前进指针旁边存着跨度：这一跳越过了几个节点</text>
<rect class="bx" x="20" y="70" width="48" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="44" y="88" text-anchor="middle" font-size="11" fill="#6b675e">H</text>
<rect class="bx-q" x="172" y="70" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="196" y="88" text-anchor="middle" font-size="11" fill="#2b2a26">20</text>
<rect class="bx-q" x="400" y="70" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="424" y="88" text-anchor="middle" font-size="11" fill="#2b2a26">50</text>
<rect class="bx-q" x="552" y="70" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="576" y="88" text-anchor="middle" font-size="11" fill="#2b2a26">70</text>
<line class="fl" x1="68" y1="84" x2="168" y2="84" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As3)"/>
<text class="ts" x="118" y="76" text-anchor="middle" font-size="10" fill="#6b675e">span 2</text>
<line class="fl" x1="220" y1="84" x2="396" y2="84" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As3)"/>
<text class="ts" x="308" y="76" text-anchor="middle" font-size="10" fill="#6b675e">span 3</text>
<line class="fl" x1="448" y1="84" x2="548" y2="84" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red5As3)"/>
<text class="ts" x="498" y="76" text-anchor="middle" font-size="10" fill="#6b675e">span 2</text>
<rect class="bx" x="20" y="140" width="48" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="44" y="158" text-anchor="middle" font-size="11" fill="#6b675e">H</text>
<rect class="bx-q" x="96" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="158" text-anchor="middle" font-size="11" fill="#6b675e">10</text>
<rect class="bx-q" x="172" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="196" y="158" text-anchor="middle" font-size="11" fill="#2b2a26">20</text>
<rect class="bx-q" x="248" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="272" y="158" text-anchor="middle" font-size="11" fill="#6b675e">30</text>
<rect class="bx-q" x="324" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="348" y="158" text-anchor="middle" font-size="11" fill="#6b675e">40</text>
<rect class="bx-q" x="400" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="424" y="158" text-anchor="middle" font-size="11" fill="#2b2a26">50</text>
<rect class="bx-q" x="476" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="500" y="158" text-anchor="middle" font-size="11" fill="#2b2a26">60</text>
<rect class="bx-q" x="552" y="140" width="48" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="576" y="158" text-anchor="middle" font-size="11" fill="#6b675e">70</text>
<line class="fl" x1="68" y1="154" x2="92" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="fl" x1="144" y1="154" x2="168" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="fl" x1="220" y1="154" x2="244" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="fl" x1="296" y1="154" x2="320" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="fl" x1="372" y1="154" x2="396" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="fl" x1="448" y1="154" x2="472" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="fl" x1="524" y1="154" x2="548" y2="154" stroke="#6b675e" stroke-width="1.2" marker-end="url(#red5As3)"/>
<line class="flc" x1="68" y1="80" x2="164" y2="80" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac3)"/>
<line class="flc" x1="220" y1="80" x2="392" y2="80" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac3)"/>
<line class="flc" x1="424" y1="98" x2="424" y2="136" stroke="#b03a2e" stroke-width="2" marker-end="url(#red5Ac3)"/>
<line class="flc" x1="448" y1="150" x2="470" y2="150" stroke="#b03a2e" stroke-width="2.4" marker-end="url(#red5Ac3)"/>
<text class="tc" x="118" y="112" text-anchor="middle" font-size="10" fill="#b03a2e">+2</text>
<text class="tc" x="308" y="112" text-anchor="middle" font-size="10" fill="#b03a2e">+3</text>
<text class="tc" x="452" y="128" font-size="10" fill="#b03a2e">降层</text>
<text class="tc" x="462" y="190" text-anchor="middle" font-size="10" fill="#b03a2e">+1</text>
<text class="tc" x="20" y="212" font-size="12" fill="#b03a2e">查 60 的排名 = 2 + 3 + 1 = 6：沿途把跨过的 span 加起来，到底即答案</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">span 只存「越过了几个」，不存名次本身：名次永远是从头累加的和</text>
</svg>
</figure>

没有跨度，ZRANK 只能第 1 层一步步数。有跨度，找排名变成**把沿途跨过的 span 加起来**：从 header 出发，高层大步跳、每跳累加跨度、目标一过就降层，到底时累加值就是排名。十万成员里查第 9900 名，走的步数是「跳过的节点数」的量级，十来步，而不是九千九百步。

`zslGetRank` 的实现正是这个累加循环；反过来 `zslGetElementByRank`（ZRANGE 按下标取成员的底层）也是同一套：带着剩余排名数爬楼，跨度能减就减，减完恰好到底。排名与位置，在 span 的加减法里可以互相换算。

维护跨度的成本在插入时：`zslInsert` 沿途记录每层的「出发点」和「已累计排名」，插好后一次性修正前后各层的 span。这是跳表比教科书版复杂的地方，也是 Redis 版跳表的精髓：**范围和排名查询不必数数，因为数数的工作在插入时就被摊进 span 里了。**

## 双索引：一份在字典，一份在跳表

现在把另一半请出来。skiplist 编码的 zset，完整结构是：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="skiplist 编码 zset 的完整结构与命令路由：zset 内部一份 dict 管成员到分数的哈希命中，一份 zsl 跳表管顺序和范围；ZSCORE 走 dict，ZRANK、ZRANGE、ZRANGEBYSCORE 走跳表，ZADD 两份索引都要更新" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red5As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一份数据，两本索引：各答各的问题</text>
<rect class="bx-q" x="250" y="36" width="160" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="59" text-anchor="middle" font-size="13" fill="#2b2a26">zset</text>
<line class="fl" x1="290" y1="72" x2="180" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As4)"/>
<line class="fl" x1="370" y1="72" x2="480" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As4)"/>
<rect class="bx" x="40" y="110" width="250" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="165" y="132" text-anchor="middle" font-size="13" fill="#2b2a26">dict · 成员 → 分数</text>
<text class="ts" x="165" y="152" text-anchor="middle" font-size="11" fill="#6b675e">不排序，只管快</text>
<text class="ts" x="165" y="170" text-anchor="middle" font-size="11" fill="#6b675e">一次哈希答「在不在、分数多少」</text>
<rect class="bx" x="370" y="110" width="250" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="495" y="132" text-anchor="middle" font-size="13" fill="#2b2a26">zsl · 按分数排序的跳表</text>
<text class="ts" x="495" y="152" text-anchor="middle" font-size="11" fill="#6b675e">带 span，管顺序和范围</text>
<text class="ts" x="495" y="170" text-anchor="middle" font-size="11" fill="#6b675e">第 1 层顺链走，backward 支持反向</text>
<rect class="bx-q" x="40" y="210" width="180" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="130" y="229" text-anchor="middle" font-size="11" fill="#6b675e">ZSCORE：dict 一次命中</text>
<rect class="bx-q" x="240" y="210" width="190" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="335" y="229" text-anchor="middle" font-size="11" fill="#6b675e">ZRANK：跳表 span 累加</text>
<rect class="bx-q" x="450" y="210" width="180" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="540" y="229" text-anchor="middle" font-size="11" fill="#6b675e">ZRANGE：定位后沿链走</text>
<rect class="bx-q" x="40" y="248" width="230" height="30" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="155" y="267" text-anchor="middle" font-size="11" fill="#6b675e">ZRANGEBYSCORE：按分数定起止</text>
<rect class="bx-sick" x="290" y="248" width="340" height="30" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="460" y="267" text-anchor="middle" font-size="11" fill="#b03a2e">ZADD：两份索引都更新，dict 改分数、跳表挪位置</text>
</svg>
</figure>

十万成员上的实测对比：

```text
ZSCORE  m:9900（dict 路径）           43.9 微秒
ZRANK   m:9900（跳表路径）            44.3 微秒
ZRANGE  取头部 100 个                 54.5 微秒
ZRANGE  取尾部 100 个（9900–9999）    74.9 微秒
```

先看前两行：**两条路径一样快**。字典的哈希与跳表的爬楼，在对数复杂度下都追平了网络往返的底噪。这也说明双索引不是「一主一备」，两套都在第一线服务。

后两行有个值得玩味的细节：尾部 100 个比头部 100 个贵约 37%。跳表定位尾部要先爬过 9900 个位置 span，定位头部只爬 99 个。**ZRANGE 的成本 = 定位成本 + 输出成本**，按下标取值时，起点越深第一项越贵。十万的表上这只是 20 微秒的差距，但「同样的命令、同样的 LIMIT，慢的那次是因为起点深」，这个形状在排查分页慢查询时值得记得。

内存的对比同样清楚。十万个成员（`m:1` 到 `m:100000`，均为 8 字符左右）：

```text
同样成员的 SET（纯 dict）              5,412,976 字节   54.1 B/成员
同样成员的 ZSET（dict + 跳表）         8,729,376 字节   87.3 B/成员
差值 ≈ 跳表侧                          3,316,400 字节   33.2 B/成员
```

多出来的每成员约 33 字节，覆盖跳表节点的层指针与 span、backward 指针、按平均 1.33 层算的层数组。**zset 比 set 贵六成，买的是「有序」这件事的全部服务**：范围、排名、按分数截取。而 33 字节里还能再省一笔：dict 那份的 value 只存一个指针指向跳表节点里的分数，两份索引没有重复存分数本体，成员字符串 sds 也只有一份、被两边共享。双索引共享载荷，贵的只是导航结构。

每成员的内存账：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 190" role="img" aria-label="十万成员的每成员内存条形对照：SET 纯 dict 是 54.1 字节；ZSET 是 87.3 字节，其中 dict 侧约 54.1，跳表侧多出 33.2 字节的导航开销；分数本体与成员字符串只存一份被两边共享" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">十万成员，每成员的字节数（条长同一比例尺）</text>
<text class="ts" x="20" y="66" font-size="12" fill="#6b675e">SET · 纯 dict</text>
<rect class="bar" x="140" y="52" width="325" height="20" fill="#2b2a26"/>
<text class="onbar" x="150" y="67" font-size="11" fill="#f6f3ec">54.1 B</text>
<text class="ts" x="20" y="110" font-size="12" fill="#6b675e">ZSET · 双索引</text>
<rect class="bar" x="140" y="96" width="325" height="20" fill="#2b2a26"/>
<text class="onbar" x="150" y="111" font-size="11" fill="#f6f3ec">dict 侧 ≈54.1 B</text>
<rect class="bx-sick" x="465" y="96" width="199" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="475" y="111" font-size="11" fill="#b03a2e">跳表侧 +33.2 B</text>
<text class="ts" x="20" y="148" font-size="12" fill="#6b675e">33.2 字节买的是层指针与 span、backward 指针、平均 1.33 层的层数组</text>
<text class="tc" x="20" y="172" font-size="12" fill="#b03a2e">载荷没有双份：dict 的 value 只是一个指向跳表节点的指针</text>
</svg>
</figure>

## 插入：两套索引的一次协同

`ZADD` 在 skiplist 编码下要走完全套协同：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 282" role="img" aria-label="ZADD 的协同流程：第一步永远先查 dict 判断成员是否存在；存在且分数不变什么也不做；存在但分数变了则 dict 改值、跳表删旧插新；不存在则两边都插。跳表插入逐层下探记录 update 与 rank 数组，掷骰子定层高挂进各层，一次性修正 span，最后 dict 插入" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red5As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">ZADD 的全套协同：存在性判断永远先问字典</text>
<rect class="bx-q" x="200" y="36" width="260" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="59" text-anchor="middle" font-size="12" fill="#2b2a26">① 查 dict：成员已存在？</text>
<line class="fl" x1="260" y1="72" x2="130" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As5)"/>
<line class="fl" x1="330" y1="72" x2="330" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As5)"/>
<line class="fl" x1="400" y1="72" x2="530" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As5)"/>
<rect class="bx" x="20" y="110" width="200" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="120" y="130" text-anchor="middle" font-size="11" fill="#6b675e">存在，分数不变</text>
<text class="ts" x="120" y="148" text-anchor="middle" font-size="11" fill="#6b675e">什么也不做，返回</text>
<text class="tc" x="120" y="164" text-anchor="middle" font-size="10" fill="#b03a2e">跳表的 O(log n) 没轮到出场</text>
<rect class="bx" x="240" y="110" width="190" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="335" y="130" text-anchor="middle" font-size="11" fill="#6b675e">存在，分数变了</text>
<text class="ts" x="335" y="148" text-anchor="middle" font-size="11" fill="#6b675e">dict 改值 O(1)</text>
<text class="ts" x="335" y="164" text-anchor="middle" font-size="11" fill="#6b675e">跳表删旧节点、插新位置</text>
<rect class="bx" x="450" y="110" width="190" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="545" y="130" text-anchor="middle" font-size="11" fill="#6b675e">不存在</text>
<text class="ts" x="545" y="148" text-anchor="middle" font-size="11" fill="#6b675e">两边都插</text>
<line class="fl" x1="335" y1="172" x2="335" y2="200" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As5)"/>
<line class="fl" x1="545" y1="172" x2="420" y2="200" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red5As5)"/>
<rect class="bx-q" x="120" y="204" width="420" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="330" y="226" text-anchor="middle" font-size="11" fill="#6b675e">② 跳表插入：逐层下探找位置，记下每层出发点与已累计排名</text>
<text class="ts" x="330" y="244" text-anchor="middle" font-size="11" fill="#6b675e">③ 掷骰子定层高挂进各层，一次性修正 span　④ dict 插入</text>
<text class="ts" x="20" y="276" font-size="12" fill="#6b675e">update 数组存出发点、rank 数组存累计排名：span 的修正是插入的收尾动作</text>
</svg>
</figure>

第 1 步的顺序藏着双索引的分工宣言：**存在性判断永远先问字典**。跳表按分数排序，按成员查分数本就要 O(log n) 的爬楼外加字符串比较；字典一次哈希就把「在不在、分数是多少」都答了。这就是为什么 ZADD 更新已有成员（分数不变）能便宜到接近一次 ZSCORE：跳表那边的 O(log n) 根本没轮到出场。

删除同理反向：先字典确认并拿到分数，再带着分数去跳表里删节点、修 span。两份索引永远同步更新，不存在「字典里有、跳表里没有」的中间状态暴露给任何命令，因为更新发生在同一条命令的执行路径里，而命令执行是事件循环篇说过的那个串行模型。

## 为什么是跳表，不是红黑树

有序集合的结构选型，教科书答案是平衡二叉搜索树（Java 的 TreeMap、C++ 的 std::map 都是红黑树）。跳表期望 O(log n)，红黑树最坏 O(log n)，后者理论上还更强。Redis 选跳表，理由散落在作者的旧帖和源码注释里，归纳起来是四条：

**实现简单得多。** 红黑树的插入删除要处理旋转、重染色、各种对称情形，代码以精巧难读著称。跳表的插入就是「找位置、掷骰子、改几个指针」；源码里 `zslInsert` 五十行出头，没有旋转没有再平衡。对一个由小团队维护的十万行级项目，可维护性是实打实的工程资产。

**范围查询天然友好。** 平衡树做范围查询要到中序后继之间反复回溯父指针；跳表的第 1 层本来就是一条排好序的链表，ZRANGE 定位起点后沿链直走即可，`backward` 指针还免费支持反向遍历（ZREVRANGE）。

**跨度是独有扩展。** 红黑树节点里塞 rank 需要子树大小计数，每次旋转都要逐级重算；跳表的 span 只在插入删除路径上局部修正，把排名查询摊成了指针加减。ZRANK/ZRANGE 这类「按名次取」的操作，在这套结构里几乎没有额外代价。

**内存可控可调。** 红黑树每个节点固定三指针（左右子、父）加颜色位；跳表平均 1.33 指针起步，而且 P 值（升层概率）可调：要更省内存把 P 降到 1/8，层数更稀疏；要更矮的塔把 P 提到 1/2。Redis 取 1/4 是内存与层数的折中。

理论上的代价要诚实交代：跳表是**期望**复杂度，最坏退化虽然概率趋零但定义上存在；红黑树是硬保证。工程上这条交换显然划算：用可忽略的概率风险，换实现简单、范围友好、排名免费三样实利。

## 双索引的对照实验：如果只剩一套

为了把双索引的价值坐实，构造一个对照组：纯字典（SET）与 zset（双索引）做同样的事，看各自擅长什么。

十万个成员上：

```text
                        SET（纯 dict）    ZSET（双索引）
查某个成员的值/分数        43.5 微秒        43.9 微秒     ← 两边都走 dict，一样快
按名次取第 9900 个        做不到           44.3 微秒     ← ZRANK 爬跳表
按区间取 100 个           做不到           74.9 微秒     ← ZRANGEBYSCORE 定位后顺链走
```

「做不到」不是修辞：纯哈希结构上实现名次或范围查询，唯一的办法是把十万成员全部拉出来排序，百万微秒级。**跳表那 33 字节/成员的开销，买的不是「更快」，是「可行」。** 反过来，只装跳表不装字典的 zset 也存在过：Redis 早期版本 ZSCORE 就是爬跳表，3.0 起加入 dict 后，ZSCORE 和 ZADD 的存在性检查才降为 O(1)。双索引是被「两种查询都高频」的真实负载逼出来的演化结果。

## 遍历与重放：zset 在流水线里的样子

两份索引还决定了 zset 在持久化和复制里的形状。AOF 篇讲过命令流水：ZADD 重放时两份索引按同一套协同逻辑更新，不需要额外机制。RDB 快照则直接遍历跳表，按分数序写出「成员、分数」对，天然有序，加载时逐条 ZADD 重建双索引。

这里有个顺带的工程观察：**zset 越大，RDB 保存和 AOF 重写时它越贵**。跳表遍历本身是 O(n)，但重建侧要逐条走双索引插入；对象编码篇的转换实验里，129 个成员的转换约 30 微秒，线性外推，十万成员的 zset 从 RDB 加载要重建十万次双索引，这笔开销在「大量大 zset + 频繁快照」的实例上会真实出现。这也是 `--save ""` 关掉自动快照的纯缓存场景敢用大 zset、而持久化实例要认真估 RDB 加载时间的原因之一。

## 观测与容量估算

```text
OBJECT ENCODING key          zset 现在的编码（listpack / skiplist）
MEMORY USAGE key             双索引的总开销（SAMPLES 0 精确统计大 zset）
ZRANK key member             排名查询，顺带验证跳表路径
DEBUG OBJECT key             底层细节（需显式开启）
```

大 zset 的容量估算可以带上本篇的数字：每成员的导航开销约 33 字节（跳表侧）加约 50 字节（字典侧），再加成员与分数本体。一个千万级成员的 zset，索引部分就是 GB 级的开销；评估「用 zset 还是另想办法（如按分数分段的一组小 zset，或外部存储）」时，这个数字应该出现在决策记录里。

zset 的双索引是 Redis 数据结构里最直白的一次「承认现实」：点查与范围都是高频需求，一套结构服务不了两种形状的访问，那就明着用两套，用共享载荷压住冗余，用同路径更新压住一致性。而跳表本身，是概率对确定性的置换：用一枚 1/4 的骰子，换掉了红黑树全部的旋转与染色。Redis 把这道题的答案写在了 `zslRandomLevel` 的第一行。

---

本文是 Redis 系列的第十一篇。上一篇《第 513 个字段，房租涨了五倍》讲对象编码与转换阈值，本文接过其中 zset 的一半；键空间 dict 的哈希机制见《哈希不直接决定位置，索引表才说了算》，CPython 系列的 dict 内幕，与本文的 Redis dict 遥相呼应。
