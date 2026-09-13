---
title: 一个字符到底占几字节：CPython 的 str 与灵活字符串表示
description: 同样十个字符，"a"×10 是 51 字节、"中"×10 是 78 字节、"😀"×10 是 100 字节；拼接产物 `is` 比对永远失败，字面量却常常 True。本文从 PEP 393 的三种结构出发，拆开 maxchar 宽度决策、compact 与 legacy 布局、懒哈希、latin1 单例与驻留机制，讲清字符宽度、UTF-8 缓存与对象身份各自的来源。实验在 CPython 3.14.7 上完成，源码对照 3.12.13 与 3.16.0a0。
pubDate: 2026-09-10T10:00:00+08:00
category: cpython
tags: [CPython, 编程语言, 内存管理, Unicode]
---

```text
"a"  × 10    getsizeof =  51 bytes
"é"  × 10    getsizeof =  67 bytes
"中" × 10    getsizeof =  78 bytes
"😀" × 10    getsizeof = 100 bytes
```

四组数字来自 CPython 3.14.7，都是十个字符的串：

```python
import sys

for s in ("a" * 10, "é" * 10, "中" * 10, "😀" * 10):
    print(len(s), sys.getsizeof(s))
```

```text
10 51
10 67
10 78
10 100
```

字符数相同，重量差了近一倍。「Python 字符串一个字符占几字节」这个问题的答案不在语言规范里，在 PEP 393 定下的灵活字符串表示（Flexible String Representation）里：每只 str 对象按自己的内容，从三种字符宽度里挑最窄的一种。

上一篇讲 dict 时反复用到 str 的几个特性：键表依赖「str 自带哈希缓存」、驻留让 `is` 成立、`me_hash` 可以省掉。这一篇把这三处的机制讲清。

先把整篇最重要的结构分层画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 192" role="img" aria-label="PEP 393 的三种字符串结构，高度按 sizeof 等比：PyASCIIObject 40 字节纯 ASCII 数据紧贴结构体；PyCompactUnicodeObject 56 字节带 UTF-8 缓存槽；PyUnicodeObject 64 字节子类专用，数据搬去独立块" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三种结构，三个 sizeof（C 编译器直接量出）</text>
<rect class="bx-q" x="30" y="76" width="180" height="64" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="120" y="98" text-anchor="middle" font-size="11" fill="#2b2a26">PyASCIIObject</text>
<text class="ts" x="120" y="116" text-anchor="middle" font-size="11" fill="#6b675e">40 字节</text>
<text class="ts" x="120" y="132" text-anchor="middle" font-size="10" fill="#6b675e">纯 ASCII：数据紧贴结构体</text>
<rect class="bx" x="240" y="58" width="180" height="82" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="80" text-anchor="middle" font-size="11" fill="#2b2a26">PyCompactUnicodeObject</text>
<text class="ts" x="330" y="98" text-anchor="middle" font-size="11" fill="#6b675e">56 字节</text>
<text class="ts" x="330" y="114" text-anchor="middle" font-size="10" fill="#6b675e">非 ASCII compact：</text>
<text class="ts" x="330" y="130" text-anchor="middle" font-size="10" fill="#6b675e">多 16 字节 UTF-8 缓存槽</text>
<rect class="bx-sick" x="450" y="46" width="180" height="94" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="540" y="68" text-anchor="middle" font-size="11" fill="#2b2a26">PyUnicodeObject</text>
<text class="ts" x="540" y="86" text-anchor="middle" font-size="11" fill="#6b675e">64 字节</text>
<text class="ts" x="540" y="102" text-anchor="middle" font-size="10" fill="#6b675e">子类专用 legacy：</text>
<text class="ts" x="540" y="118" text-anchor="middle" font-size="10" fill="#6b675e">数据搬去独立块，</text>
<text class="ts" x="540" y="132" text-anchor="middle" font-size="10" fill="#6b675e">两块内存</text>
<text class="ts" x="20" y="166" font-size="12" fill="#6b675e">每只 str 按内容从三种里挑一种：挑中前两种的都是 compact，结构体与数据同住一次分配</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">PEP 393 自 3.3 定型：3.12 / 3.14 / 3.16.0a0 三个版本逐项一致，十三年没动过布局</text>
</svg>
</figure>

