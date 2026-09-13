---
title: dict 改了分层，set 为什么没改：CPython 的 set 与开放寻址
description: 同样 170 个元素，set 占的内存接近 dict 的两倍。本文拆开 setobject.c 的单表开放寻址：LINEAR_PROBES 九连探、perturb 右移的递推、5/8 负载的扩容公式、tombstone 的复用规则，以及为什么 dict 改了分层设计而 set 没改，最后用全部同哈希的恶意键实测二次方退化。数据来自 CPython 3.14.7。
pubDate: 2026-09-10
category: cpython
tags: [CPython, Python]
---

```text
同样 170 个 int 元素：
dict（带值）  4,688 字节     27.6 B/条目
set（只有键）  8,408 字节     49.5 B/条目
```

只存一半的数据，占了近两倍的内存。这组对比是本文的起点。

dict 篇拆过「索引表 + 条目表」的分层哈希表：条目表紧凑连续，索引表只存小整数下标，删除不挖洞只标灰，这是 3.6 时代 dict 的大改。同一个解释器里还有另一张哈希表：set。它没有跟着改，仍是古典的开放寻址，单张表，槽内直接存键和哈希，碰撞了就地向后探。

于是有了开头那组数字：set 每存一个键，成本接近 dict 存一个键值对的两倍。set 没有被遗忘。分层设计的收益（插入序、共享键、紧凑条目）都属于 dict 独有的需求，set 一样用不上。这一篇拆开 set 的方案，看它贵在哪、换来什么，最后实测它的弱点。文中数据测自 CPython 3.14.7，源码以 3.14 分支为准。

## 只有一张表

PySetObject 没有分层：

```c
typedef struct {
    PyObject *key;       /* 8 字节：元素指针 */
    Py_hash_t hash;      /* 8 字节：缓存的哈希值 */
} setentry;

typedef struct {
    ...
    setentry *table;         /* 槽位数组本体 */
    Py_ssize_t fill;         /* 占用 + 墓碑 */
    Py_ssize_t used;         /* 实际元素 */
    setentry smalltable[8];  /* 前 8 槽内嵌，免 malloc */
} PySetObject;
```

对照 dict 的方案，差异一目了然：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="dict 与 set 的结构对照：dict 分两张表，索引表每项 1 到 4 字节指向紧凑的条目表，条目里 key、value、hash 连续存放；set 只有一张表，每个槽 16 字节直接存 key 指针和缓存哈希，槽位就是数据本身" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="setAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同样 170 个元素：dict 27.6 B/条目，set 49.5 B/条目</text>
<text class="t" x="20" y="48" font-size="12" fill="#2b2a26">dict：两张表分层</text>
<rect class="bx" x="20" y="58" width="20" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="40" y="58" width="20" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="60" y="58" width="20" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="80" y="58" width="20" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="100" y="58" width="20" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="120" y="58" width="20" height="20" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="150" y="72" font-size="10" fill="#6b675e">索引表：每项 1–4 字节</text>
<line class="fl" x1="70" y1="78" x2="70" y2="94" stroke="#6b675e" stroke-width="1.4" marker-end="url(#setAs1)"/>
<rect class="bx-q" x="20" y="98" width="250" height="22" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="145" y="113" text-anchor="middle" font-size="10" fill="#6b675e">条目：key · value · hash 连续存放</text>
<rect class="bx-q" x="20" y="120" width="250" height="22" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="145" y="135" text-anchor="middle" font-size="10" fill="#6b675e">条目表紧凑连续，删除标灰不挖洞</text>
<text class="t" x="350" y="48" font-size="12" fill="#2b2a26">set：单表开放寻址</text>
<rect class="bx-q" x="350" y="58" width="130" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="415" y="75" text-anchor="middle" font-size="10" fill="#6b675e">key 指针 8B</text>
<rect class="bx-sick" x="480" y="58" width="130" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="545" y="75" text-anchor="middle" font-size="10" fill="#6b675e">hash 8B</text>
<rect class="bx-q" x="350" y="84" width="130" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="480" y="84" width="130" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-q" x="350" y="110" width="130" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="480" y="110" width="130" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="350" y="156" font-size="10" fill="#6b675e">每槽 16 字节的 {key, hash} 二元组，碰撞就地向后探</text>
<text class="ts" x="20" y="188" font-size="12" fill="#6b675e">set 的槽位就是数据本身：哈希值每槽存一份，没有第二张表可以挪</text>
<text class="ts" x="20" y="208" font-size="12" fill="#6b675e">换来的是命中路径少一次间接寻址：百万元素查一万次，set 2.60ms 对 dict 3.53ms</text>
</svg>
</figure>

