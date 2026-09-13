---
title: 每次搬家只多租一成：CPython 的 list 与过度分配
description: 一百万次 append 背后只有六十次 realloc。本文拆开 PyListObject 的指针数组结构、append 的 12.5% 增长公式、半数收缩的对称规则，以及 insert(0) 为什么比 append 慢五百倍，并记录 3.13 之后构造器精确分配带来的行为变化。文中实测数据均来自 CPython 3.14.7。
pubDate: 2026-09-10
category: cpython
tags: [CPython, Python]
---

先看两组实测数字。往 list 里 append 一百万次，realloc 只发生约 60 次；换成 insert(0) 一百万次，指针搬运累计约五千亿次。差距来自同一个结构细节：连续指针数组在增长时怎么搬、搬几次。

list 是 Python 里用得最不经意的容器。它随长随加、随处插删，容易被想象成链表，但 CPython 的 list 是一块连续的指针数组，每次扩容都是一次真正的内存搬家。搬得划不划算，全看操作：append 路径靠过度分配把搬家成本摊成常数级零头，insert(0) 则每一次都要全队平移。

对象布局篇拆过 PyObject 的头，dict 篇拆过索引表和条目表，这一篇补上三大容器里的最后一个：PyListObject。下面的实验跑在 CPython 3.14.7 上，源码引自 3.14 分支。

## 本体：一排指针

PyListObject 只有三样东西：

```c
typedef struct {
    PyObject_VAR_HEAD          // 引用计数、类型、长度 ob_size
    PyObject **ob_item;        // 指向指针数组的开头
    Py_ssize_t allocated;      // 实际分配的槽数
} PyListObject;
```

关键在 `ob_item` 指的那块内存：数组里存的是 PyObject 指针，不是对象本身。`[1, "a", [2]]` 的三个元素对象分散在堆的三个地方，list 里只有三个 8 字节的指针。所以 `sys.getsizeof(lst)` 量到的只是指针数组，元素本身另算。这是容量评估最常见的漏项：一个百万元素的 list 本体 8MB，但元素如果是百万个独立 int，还得再加上每个 28 字节的对象本体（对象布局篇算过这笔构成）。

`ob_size` 是元素个数（`len()` 直接读它），`allocated` 是实际分配的槽数。两者之间的差，就是这一篇的主角：过度分配。

这个结构的现场：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="PyListObject 布局：对象本体只有头部、ob_size、allocated 和 ob_item 指针；ob_item 指向连续的指针数组，数组存的是指向堆上分散对象的 8 字节指针，不是对象本身；allocated 比 ob_size 多出的空槽就是过度分配" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="lstAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">lst = [1, "a", [2]]：三样东西，一块指针数组</text>
<rect class="bx-q" x="20" y="44" width="180" height="106" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">PyListObject</text>
<text class="ts" x="110" y="84" text-anchor="middle" font-size="10" fill="#6b675e">VAR_HEAD：计数 + 类型</text>
<text class="ts" x="110" y="100" text-anchor="middle" font-size="10" fill="#6b675e">ob_size = 3（len 直接读）</text>
<text class="ts" x="110" y="116" text-anchor="middle" font-size="10" fill="#6b675e">allocated = 4</text>
<text class="ts" x="110" y="132" text-anchor="middle" font-size="10" fill="#6b675e">ob_item →</text>
<line class="fl" x1="200" y1="128" x2="244" y2="86" stroke="#6b675e" stroke-width="1.5" marker-end="url(#lstAs1)"/>
<rect class="bx" x="248" y="60" width="70" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="283" y="79" text-anchor="middle" font-size="10" fill="#6b675e">ptr 8B</text>
<rect class="bx" x="326" y="60" width="70" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="361" y="79" text-anchor="middle" font-size="10" fill="#6b675e">ptr 8B</text>
<rect class="bx" x="404" y="60" width="70" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="439" y="79" text-anchor="middle" font-size="10" fill="#6b675e">ptr 8B</text>
<rect class="bx-gone" x="482" y="60" width="70" height="30" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="517" y="79" text-anchor="middle" font-size="10" fill="#6b675e">空槽</text>
<text class="ts" x="560" y="79" font-size="10" fill="#6b675e">← 过度分配</text>
<line class="fl" x1="283" y1="90" x2="290" y2="134" stroke="#6b675e" stroke-width="1.4" marker-end="url(#lstAs1)"/>
<line class="fl" x1="361" y1="90" x2="392" y2="134" stroke="#6b675e" stroke-width="1.4" marker-end="url(#lstAs1)"/>
<line class="fl" x1="439" y1="90" x2="496" y2="134" stroke="#6b675e" stroke-width="1.4" marker-end="url(#lstAs1)"/>
<rect class="bx-q" x="240" y="138" width="100" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="290" y="160" text-anchor="middle" font-size="10" fill="#6b675e">int 对象 1</text>
<rect class="bx-q" x="352" y="138" width="100" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="402" y="160" text-anchor="middle" font-size="10" fill="#6b675e">str 对象 "a"</text>
<rect class="bx-q" x="464" y="138" width="100" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="514" y="160" text-anchor="middle" font-size="10" fill="#6b675e">list 对象 [2]</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">getsizeof 只量指针数组：56 + 8 × allocated；元素本体分散在堆上另算</text>
<text class="ts" x="20" y="216" font-size="12" fill="#6b675e">百万元素 list 本体 8MB；元素若是百万个独立 int，再加每个 28 字节的对象</text>
</svg>
</figure>