三个结构的字节数不是估算，是本机用 C 编译器直接量出来的 `sizeof`。它们和 `sys.getsizeof` 的关系，下文逐层展开。

本文实验以 CPython 3.14.7 为主（x86_64 Linux，64 位，默认 GIL，非 debug），并与 CPython 3.12.13 对照。源码结构另核对本地一份标记为 CPython 3.16.0a0 的开发快照；该目录没有 Git 元数据，无法对应到具体提交。结构、宽度决策与驻留规则都是这两个版本的实现事实，不是 Python 语言的承诺。

## PyASCIIObject：40 字节里放了什么

最常遇到的 str 是纯 ASCII 串，用最短的结构：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 262" role="img" aria-label="PyASCIIObject 的 40 字节分解：PyObject 公共前缀 16 字节、length 8 字节记字符数、hash 8 字节懒缓存负一表示未算、state 位域 4 字节塞下 interned、kind、compact、ascii、static 五面旗加填充，之后是 len+1 字节的数据区含结尾 NUL" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">40 字节结构体 + 数据区：每级都是 40 + n + 1</text>
<rect class="bx" x="30" y="40" width="400" height="34" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="40" y="61" font-size="11" fill="#6b675e">PyObject 公共前缀：引用计数 + 类型指针</text>
<text class="ts" x="440" y="61" font-size="11" fill="#6b675e">16 字节</text>
<rect class="bx-q" x="30" y="74" width="400" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="40" y="91" font-size="11" fill="#6b675e">length：字符数（不是字节数）</text>
<text class="ts" x="440" y="91" font-size="11" fill="#6b675e">8 字节</text>
<rect class="bx-q" x="30" y="100" width="400" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="40" y="117" font-size="11" fill="#6b675e">hash：懒缓存，−1 = 还没算过</text>
<text class="ts" x="440" y="117" font-size="11" fill="#6b675e">8 字节</text>
<rect class="bx-sick" x="30" y="126" width="400" height="22" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="40" y="141" font-size="11" fill="#6b675e">state 位域：一只 str 的全部身份 metadata</text>
<text class="ts" x="440" y="141" font-size="11" fill="#6b675e">4 字节</text>
<rect class="bx-q" x="30" y="148" width="400" height="40" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="40" y="172" font-size="11" fill="#6b675e">数据区：每字符 1 字节（ASCII），结尾带 NUL</text>
<text class="ts" x="440" y="172" font-size="11" fill="#6b675e">len + 1</text>
<rect class="bx" x="30" y="200" width="98" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="79" y="216" text-anchor="middle" font-size="9" fill="#6b675e">interned 2 位</text>
<rect class="bx" x="132" y="200" width="80" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="172" y="216" text-anchor="middle" font-size="9" fill="#6b675e">kind 3 位</text>
<rect class="bx" x="216" y="200" width="86" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="259" y="216" text-anchor="middle" font-size="9" fill="#6b675e">compact 1 位</text>
<rect class="bx" x="306" y="200" width="80" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="346" y="216" text-anchor="middle" font-size="9" fill="#6b675e">ascii 1 位</text>
<rect class="bx" x="390" y="200" width="86" height="24" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="433" y="216" text-anchor="middle" font-size="9" fill="#6b675e">static 1 位</text>
<rect class="bx-gone" x="480" y="200" width="100" height="24" rx="2" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="530" y="216" text-anchor="middle" font-size="9" fill="#6b675e">填充 24 位</text>
<text class="ts" x="20" y="244" font-size="12" fill="#6b675e">实测 getsizeof("x"*n)：0→41、10→51、1000→1041；空串也留 1 字节 NUL</text>
</svg>
</figure>

`state` 是一个 32 位位域，塞着六件事：interned（2 位）、kind（3 位）、compact（1 位）、ascii（1 位）、statically_allocated（1 位）、24 位对齐填充。一只 str 的全部身份 metadata 只花 4 字节。

验证尺寸公式：

```python
for n in (0, 1, 2, 10, 100, 1000):
    print(n, sys.getsizeof("x" * n))
```

