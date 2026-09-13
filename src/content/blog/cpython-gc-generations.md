---
title: 活得越久，查得越少：CPython 的分代垃圾回收
description: 引用计数当场回收绝大多数对象，循环引用是它唯一的盲区。本文拆开补上这个盲区的分代 GC：三代的链表与晋升、2000 的 0 代阈值、25% 的全量收集闸门、哪些容器才进追踪名单、PEP 442 之后 __del__ 循环的两阶段收集，以及 gc.freeze 在 fork 场景里的作用。实验数据取自 CPython 3.14.7。
pubDate: 2026-09-10
category: cpython
tags: [CPython, Python]
---

```text
gc.collect(0)   [只扫年轻代]      0.02 ms
gc.collect(2)   [全量扫描]       27.53 ms
```

同一时刻的同一个堆，12 万个已追踪对象，两个调用差了三个数量级。这个差距就是分代存在的全部理由。

引用计数篇讲过 CPython 的第一套回收系统：每个对象带一个计数器，归零当场释放，即时、精确、摊在每个赋值上。但它有一个结构性盲区：循环引用。`a.peer = b; b.peer = a` 之后删掉两个名字，两个对象的计数都还是 1，谁也不归零，谁也不释放。分代垃圾回收就是补上这个盲区的第二套系统，周期性地把堆里引用计数收拾不了的孤岛找出来。

本文把这套系统拆开：三代怎么分、阈值怎么触发、全量收集为什么还要过一道 25% 的闸门、哪些对象才进 GC 的追踪名单。下面的实验基于 CPython 3.14.7，源码以 3.14 分支为准。

## 触发器：数分配个数

GC 的启动条件容易想错：它不看内存用了多少，看容器对象分配了多少个。每个被追踪的对象创建时，0 代计数 +1（`_PyObject_GC_New` 路径里的 `generations[0].count++`）；计数越过阈值就排一次回收。

三代阈值（`gc.get_threshold()` 实测）：

```text
(2000, 10, 10)
 ↑0代阈值：净增 2000 个容器对象触发一次年轻代收集
 ↑1、2代阈值：收集满 10 次晋升一代
```

两个常被读错的地方。第一，2000 是 3.13 起的新默认，此前二十年一直是 700，网上资料几乎全是 700；改动动机是现代工作负载里容器更多更大，降低收集频率摊薄成本。第二，0 代计数是净增量：回收时活下来的对象会晋升走，计数重置，涨的是新造的、还没经历过回收的对象数。

收集哪一代由 `gc_select_generation` 决定，从老到年轻找第一个越线的代，收集它和比它年轻的所有代。这里有一道著名的闸门，下一节说。

计数的机制：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 160" role="img" aria-label="GC 触发计数器：0 代净增计数随容器对象创建加一，越过 2000 触发年轻代收集并清零；0 代收满 10 次让 1 代计数加一，1 代计数满 10 才轮到 2 代全量，全量还要过闸门" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="gcgAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">get_threshold() = (2000, 10, 10)：三个计数器的接力</text>
<rect class="bx-sick" x="20" y="44" width="190" height="56" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="115" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">0 代净增计数</text>
<text class="ts" x="115" y="86" text-anchor="middle" font-size="10" fill="#6b675e">每创建一个被追踪容器 +1</text>
<line class="fl" x1="210" y1="72" x2="246" y2="72" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs2)"/>
<text class="ts" x="228" y="62" text-anchor="middle" font-size="10" fill="#6b675e">≥2000</text>
<rect class="bx" x="250" y="44" width="190" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">年轻代收集</text>
<text class="ts" x="345" y="86" text-anchor="middle" font-size="10" fill="#6b675e">幸存者晋升，计数清零</text>
<rect class="bx" x="470" y="36" width="170" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="555" y="56" text-anchor="middle" font-size="10" fill="#6b675e">收满 10 次：1 代计数 +1</text>
<rect class="bx" x="470" y="76" width="170" height="32" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="555" y="96" text-anchor="middle" font-size="10" fill="#6b675e">1 代计数满 10：轮到 2 代</text>
<text class="ts" x="20" y="128" font-size="12" fill="#6b675e">数的是分配个数，不是内存用量；净增 = 新造的 − 晋升走的</text>
<text class="ts" x="20" y="148" font-size="12" fill="#6b675e">2000 是 3.13 起的新默认：此前二十年是 700，网上旧资料几乎全没更新</text>
</svg>
</figure>

## 三代与弱代假设

分代的赌注押在一条经验规律上，弱代假设：大多数对象朝生暮死。函数里的临时列表、请求解析的中间 dict，用完即弃；活过一轮收集的对象，大概率还要活很久。

