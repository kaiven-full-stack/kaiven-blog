---
title: 0.1 + 0.2 为什么不等于 0.3：CPython 的 float 与 IEEE 754
description: 0.1 + 0.2 与 0.3 只差一个 ULP，却判为不相等。本文拆开 double 的符号位、指数、尾数三段布局，实测 2**53 精度悬崖与「向偶数舍入」，解释 repr 的最短往返算法怎么把 0.10000000000000000555 印成 0.1、hash(1.0) == hash(1) 背后的数学哈希，最后与 int 篇对照：为什么一个无限延伸、一个定死 64 位。实测基于 CPython 3.14.7。
pubDate: 2026-09-10
category: cpython
tags: [CPython, Python]
---

```text
>>> 0.1 + 0.2 == 0.3
False
>>> 0.4 - 0.1 == 0.3
False
>>> 0.1 + 0.2 - 0.3
5.551115123125783e-17
```

三行输出看着荒谬，其实都来自同一张 64 位的编码表。

int 篇讲过 CPython 对整数不设上限：30 比特一个 digit，数字无限延伸。float 正好相反，边界精确到比特：64 位，符号 1 位、指数 11 位、尾数 52 位，一个比特都不能多。这条边界由 IEEE 754 双精度标准划定，CPython 只是严格执行它。

这一篇把问题逐个拆开：0.1 到底是个什么数、2**53 的悬崖为什么在那里、repr 怎么决定印多少位、`hash(1.0) == hash(1)` 是巧合还是规定，最后与 int 篇对照：为什么一个选无限延伸、一个选定宽 64 位。实验环境是 CPython 3.14.7，源码来自 3.14 分支。

## PyFloatObject：朴素的 24 字节

PyFloatObject 是所有内置类型里最朴素的：

```c
typedef struct {
    PyObject_HEAD        /* 16 字节：引用计数 + 类型指针 */
    double ob_fval;      /* 8 字节：C double，没有别的了 */
} PyFloatObject;         /* 共 24 字节 */
```

`sizeof(1.0)` 实测 24 字节，对比 int 的 28 字节起步。float 永远是 24，因为 double 定宽，没有 digit 数组要伸缩。复杂度全不在结构里，在 `ob_fval` 这 8 个字节的编码规则里。

64 个比特分三段：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="double 的 64 位布局：符号 1 位、指数 11 位用偏移码存真实指数加 1023、尾数 52 位且规格化数隐含首位 1 所以实际 53 位有效数字；值等于正负 1 点尾数乘 2 的指数次方" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">64 个比特，三段分工（宽度按比例）</text>
<text class="tc" x="45" y="40" text-anchor="middle" font-size="10" fill="#b03a2e">符号</text>
<rect class="bx-sick" x="40" y="46" width="10" height="44" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx" x="50" y="46" width="100" height="44" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="100" y="64" text-anchor="middle" font-size="10" fill="#6b675e">指数 11 位</text>
<text class="ts" x="100" y="80" text-anchor="middle" font-size="9" fill="#6b675e">偏移码</text>
<rect class="bx-q" x="150" y="46" width="470" height="44" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="385" y="64" text-anchor="middle" font-size="10" fill="#6b675e">尾数 52 位（规格化数首位恒为 1，干脆不存）</text>
<text class="ts" x="385" y="80" text-anchor="middle" font-size="9" fill="#6b675e">52 位存储当 53 位用：2**53 悬崖的出处</text>
<text class="ts" x="100" y="110" text-anchor="middle" font-size="10" fill="#6b675e">真实指数 + 1023</text>
<text class="tc" x="20" y="140" font-size="12" fill="#b03a2e">值 = ±1.尾数 × 2^指数</text>
<text class="ts" x="20" y="164" font-size="12" fill="#6b675e">偏移码省掉负号位，还让同号数可以直接按位比大小</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">PyFloatObject 共 24 字节：16 字节对象头 + 这 8 字节的 ob_fval，没有别的了</text>
</svg>
</figure>