```text
0    41
1    42
2    43
10   51
100  141
1000 1041
```

每一级都是 40 + n + 1。那个 +1 是结尾 NUL：str 不需要 C 风格终止符参与长度计算（`length` 字段说了算），但保留它能让 `PyUnicode_AsUTF8String` 一类接口零拷贝直出。空串报 41 而不是 40，即使零字符，数据区也留了那 1 字节。

`sys.getsizeof('abc')` 与 `'abc'.__sizeof__()` 完全相等（44）：exact str 不参与循环 GC、没有 managed preheader，`sys.getsizeof` 无任何加成。上一篇 dict 的 GC 头 16 字节加成，在这里不存在。这一点到子类那一节会反转。

## 一个字符变宽，全串跟着变宽

`PyUnicode_New` 的宽度决策只有一条主干：看整个串里码点最大的那个字符（maxchar）：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="宽度决策四档阶梯：全串最大码点小于 128 走 ASCII 每字符 1 字节结构 40；小于 256 走 latin1 结构 56 每字符 1 字节；小于 65536 走 BMP 每字符 2 字节；更大走 astral 每字符 4 字节；宽度整串统一，建串时一次定死" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">PyUnicode_New 只看一个输入：全串最大码点 maxchar</text>
<rect class="bx-q" x="20" y="40" width="170" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="105" y="58" text-anchor="middle" font-size="10" fill="#6b675e">maxchar &lt; 128 · ASCII</text>
<rect class="bx" x="200" y="40" width="190" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="295" y="58" text-anchor="middle" font-size="10" fill="#6b675e">PyASCIIObject</text>
<rect class="bx" x="400" y="40" width="230" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="515" y="58" text-anchor="middle" font-size="10" fill="#6b675e">40 + (len+1) × 1</text>
<rect class="bx-q" x="20" y="72" width="170" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="105" y="90" text-anchor="middle" font-size="10" fill="#6b675e">&lt; 256 · latin1</text>
<rect class="bx" x="200" y="72" width="190" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="295" y="90" text-anchor="middle" font-size="10" fill="#6b675e">PyCompactUnicodeObject</text>
<rect class="bx" x="400" y="72" width="230" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="515" y="90" text-anchor="middle" font-size="10" fill="#6b675e">56 + (len+1) × 1</text>
<rect class="bx-q" x="20" y="104" width="170" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="105" y="122" text-anchor="middle" font-size="10" fill="#6b675e">&lt; 65536 · BMP</text>
<rect class="bx" x="200" y="104" width="190" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="295" y="122" text-anchor="middle" font-size="10" fill="#6b675e">PyCompactUnicodeObject</text>
<rect class="bx-sick" x="400" y="104" width="230" height="28" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="515" y="122" text-anchor="middle" font-size="10" fill="#b03a2e">56 + (len+1) × 2</text>
<rect class="bx-q" x="20" y="136" width="170" height="28" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="105" y="154" text-anchor="middle" font-size="10" fill="#6b675e">更大 · astral（emoji）</text>
<rect class="bx" x="200" y="136" width="190" height="28" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="295" y="154" text-anchor="middle" font-size="10" fill="#6b675e">PyCompactUnicodeObject</text>
<rect class="bx-sick" x="400" y="136" width="230" height="28" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="515" y="154" text-anchor="middle" font-size="10" fill="#b03a2e">56 + (len+1) × 4</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">"a"×9 + "中" = 78 字节：一个字符升宽，全串跟着变宽，没有混合宽度存储</text>
<text class="ts" x="20" y="202" font-size="12" fill="#6b675e">宽度建串时一次定死、不可降；切片是新串，按切出的内容重选宽度</text>
</svg>
</figure>

宽度是整串统一的，没有混合宽度存储。九个 a 加一个中文字符：

```python
print(sys.getsizeof("a" * 10))        # 51：1 字节宽
print(sys.getsizeof("a" * 9 + "中"))  # 78：一个字符升宽，全串 2 字节
```

一个 BMP 字符让尺寸从 51 涨到 78：结构体从 40 换成 56，每字符从 1 字节涨到 2 字节。str 没有「降宽」操作，宽度在建串时一次定死，此后不变。