于是堆被分成三个年龄组，各是一条双向链表。回收时只扫年轻的：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 272" role="img" aria-label="三代链表与晋升：0 代装新造的容器对象，收集时只扫 0 代，活下来的晋升 1 代；1 代收集扫 0 加 1 代，活下来的记入 long_lived_pending 晋升 2 代；2 代收集是全量。扫描成本与新对象数成正比，与堆总大小脱钩" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="gcgAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三个年龄组，三条双向链表：越老越少被扫</text>
<text class="t" x="20" y="76" font-size="12" fill="#2b2a26">0 代</text>
<rect class="bx-sick" x="90" y="56" width="40" height="26" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-sick" x="138" y="56" width="40" height="26" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-sick" x="186" y="56" width="40" height="26" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-sick" x="234" y="56" width="40" height="26" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-sick" x="282" y="56" width="40" height="26" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="336" y="74" font-size="11" fill="#6b675e">…新造的容器对象，净增计数在这涨</text>
<line class="fl" x1="300" y1="84" x2="300" y2="116" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs1)"/>
<text class="ts" x="310" y="106" font-size="10" fill="#6b675e">0 代收集后，活下来的晋升</text>
<text class="t" x="20" y="146" font-size="12" fill="#2b2a26">1 代</text>
<rect class="bx" x="90" y="126" width="40" height="26" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="138" y="126" width="40" height="26" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="186" y="126" width="40" height="26" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="240" y="144" font-size="11" fill="#6b675e">…活过一轮收集的对象</text>
<line class="fl" x1="300" y1="154" x2="300" y2="186" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs1)"/>
<text class="ts" x="310" y="176" font-size="10" fill="#6b675e">晋升 2 代：记入 long_lived_pending</text>
<text class="t" x="20" y="216" font-size="12" fill="#2b2a26">2 代</text>
<rect class="bx-q" x="90" y="196" width="40" height="26" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-q" x="138" y="196" width="40" height="26" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-q" x="186" y="196" width="40" height="26" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-q" x="234" y="196" width="40" height="26" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="288" y="214" font-size="11" fill="#6b675e">…长命对象：全量收集才碰，还要过 25% 闸门</text>
<text class="ts" x="20" y="248" font-size="12" fill="#6b675e">扫描范围：0 代收集只扫 0 代；1 代收集扫 0+1；2 代收集全量</text>
<text class="ts" x="20" y="266" font-size="12" fill="#6b675e">成本与新对象数成正比、与堆总大小脱钩：分代的价值在少扫，不在扫得快</text>
</svg>
</figure>

扫描成本因此与新对象数成正比，与堆的总大小脱钩。开头那组数字是它的实测版：12 万个追踪对象、其中大多是长命的树节点时，0 代收集 0.02ms（只看最近净增的几百个），全量 27.5ms（12 万个全过一遍）。分代的价值不在扫得快，在少扫。

晋升还有一处容易误会的地方：从 1 代晋升到 2 代（记入 `long_lived_pending`）的对象，并不必然在下次全量收集时被扫到。这就是 25% 闸门的事。

## 25% 闸门：全量收集的边际成本控制

2 代（全量）收集的成本与堆中长命对象总数成正比，对象越多越贵。如果机械地「每收集 10 次年轻代就来一次全量」，长命对象堆积的工作负载会退化成二次方（issue #4074 的原案）：建一个百万对象的列表，每次全量都白扫九十几万个不会死的对象。

`gc_select_generation` 里的解法是给 2 代加一道比例闸门：只有「待晋升量 ≥ 上次全量存活量的四分之一」才做全量。用注释里的话说：全量越来越贵，就做得越来越少，两者相抵，总成本对总对象数保持均摊线性。这个启发式出自 2008 年 Martin von Löwis 在 python-dev 的分析，至今仍在用。