## append 的扩容公式：12.5% 的余量

append 遇到容量满了要扩容。CPython 的扩容公式（`list_resize`）是：

```c
new_allocated = (newsize + (newsize >> 3) + 6) & ~3;
```

比需要的多出约 `newsize/8 + 6` 个槽，再对齐到 4：大约 12.5% 的余量，外加一点起步补贴。源码注释里直接给出了增长序列：

```text
0, 4, 8, 16, 24, 32, 40, 52, 64, 76, ...
```

实测逐个 append 并跟踪 `sys.getsizeof`，容量跳变的序列完全对上：

```text
len   1   5   9  17  25  33  41  53  65  77  93
cap   4   8  16  24  32  40  52  64  76  92 108
```

多租是为了摊成本。如果每次满员都恰好扩一格，一百万次 append 就要一百万次 realloc，每次都要申请新内存、拷贝全部指针、释放旧内存。多租 12.5% 之后，扩容的间隔越拉越长，搬家总成本摊到每次 append 上就是常数级，这是「均摊 O(1)」的物理含义。付出的是平均约 6% 的内存空转（多租 12.5% 的均值），以及地址不连续：每次 realloc 后整个数组都搬到新地址。

增长阶梯与「刚好够用」的对照：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 264" role="img" aria-label="list 容量增长阶梯图：横轴是 append 次数，纵轴是 allocated 容量；容量按 4、8、16、24、32、40、52、64、76、92、108 跳变，台阶间隔越来越宽；虚线是 cap 等于 len 的刚好够用参照线，那条路上每次满员都要一次 realloc" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">容量阶梯：new_allocated = (newsize + newsize&gt;&gt;3 + 6) &amp; ~3</text>
<line class="grid" x1="70" y1="164" x2="610" y2="164" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="127" x2="610" y2="127" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="91" x2="610" y2="91" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="54" x2="610" y2="54" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="200" x2="70" y2="40" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="200" x2="620" y2="200" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="168" text-anchor="end" font-size="10" fill="#6b675e">25</text>
<text class="ts" x="62" y="131" text-anchor="end" font-size="10" fill="#6b675e">50</text>
<text class="ts" x="62" y="95" text-anchor="end" font-size="10" fill="#6b675e">75</text>
<text class="ts" x="62" y="58" text-anchor="end" font-size="10" fill="#6b675e">100</text>
<text class="ts" x="20" y="44" font-size="10" fill="#6b675e">cap</text>
<line class="flc" x1="70" y1="200" x2="610" y2="54" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="5 4"/>
<text class="tc" x="420" y="80" font-size="10" fill="#b03a2e">cap = len：每次满员都 realloc 的路</text>
<polyline class="curve-k" points="70,200 75,200 75,194 97,194 97,188 119,188 119,177 162,177 162,165 205,165 205,153 248,153 248,142 291,142 291,124 356,124 356,107 421,107 421,90 486,90 486,66 572,66 572,43 610,43" fill="none" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="100" y="188" font-size="9" fill="#6b675e">4</text>
<text class="ts" x="130" y="172" font-size="9" fill="#6b675e">8→16</text>
<text class="ts" x="300" y="118" font-size="9" fill="#6b675e">52</text>
<text class="ts" x="500" y="60" font-size="9" fill="#6b675e">92→108</text>
<text class="ts" x="70" y="218" text-anchor="middle" font-size="10" fill="#6b675e">0</text>
<text class="ts" x="205" y="218" text-anchor="middle" font-size="10" fill="#6b675e">25</text>
<text class="ts" x="340" y="218" text-anchor="middle" font-size="10" fill="#6b675e">50</text>
<text class="ts" x="475" y="218" text-anchor="middle" font-size="10" fill="#6b675e">75</text>
<text class="ts" x="610" y="218" text-anchor="middle" font-size="10" fill="#6b675e">100 次 append</text>
<text class="ts" x="20" y="242" font-size="12" fill="#6b675e">台阶间隔越拉越宽：一百万次 append 只要约 60 次 realloc，搬家成本摊成常数级零头</text>
</svg>
</figure>