每槽 16 字节，dict 的索引项只要 1–4 字节，差距的主因就在这里。dict 把「表」和「数据」分开后，表可以缩到极致；set 的槽位就是数据本身，哈希值只能每个槽存一份，没有第二张表可以挪。

`fill` 与 `used` 的差值是墓碑（dummy）数，即被删元素留下的槽。dict 篇见过同款概念，但 set 的墓碑直接占着活动槽位、参与探测链，这笔成本后面单独说。

还有一处老设计：`smalltable[8]` 内嵌，小 set 的前 8 个槽直接长在对象体里，连 malloc 都省了。dict 的空表内嵌也是同款思路，但 set 起步就带 8 槽：空 set 216 字节，空 dict 只要 64 字节。小对象极多的场景里，这三倍差距不是零头。

## 探测：九连探再跳跃

碰撞处理决定开放寻址的性能。hash 落到槽 i，若被占，下一个位置怎么找？set 的做法分两段（`set_add_entry`）：

```c
i = hash & mask;
perturb = hash;
while (1) {
    /* 第一段：从 i 开始的 LINEAR_PROBES=9 次线性探测 */
    probes = (i + LINEAR_PROBES <= mask) ? 9 : 0;
    do { 检查 entry++; } while (probes--);
    /* 第二段：换阵地，重新散列 */
    perturb >>= 5;
    i = (i * 5 + 1 + perturb) & mask;
}
```

第一段是九连探：从落点开始一口气看接下来 9 个槽。线性探测的毛病是聚集（clustering），但小范围聚集几乎免费，9 个连续槽大概率同在一两个缓存行里，一次内存总线取数就全带回来了。第二段是跳跃：九连探落空说明这一带满了，`i*5 + 1 + perturb` 跳到表的另一头重来；`perturb` 每轮右移 5 位，把哈希值的高位比特逐步搅进探测位置，保证最坏情况下所有槽都会被访问到。

「先扫描后跳跃」是对缓存折中的产物：纯线性探测聚集严重，纯双重散列每次探测都可能缓存 miss，九连探用 9 次廉价探测换 1 次跳跃，在两者之间取平衡。dict 篇的 `perturb >>= 5` 递推与这里完全同源，dict 的索引表探测沿用了 set 的方案，只是不需要 LINEAR_PROBES：它的索引表小到整表都留在缓存里。

探测路径：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="set 的探测路径：hash 与 mask 定位落点后先做九连探，从落点起一口气看 9 个相邻槽，大概率同在一两个缓存行；九连探落空则按 i 乘 5 加 1 加 perturb 跳到表的另一头再来，perturb 每轮右移 5 位把哈希高位搅进位置，保证全覆盖" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="setAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">两段式探测：九连探吃缓存红利，跳跃保全覆盖</text>
<text class="tc" x="138" y="52" text-anchor="middle" font-size="10" fill="#b03a2e">hash &amp; mask 落点</text>
<rect class="bx-q" x="20" y="60" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="42" y="81" text-anchor="middle" font-size="10" fill="#6b675e">空</text>
<rect class="bx" x="68" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="90" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx-sick" x="116" y="60" width="44" height="34" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="138" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx" x="164" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="186" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx-q" x="212" y="60" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.6"/>
<text class="tc" x="234" y="81" text-anchor="middle" font-size="10" fill="#b03a2e">空 ✓</text>
<rect class="bx" x="260" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="282" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx" x="308" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="330" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx" x="356" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="378" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx" x="404" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="426" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx" x="452" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="474" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx" x="500" y="60" width="44" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="522" y="81" text-anchor="middle" font-size="10" fill="#6b675e">占</text>
<rect class="bx-q" x="548" y="60" width="44" height="34" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="570" y="81" text-anchor="middle" font-size="10" fill="#6b675e">空</text>
<path class="fl" d="M116 100 L116 110 L544 110 L544 100" fill="none" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="330" y="128" text-anchor="middle" font-size="11" fill="#6b675e">第一段：LINEAR_PROBES = 9，从落点起一口气看完（大概率同一两个缓存行）</text>
<path class="flc" d="M522 56 C 540 26, 580 26, 596 44" fill="none" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#setAs2)"/>
<text class="tc" x="470" y="36" text-anchor="middle" font-size="10" fill="#b03a2e">九连探落空 → 跳到表的另一头</text>
<text class="ts" x="20" y="156" font-size="12" fill="#6b675e">第二段：i = (i×5 + 1 + perturb) &amp; mask；perturb 每轮右移 5 位，把哈希高位逐步搅进位置</text>
<text class="ts" x="20" y="178" font-size="12" fill="#6b675e">右移递推保证最坏情况下所有槽都会被访问到：查找永远不会漏</text>
<text class="ts" x="20" y="200" font-size="12" fill="#6b675e">dict 的探测递推与此同源，但没有九连探：它的索引表小到整表常驻缓存</text>
</svg>
</figure>