但「变宽」有另一面：派生串按新内容重新选宽。切片是新建对象：

```python
print(sys.getsizeof("中" * 10))          # 78：2 字节宽
print(sys.getsizeof(("中" * 10)[0:1]))   # 60：新串只含一个 BMP 字符，仍是 2 字节
print(sys.getsizeof("a" + "中"))         # 62：整个串 2 字节宽
print(sys.getsizeof(("a" + "中")[0]))    # 42：切出的 'a' 是新串，回到 ASCII
```

切片从不「继承」原串的宽度，它按切出来的内容重新走一遍 `PyUnicode_New`。上一行的 60 = 56 + 2×1 + 2，是单个 BMP 字符的 compact 串；下一行的 42 是 latin1 单例 'a'（下一节会讲为什么它不占 40+2）。

宽度决策的输入是 maxchar，不是「平均」也不是「首字符」。`"éa"` 与 `"aé"` 同宽，`"中a"` 与 `"a中"` 同宽；判定只看最大的那个码点。

## compact：结构体与数据同住一次分配

三种结构里，前两种都是 compact 的：结构体和字符数据在同一次 `PyObject_Malloc` 里，`PyUnicode_New` 按公式一次申请，数据紧跟结构体：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="PyCompactUnicodeObject 的 56 字节布局：前 40 字节是 PyASCIIObject 全部内容，再加 utf8_length 与 utf8 缓存指针各 8 字节，之后是 len+1 乘 kind 的数据区；UTF-8 缓存是懒的，C 层接口第一次调用才编码存入" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">56 = 40 + 两个 UTF-8 缓存槽字段</text>
<rect class="bx-q" x="30" y="40" width="400" height="44" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="40" y="66" font-size="11" fill="#6b675e">PyASCIIObject 的全部内容</text>
<text class="ts" x="440" y="66" font-size="11" fill="#6b675e">40 字节</text>
<rect class="bx-sick" x="30" y="84" width="400" height="24" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="40" y="100" font-size="11" fill="#6b675e">utf8_length：UTF-8 编码后的字节数</text>
<text class="ts" x="440" y="100" font-size="11" fill="#6b675e">8 字节</text>
<rect class="bx-sick" x="30" y="108" width="400" height="24" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="40" y="124" font-size="11" fill="#6b675e">utf8：懒缓存指针，C 层接口第一次调用才填</text>
<text class="ts" x="440" y="124" font-size="11" fill="#6b675e">8 字节</text>
<rect class="bx-q" x="30" y="132" width="400" height="36" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="40" y="154" font-size="11" fill="#6b675e">数据区（含 NUL）</text>
<text class="ts" x="440" y="154" font-size="11" fill="#6b675e">(len+1) × kind</text>
<text class="ts" x="20" y="194" font-size="12" fill="#6b675e">缓存计入 __sizeof__：100 个中文字符的串 258 字节，ctypes 直调 AsUTF8AndSize 后报 559</text>
<text class="ts" x="20" y="214" font-size="12" fill="#6b675e">Python 层的 s.encode('utf-8') 不碰它：返回独立 bytes，前后 getsizeof 纹丝不动</text>
<text class="ts" x="20" y="234" font-size="12" fill="#6b675e">ASCII 串的数据本身就是合法 UTF-8，不需要这两个字段：40 字节短结构就是这么省的</text>
</svg>
</figure>

compact 非 ASCII 比 ASCII 多出的 16 字节是 `utf8` 指针和 `utf8_length`：非 ASCII 串的 UTF-8 编码不再等于自身，需要时在这里懒缓存一份。这个缓存是给 C 层准备的：`PyUnicode_AsUTF8AndSize` 一类接口要求拿到 NUL 结尾的 UTF-8 视图，第一次调用时把编码结果缓存进对象，此后零拷贝。缓存会计入 `__sizeof__`：本机用 ctypes 直调该接口后，一只 100 个中文字符的串（258 字节）报告值涨到 559，恰好加上 300 字节 UTF-8 缓存加 1 字节 NUL。而 Python 层的 `s.encode('utf-8')` 不碰这个缓存（它返回独立的 bytes 对象），所以 encode 前后 `getsizeof` 纹丝不动。同一份 UTF-8，缓存在对象内部就计入对象尺寸，由 encode 交还成新对象则另算尺寸。