一个 double 的值是 `±1.尾数 × 2^指数`。指数段用「偏移码」存（真实指数 + 1023），既省一个负号位又让同号数可以按位比大小。尾数段还有个窍门：规格化数的首位永远是 1，干脆不存，52 位存储当 53 位用。这就是 2**53 那道悬崖的出处。

把 0.1 放进这张表，立刻看到问题所在：

```text
0.1 的真身 = 3602879701896397 / 2**55
           = 0.1000000000000000055511151231257827...
```

十进制的 0.1 是 1/10，分母含质因数 5，而二进制世界的分母只有 2。所以 1/10 在二进制下是无限循环小数（就像 1/3 在十进制下无限循环），53 位尾数装不下无限循环，只能舍入到最接近的表示。存进去的那一刻，0.1 就已经不是 0.1，是 0.1000000000000000055…。0.2、0.3 同理各有自己的偏差。

## 一 ULP 之差：加法为什么对不上

`0.1 + 0.2 == 0.3` 判 False 的机制可以精确到比特。用十六进制浮点表示（`float.hex()`）看四个数的精确值：

```text
0.1      = 0x1.999999999999ap-4
0.2      = 0x1.999999999999ap-3     （0.1 的两倍，尾数相同）
0.1+0.2  = 0x1.3333333333334p-2
0.3      = 0x1.3333333333333p-2
```

两个带偏差的数相加，误差也加了进去；相加结果再舍入到最近的 float，落在了 `...334`，而字面量 0.3 直接舍入到 `...333`。尾数末位差 1，即一个 ULP（unit in the last place）。

判定相等用的是 `==`，浮点的 `==` 是逐位精确比较（同值不同表示如 +0.0/-0.0 除外），不做任何容差。差一个 ULP 就是不等，哪怕差值只有 5.55e-17。

那一个 ULP 在哪：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="0.1+0.2 与 0.3 的尾数逐位对照：两个数的十六进制尾数前十二位都是 3，只差最后一位，加法结果是 4，字面量 0.3 是 3；一个 ULP 的差距让逐位比较的等号判 False" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">0x1.333333333333?p-2：问号处差一位</text>
<text class="ts" x="20" y="70" font-size="11" fill="#6b675e">0.1 + 0.2</text>
<rect class="bx-q" x="110" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="128" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="146" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="164" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="182" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="200" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="218" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="236" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="254" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="272" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="290" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="308" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="326" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="344" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="362" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="380" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="398" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="416" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="434" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="452" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="470" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="488" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="506" y="52" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="524" y="69" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-sick" x="542" y="52" width="36" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="560" y="69" text-anchor="middle" font-size="10" fill="#b03a2e">4</text>
<text class="ts" x="20" y="122" font-size="11" fill="#6b675e">0.3</text>
<rect class="bx-q" x="110" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="128" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="146" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="164" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="182" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="200" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="218" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="236" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="254" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="272" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="290" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="308" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="326" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="344" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="362" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="380" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="398" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="416" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="434" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="452" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="470" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="488" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="506" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="524" y="121" text-anchor="middle" font-size="10" fill="#6b675e">3</text>
<rect class="bx-q" x="542" y="104" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.6"/>
<text class="tc" x="560" y="121" text-anchor="middle" font-size="10" fill="#b03a2e">3</text>
<line class="flc" x1="560" y1="78" x2="560" y2="100" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="590" y="94" text-anchor="middle" font-size="10" fill="#b03a2e">1 ULP</text>
<text class="ts" x="20" y="160" font-size="12" fill="#6b675e">两个带偏差的数相加，误差也加了进去：结果舍入到 …334，字面量 0.3 舍入到 …333</text>
<text class="ts" x="20" y="182" font-size="12" fill="#6b675e">== 逐位精确比较、无容差；工程答案：abs(a-b) &lt; epsilon，要精确用 decimal / fractions</text>
</svg>
</figure>

工程答案因此从来不是绕过 `==` 的技巧，而是换工具：要比较用 `abs(a-b) < epsilon`（带量纲的容差），要精确用 `decimal` 或 `fractions`。至于为什么，上文已经能解释到比特级。