## 扩容：fill 过五分之三就触发

`set_add_entry` 的收尾处写着扩容条件：

```c
if ((size_t)so->fill*5 < mask*3)
    return 0;                              /* 还够用 */
return set_table_resize(so, so->used>50000 ? so->used*2 : so->used*4);
```

fill 超过槽位的 3/5 就扩容，新尺寸取 used 的 4 倍（大表 2 倍）。注意分子是 fill 不是 used：墓碑也算压力，因为它们参与探测成本。实测的容量跳变点与公式一致：

```text
n=17   728 字节（32 槽）      n=21   2,264 字节（128 槽）
n=85  8,408 字节（512 槽）    n=171 33,064 字节（2048 槽）
```

8、32、128、512、2048，每个跳变点都在 fill 触及 3/5 时出现。对比 dict 的 2/3 负载上限，set 收得更紧：它没有索引表分摊探测成本，聚集在单表结构里更致命。

`used > 50000 ? ×2 : ×4` 这个分支是 2008 年 Guido 改的（commit 注释还在源码里）：大 set 翻 4 倍太浪费内存，改翻 2 倍；小表多翻一点，减少 rehash 频率。负载因子和扩容倍率的每个数字，背后都是探测成本、内存空转、rehash 频率三者的权衡。

公式与跳变点：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="set 扩容规则：fill 乘 5 大于等于 mask 乘 3 即触发，fill 含墓碑所以删除也在施压；新尺寸小表取 used 乘 4、超过五万元素取乘 2，取整到 2 的幂；实测容量跳变 8 到 32 到 128 到 512 到 2048" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="setAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">负载上限 3/5：fill（含墓碑）过线就扩</text>
<rect class="bx-sick" x="20" y="40" width="280" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="160" y="64" text-anchor="middle" font-size="11" fill="#b03a2e">fill × 5 ≥ mask × 3 ？</text>
<line class="fl" x1="300" y1="60" x2="336" y2="60" stroke="#6b675e" stroke-width="1.5" marker-end="url(#setAs3)"/>
<rect class="bx" x="340" y="40" width="300" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="490" y="58" text-anchor="middle" font-size="11" fill="#6b675e">新尺寸 = used×4（小表）/ used×2（&gt;50000）</text>
<text class="ts" x="490" y="74" text-anchor="middle" font-size="10" fill="#6b675e">取整到 2 的幂</text>
<rect class="bx-q" x="20" y="100" width="90" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="65" y="121" text-anchor="middle" font-size="11" fill="#6b675e">8 槽</text>
<line class="fl" x1="110" y1="117" x2="136" y2="117" stroke="#6b675e" stroke-width="1.4" marker-end="url(#setAs3)"/>
<rect class="bx-q" x="140" y="100" width="90" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="185" y="121" text-anchor="middle" font-size="11" fill="#6b675e">32 槽</text>
<line class="fl" x1="230" y1="117" x2="256" y2="117" stroke="#6b675e" stroke-width="1.4" marker-end="url(#setAs3)"/>
<rect class="bx-q" x="260" y="100" width="90" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="305" y="121" text-anchor="middle" font-size="11" fill="#6b675e">128 槽</text>
<line class="fl" x1="350" y1="117" x2="376" y2="117" stroke="#6b675e" stroke-width="1.4" marker-end="url(#setAs3)"/>
<rect class="bx-q" x="380" y="100" width="90" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="425" y="121" text-anchor="middle" font-size="11" fill="#6b675e">512 槽</text>
<line class="fl" x1="470" y1="117" x2="496" y2="117" stroke="#6b675e" stroke-width="1.4" marker-end="url(#setAs3)"/>
<rect class="bx-q" x="500" y="100" width="100" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="550" y="121" text-anchor="middle" font-size="11" fill="#6b675e">2048 槽</text>
<text class="ts" x="20" y="158" font-size="11" fill="#6b675e">实测对应点：n=17 · 728B · 32 槽　　n=21 · 2,264B · 128 槽　　n=85 · 8,408B · 512 槽　　n=171 · 33,064B · 2048 槽</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">dict 的上限是 2/3，set 收到 3/5：单表没有索引表分摊探测成本，聚集更致命</text>
<text class="ts" x="20" y="206" font-size="12" fill="#6b675e">分子是 fill 不是 used：墓碑也参与探测成本，删除同样在给扩容施压</text>
</svg>
</figure>

