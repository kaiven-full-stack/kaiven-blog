---
title: 缓存里存的不是源码，是编译结果：CPython 的 import 与 .pyc
description: 修改源文件后 import 却拿到旧行为，多数情况不是玄学：mtime 和字节数都没变。本文沿一次 import 走完 finder 与 loader 的分工、__pycache__ 的 16 字节头、marshal 载入比重新编译快 14 倍的原因，以及时间戳与哈希两种校验模式的攻防，把「为什么改了不生效」拆到源码层。实验环境为 CPython 3.14.7，x86_64 Linux。
pubDate: 2026-09-10
category: cpython
tags: [CPython, Python]
---

熟悉的一幕：mymod.py 的内容明明改了，`import mymod` 拿到的还是旧函数。事后查会发现文件的 mtime 没变、字节数也没变，于是 `__pycache__` 里的旧字节码被判为「仍然新鲜」。

每个 Python 程序员迟早撞上这一幕。多数人的解法是「删掉 __pycache__ 再试」，然后把它当作 Python 的小怪癖翻篇。但这个怪癖背后有一条完整的机制链：import 时到底发生了什么、缓存里存的到底是什么、新鲜与陈旧由谁判定。

字节码篇讲过求值循环怎么执行指令，异常表篇讲过 try 的跳转目标记在哪里，还没讲的是那些字节码从哪来。这一篇补上另一半：从 `import` 语句到可执行 code object 的完整过程。实验跑在 CPython 3.14.7 上，引用的代码来自 3.14 分支。

## import 要交付什么

`import mymod` 的交付物是一个模块对象，核心是一个 code object，即把源码完整编译后的产物：字节码指令、常量表、名字表、参数信息、行号映射、异常表。求值循环篇里帧的 `f_code` 指的就是它。

源码每次 import 都重新编译当然可行，但编译是实打实的成本。实测一个 44 字节的小模块：

```text
compile() ×1000 次      20.2 ms
marshal 载入 ×1000 次    1.4 ms

缓存命中比重新编译快 14.5 倍。
```

小模块尚且 14 倍，几千行的真实模块差距更大。.pyc 的全部意义就在这 14.5 倍里：把编译结果存盘，下次 import 直接装载。名字里的 c 是 compiled。

## 一次 import 的完整流程

`import mymod` 触发的流程，按执行顺序：

```text
1. 检查 sys.modules——模块已导入过？直接返回，后面全部跳过
2. 遍历 sys.meta_path 上的 finder，问「mymod 归你管吗」
   ├─ BuiltinImporter：内建模块（sys、builtins）
   ├─ FrozenImporter：冻结模块（启动用的 importlib 自己）
   └─ PathFinder：去 sys.path 的目录里找文件
3. PathFinder 对每个目录问 sys.path_hooks，拿到 FileFinder
4. FileFinder 按优先级探测文件后缀：
     mymod.cpython-314-x86_64-linux-gnu.so   （扩展模块，最高优先）
     mymod.py                                 （源码）
     mymod.pyc                                （无源字节码，最低）
5. finder 返回一个 loader（如 SourceFileLoader）
6. loader.exec_module 执行模块代码、绑定到模块对象、登记 sys.modules
```

两个常被忽略的点。第一，`sys.modules` 是最高优先级缓存：同一进程里第二次 import 根本不碰文件系统，这就是为什么「改了代码要重启进程」（除非用 importlib.reload）。第二，扩展模块、源码、字节码的优先级由 `_get_supported_file_loaders()` 的列表顺序写死，同目录下 `mymod.py` 和 `mymod.so` 并存时，.so 赢。

## __pycache__ 里到底是什么

源码 import 成功后（且目录可写），CPython 顺手把编译结果写成 `__pycache__/mymod.cpython-314.pyc`。实测解剖这个文件：

```text
245 字节 = 16 字节头 + 229 字节 marshal 载荷

偏移   字段          本例的值
0-3    magic         2b 0e 0d 0a    （版本指纹）
4-7    flags         0              （校验模式：时间戳）
8-11   mtime         1789008319     （源文件的 mtime）
12-15  source size   44             （源文件的字节数）
16-    marshal 载荷  code object 序列化
```

四样东西各有职责。