还有一个工程事实：浮点误差会累积。十万次 `+=` 的朴素求和与 `math.fsum`（精确补偿求和）实测差 3.9e-10。用 float 累加金额时，最后的差额多半来自舍入的逐步积累，而不是哪里的 bug。

## 2**53 悬崖：尾数的物理边界

尾数 52 位存 53 位，意味着 double 能精确表示所有绝对值不超过 2**53 的整数；再往上，相邻整数之间的间距就会超过 1：

```text
2**53     = 9007199254740992      float 精确
2**53 + 1 = 9007199254740993      float 装不下——变成 9007199254740992.0
2**53 + 2 = 9007199254740994      又能装下（间距变成 2）
```

实测三连：

```text
int 4503599627370497 (2**52+1) → float 精确保留      （悬崖以下）
int 9007199254740993 (2**53+1) → 变成 9007199254740992
int 9007199254740995 (2**53+3) → 变成 9007199254740996  （向偶数舍入！）
```

最后一行暴露了 IEEE 754 的默认舍入规则「round to nearest, ties to even」：正中间的两个候选一样近时，选尾数为偶的那个。`+3` 距离 `+2` 和 `+4` 各 1，选了偶数的 +4。这条规则不是随意定的：统计上它让舍入误差无偏，一半向上、一半向下。

悬崖之上间距持续翻倍：`float(10**17+1)` 实测直接丢掉那个 +1（`1e+17`）。`float(big_int)` 再 `int()` 回来可能悄悄变值，这是 int 与 float 混用时最容易出错的一步。而 `10**17+1 == float(10**17+1)` 返回 False 至少是诚实的：Python 不假装那个 +1 还在。

悬崖两侧：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 234" role="img" aria-label="2 的 53 次方悬崖数轴：悬崖以下相邻整数间距为 1、个个精确；悬崖以上间距翻倍为 2，加 1 装不下落回 2 的 53 次方，加 3 距离加 2 与加 4 一样近，向偶数舍入落到加 4" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="fltAc3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">间距在悬崖处从 1 翻到 2，此后随指数继续翻倍</text>
<line class="axis" x1="40" y1="110" x2="620" y2="110" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="100" y1="100" x2="100" y2="120" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="100" y="138" text-anchor="middle" font-size="10" fill="#6b675e">2⁵³−2</text>
<line class="flk" x1="160" y1="100" x2="160" y2="120" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="160" y="138" text-anchor="middle" font-size="10" fill="#6b675e">2⁵³−1</text>
<line class="flc" x1="220" y1="52" x2="220" y2="128" stroke="#b03a2e" stroke-width="2.4"/>
<text class="tc" x="220" y="44" text-anchor="middle" font-size="11" fill="#b03a2e">悬崖 2⁵³</text>
<text class="ts" x="220" y="138" text-anchor="middle" font-size="10" fill="#6b675e">9007199254740992</text>
<line class="flk" x1="340" y1="100" x2="340" y2="120" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="340" y="138" text-anchor="middle" font-size="10" fill="#6b675e">+2</text>
<line class="flk" x1="460" y1="100" x2="460" y2="120" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="460" y="138" text-anchor="middle" font-size="10" fill="#6b675e">+4</text>
<line class="flk" x1="580" y1="100" x2="580" y2="120" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="580" y="138" text-anchor="middle" font-size="10" fill="#6b675e">+6…</text>
<line class="fl" x1="280" y1="100" x2="280" y2="120" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="3 2"/>
<text class="ts" x="280" y="138" text-anchor="middle" font-size="10" fill="#6b675e">+1?</text>
<line class="flc" x1="280" y1="88" x2="228" y2="88" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#fltAc3)"/>
<text class="tc" x="266" y="80" text-anchor="middle" font-size="10" fill="#b03a2e">装不下：落回 2⁵³</text>
<line class="fl" x1="400" y1="100" x2="400" y2="120" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="3 2"/>
<text class="ts" x="400" y="138" text-anchor="middle" font-size="10" fill="#6b675e">+3?</text>
<line class="flc" x1="400" y1="88" x2="452" y2="88" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#fltAc3)"/>
<text class="tc" x="416" y="80" text-anchor="middle" font-size="10" fill="#b03a2e">平局向偶数：落到 +4</text>
<text class="ts" x="40" y="166" font-size="11" fill="#6b675e">← 间距 1：个个精确 →</text>
<text class="ts" x="300" y="166" font-size="11" fill="#6b675e">← 间距 2：奇数没有落点 →</text>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">round to nearest, ties to even：平局选偶让舍入误差统计上无偏，一半向上一半向下</text>
<text class="ts" x="20" y="218" font-size="12" fill="#6b675e">跨悬崖的 int → float → int 往返会静默变值：转换后必须用 == 验收</text>
</svg>
</figure>