ASCII 串不需要这两个字段：它的数据本身就是合法 UTF-8，utf8 指针语义上等于数据指针，40 字节的短结构体就是这么省出来的。

## legacy：子类的两块内存

第三种结构只在 str 子类上出现。子类实例不能把数据紧贴结构体（继承体系里类型大小不可预测，数据内联会破坏 C 层的派生布局），所以退回两块内存的 legacy 布局：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="legacy 布局：PyUnicodeObject 结构体 64 字节，前 56 字节是 PyCompactUnicodeObject 全部内容，再加一个 data 指针指向另行分配的独立数据块；子类不能数据内联，因为继承体系里类型大小不可预测" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="strAs5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">str 子类：结构体与数据分家，两块内存</text>
<rect class="bx-q" x="30" y="44" width="300" height="48" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="40" y="72" font-size="11" fill="#6b675e">PyCompactUnicodeObject 全部内容</text>
<text class="ts" x="340" y="72" font-size="11" fill="#6b675e">56 字节</text>
<rect class="bx-sick" x="30" y="92" width="300" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="40" y="109" font-size="11" fill="#6b675e">data 指针 →</text>
<text class="ts" x="340" y="109" font-size="11" fill="#6b675e">8 字节</text>
<line class="fl" x1="180" y1="118" x2="420" y2="118" stroke="#6b675e" stroke-width="1.5" marker-end="url(#strAs5)"/>
<rect class="bx-gone" x="424" y="98" width="200" height="40" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="524" y="114" text-anchor="middle" font-size="10" fill="#6b675e">独立数据块：另行分配</text>
<text class="ts" x="524" y="130" text-anchor="middle" font-size="10" fill="#6b675e">(len+1) × kind</text>
<text class="ts" x="30" y="146" font-size="11" fill="#6b675e">sizeof(PyUnicodeObject) = 64</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">实测：getsizeof("abc") = 44，getsizeof(S("abc")) = 100 —— 同内容重 56 字节，还多一次 malloc</text>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">100 = 64 结构体 + 4 数据块 + GC 头 16 + managed preheader 16；快路径只认 exact str</text>
</svg>
</figure>

实测对比：

```python
class S(str):
    pass

print(sys.getsizeof("abc"))    # 44：40 + 3 + 1
print(sys.getsizeof(S("abc"))) # 100
```

子类的尺寸要多读一层。`S("abc").__sizeof__()` 报 68（64 结构体 + 4 数据块），`sys.getsizeof` 再加 32：str 子类是用户定义的堆类型实例，带 GC 头 16 字节与 managed preheader 16 字节。同样的文本内容，子类比 exact str 重 56 字节，还多一次独立分配。这就是 `PyUnicode_CheckExact` 在 C 源码里到处出现的原因：快路径只认 exact str，子类走通用路径。dict 键表的 UNICODE 形态、特化的 exact-type guard，判的都是它。

## 哈希：算一次，记一辈子

`PyASCIIObject` 里那个 hash 字段是懒缓存。建串时填 -1（「未算」），第一次被问哈希才算：

```c
static Py_hash_t unicode_hash(PyObject *self) {
    Py_hash_t hash = PyUnicode_HASH(self);
    if (hash != -1) {
        return hash;              /* 缓存命中 */
    }
    x = Py_HashBuffer(PyUnicode_DATA(self),
                      PyUnicode_GET_LENGTH(self) * PyUnicode_KIND(self));
    PyUnicode_SET_HASH(self, x);  /* 写回缓存 */
    return x;
}
```