公式里还有两个小常数各有用途：`+6` 是给小 list 的起步补贴，前几次扩容不至于 1 格 1 格地抠；`& ~3` 对齐到 4 槽，减少 realloc 次数。3.14 新增的判断「新尺寸更接近过度分配尺寸时取消过度分配」堵了另一头的浪费：`lst[1000:2000]` 这种一步到位的大扩展，不再先算出一个巨大的余量。

## 3.13 起的构造器：精确分配

3.13 之前，上面的增长序列是 list 唯一的扩容路径。3.13/3.14 起，构造和 append 分道扬镳：

```text
list(range(100))   →  sizeof 精确 = 56 + 100*8   （容量 == 长度）
[...] 逐个 append  →  容量按增长序列跳变（4, 8, 16, 24…）
```

实测对照（同一长度、不同出生方式）：

```text
list(range(n))   cap = n        （list_preallocate_exact）
append 构造      cap = 增长序列
```

源码里是 `list_preallocate_exact`：知道最终尺寸的构造路径不再多租。`list(range(n))`、`list(iterable)` 这类一次性到货的场景直接精确分配，反正马上就要用满，余量只会浪费。逐个 append 无法预知未来，仍走 12.5% 的老路。

两条出生路径：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 168" role="img" aria-label="3.13 起 list 的两条出生路径：构造器 list(range(n)) 走 list_preallocate_exact，容量精确等于长度不多租；逐个 append 构造无法预知未来，容量仍按增长序列 4、8、16、24 跳变" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="lstAs5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一个长度，两种容量：出生方式决定走哪条路</text>
<rect class="bx-q" x="20" y="40" width="220" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="130" y="64" text-anchor="middle" font-size="11" fill="#6b675e">list(range(n)) / list(iterable)</text>
<line class="fl" x1="240" y1="60" x2="296" y2="60" stroke="#6b675e" stroke-width="1.5" marker-end="url(#lstAs5)"/>
<rect class="bx" x="300" y="40" width="330" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="465" y="64" text-anchor="middle" font-size="11" fill="#b03a2e">list_preallocate_exact：cap == len，不多租</text>
<rect class="bx-q" x="20" y="92" width="220" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="130" y="116" text-anchor="middle" font-size="11" fill="#6b675e">[] 逐个 append</text>
<line class="fl" x1="240" y1="112" x2="296" y2="112" stroke="#6b675e" stroke-width="1.5" marker-end="url(#lstAs5)"/>
<rect class="bx" x="300" y="92" width="330" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="465" y="116" text-anchor="middle" font-size="11" fill="#6b675e">无法预知未来：容量按 4, 8, 16, 24… 跳变</text>
<text class="ts" x="20" y="158" font-size="12" fill="#6b675e">测量陷阱：拿构造器造样本会低估 append 场景的内存；同一个 list 在 3.12 与 3.14 尺寸不同</text>
</svg>
</figure>