## repr：最短往返算法

内存里存的值和印出来给人看的，不是一回事：

```text
repr(0.1)   → '0.1'         （真身是 0.1000000000000000055511…）
repr(1/3)   → '0.3333333333333333'
'%.17g' % 0.1 → '0.10000000000000001'   （17 位全精度，不是 repr）
```

老 Python（≤3.1）用的正是 17 位全精度打印，每行代码都顶着 `0.10000000000000001` 这种数字。3.1 起 repr 换成最短往返算法（`float_repr` → `PyOS_double_to_string`，'r' 模式）：从 1 位到 17 位精度逐个试，找到最短的、读回来还是同一个 double 的十进制表示。

`'0.1'` 读回去恰好舍入到那个 `0x1.99...ap-4`，所以两位就够了。这里的规则不是四舍五入到几位，是在能唯一往返的前提下要最短。设计动机也直接：repr 要保证 eval(repr(x)) == x，多印的每一位都是读者用不上的信息。实验确认 `'%.1g' % 0.3` 读回也是 0.3 本尊；最短往返不一定唯一（'0.3' 与 '.3' 都行），算法保证的是最短且有往返保证。

最短往返的过程：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="repr 的最短往返算法：内存真身是 0x1.999999999999ap-4，从 1 位精度开始逐个尝试十进制表示，读回来能舍入到同一个 double 就停；'0.1' 两位即往返成功，所以 repr 印 0.1 而不是老版本的 17 位全精度 0.10000000000000001" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="fltAs4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">从 1 位试到 17 位：最短的、读回来还是同一个 double 的表示胜出</text>
<rect class="bx-q" x="20" y="44" width="220" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="130" y="66" text-anchor="middle" font-size="10" fill="#6b675e">内存真身</text>
<text class="ts" x="130" y="84" text-anchor="middle" font-size="10" fill="#6b675e">0x1.999999999999ap-4</text>
<line class="fl" x1="240" y1="74" x2="276" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#fltAs4)"/>
<rect class="bx" x="280" y="44" width="200" height="60" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="380" y="66" text-anchor="middle" font-size="10" fill="#6b675e">逐精度尝试 + 读回验证</text>
<text class="ts" x="380" y="84" text-anchor="middle" font-size="10" fill="#6b675e">'0' 往不往返 → '0.1' 往返 ✓</text>
<line class="fl" x1="480" y1="74" x2="516" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#fltAs4)"/>
<rect class="bx-sick" x="520" y="44" width="120" height="60" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="580" y="66" text-anchor="middle" font-size="12" fill="#b03a2e">repr → '0.1'</text>
<text class="ts" x="580" y="84" text-anchor="middle" font-size="10" fill="#6b675e">eval 读回同一个值</text>
<text class="ts" x="20" y="132" font-size="12" fill="#6b675e">老 Python（≤3.1）印 17 位全精度：0.10000000000000001，每位都是读者用不上的信息</text>
<text class="ts" x="20" y="154" font-size="12" fill="#6b675e">str 与 repr 在 float 上 3.2 起同款：调试别靠 print，用 float.hex() 看真身</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">JSON 序列化的 round-trip 也由这套最短算法保证</text>
</svg>
</figure>