这就是 dict 键表敢省掉 `me_hash` 的原因：exact str 键的哈希就存在键自己身上，用的时候 O(1) 取。list、tuple 没有这种缓存字段，哈希每次都现算。这也是 str 做 dict 键比 tuple 快的原因之一。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 182" role="img" aria-label="懒哈希流程：建串时 hash 字段填负一表示未算；第一次被问哈希才调 Py_HashBuffer 对内部宽度编码的字节算 siphash，写回字段后终身缓存；dict 键表因此省掉 me_hash 列" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="strAs6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">算一次，记一辈子</text>
<rect class="bx" x="20" y="44" width="140" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="90" y="64" text-anchor="middle" font-size="10" fill="#6b675e">建串</text>
<text class="ts" x="90" y="82" text-anchor="middle" font-size="10" fill="#6b675e">hash = −1（未算）</text>
<line class="fl" x1="160" y1="68" x2="196" y2="68" stroke="#6b675e" stroke-width="1.5" marker-end="url(#strAs6)"/>
<text class="ts" x="178" y="58" text-anchor="middle" font-size="9" fill="#6b675e">首次 hash(s)</text>
<rect class="bx-sick" x="200" y="44" width="180" height="48" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="290" y="64" text-anchor="middle" font-size="10" fill="#6b675e">Py_HashBuffer 算 siphash</text>
<text class="ts" x="290" y="82" text-anchor="middle" font-size="10" fill="#6b675e">按 length × kind 字节算</text>
<line class="fl" x1="380" y1="68" x2="416" y2="68" stroke="#6b675e" stroke-width="1.5" marker-end="url(#strAs6)"/>
<rect class="bx-q" x="420" y="44" width="220" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="530" y="64" text-anchor="middle" font-size="10" fill="#6b675e">写回 hash 字段：此后 O(1) 直取</text>
<text class="ts" x="530" y="82" text-anchor="middle" font-size="10" fill="#6b675e">dict 键表因此省掉 me_hash 列</text>
<text class="ts" x="20" y="122" font-size="12" fill="#6b675e">哈希带 PYTHONHASHSEED 随机种子；str 与 bytes 同源，hash("x") == hash(b"x")</text>
<text class="ts" x="20" y="144" font-size="12" fill="#6b675e">但 d["x"] 与 d[b"x"] 仍分家：哈希同槽只进同一条探测链，命中还要过 __eq__</text>
<text class="ts" x="20" y="166" font-size="12" fill="#6b675e">算过哈希即失去内部改动资格：StringIO、str.join 刻意避免提前算</text>
</svg>
</figure>

哈希按内部宽度编码后的字节算：`PyUnicode_DATA` 起、`length × kind` 字节长。于是有一个跨类型的副产品：

```python
print(hash("x") == hash(b"x"))    # True
print(hash("foo") == hash(b"foo"))  # True
```

str 与 bytes 的哈希函数都落到 `Py_HashBuffer` 上，同样的字节序列得到同样的 siphash 值。但别急着下结论：dict 查找是「哈希定位 + 相等确认」两步，`'x' == b'x'` 是 False：

```python
d = {"x": 1}
d[b"x"]     # KeyError：哈希同槽，相等不成立
```

哈希相同只是进了同一个探测链；能不能命中由 `__eq__` 说了算。这个例子同时复习了上一篇的探测机制：`b"x"` 与 `"x"` 在表里同槽相遇，又在 `__eq__` 处分手。

str 的哈希还带随机种子（`PYTHONHASHSEED`），每次进程启动都不同。上一篇讲过它的来历：3.3 之前的哈希碰撞 DoS 让 str 哈希默认随机化。`hash(42) == 42` 的规律性只属于小整数。

## 驻留：谁配拥有唯一身份

「两个字面量 `is` 比对为什么是 True」是 Python 面试的经典题，标准答案「小字符串缓存」其实是三套机制的混合。CPython 的内部文档 `InternalDocs/string_interning.md` 把它们分得很清楚。

第一套：静态单例。256 个 latin1 单字符（U+0000–U+00FF）、空串、以及全部 CPython 内部标识符，在运行时初始化时就静态分配完毕，全解释器唯一：

```python
print(chr(97) is "a")     # True：'a' 是静态单例，不是新对象
print("" is "")           # True：空串单例
```

`chr(97)` 每次调用返回同一个对象：单字符 latin1 串不进堆，`_Py_LATIN1_CHR` 直接查表。单例的尺寸还暴露一个细节：ASCII 区的单例报 42（40+2，标准公式），而 `'é'` 这类 128–255 区的单例报 61，即 56 的 compact 头加 2 字节数据，再加 3 字节 UTF-8 缓存。静态初始化宏 `_PyUnicode_LATIN1_INIT` 在生成这些单例时就填好了 `utf8` 指针（é 的 UTF-8 形式是 2 字节），因为 C API 里高频出现的正是单字符的 UTF-8 视图。这些单例是唯一一出生就带着 UTF-8 缓存的 str。BMP 之外的字符没有单例，`chr(0x4E2D) is "中"` 的结果就不保证了（实测本机为 False）。