这道闸门：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="全量收集的 25% 闸门：待晋升量 long_lived_pending 与上次全量存活量比较，达到四分之一才做全量收集，否则跳过继续年轻代收集、待晋升量继续攒；全量越来越贵就做得越来越少，总成本保持均摊线性" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="gcgAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">轮到 2 代时，先过一道比例闸门</text>
<rect class="bx-q" x="20" y="44" width="250" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="145" y="64" text-anchor="middle" font-size="11" fill="#6b675e">待晋升量 long_lived_pending</text>
<text class="ts" x="145" y="82" text-anchor="middle" font-size="11" fill="#6b675e">≥ 上次全量存活量 × 1/4 ？</text>
<line class="fl" x1="270" y1="58" x2="326" y2="50" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs3)"/>
<text class="ts" x="296" y="44" text-anchor="middle" font-size="10" fill="#6b675e">是</text>
<rect class="bx-sick" x="330" y="36" width="300" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="480" y="58" text-anchor="middle" font-size="11" fill="#b03a2e">做全量收集：成本与长命对象总数成正比</text>
<line class="fl" x1="270" y1="80" x2="326" y2="96" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs3)"/>
<text class="ts" x="296" y="100" text-anchor="middle" font-size="10" fill="#6b675e">否</text>
<rect class="bx" x="330" y="84" width="300" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="480" y="106" text-anchor="middle" font-size="11" fill="#6b675e">跳过：继续年轻代，待晋升量接着攒</text>
<text class="ts" x="20" y="148" font-size="12" fill="#6b675e">全量越来越贵，就做得越来越少：总成本对总对象数保持均摊线性（2008 年的启发式）</text>
<text class="ts" x="20" y="170" font-size="12" fill="#6b675e">观测：gc.get_stats() 里 2 代 collections 增长远慢于 0 代，年轻代收几十次全量可能一次没做</text>
<text class="ts" x="20" y="190" font-size="12" fill="#6b675e">急着要全量：gc.collect() 手动触发</text>
</svg>
</figure>

实测能看到闸门的存在：`gc.get_stats()` 里 2 代的 collections 增长远慢于 0 代，年轻代收了几十次，全量可能一次没做。急着要全量时可以 `gc.collect()` 手动触发（返回回收对象数，实验里一个 `a↔b` 循环返回 2）。

## 谁在名单上：追踪的资格

GC 只追踪可能参与循环的对象，即能装别的对象引用的容器。实测一组：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="追踪名单实测对照：list、dict、实例对象、含可变容器的元组被追踪；int、str、纯原子元组不被追踪；规则是可变容器一律追踪，不可变容器只在内容可能变出循环时追踪" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">gc.is_tracked() 实测：名单只收可能成环的容器</text>
<rect class="bx-q" x="20" y="40" width="300" height="130" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">在名单上 · True</text>
<rect class="bx" x="36" y="74" width="130" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="101" y="91" text-anchor="middle" font-size="10" fill="#6b675e">list [1, 2]</text>
<rect class="bx" x="176" y="74" width="130" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="241" y="91" text-anchor="middle" font-size="10" fill="#6b675e">dict {'a': 1}</text>
<rect class="bx" x="36" y="108" width="130" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="101" y="125" text-anchor="middle" font-size="10" fill="#6b675e">实例对象</text>
<rect class="bx" x="176" y="108" width="130" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="241" y="125" text-anchor="middle" font-size="10" fill="#6b675e">元组 ([1],) 含可变</text>
<text class="ts" x="170" y="156" text-anchor="middle" font-size="10" fill="#6b675e">3.14 起 dict 恒定追踪，不再有「懒惰开启」</text>
<rect class="bx-gone" x="340" y="40" width="300" height="130" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="490" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">不在名单 · False</text>
<rect class="bx-gone" x="356" y="74" width="130" height="26" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="421" y="91" text-anchor="middle" font-size="10" fill="#6b675e">int 1</text>
<rect class="bx-gone" x="496" y="74" width="130" height="26" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="561" y="91" text-anchor="middle" font-size="10" fill="#6b675e">str 'str'</text>
<rect class="bx-gone" x="356" y="108" width="270" height="26" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="491" y="125" text-anchor="middle" font-size="10" fill="#6b675e">纯原子元组 (1, 2)：内容不可能形成循环</text>
<text class="ts" x="490" y="156" text-anchor="middle" font-size="10" fill="#6b675e">不含引用的对象，GC 看都不看</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">规则两条：可变容器一律追踪；不可变容器只在内容可能变出循环时追踪</text>
<text class="ts" x="20" y="220" font-size="12" fill="#6b675e">进名单的物理成本：对象头多一对 _gc_next / _gc_prev 链表指针（PyGC_Head）</text>
</svg>
</figure>

两条规则：可变容器一律追踪；不可变容器只在内容可能变出循环时追踪。这条线在 3.14 里有一个值得记录的改动：dict 的追踪不再有「懒惰开启」。3.13 及之前，只装原子值的 dict 会被 GC 摘出名单省扫描（issue #14775）；3.14 起为简化并发正确性（GH-127010），dict 从创建起恒定追踪、永不摘除。老版本「往 dict 里塞一个 list 它才被追踪」的描述已成历史。