`str` 与 `repr` 在 float 上 3.2 起完全同款。所以调试浮点问题时别依赖 print：`float.hex()` 看精确值，`struct` 看字节，上面表格里那些 `...999a`、`...334` 才是诊断时靠得住的证据。

## hash(1.0) 为什么等于 hash(1)

一个意料之外却刻意的等式：

```text
hash(1) == hash(1.0) == hash(True) == 1
hash(2.0) == hash(2)
```

dict 篇讲过：键的判等是「哈希相等 + `==` 成立」两条都过。而 `1 == 1.0` 是 True（数值相等，跨类型比较）。如果哈希不同，`d[1]` 和 `d[1.0]` 就会落到不同桶里，同一个相等的键查出两个条目，字典的等价类就分裂了。

所以 CPython 规定：数值相等的一切对象，哈希必须相等（连 True 也算，bool 是 int 的子类）。实现不靠巧合：`_Py_HashDouble` 把 double 分解成 `m × 2^e`，用模 2**61−1 的整数运算对尾数做数学哈希再按指数移位，算的是这个数的值，不是这串比特。1.0 和 1 的值相同，无论存储形态是 double 还是 digit 数组，哈希结果一致。

等式如何守住 dict 的等价类：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="数值哈希的等价类：int 1、float 1.0、bool True 三种存储形态经 _Py_HashDouble 的数学哈希都得到 1，于是 dict 里 d[1.0] 覆写 d[1] 只剩一个条目，set 里三个写法只剩一个元素；哈希算的是值不是比特" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="fltAs5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">值相等 → 哈希必须相等：否则相等的键会裂成两个桶</text>
<rect class="bx-q" x="20" y="44" width="110" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="75" y="66" text-anchor="middle" font-size="11" fill="#6b675e">1（int）</text>
<rect class="bx-q" x="20" y="88" width="110" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="75" y="110" text-anchor="middle" font-size="11" fill="#6b675e">1.0（float）</text>
<rect class="bx-q" x="20" y="132" width="110" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="75" y="154" text-anchor="middle" font-size="11" fill="#6b675e">True（bool）</text>
<line class="fl" x1="130" y1="62" x2="216" y2="98" stroke="#6b675e" stroke-width="1.4" marker-end="url(#fltAs5)"/>
<line class="fl" x1="130" y1="106" x2="216" y2="106" stroke="#6b675e" stroke-width="1.4" marker-end="url(#fltAs5)"/>
<line class="fl" x1="130" y1="150" x2="216" y2="114" stroke="#6b675e" stroke-width="1.4" marker-end="url(#fltAs5)"/>
<rect class="bx-sick" x="220" y="80" width="200" height="52" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="320" y="100" text-anchor="middle" font-size="11" fill="#b03a2e">值的数学哈希</text>
<text class="ts" x="320" y="118" text-anchor="middle" font-size="10" fill="#6b675e">m×2^e 分解 · 模 2⁶¹−1 运算</text>
<line class="fl" x1="420" y1="106" x2="466" y2="106" stroke="#6b675e" stroke-width="1.5" marker-end="url(#fltAs5)"/>
<rect class="bx-q" x="470" y="80" width="170" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="555" y="100" text-anchor="middle" font-size="12" fill="#2b2a26">全都 = 1</text>
<text class="ts" x="555" y="118" text-anchor="middle" font-size="10" fill="#6b675e">同一个桶，同一个键</text>
<text class="ts" x="20" y="192" font-size="12" fill="#6b675e">实测：d[1.0] 覆写 d[1] 只剩一条目；{1, 1.0, True} 只剩一个元素 —— 等价类的正确执行</text>
<text class="ts" x="20" y="210" font-size="12" fill="#6b675e">边角：inf 哈希 ±314159（源码彩蛋）；nan 哈希基于 id 且 nan != nan</text>
</svg>
</figure>

实测的连带后果：