## 墓碑：删除不搬家，只立碑

删除是开放寻址最麻烦的操作。直接把槽清空，会截断经过它的探测链，后面同哈希的元素就「找不到了」：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="墓碑机制三行对照：B 的哈希落点是槽 10，被 A 挤到槽 11；若删 A 时直接清空槽 10，查 B 的探测链在空槽停下、误判不存在；set 的做法是槽 10 立墓碑，探测链遇碑跳过继续走，B 仍能找到，插入还可以复用墓碑槽" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="setAs4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">删除为什么不能直接清空槽：探测链会被截断</text>
<text class="ts" x="20" y="52" font-size="11" fill="#6b675e">初始：B 的落点是槽 10，被 A 挤到 11</text>
<rect class="bx" x="290" y="38" width="80" height="30" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="57" text-anchor="middle" font-size="10" fill="#6b675e">槽10 · A</text>
<rect class="bx-q" x="378" y="38" width="110" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="433" y="57" text-anchor="middle" font-size="10" fill="#6b675e">槽11 · B（hash→10）</text>
<text class="ts" x="20" y="100" font-size="11" fill="#6b675e">若删 A 直接清空：查 B 误判不存在</text>
<rect class="bx-gone" x="290" y="86" width="80" height="30" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="330" y="105" text-anchor="middle" font-size="10" fill="#6b675e">槽10 · 空</text>
<rect class="bx-q" x="378" y="86" width="110" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="433" y="105" text-anchor="middle" font-size="10" fill="#6b675e">槽11 · B 还在</text>
<line class="flc" x1="290" y1="128" x2="356" y2="128" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3"/>
<text class="tc" x="364" y="132" font-size="10" fill="#b03a2e">查 B：槽10 空 → 停 → 「不存在」✗</text>
<text class="ts" x="20" y="166" font-size="11" fill="#6b675e">set 的做法：立墓碑，链不断</text>
<rect class="bx-sick" x="290" y="152" width="80" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="330" y="171" text-anchor="middle" font-size="10" fill="#b03a2e">槽10 · 墓碑</text>
<rect class="bx-q" x="378" y="152" width="110" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="433" y="171" text-anchor="middle" font-size="10" fill="#6b675e">槽11 · B</text>
<line class="fl" x1="290" y1="194" x2="428" y2="194" stroke="#6b675e" stroke-width="1.4" marker-end="url(#setAs4)"/>
<text class="ts" x="436" y="198" font-size="10" fill="#6b675e">查 B：遇碑跳过 → 命中 ✓；插入可复用碑位</text>
<text class="ts" x="20" y="226" font-size="12" fill="#6b675e">规则：查找遇空槽停、遇墓碑跳过；插入记住第一个墓碑，找一圈没有就复用它</text>
<text class="ts" x="20" y="246" font-size="12" fill="#6b675e">代价：dict 的灰标记只占索引项 1 比特，set 的墓碑占满 16 字节一槽，还计入 fill</text>
</svg>
</figure>