进名单也有物理成本：每个被追踪对象头上多出一对链表指针（`_gc_next`/`_gc_prev`，对象布局篇提过的 PyGC_Head）。

## __del__ 循环：PEP 442 之后能收了

带 `__del__` 的循环引用曾经无解：收集器不敢随便调用 `__del__`（对象可能处于半死状态、还被另一个 `__del__` 引用），旧解释器把这类循环永久扔进 `gc.garbage`，不再处理。PEP 442（3.4 起）改了做法：收集器分两阶段，先把整个孤岛从堆上完整摘下，再对每个对象调用 `__del__`，最后统一释放。

实测 `a.p = b; b.p = a` 且两者都带 `__del__`：`del` 名字后 `gc.collect()` 返回 2，两个 `__del__` 依序执行，weakref 全部归 None。`gc.garbage` 保持空，纯 Python 的 `__del__` 循环现在都是可收的。仍进 garbage 的只剩 C 扩展用旧式 `tp_del` 的遗留对象，现代扩展该用 PEP 442 的 `tp_finalize`。

两阶段协议：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 186" role="img" aria-label="PEP 442 两阶段收集：先把整个循环孤岛从堆上完整摘下，使其不再被外部触达；再对岛上每个对象依序调用 __del__ 或 tp_finalize；最后统一释放。旧解释器会把这类循环永久扔进 gc.garbage" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="gcgAs5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">带 __del__ 的循环，PEP 442（3.4 起）这样收</text>
<rect class="bx" x="20" y="44" width="190" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="115" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">① 摘孤岛</text>
<text class="ts" x="115" y="86" text-anchor="middle" font-size="10" fill="#6b675e">整个循环从堆上完整摘下</text>
<text class="ts" x="115" y="100" text-anchor="middle" font-size="10" fill="#6b675e">外部再也够不着它</text>
<line class="fl" x1="210" y1="76" x2="231" y2="76" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs5)"/>
<rect class="bx-sick" x="235" y="44" width="190" height="64" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="330" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">② 依序终结</text>
<text class="ts" x="330" y="86" text-anchor="middle" font-size="10" fill="#6b675e">逐个调用 __del__ / tp_finalize</text>
<text class="ts" x="330" y="100" text-anchor="middle" font-size="10" fill="#6b675e">此时对象状态已隔离，安全</text>
<line class="fl" x1="425" y1="76" x2="446" y2="76" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs5)"/>
<rect class="bx-q" x="450" y="44" width="190" height="64" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="545" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">③ 统一释放</text>
<text class="ts" x="545" y="86" text-anchor="middle" font-size="10" fill="#6b675e">gc.collect() 返回 2</text>
<text class="ts" x="545" y="100" text-anchor="middle" font-size="10" fill="#6b675e">weakref 全部归 None</text>
<text class="ts" x="20" y="138" font-size="12" fill="#6b675e">442 之前：这类循环永久扔进 gc.garbage 不再处理；现在 garbage 保持空</text>
<text class="ts" x="20" y="160" font-size="12" fill="#6b675e">仍进 garbage 的只剩旧式 tp_del 的 C 扩展；工程正解仍是上下文管理器 + weakref.finalize</text>
</svg>
</figure>

顺带一句工程提醒：`__del__` 仍是危险区，异常会被吞、执行顺序无保证、复活（在 `__del__` 里把自己存进全局变量）会造出状态诡异的对象。资源释放的正解是上下文管理器和 weakref.finalize，`__del__` 只作最后兜底。

## freeze：给 fork 的让路

`gc.freeze()` 是个冷门但精准的 API，设计给 fork 型应用（prefork 服务器、Redis 篇见过的那类模型）。它把当前所有代的对象全部合并进一个「永久代」（permanent_generation），计数器清零：

```text
gc.freeze() 实测：
  冻结 16,176 个对象；gc.get_count() 归零
  随后的 gc.collect()：0.00 ms——永久代不参与任何扫描
```

两重收益。一，启动期导入的所有长命模块对象从此不进任何收集名单，每代收集都跳过它们，扫描名单显著变短。二，与 fork 的配合：这些对象此后不会被 GC 移动链表指针，fork 后子进程写这些页的机会更少，写时复制的页数更少（fork 篇讲过的 COW 机制）。Instagram 的 pre-fork 部署里这一手是标配。

`gc.unfreeze()` 把永久代归还第 2 代。边界也直白：冻结期间这些对象永远不会被循环回收，冻结的隐含前提就是这里没有垃圾。