这个分裂给性能测量添了个坑：`sys.getsizeof(list(range(n)))` 在新旧版本里数字不同（3.12 还会过度分配）。容量评估的脚本如果拿构造器造样本，会严重低估 append 场景的内存。要测过度分配，样本必须用 append 路径构造。

## 收缩：过半才动

扩容有公式，收缩也有对称的规矩。`list_resize` 开头有一条快速通道：新尺寸不小于已分配容量的一半时，只改 `ob_size`，不动内存；跌破一半才 realloc 缩小。

实测从 cap=1100 的 list 逐个 pop，精确捕捉到收缩点：

```text
cap 1100 → pop 到 len 550：缩到 620
cap  620 → pop 到 len 310：缩到 352
cap  352 → pop 到 len 176：缩到 200
```

每次都是半数触发、缩到增长序列的下一档。有了这条规矩，pop 也是均摊 O(1)：不至于每 pop 一次就 realloc 一次，也不至于只剩几个元素还占着原来的大分配。

值得留意的副作用：一个从百万元素 pop 到十个的 list，中间要经历约二十次半数收缩，每次都是全量指针搬运。所以最贵的消费方式是 pop 到一半就停：搬运的成本付了，内存却没退。想一次性砍掉一大段，用 `del lst[:k]`，只触发一次 resize，比逐个 pop 划算。

收缩的对称规矩：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 234" role="img" aria-label="半数收缩三连：cap 1100 的 list 逐个 pop，len 跌到 550 即容量一半时缩到增长序列下一档 620；620 pop 到 310 缩到 352；352 pop 到 176 缩到 200；未跌破一半时只改 ob_size 不动内存" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="lstAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">跌破一半才动：三次收缩实测</text>
<rect class="bx-q" x="20" y="40" width="230" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="135" y="62" text-anchor="middle" font-size="11" fill="#6b675e">cap 1100 · pop 到 len 550</text>
<line class="fl" x1="250" y1="58" x2="316" y2="58" stroke="#6b675e" stroke-width="1.5" marker-end="url(#lstAs3)"/>
<text class="ts" x="283" y="48" text-anchor="middle" font-size="10" fill="#6b675e">半数触发</text>
<rect class="bx" x="320" y="40" width="150" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="395" y="62" text-anchor="middle" font-size="11" fill="#6b675e">缩到 620</text>
<rect class="bx-q" x="20" y="90" width="230" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="135" y="112" text-anchor="middle" font-size="11" fill="#6b675e">cap 620 · pop 到 len 310</text>
<line class="fl" x1="250" y1="108" x2="316" y2="108" stroke="#6b675e" stroke-width="1.5" marker-end="url(#lstAs3)"/>
<rect class="bx" x="320" y="90" width="150" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="395" y="112" text-anchor="middle" font-size="11" fill="#6b675e">缩到 352</text>
<rect class="bx-q" x="20" y="140" width="230" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="135" y="162" text-anchor="middle" font-size="11" fill="#6b675e">cap 352 · pop 到 len 176</text>
<line class="fl" x1="250" y1="158" x2="316" y2="158" stroke="#6b675e" stroke-width="1.5" marker-end="url(#lstAs3)"/>
<rect class="bx" x="320" y="140" width="150" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="395" y="162" text-anchor="middle" font-size="11" fill="#6b675e">缩到 200</text>
<text class="ts" x="490" y="62" font-size="11" fill="#6b675e">每次都缩到增长序列</text>
<text class="ts" x="490" y="80" font-size="11" fill="#6b675e">的下一档；没跌破一半</text>
<text class="ts" x="490" y="98" font-size="11" fill="#6b675e">时只改 ob_size 不动内存</text>
<text class="ts" x="20" y="204" font-size="12" fill="#6b675e">pop 也是均摊 O(1)；最贵的消费方式是 pop 到一半就停：搬运付了、内存没退</text>
<text class="ts" x="20" y="224" font-size="12" fill="#6b675e">要砍一大段用 del lst[:k]：只触发一次 resize</text>
</svg>
</figure>