```text
d = {1: 'int key'}; d[1.0] = 'float key'
→ {1: 'float key'}           （同键覆写）
{1, 1.0, True} → {1}          （set 里只剩一个元素）
```

这不是 bug，是等价类的正确执行。要记的边角：用 float 做 dict 键时，1 和 1.0 是同一个键，换写法不会多出一个条目。顺带 infinities 的哈希是 ±314159（π 的前六位，源码里写死的彩蛋），nan 的哈希基于对象 id 且 `nan != nan`，所以同一个 nan 对象 `in` 列表靠的是身份捷径（实测 True），两个不同来源的 nan 连和自己相等都做不到。

## 与 int 对照

把 int 和 float 逐项放在一起：

```text
              int                float
上限          无，digit 无限延伸    2**1024 溢出为 inf（OverflowError 转换时）
精度          精确（整数本体）       53 位尾数，十进制约 15–17 位
加法          O(位数) 进位链        1 条 CPU 指令（近似的！）
0.1           不适用（整数）        已是 0.10000...0555…
哈希          值的数学哈希          值的数学哈希（与 int 一致）
sizeof        28 + 4×digit        恒 24
```

结论与 int 篇一致：两种类型没有谁更对，各自适合各自的场景。科学计算与图形学要速度和硬件原生支持，一条 SSE 指令加四个 double，software bignum 给不了；金融与计数要精确，53 位尾数给不了。CPython 把两种都保留，边界写进文档。

还有一处对照值得记：int 有 -5..256 的常驻缓存，float 没有也不需要，实测 `float('1.0') is float('1.0')` 为 False（每次新对象）。原因上一篇讲过：int 的小值出现频率极高（循环下标、比较哨兵）且不可变，缓存收益大；float 的高频值没有类似的聚集模式，24 字节的分配成本也压得住。缓存与否跟着访问分布走，set 篇的墓碑、dict 篇的共享键，都是同一个逻辑。

## 观测工具

```text
float.hex() / float.fromhex()   看真身：0x1.999...ap-4
struct.pack('<d', x)            比特级检视
math.fsum / decimal / fractions 补偿求和 / 十进制精确 / 有理数精确
sys.float_info                  epsilon、max、mant_dig=53 的官方口径
```

还有几条边界：float 的 `==` 无容差，比较一律用带量纲的 epsilon；累加用 fsum 或 Kahan；跨悬崖的 `int ↔ float` 转换要 `==` 验收；`round()` 的银行家舍入与格式化的舍入是两套规则（`round(2.675, 2)` 得 2.67，因为 2.675 的存储值更接近 2.67）；JSON 序列化的 round-trip 由 repr 的最短算法保证。

---

## 边界写下来

float 是定宽 24 字节的对象包着一个 C double，复杂度全在 IEEE 754 的编码里：1 位符号、11 位偏移指数、52 位尾数，隐含首位凑成 53 位有效数字。

0.1 存进去的那一刻就不等于 0.1：十进制有限小数在二进制下无限循环，53 位截断产生固定偏差；0.1+0.2 与 0.3 差一个 ULP，`==` 逐位比较判 False，容差比较才是工程正解。悬崖在 2**53，间距随指数翻倍，平局向偶数舍入；int→float→int 的往返在悬崖之上会静默变值，必须 `==` 验收。

repr 是最短往返算法，保证 eval(repr(x)) == x，诊断浮点用 hex 表示，别依赖 print。数值哈希的规则是值相等则哈希相等：`_Py_HashDouble` 对值做数学哈希，所以 1 和 1.0 在 dict 里是同一个键。

int 买精确，付出的是分配和进位链；float 买速度，付出的是舍入和上限。CPython 两种都给，边界写进文档。

int 的任意精度见《三十个比特一间房》，str 的变宽布局见《一个字符到底占几字节》；哈希相等怎样参与键的判等，见《哈希不直接决定位置，索引表才说了算》；set 篇《dict 改了分层，set 为什么没改》的墓碑取舍与本篇的缓存取舍同理，都跟着访问分布走。