magic 是版本指纹。前两个字节随每个会改字节码格式的版本变化，后两个固定为 `0d 0a`。升级 Python 后旧 pyc 全部作废，magic 不匹配连读都不读。这也是 pyc 文件名里带 `cpython-314` 的原因：多版本共存，各用各的缓存。

flags 决定校验模式。0 是时间戳模式（默认），1 是无校验哈希，3 是校验哈希。

mtime 和 size 是默认模式的新鲜度证据，下一节的主角。

marshal 载荷是主体。marshal 是 CPython 专用的对象序列化格式，比 pickle 快得多、也封闭得多（跨版本不保证兼容，因为根本不需要）。对 code object，它按 `w_object` 的 TYPE_CODE 分支逐字段写出：

```c
W_TYPE(TYPE_CODE, p);
w_long(co_argcount);  w_long(co_stacksize);  w_long(co_flags);
w_object(co_code);            /* 字节码本体 */
w_object(co_consts);          /* 常量表：嵌套的函数 code object 也在里面 */
w_object(co_names);
w_object(co_localsplusnames); /* 局部变量名 */
w_object(co_filename);  w_object(co_qualname);
w_long(co_firstlineno);
w_object(co_linetable);       /* 行号映射，帧篇的断点信息 */
w_object(co_exceptiontable);  /* 异常表篇的那张表 */
```

值得停下来看一眼这份清单：求值循环篇的 co_code、帧篇的局部变量、异常表篇的 exceptiontable，之前几篇拆开看过的每个部件，都在 marshal 载荷里有自己的一行。.pyc 缓存的是编译产物本身：词法分析、PEG 语法分析、AST 优化、代码生成都已经做完，输出被整个存了下来，下次 import 全部不用重做。

反序列化同样直白：`marshal.loads(data[16:])` 一路读回，重建 code object。字节码篇讲过的自适应特化从头开始（缓存的 code 是未特化的干净版本），特化只发生在运行中的帧上，所以 pyc 与特化机制天然不冲突。

## 新鲜度判定：时间戳模式的攻防

import 时 loader 先找 pyc，找到不等于能用，头 16 字节要先过校验。时间戳模式的判定（`_validate_timestamp_pyc`）只有两条：

```text
pyc 里的 mtime == 源文件当前 mtime ？
pyc 里的 size  == 源文件当前字节数 ？
```

两条都过，缓存生效，源码连读都不用读（省掉的是读文件、解码、编译三步）。任一不过，判 stale，重新编译源码并回写 pyc。

正常编辑总会改 mtime，为什么缓存有时还是被判新鲜？因为判定依据是元数据，不是内容。三个漏洞逐一实测。

漏洞一：同秒覆盖。mtime 的粒度是秒（文件系统相关，纳秒精度时也常被挂载选项截断）。实验把文件内容整个换掉后用 `os.utime` 把 mtime 改回原值，size 变了，被第二条拦住，缓存正确失效。但若改写时恰好保持了字节数不变：

```text
把 "hello" 改成 "HELLO"（同为 5 字节），mtime 和 size 都不变
→ import 仍然拿到旧函数
```

实验复现成功，这是「改了不生效」的最纯粹形态。高速写代码加快速重跑的循环里，编辑器保存和上次编译落在同一秒、内容增删恰好抵消时就会踩中。现实的触发概率不高，但「删 __pycache__ 就好了」的都市传说，源头就是它。

漏洞二：时钟回拨。mtime 是墙上时间。把系统时钟拨回过去再改文件，新文件的 mtime 可能与旧 pyc 记录的一致。Redis 系列的过期篇讲过绝对时间戳的同一类软肋。

漏洞三：分布式构建。容器镜像、CI 缓存、网络文件系统里，源文件的 mtime 由打包工具或远端决定。Docker `COPY` 会保留构建上下文的 mtime，不同内容的文件带着相同 mtime 和相同 size 进入镜像时，缓存就会张冠李戴。Linux 发行版打包 Python 时普遍改用哈希模式，正是为了躲开元数据的不可靠。

## 哈希模式：为不可靠的时钟准备的

flags 的另外两档把新鲜度证据从元数据换成内容本身：

```text
checked-hash（flags=3）:  pyc 头里存源文件内容的 SHA-256（截断）
                          import 时重算源哈希，比对不一致 → 重新编译
unchecked-hash（flags=1）: 存哈希但 import 时不校验
                          ——「我相信构建时的源，之后源怎么变都与我无关」
```