冻结后的格局：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="gc.freeze 的效果：0、1、2 三代的全部对象合并进永久代 permanent_generation，计数器清零；永久代不参与任何扫描，链表指针不再被改动，fork 后子进程写这些页的机会更少，写时复制的页数更少" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="gcgAs6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">gc.freeze()：给 fork 型应用的让路</text>
<rect class="bx-sick" x="20" y="44" width="90" height="36" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="65" y="66" text-anchor="middle" font-size="11" fill="#6b675e">0 代</text>
<rect class="bx" x="20" y="88" width="90" height="36" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="65" y="110" text-anchor="middle" font-size="11" fill="#6b675e">1 代</text>
<rect class="bx-q" x="20" y="132" width="90" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="65" y="154" text-anchor="middle" font-size="11" fill="#6b675e">2 代</text>
<line class="fl" x1="110" y1="62" x2="196" y2="96" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs6)"/>
<line class="fl" x1="110" y1="106" x2="196" y2="106" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs6)"/>
<line class="fl" x1="110" y1="150" x2="196" y2="116" stroke="#6b675e" stroke-width="1.5" marker-end="url(#gcgAs6)"/>
<text class="ts" x="152" y="86" text-anchor="middle" font-size="10" fill="#6b675e">freeze()</text>
<rect class="bx-q" x="200" y="70" width="220" height="72" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="310" y="94" text-anchor="middle" font-size="12" fill="#2b2a26">永久代</text>
<text class="ts" x="310" y="114" text-anchor="middle" font-size="10" fill="#6b675e">permanent_generation</text>
<text class="ts" x="310" y="130" text-anchor="middle" font-size="10" fill="#6b675e">实测并入 16,176 个对象，计数归零</text>
<text class="ts" x="440" y="94" font-size="11" fill="#6b675e">不参与任何扫描：</text>
<text class="ts" x="440" y="112" font-size="11" fill="#6b675e">collect() 0.00ms</text>
<text class="ts" x="440" y="130" font-size="11" fill="#6b675e">链表指针不再被改动</text>
<text class="ts" x="20" y="180" font-size="12" fill="#6b675e">fork 后子进程写这些页的机会更少：COW 页更少，prefork 服务器的标配</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">unfreeze() 归还第 2 代；冻结的隐含前提：这里面没有垃圾</text>
</svg>
</figure>

## 观测接口

```text
gc.get_threshold() / set_threshold()   （2000, 10, 10）
gc.get_count()                          (gen0 净增, gen1, gen2 计数)
gc.get_stats()                          各代收集次数、回收数
gc.is_tracked(obj)                      是否在名单上
gc.freeze() / get_freeze_count()        fork 场景
objgraph / gc.get_objects()             循环泄漏的事后调查
```

几条边界：GC 只管循环，非循环的释放全权在引用计数，`del` 一个非循环对象是即时的，与 GC 无关（引用计数篇）。`gc.disable()` 关的是周期收集，引用计数照常工作，泄漏的只有循环。阈值调大省 CPU，但循环垃圾滞留更久，调小反之。内存曲线异常时先分清两种情况：未释放的循环归 GC 管，分配器不还页归 pymalloc 篇管。

---

## 两套系统怎么分工

触发看分配数：0 代净增 2000 个容器触发一次年轻代收集，2000 是 3.13 的新默认，替代了用了二十年的 700。

弱代假设把扫描成本与堆总大小解耦：活过收集就晋升，越老越少被扫。12 万对象的堆上，0 代 0.02ms 对全量 27.5ms，三个数量级的差距就是分代的全部回报。全量收集还有一道 25% 闸门，待晋升量不足上次存活量的四分之一就不做，这个 2008 年的启发式把长命对象堆上的二次方退化压回了均摊线性。

追踪名单只收可能成环的容器：可变容器恒定追踪，纯原子元组不追踪，3.14 起 dict 也恒定追踪；进名单的成本是对象头上两个链表指针。__del__ 循环在 PEP 442 的两阶段协议下可收，只剩旧式 tp_del 的 C 扩展还会进 gc.garbage。freeze 把启动期对象挪进永久代，不扫描、指针不再被改，既缩短每代名单，又减少 fork 场景的 COW 页。

引用计数即时、精确，但看不见环；分代回收批量、扫描，但只看名单。绝大多数对象在计数器手里当场结清，周期扫描只负责打捞那些互相引用、计数永不归零的孤岛。

引用计数与循环回收的主线见《名字已经划掉，住客还没退房》，PyGC_Head 的内存成本见《一只 Python 对象到底有多重》；写时复制的另一面见 Redis 系列《快照在后台，停顿发生在前台》，「GC 回收了但 RSS 不降」的分界见《房客只剩四十位，三十九座楼还不能退》。