## insert(0)：比 append 慢五百倍

指针数组的成本集中在头部操作上。`insert(0, x)` 要把现有全部元素向后挪一格，对整个指针数组做一次 memmove：

```text
n=1,000     insert(0)×n   0.2 ms     append×n   0.03 ms
n=10,000    insert(0)×n  18.1 ms     append×n   0.30 ms
n=100,000   insert(0)×n  1806 ms     append×n   3.39 ms
```

十万元素时差五百倍，而且差距随 n 线性拉大。一百万次 `insert(0)` 累计约五千亿次指针搬运，1806ms 里几乎全是 memmove。`pop(0)` 同理对称。

两种操作的物理动作：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 276" role="img" aria-label="insert(0) 与 append 的物理动作对照：insert(0) 每次把整个指针数组向后 memmove 一格，十万次累计千亿级指针搬运耗时 1806 毫秒；append 只往过度分配的空槽里填一个指针，同样规模只要 3.39 毫秒，差五百倍" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="lstAs4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">insert(0)：每一次都是全队平移</text>
<rect class="bx" x="60" y="40" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="84" y="58" text-anchor="middle" font-size="10" fill="#6b675e">a</text>
<rect class="bx" x="116" y="40" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="140" y="58" text-anchor="middle" font-size="10" fill="#6b675e">b</text>
<rect class="bx" x="172" y="40" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="196" y="58" text-anchor="middle" font-size="10" fill="#6b675e">c</text>
<rect class="bx" x="228" y="40" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="252" y="58" text-anchor="middle" font-size="10" fill="#6b675e">d</text>
<line class="flc" x1="90" y1="76" x2="140" y2="92" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#lstAs4)"/>
<line class="flc" x1="146" y1="76" x2="196" y2="92" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#lstAs4)"/>
<line class="flc" x1="202" y1="76" x2="252" y2="92" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#lstAs4)"/>
<text class="tc" x="290" y="86" font-size="10" fill="#b03a2e">memmove：n 个指针整体后移一格</text>
<rect class="bx-sick" x="60" y="96" width="48" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="84" y="114" text-anchor="middle" font-size="10" fill="#6b675e">x</text>
<rect class="bx" x="116" y="96" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="140" y="114" text-anchor="middle" font-size="10" fill="#6b675e">a</text>
<rect class="bx" x="172" y="96" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="196" y="114" text-anchor="middle" font-size="10" fill="#6b675e">b</text>
<rect class="bx" x="228" y="96" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="252" y="114" text-anchor="middle" font-size="10" fill="#6b675e">c</text>
<rect class="bx" x="284" y="96" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="308" y="114" text-anchor="middle" font-size="10" fill="#6b675e">d</text>
<text class="ts" x="20" y="156" font-size="12" fill="#6b675e">append：只填进过度分配的空槽，谁也不用动</text>
<rect class="bx" x="60" y="166" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="84" y="184" text-anchor="middle" font-size="10" fill="#6b675e">a</text>
<rect class="bx" x="116" y="166" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="140" y="184" text-anchor="middle" font-size="10" fill="#6b675e">b</text>
<rect class="bx" x="172" y="166" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="196" y="184" text-anchor="middle" font-size="10" fill="#6b675e">c</text>
<rect class="bx" x="228" y="166" width="48" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="252" y="184" text-anchor="middle" font-size="10" fill="#6b675e">d</text>
<rect class="bx-gone" x="284" y="166" width="48" height="28" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<line class="fl" x1="308" y1="158" x2="308" y2="164" stroke="#6b675e" stroke-width="1.4" marker-end="url(#lstAs4)"/>
<text class="ts" x="350" y="184" font-size="10" fill="#6b675e">x 落进空槽：一次写入，零搬运</text>
<text class="ts" x="20" y="222" font-size="11" fill="#6b675e">n=100,000 实测：</text>
<rect class="bar" x="150" y="210" width="452" height="16" fill="#b03a2e"/>
<text class="onbar" x="158" y="222" font-size="10" fill="#f6f3ec">insert(0)×n：1806ms，几乎全是 memmove</text>
<rect class="bar" x="150" y="234" width="4" height="16" fill="#2b2a26"/>
<text class="tc" x="162" y="247" font-size="10" fill="#b03a2e">append×n：3.39ms · 500 倍差距随 n 线性拉大</text>
<text class="ts" x="20" y="270" font-size="12" fill="#6b675e">往头部加的场景交给 collections.deque（分块链表，两端 O(1)），或 append 完再 reverse()</text>
</svg>
</figure>