set 的解法是墓碑（dummy）：删 A 时槽 10 换成一个特殊标记对象，占位但不等于任何键。探测链经过墓碑不停下（继续往后找），但插入遇到墓碑可以复用。于是：

```text
查找：空槽 → 停（不存在）；墓碑 → 跳过；匹配 → 命中
插入：记住第一个墓碑，找一圈没找到就复用它
```

实测的墓碑残留：一千个元素的 set 全部 discard 后，len=0 但 sizeof 纹丝不动，33 KB 的表原封不动，空了 99% 也不自动收缩。再往里 add，新元素住进墓碑的槽位，表也不涨。只有扩容 rehash 或显式重建（`set(s)`、`s |= set()`）才会清走墓碑、归还内存。

dict 篇的对应设计是「索引表标灰」，思想相同，但 dict 的灰标记只占索引项 1 个比特，set 的墓碑占满 16 字节一槽，这是单表结构付出的又一处成本。长时间增删循环的 set（比如滑动窗口的 id 集合），实际内存由历史峰值决定而非当前规模，容量评估时要记上。

## set 换回了什么

贵有贵的道理，set 也拿回了 dict 拿不到的东西。

成员检查与 dict 同速甚至更快。一百万元素的容器里查一万次：set 2.60 ms、dict 3.53 ms。dict 的 `in` 走完索引表还要跳到条目表核对，set 命中槽位即得键，单表结构少一次间接寻址。

frozenset 几乎是免费的。dict 可变、无法整体哈希，frozenset 可以缓存整表哈希值去做 dict 的键。set 和 frozenset 共享同一套布局（`sizeof` 完全相同），区别只有一个 `__hash__` 和一组不可变约束，这是「只有键没有值」的结构顺带带来的。

## 死穴实测：全部同哈希

开放寻址的性能系在哈希分布上。构造一组恶意键，哈希函数全部返回同一个值，古典方案立刻原形毕露：

```python
class Bad:
    def __hash__(self): return 42      # 所有人挤在同一个槽
    def __eq__(self, o): return self.v == o.v
```

实测往 set 里逐个插入：

```text
n=500    10.8 ms
n=1,000  43.3 ms     （2 倍规模 → 4 倍耗时）
n=2,000  162.8 ms    （2 倍规模 → 3.8 倍耗时）
```

标准的二次方曲线。九连探在这里帮不上忙（同一落点，探完 9 个还是同一批键），perturb 跳跃也只是换到另一批同样拥挤的槽，每次插入都要 O(n) 次比较才能找到空槽。dict 面对同样的攻击退化得更狠（它连 LINEAR_PROBES 都没有）。这也是 str 的哈希默认加盐（PYTHONHASHSEED）的原因之一：不让外部输入预测哈希分布。

二次方的形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 194" role="img" aria-label="全部同哈希的恶意键逐个插入 set 的耗时条形图：500 个 10.8 毫秒，1000 个 43.3 毫秒是 4 倍，2000 个 162.8 毫秒再约 4 倍，标准二次方曲线；每次插入都要 O(n) 次比较才能找到空槽" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">__hash__ 恒返回 42 的恶意键：规模翻倍，耗时翻两番</text>
<text class="ts" x="20" y="58" font-size="11" fill="#6b675e">n=500</text>
<rect class="bar" x="110" y="44" width="33" height="18" fill="#2b2a26"/>
<text class="ts" x="151" y="58" font-size="11" fill="#6b675e">10.8 ms</text>
<text class="ts" x="20" y="94" font-size="11" fill="#6b675e">n=1,000</text>
<rect class="bar" x="110" y="80" width="132" height="18" fill="#6b675e"/>
<text class="tc" x="250" y="94" font-size="11" fill="#b03a2e">43.3 ms · 2 倍规模 → 4 倍耗时</text>
<text class="ts" x="20" y="130" font-size="11" fill="#6b675e">n=2,000</text>
<rect class="bar" x="110" y="116" width="497" height="18" fill="#b03a2e"/>
<text class="onbar" x="120" y="130" font-size="10" fill="#f6f3ec">162.8 ms · 再 ×3.8</text>
<text class="ts" x="20" y="160" font-size="12" fill="#6b675e">防线一：str 哈希默认加盐（PYTHONHASHSEED），外部输入猜不到分布</text>
<text class="ts" x="20" y="182" font-size="12" fill="#6b675e">防线二：重写 __eq__ 必须配套重写 __hash__——「return 1」的老代码会把表滑进这张图</text>
</svg>
</figure>