第二套：编译期驻留。编译器把代码里出现的标识符、属性名、函数名、类名送进解释器级 interned dict（`co_names`、`co_varnames` 里的每个名字）。运行时的同名 str 与之 `is` 相等：

```python
def f(x):
    return x

print(f.__code__.co_varnames[0] is sys.intern("x"))   # True
```

第三套：动态驻留。`sys.intern()` 手动把任意 str 送进同一张表：

```python
def make(prefix):
    return prefix + "_tail"

a, b = make("x"), make("x")
print(a is b)                  # False：运行时拼接，两块内存
print(sys.intern(a) is sys.intern(b))   # True：驻留后同一身份
```

驻留表是一张普通 dict（键值都是同一个 str 对象）。入表的代价在引用计数上：interned dict 对对象的两条引用（键、值）不计入 `ob_refcnt`。对象多挂一份表内身份却不加计数，这样用户的最后一个引用消失时对象仍能正常析构、顺带把自己从表里摘掉。`interned` 位域的四种状态（未驻留 / 驻留 / 驻留且不朽 / 驻留且静态）标记的就是这些对应的清理方式。

驻留的收益在 dict 与属性查找：比较两个 interned 串可以先用指针判等，上一篇探测循环里 `ep->me_key == key` 那行指针短路，命中的正是驻留带来的身份相等。`LOAD_ATTR` 的特化也依赖它。

三套机制一张图：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="is 成立的三套机制：静态单例在解释器初始化时分配 256 个 latin1 单字符、空串与内部标识符；编译期驻留把代码里的标识符送进 interned dict；动态驻留靠 sys.intern 手动入表；运行时拼接永远是新对象" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">「字面量 is 为 True」的真相：三套机制，都不是语言承诺</text>
<rect class="bx-q" x="20" y="40" width="200" height="100" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="120" y="60" text-anchor="middle" font-size="11" fill="#2b2a26">① 静态单例</text>
<text class="ts" x="120" y="80" text-anchor="middle" font-size="10" fill="#6b675e">256 个 latin1 单字符</text>
<text class="ts" x="120" y="96" text-anchor="middle" font-size="10" fill="#6b675e">+ 空串 + 内部标识符</text>
<text class="ts" x="120" y="116" text-anchor="middle" font-size="10" fill="#6b675e">初始化时静态分配</text>
<text class="ts" x="120" y="132" text-anchor="middle" font-size="10" fill="#6b675e">chr(97) is "a" → True</text>
<rect class="bx" x="232" y="40" width="200" height="100" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="332" y="60" text-anchor="middle" font-size="11" fill="#2b2a26">② 编译期驻留</text>
<text class="ts" x="332" y="80" text-anchor="middle" font-size="10" fill="#6b675e">标识符、属性名、</text>
<text class="ts" x="332" y="96" text-anchor="middle" font-size="10" fill="#6b675e">函数名、类名进 interned dict</text>
<text class="ts" x="332" y="116" text-anchor="middle" font-size="10" fill="#6b675e">co_names / co_varnames 全员</text>
<text class="ts" x="332" y="132" text-anchor="middle" font-size="10" fill="#6b675e">运行时同名 str 与之 is 相等</text>
<rect class="bx" x="444" y="40" width="196" height="100" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="542" y="60" text-anchor="middle" font-size="11" fill="#2b2a26">③ 动态驻留</text>
<text class="ts" x="542" y="80" text-anchor="middle" font-size="10" fill="#6b675e">sys.intern() 手动入表</text>
<text class="ts" x="542" y="96" text-anchor="middle" font-size="10" fill="#6b675e">intern(a) is intern(b) → True</text>
<text class="ts" x="542" y="116" text-anchor="middle" font-size="10" fill="#6b675e">运行时拼接本身：永远新对象</text>
<text class="ts" x="542" y="132" text-anchor="middle" font-size="10" fill="#6b675e">a is b → False</text>
<text class="ts" x="20" y="170" font-size="12" fill="#6b675e">驻留表是普通 dict：键值两条引用不计入 ob_refcnt，最后一个用户引用消失时对象照常析构</text>
<text class="ts" x="20" y="192" font-size="12" fill="#6b675e">收益：探测循环的指针判等短路、LOAD_ATTR 特化；BMP 之外没有单例，chr(0x4E2D) is "中" 不保证</text>
<text class="ts" x="20" y="214" font-size="12" fill="#6b675e">边界：三套机制服务解释器自己的查找性能，a is b 做值比较永远是坏味道</text>
</svg>
</figure>

