---
title: 中间商不止一个：CPython 的编译流水线与 PEG
description: compile() 一步到字节码，中间其实过了四个中间商：tokenizer、PEG 解析器、符号表、代码生成加 CFG 优化。本文逐站拆开这条流水线，实测常量折叠发生在哪一站、-O 三个级别各裁掉什么、闭包变量如何被 symtable 判定成 cell 与 free，以及 3.9 换 PEG 后错误信息变具体的那遍二次解析。文中数据测自 CPython 3.14.7。
pubDate: 2026-09-10
category: cpython
tags: [CPython, Python]
---

```text
>>> compile('x = 1 + 2 * 3', '<t>', 'exec').co_consts
(None, 7)
```

源码里明明白白写着 1 + 2 * 3，字节码的常量表里只剩一个小整数 7。折叠是在哪一步做的？答案藏在流水线中段。

`compile()` 在 Python 里是一个黑盒函数：吃进字符串，吐出 code object。求值循环篇讲过盒子右边的事，字节码怎么被执行；import 篇讲过编译结果的缓存与校验。这一篇打开盒子本身：从源码字符到字节码的完整流水线，一共五站。实验在 CPython 3.14.7 上进行，源码来自 3.14 分支。

## 流水线全景：五站

compile.c 的文件头注释把路线图写得明明白白：

```text
源码字符串
  ↓ ①  tokenizer：字符流 → token 流
  ↓ ②  PEG 解析器：token 流 → AST
  ↓ ③  symtable：AST → 作用域与变量分类
  ↓ ④  codegen：AST → 指令序列
  ↓ ⑤  CFG 优化 + 装配：指令序列 → 字节码
code object
```

用 25KB 的真实文件（标准库 ast.py）给每站计时：

```text
ast.parse ×20（① + ②）    132.6 ms
compile   ×20（①到⑤全程）  133.8 ms
```

两组数字几乎相同：解析占掉了编译的一半时间，③④⑤三站加起来才另一半。这个分布也解释了 .pyc 缓存的价值：它缓存的是全部五站的产物（import 篇的 14.5 倍加速），而成本重心在解析。

逐站走进去。

## 第一站与第二站：tokenizer 和 PEG

tokenizer 负责把 `x = 1 + 2 * 3` 切成 NAME、EQ、NUMBER 一类的 token，纯词法，无结构。结构由解析器建立，而 3.9 起解析器是 PEG（Parsing Expression Grammar），取代了用了三十年的 LL(1)。

换 PEG 的动机是表达力。LL(1) 只许看一个前瞻 token 决定走哪条规则，语法因此被迫写得很别扭：左递归必须手工改写，模式匹配（3.10 的 match）在 LL(1) 下几乎写不出来。PEG 的每条规则是描述性的匹配尝试，天然支持回溯，一条路走不通，退回来换下一条。代价是理论上可能指数级回溯，解法是记忆化：`_PyPegen_is_memoized` 把「从这个位置尝试这条规则的结果」存进 memo 表，同一 (位置, 规则) 只算一次，把指数压回线性。生成的 parser.c 有三万八千行，全由语法文件生成。

回溯结构带来一个副产品：更好的错误信息。解析失败时 `_PyPegen_run_parser` 并不直接报错了事，而是清空状态、带着一套额外的 `invalid_*` 规则再解析一遍，这些慢而精细的规则专为诊断而设。实测几条：

```text
x = (1 + 2        →  "'(' was never closed"
if x > 1          →  "expected ':'"
def 123func():    →  "invalid decimal literal"
```

3.9 之前的错误信息基本只有 "invalid syntax" 一句。这第二遍解析用一次重复换来能直接指认错误的诊断，3.10 之后明显变具体的报错，出处就在这里。

第二站的交付物是 AST。`ast.dump` 看一眼 `x = 1 + 2 * 3`：

```text
Assign(targets=[Name('x')], value=BinOp(Constant(1), Add, BinOp(Constant(2), Mult, Constant(3))))
```

注意：AST 里 1 + 2 * 3 还是完整的树，没有任何折叠。折叠是下一站之后的事。

## 第三站：symtable 与变量分类

代码生成前，编译器必须先回答：每个名字在哪个作用域，是什么性质。这就是 symtable.c 的工作：遍历 AST，为每个作用域建一张符号表，把名字分成四类：

```text
local      本作用域赋值过
global     声明过 global
cell       本作用域赋值、且被内层作用域引用（做成了 cell）
free       只是引用、赋值在内层——闭包变量
```

分类规则就一条：在本作用域里有赋值语句，就是 local（除非 global/nonlocal 声明）。这条规则的推论是经典的 UnboundLocalError：函数里只要任何位置有 `x = ...`，整个函数的 x 都是 local，哪怕赋值在引用之后。

闭包的实测看得最清楚：

```python
def outer():
    x = 2
    def inner():
        return x
    return inner
```

编译产物的元数据直接给出 cell/free 的判定：

```text
outer.co_cellvars: ('x',)     ← x 被内层引用，做成 cell
inner.co_freevars: ('x',)     ← inner 里的 x 是 free，LOAD_DEREF 取值
```