生成方式（注意 3.14 的 CLI 已移除 `--invalidation-mode` 参数，用 API）：

```python
py_compile.compile('mymod.py',
                   invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
```

对照实验，三档模式面对「同长度内容替换」的反应：

```text
时间戳模式        hello   ← 旧字节码赢了（stale）
checked-hash      HELLO   ← 内容变了被抓住，重新编译
```

checked-hash 的代价是每次 import 都要读源文件并算哈希：省的是编译，不省读取。它防御的是元数据不可靠，mtime 不准、时钟回拨、镜像打包，内容哈希都不受影响。

unchecked-hash 则连源文件都不看。实测源文件被彻底改写后 import，拿到的仍是旧字节码；甚至删掉源文件，把 pyc 从 `__pycache__` 挪到模块同目录（无源形式，`mymod.pyc`），没有源码也能 import 成功。这是给分发场景设计的：源码是构建期的资产，运行环境只带走字节码。商业闭源 Python 模块、空间受限的镜像，都靠这条路。

unchecked 的信任是一次性的：构建时算好哈希写进头，之后源与 pyc 的任何分歧都以 pyc 为准。代价也直白：忘了更新 pyc 时，bug 修复永远不生效，且没有任何报错。

## 一个模块，三种形态

把三种物理形态并排，优先级与校验就全清楚了：

```text
mymod.py                  源码形态：+ __pycache__/mymod.cpython-314.pyc
                          import 时按 mtime+size 或哈希校验，可自动重编译

mymod.pyc（模块目录下）    无源形态：SourcelessFileLoader 直接装载
                          没有源码参照，永不重编译

mymod.cpython-314-*.so    扩展形态：C 扩展，最高优先级
                          marshal 的世界之外，是另一条 dlopen 路径
```

同目录下三种形态并存时，.so > .py > .pyc。这个顺序决定了「装了个包却感觉改源码没用」的另一类排查方向：可能你的 .py 根本没被 import，赢的是旁边的 .so。

## 观测与排查

```text
python -X importtime -c 'import mymod'    每个 import 花了多少毫秒
python -m py_compile mymod.py             手动编译（控制校验模式）
importlib.util.cache_from_source('m.py')  pyc 路径的官方算法
sys.modules                               进程内的最高缓存
rm -rf __pycache__                        玄学修复的原理：清空缓存强制重编译
PYTHONDONTWRITEBYTECODE=1                 完全不写 pyc（代价：每次全价编译）
```

`-X importtime` 特别值得常备：它能直接指出「import 慢」的元凶是哪一个包、是 finder 找得慢还是编译慢。缓存命中与否，时间数字上看得清清楚楚。

---

## 几条要记住的事实

import 的最高缓存是 sys.modules。改了代码不重启进程永远不生效，文件系统层面的事情只发生在进程首次导入时。

.pyc 缓存的是完整编译产物：16 字节头（magic、flags、新鲜度证据）加 marshal 序列化的 code object，字节码、常量、行号表、异常表全在里面，载入比编译快 14 倍以上。

默认校验依据 mtime 和 size，不依据内容。同秒同字节数的改写会让缓存误判新鲜，「改了不生效」的玄学就这一条；时间戳还会被时钟回拨和镜像打包欺骗。哈希模式把证据换成内容：checked-hash 每次重算源哈希，防元数据不可靠；unchecked-hash 构建后连源都不看，为分发而生，无源 .pyc 可独立 import。

三形态优先级 .so > .py > .pyc。「源码没生效」先确认赢家是谁，排查的第一现场是 `-X importtime`，不是删缓存。

缓存系统的经典取舍在这里以最小规模重演：校验要快，就得信任元数据，mtime 只要一次 stat；要准，就得多读一遍文件算哈希。CPython 把默认值押给前者，把选择权留给后者。押注输掉的时候，删掉 __pycache__ 强制重编译就是兜底手段，这也正是它每次都好使的原因。

pyc 载荷里的 co_code、co_linetable、co_exceptiontable 分别见《下一条指令藏在哪里》《不出事不花钱：3.11 把 try 的成本挪出了字节码》；绝对时间戳依赖墙上时钟的另一处见 Redis 系列《过期的键，不会准时消失》；magic 编号与《三十个比特一间房》里 lv_tag 的打包是同一类思路：都把版本和身份信息压进一个小字段。