边界同样重要：驻留不是用户可以依赖的语言特性。字面量是否驻留、拼接是否折叠，都是解释器实现自由；`a is b` 用于值比较永远是坏味道。三套机制服务的是解释器自己的查找性能，不是 `is` 的语义保证。

## 谁不能被原地修改

str 不可变，但「不可变」在 C 层有更细的边界。`unicode_modifiable` 列出能被内部原地 resize 的条件：

```text
引用计数为 1（无别名）
哈希未计算过（hash == -1）
未被驻留
是 exact str（非子类）
```

四个条件全满足时，构建期的一些操作（如 `+=` 的内部优化路径）可以原地扩容；任何一条不满足，就走「新建 + 拷贝」。哈希已算这条最微妙：一旦对象被问过哈希，它就不能再被内部改动，缓存住的哈希必须永远对应同一份内容。用户层面感知不到这条边界，但它解释了一个现象：`io.StringIO`、`str.join` 这类内部构建路径会刻意避免提前算哈希。

## 三版对照：又一套十年稳定

本文全部实验在 3.12.13、3.14.7、3.16.0a0 上输出完全一致：宽度阶梯、结构尺寸（40/56/64）、驻留行为、latin1 单例、str/bytes 哈希一致，逐项相同。PEP 393 自 3.3 定型，十三年没有动过布局。对比 dict 篇的「十年稳定」，str 的稳定期更长。这两个使用频率最高的内置类型，恰恰是 CPython 里最保守的地基。

版本之间的差异在别处：interned 位域的语义（3.12 引入 SSTATE_INTERNED_IMMORTAL_STATIC 服务多解释器共享）、free-threaded 构建里 interned 字段从位域改为原子字节。布局数字不动，变的是并发与生命周期语义。

---

## 关于 str 的几条结论

一个字符占几字节，由全串最宽的字符决定：1、2、4 字节三档，一个 astral 字符让整串按 4 字节存放，九个 ASCII 字符拦不住。compact 与 legacy 是分配方式的差异，不是内容的差异：exact str 单块分配（结构体加数据），子类两块分配，同内容相差 56 字节与一次 malloc。

哈希是懒缓存，算一次就存在对象头里，dict 键表因此省掉 `me_hash`；算过哈希的串永远失去内部改动的资格。str 与 bytes 哈希同源，同样的字节序列得到同样的 siphash，但 dict 命中还要求 `==`，跨类型查找仍会 KeyError。

`is` 成立是三套机制的副产品，不是承诺：latin1 单字符与空串是静态单例，编译期驻留标识符，`sys.intern` 手动入表；运行时拼接永远是新对象。宽度不可降，内容可重建：切片、连接都新建对象并按新内容重选宽度。单字符 latin1 不进堆，256 个静态单例解释了 `chr(97) is 'a'`；BMP 以外没有这层缓存。

上一篇 dict 的键表反复引用 str 的两个特性：自带哈希缓存、驻留可指针判等。这一篇把两处都讲清了：键表省下的 `me_hash` 存在 str 头部，探测循环里的指针短路来自 interned dict。

dict 篇还留了一个更早的钩子：属性查找。`obj.x` 的完整链路要翻实例字典、类型 MRO，还要面对 data/non-data 描述符的优先级。实例 `__dict__` 已经拆过，下一篇走完这条链：`LOAD_ATTR` 的字节码路径、`__slots__` 与描述符的会师之处，以及 `property`、`super()` 背后的机制。