`inner` 的字节码开头有一条 `COPY_FREE_VARS 1`、取值用 `LOAD_DEREF`。闭包不是运行时查找，是编译期就安排好的间接寻址。帧篇讲过 cell/free 的存储布局，这里补上了它们的出身：symtable 的分类结果。

## 第四站之后：codegen 与两级折叠

codegen（codegen.c）把 AST 翻译成指令序列。折叠从这里开始，而且分两级。

第一级在 AST 上（`_PyAST_Preprocess`，即 3.14 的 optimizer 符号与常量折叠）。开头的问题在这里有答案：`1 + 2 * 3` 的 BinOp 树在进 codegen 之前就被算成 `Constant(7)`，所以字节码里只有一条 `LOAD_SMALL_INT 7`。`"a" + "b" if True else "c"` 更进一步：常量拼接和死分支一起消失，`co_consts` 里只剩 `'ab'`，条件跳转一条不剩。

第二级在 CFG 上（flowgraph.c 的十几个 pass）。指令序列先被组织成基本块图，然后逐 pass 清扫：`remove_redundant_nops`（NOP 与 NOP 对消）、跳转链压缩（跳到跳转的改成直达）、死代码块删除、`JUMP_IF_FALSE_OR_POP` 变体折叠。实测 if/elif 链的产物：每个分支一条 `POP_JUMP_IF_FALSE` 直达下一个分支，尾部零冗余。

`-O` 系列开关也作用在这一段，且裁的是不同层的东西：

```text
optimize=0（默认）  全保留
optimize=1（-O）    assert 语句整条消失（实测 boom 字符串从 co_consts 里消失）
optimize=2（-OO）   再裁掉 docstring（模块和函数的都裁）
```

值得强调：-O 从不做激进优化。没有内联，没有循环展开，那些是 JIT 篇的 Tier 2 在运行时干的事。静态编译器只做「定义上安全」的折叠与清扫，因为它没有类型信息：`x + y` 可能是任何重载，只有 `1 + 2 * 3` 这种纯常量才敢下手。这个分工与特化机制一脉相承：编译期做小而安全的清理，热路径留给运行时的自适应特化。

装配最后一站（assembler）算栈深、排跳转偏移、生成异常表，异常表篇讲过的那张表就是在这里从 CFG 的基本块边生成的。五站到此交付 code object，随后被写进 pyc 的 marshal 载荷（import 篇的清单）。

## 实验对照：一图收拢

同一份源码在各站的形态变化，并排放好：

```text
源码      x = 1 + 2 * 3
AST       BinOp(1, +, BinOp(2, *, 3))     ← 树完整
symtable  x → local
codegen   LOAD_SMALL_INT 7; STORE_NAME x  ← 折叠完成
CFG 优化  （本例已无可优化）
```

这四行就是整条流水线的分工：结构在第二站成型，名字的作用域在第三站判定，常量的值在第四站算出，跳转效率在第五站打磨。每一站的产物都能亲手拿到：`ast.parse` 取第二站的结果，`co_cellvars`/`co_freevars` 是第三站的输出，`dis` 看第四五站的成品。

## 各站的自查方法

```text
ast.parse(src)                    拿到 AST（跳过后续站）
ast.dump(tree, indent=2)          树的完整视图
compile(src, f, 'exec', optimize=N) 三个优化级别对照
dis.dis(code)                     成品指令；co_consts 看折叠结果
symtable：co_cellvars / co_freevars / co_varnames  第三站的输出
```

调试「为什么我的代码被编译成这样」时，按流水线顺序逐站检查：AST 对不对（解析问题）、名字分类对不对（作用域问题）、常量对不对（折叠问题）、跳转对不对（CFG 问题）。按站排查，问题容易归位。

---

## 五站的分工

编译是五站流水线，解析占一半成本：tokenizer、PEG、symtable、codegen、CFG 加装配。25KB 文件的 parse 与 compile 耗时几乎相同，.pyc 缓存砍的就是这整条线。

PEG 用记忆化换表达力：回溯加 memo 把指数压回线性，换来左递归和模式匹配的支持；错误信息靠失败后的第二遍诊断性重解析。symtable 管作用域：「本作用域赋值即 local」推出 UnboundLocalError，co_cellvars 与 co_freevars 的配对是闭包的编译期出身。

折叠分两级，都是保守的：AST 级算常量表达式与死分支，CFG 级清 NOP 与冗余跳转；-O 和 -OO 裁掉的只是 assert 与 docstring。激进优化不在这里，在 JIT 的运行时。

Python 把这条流水线藏在 `compile()` 一个函数名的后面，又在 `ast`、`dis`、`co_*` 元数据里给每一站留了入口，想看哪一站都有对应的工具。

本篇与《下一条指令藏在哪里》（求值循环）首尾相接：那条流水线的终点是这篇的起点。异常表的生成见《不出事不花钱》，编译产物的缓存与校验见《缓存里存的不是源码，是编译结果》，运行时优化见《循环热起来之后，字节码去了哪里》，闭包变量的帧侧布局见《一次 await 究竟暂停了什么》。