要倒序把元素装进 list，先 `append` 完再 `reverse()`（O(n) 一次），或者直接用 `collections.deque`：它是分块链表，两端插删都是 O(1)。list 的结构决定它擅长尾部增长和随机访问，这两件事它做得很快，下标访问就是一次指针数组的寻址。

## sort：挪的是指针

指针数组还顺带成就了一件事：`list.sort()` 的高效有一部分根基就在这里。排序挪动的只是指针，一次 8 字节，比较才调用元素自己的 `__lt__`。搬运和数据访问是分离的，对大对象排序时，Timsort 的归并搬移几乎免费，成本集中在比较本身。

3.14 的 sort 实现仍是 Timsort 的加强版（小段二分插入、识别既有顺序的 run、galloping mode），配合特化篇讲的比较操作自适应特化，`sort` 已经把「解释器里排序」的极限压得很低。同数据的排序在 C 层和 Python 层的差距，远小于想象。

## 各操作的成本

把主要操作并排放一起，成本就清楚了：

```text
append / pop        均摊 O(1)：12.5% 余量摊薄搬家
insert(0) / pop(0)  O(n)：每一次都是全队平移
sort                O(n log n)：挪指针不挪对象
list(range(n))      精确分配：3.13+ 的「一次性到货」优化
```

四种操作的成本，都由同一个指针数组结构决定。

## 观测手段与旧数字

```text
sys.getsizeof(lst)          指针数组尺寸；56 + 8*allocated
len(lst)                    元素个数 ob_size
lst.__sizeof__()            同上（同样不含元素对象本身）
tracemalloc / pymalloc 篇   元素本体的内存记在哪一层
```

评估 list 内存的经验公式：`56 + 8 × capacity` 是指针数组，再加上每个元素对象本体的总和。元素是小整数（-5..256 走共享缓存，见下一篇）时本体几乎不占空间；元素是独立字符串或对象时，本体通常比指针数组贵一个数量级。

旧数字要对着版本看：过度分配在 3.12 与 3.14 之间经历了精确分配改造，网上「list(range(8)) 占 120 字节」这类数字多半对应旧版本。另外 `getsizeof` 从不递归，嵌套结构的总量要自己算。

---

## 规矩写下来

list 的本体是指针数组。随机访问是一次寻址，头部插删是全队平移，快不快要先看操作再看容器。

append 的均摊 O(1) 来自过度分配：12.5% 的余量把一百万次增长压成约六十次 realloc，增长序列与源码公式逐项吻合。这等于赌 list 会继续增长，赌注只有 12.5%，而这个假设在真实代码里几乎总是成立。收缩是对称的，长度跌破容量一半才缩到下一档，所以 pop 也是均摊 O(1)，pop 到一半停下反而最贵。

3.13 之后构造器精确分配，`list(range(n))` 不再多租，测过度分配要用 append 路径造样本。insert(0) 慢五百倍由结构决定，往头部加的场景应该交给 deque 或 append+reverse。

对象头与本体的重量见《一只 Python 对象到底有多重》，dict 的分层设计见《哈希不直接决定位置，索引表才说了算》，小整数缓存见下一篇《三十个比特一间房》。Redis 的 quicklist 是另一条路线：链表串小数组，两端插删免费，见《第 513 个字段，房租涨了五倍》。