日常代码里的「意外同哈希」没这么极端，但方向相同：自定义类不写 `__hash__` 时默认用 id，分布尚可；写了糟糕的 `__hash__`（比如 `return 1` 的老代码），set 的性能就会滑向上面那张表。重写 `__eq__` 时必须同时重写 `__hash__`，这既是语义要求（相等对象必须同哈希），也直接决定这张表的性能。

## 为什么 dict 改了，set 没改

回到开头的问题。3.6 的 dict 改分层时，set 明显是候选，为什么没动？

分层的三项收益逐条看：紧凑条目表，set 的条目本来就只有 key+hash，再分层要多一次间接寻址，白付；共享键配额，dict 实例的键可与对象属性共享（attribute 篇的那套），set 无此场景；插入序，set 语义上无序，白送也不要。反过来，分层把「表」和「数据」拆开后，单次访问从一次寻址变两次，恰好丢掉 set 现在成员检查的优势。

所以答案是：dict 的分层是为 dict 的需求定制的，set 的需求清单几乎全不重合。保持单表，set 拿到更快的命中路径和更简单的结构，付出的是每槽 16 字节、墓碑全额占位、更低的负载上限。两种哈希表并存于同一个解释器，是按需选型的结果；只有 216 字节的空 set 起步价，确实带着历史遗留的成分（smalltable 的 8 槽内嵌）。

## 观测与容量估算

```text
sys.getsizeof(s)             216 + 16 × 槽数（超出内嵌 8 槽后）
len(s) vs 容量跳变            8→32→128→512→2048（fill 3/5 触发）
sys.hash_info                哈希宽度、算法、PYTHONHASHSEED 的语义
s = set(s)                   清墓碑重建：长寿命高删除 set 的保养动作
```

容量估算的经验值：int 元素的 set 约 16 × n / 0.6 ≈ 27 字节/元素（不含元素本体；小 int 免费，见 int 篇），dict 键值对约 50 字节。set 的成本摊在每个键上，dict 的成本摊在每个键值对上，键和值差不多大时 dict 反而更省。这是选型时最容易弄反的一处。

几条边界：3.14 的 set 没有插入序保证（dict 有，3.7 起）；迭代中修改 set 会 RuntimeError（dict 同样）；墓碑表不自动收缩，峰值内存要按 fill 的历史最高点算。

---

## 单表方案的得与失

set 是单表开放寻址，每槽 16 字节存 {key, hash}。对比 dict 的索引表加条目表，它每键贵约一倍，换来命中路径少一次间接寻址。探测是「九连探 + perturb 跳跃」的混合：9 次线性探测吃缓存红利，`i*5+1+perturb`、`perturb >>= 5` 保证全覆盖；dict 的探测递推同源，但没有九连探。

fill 过 3/5 就扩容，小表 ×4、大表 ×2，跳变序列 8/32/128/512/2048 实测吻合；墓碑计入 fill，删除也在给扩容施压。删除立墓碑、探测链不断，空表不自动收缩：一千元素删光，33 KB 原样保留，长寿命 set 要用 `set(s)` 重建清碑。

同哈希是命门，二次方退化实测在案：全同哈希键 2 倍规模 4 倍耗时，`__eq__` 与 `__hash__` 的配套重写既是语义也是性能要求。dict 改了分层而 set 没改，不是欠账，是选型：分层的三项收益 set 全用不上，单表换来的命中速度和 frozenset 便利，是它自己的收益。

到这里三张哈希表都拆过了：CPython 的 dict 把索引和数据分层，CPython 的 set 守着古典开放寻址，Redis 的 dict 用链地址加渐进式 rehash。dict 和 set 在同一个解释器里给出两种方案，原因只有一个：需求不同。

dict 的分层设计见《哈希不直接决定位置，索引表才说了算》，本文处处与之对照；Redis 的链地址哈希表见《搬了一半的家，也照常开门营业》。空 set 的 216 字节构成见《一只 Python 对象到底有多重》，小 int 元素免费的原因见上一篇《三十个比特一间房》。
