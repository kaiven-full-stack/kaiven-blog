---
title: Node 的四层：一次 require 从 JS 走到 syscall
description: Node.js 系列第一篇。把「Node 是能读文件的 JS」这句话拆成四层：JS 标准库、C++ 绑定、静态链入的依赖库、内核 syscall。strace 现场记录：require('fs') 全程零次文件打开，标准库的代码睡在 121MB 的二进制里，require 本地模块则实打实付出 12 个 syscall；readFileSync 是主线程上的 5 个 syscall 一条龙，同一次读交给 fs.readFile 就变成四个任务派给四条 libuv-worker 线程，每步干完往管道写 8 个字节给事件循环打铃；空启动约 1000 个 syscall，17.7 毫秒走到 loopStart；readFileSync 读三遍 256MB 文件，0.2ms 的接口被拖到 338ms，异步版窗口里 331 个快请求 p50 仍是 0.30ms。脚本结束时进程里挂着 11 条线程，执行你 JS 的只有 1 条。
pubDate: 2026-11-13
category: nodejs
tags: [Node.js, 运行时, libuv]
---

这个博客本身就跑在 Node 上。Astro 把八十来篇文章编译成静态站，干活的从头到尾都是 Node 进程。开一个拆 Node 的系列，算是就地取材。角度沿袭前面几个系列：不谈用法，谈现场。Redis 篇拆的是内存数据库的边界，内核系列拆的是内存管理，CPython 系列拆的是解释器，这一次轮到的问题是：一个 JS 运行时是怎么搭起来的。

第一篇不急着进任何具体机制，先把地图画出来。关于 Node 流传最广的一句话是「Node 是能读文件的 JS」。这句话把所有有意思的部分都一带而过了：JS 自己既读不了文件也开不了 socket，从你写下 `fs.readFile` 到数据真的到手，中间隔着好几层翻译。这一篇把一次 require 从最上面一层走到底，数清楚它路过几层、每层里谁在干活，每一步都用 strace 钉住。

版本钉在 Node 24 LTS，实验在两套环境里跑：宿主机 v24.20.0（glibc），以及 node:24-alpine 容器 v24.21.0（musl libc，装了 strace 6.19）。文中数字都注明出处，全部可复现。

## 四层，谁替谁翻译

Node 源码树的目录结构就是这张地图：`lib/` 是 JS，`src/` 是 C++，`deps/` 是一堆独立项目，三层之下是内核。一次调用从上往下穿：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 380" role="img" aria-label="四层地图：第一层 JS 标准库 lib/，第二层 C++ 绑定 src/，第三层依赖库 deps/ 静态链入二进制（V8、libuv、llhttp、OpenSSL 等），第四层内核，syscall 是唯一出口；左侧实线箭头表示下穿，右侧虚线箭头表示数据原路返回" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="nd1Ai1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-i" d="M0 0 L8 4 L0 8 Z" fill="#2b2a26"/></marker>
<marker id="nd1As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一次 fs.readFileSync 的四层下穿</text>
<line class="flk" x1="46" y1="46" x2="46" y2="326" stroke="#2b2a26" stroke-width="2" marker-end="url(#nd1Ai1)"/>
<text class="ts" x="46" y="40" text-anchor="middle" font-size="12" fill="#6b675e">下穿</text>
<line class="fl" x1="614" y1="324" x2="614" y2="52" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#nd1As1)"/>
<text class="ts" x="614" y="348" text-anchor="end" font-size="12" fill="#6b675e">数据原路返回</text>
<rect class="bx" x="80" y="44" width="500" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="100" y="66" font-size="14" fill="#2b2a26">第一层 · JS 标准库（源码 lib/）</text>
<text class="ts" x="100" y="86" font-size="12" fill="#6b675e">fs、http、path 本身就是 JS：API 形状、参数检查、流程编排</text>
<text class="ts" x="592" y="108" text-anchor="end" font-size="12" fill="#6b675e">internalBinding('fs')</text>
<rect class="bx" x="80" y="112" width="500" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="100" y="134" font-size="14" fill="#2b2a26">第二层 · C++ 绑定（源码 src/）</text>
<text class="ts" x="100" y="154" font-size="12" fill="#6b675e">把 JS 值翻译成 C 结构，把 C 结果翻译回 JS 值</text>
<text class="ts" x="592" y="176" text-anchor="end" font-size="12" fill="#6b675e">uv_fs_read()</text>
<rect class="bx-q" x="80" y="180" width="500" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="100" y="202" font-size="14" fill="#2b2a26">第三层 · 依赖库（deps/，静态链入二进制）</text>
<text class="ts" x="100" y="222" font-size="12" fill="#6b675e">V8 执行 JS · libuv 事件循环与异步 IO · llhttp 解析 HTTP</text>
<text class="ts" x="100" y="240" font-size="12" fill="#6b675e">OpenSSL 加密与 TLS · zlib/brotli/zstd 压缩 · ICU 国际化</text>
<text class="tc" x="568" y="202" text-anchor="end" font-size="12" fill="#b03a2e">本系列主战场</text>
<text class="ts" x="592" y="268" text-anchor="end" font-size="12" fill="#6b675e">read(fd, buf, len)</text>
<rect class="bx" x="80" y="272" width="500" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="100" y="294" font-size="14" fill="#2b2a26">第四层 · 内核</text>
<text class="ts" x="100" y="314" font-size="12" fill="#6b675e">syscall 是唯一出口：open、read、close、epoll_wait</text>
<text class="ts" x="20" y="356" font-size="12" fill="#6b675e">上面三层全部住在 node 这一个二进制文件里</text>
<text class="ts" x="20" y="374" font-size="12" fill="#6b675e">第四层在内核里，Node 只是它无数用户中的一个</text>
</svg>
</figure>

第一层，JS 标准库。你 require 的 fs、http、path，它们本身就是 JS，在源码树的 `lib/` 里。这一层的活是给 API 形状：参数检查、错误包装、流程编排。fs.readFile 的实现里「先 open、再 stat 拿大小、再 read」这套编排全是 JS 代码写的，只是它们自己碰不到磁盘。

第二层，C++ 绑定，`src/` 目录。JS 标准库通过 internalBinding 这样的入口调到这层，它干的是翻译：把 JS 的数字、字符串翻成 C 的结构，把 C 的结果翻回 JS 值。V8 堆和原生内存是两个世界，边界上的关卡就是它。

第三层，依赖库，`deps/` 目录，静态链接进 node 二进制。V8 负责执行 JS 和管理堆，libuv 负责事件循环和异步 IO，llhttp 解析 HTTP，OpenSSL 管 TLS 和加密，zlib、brotli、zstd 管压缩，ICU 管国际化。这一层没有一个是 Node 自己写的，每个都是独立项目，Node 更像一个集成商。`process.versions` 就是花名册，节选几行：

| 条目 | 版本 | 管什么 |
|---|---|---|
| v8 | 13.6.233.17-node.53 | 执行 JS，管堆和 GC |
| uv | 1.52.1 | 事件循环、异步 IO、线程池 |
| llhttp | 9.4.3 | HTTP/1.1 解析 |
| openssl | 3.5.7 | TLS 与加密 |
| zlib / brotli / zstd | 1.3.2.1 / 1.2.0 / 1.5.7 | 三种压缩 |
| icu / cldr / tz | 78.3 / 48.0 / 2026c | 国际化、时区、排序规则 |
| ada | 4.0.0 | URL 解析（WHATWG 规范那套） |
| undici | 7.29.0 | fetch 的 HTTP 客户端 |
| nghttp2 | 1.70.0 | HTTP/2 |
| amaro | 1.1.11 | 剥离 TypeScript 语法 |
| sqlite | 3.53.4 | 内嵌数据库（实验特性） |
| ares | 1.34.8 | 异步 DNS 解析 |

一共 29 条，一个进程里全须全尾。这也顺带解释了 Deno 和 Bun 是什么：同样的四层结构，第三层换了住户。Deno 留着 V8，把底座换成 Rust 和 tokio；Bun 连 V8 都换了，用 JavaScriptCore 加 Zig 底座。地图不变，住户变。

第四层，内核。上面三层再怎么花哨，落到最底下只有一个出口：syscall。关于「静态链接」有两个物理证据：宿主机的 node 是一个 121MB 的单一文件；`ldd` 它，只剩 libc、libstdc++、libm 这些基础动态库，V8、libuv、OpenSSL 一个都不在外面。第三层的「安装」发生在你下载 node 的那一刻。

四层里，第一二层是 Node 自己的，第三层是一群人的，第四层完全不是 Node 的。后面各篇要拆的，基本都是第三层的名胜：libuv 的事件循环和线程池、V8 的堆和 GC、llhttp 的状态机。这一篇的任务只有一个：验证四层真的存在。验证手段是 strace，只要调用走到了第四层，就会留下脚印，一层一行。

## require('fs') 不碰磁盘

先交代方法。写一个脚本，在每个目标操作前后用 `console.error` 往 stderr 打一个标记（`===M0===` 这样），`strace -f` 录下全程，再按标记切段数数。标记本身就是一次 write(2) syscall，在 trace 里天然就是分界线。脚本十几行，圈了三件事：`require('fs')`、`require('./mymod.js')`、`readFileSync`。切出来的结果：

```text
段                          syscall 数    文件相关操作
execve 到 M0（启动段）       935           读 ELF、动态链接、V8 起步
M0 到 M1  require('fs')      15            零，全是 mmap 和 munmap
M1 到 M2  require 本地模块   12            statx×3、open、read×2、close
M2 到 M3  readFileSync       5             open、fcntl、statx、read、close
```

两条 require，走的是完全不同的两条路：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 300" role="img" aria-label="require 的两条路：内建名 require('fs') 查内建表，0 次文件打开，15 个 syscall 全是内存操作；相对路径 require('./mymod.js') 走磁盘查找，12 个 syscall 里有 statx 三次、open、read 两次、close" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="nd1As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx" x="250" y="30" width="160" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="55" text-anchor="middle" font-size="14" fill="#2b2a26">require(specifier)</text>
<line class="fl" x1="290" y1="70" x2="180" y2="100" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As2)"/>
<line class="fl" x1="370" y1="70" x2="480" y2="100" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As2)"/>
<text class="ts" x="196" y="80" text-anchor="middle" font-size="12" fill="#6b675e">内建名，查表</text>
<text class="ts" x="468" y="80" text-anchor="middle" font-size="12" fill="#6b675e">路径，落盘查找</text>
<rect class="bx-q" x="60" y="106" width="220" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="132" text-anchor="middle" font-size="14" fill="#2b2a26">require('fs')</text>
<line class="fl" x1="170" y1="148" x2="170" y2="160" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As2)"/>
<rect class="bx" x="60" y="164" width="220" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="170" y="188" text-anchor="middle" font-size="14" fill="#2b2a26">0 次文件打开</text>
<text class="ts" x="170" y="208" text-anchor="middle" font-size="12" fill="#6b675e">15 个 syscall 全是 mmap/munmap</text>
<text class="ts" x="170" y="226" text-anchor="middle" font-size="12" fill="#6b675e">代码在二进制里</text>
<rect class="bx-q" x="380" y="106" width="230" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="495" y="132" text-anchor="middle" font-size="14" fill="#2b2a26">require('./mymod.js')</text>
<line class="fl" x1="495" y1="148" x2="495" y2="160" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As2)"/>
<rect class="bx" x="380" y="164" width="230" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="495" y="188" text-anchor="middle" font-size="14" fill="#2b2a26">12 个 syscall</text>
<text class="ts" x="495" y="208" text-anchor="middle" font-size="12" fill="#6b675e">statx×3 · open · read×2 · close</text>
<text class="ts" x="495" y="226" text-anchor="middle" font-size="12" fill="#6b675e">外加 4 个内存操作</text>
<text class="ts" x="20" y="266" font-size="12" fill="#6b675e">整份 strace 输出里 grep fs.js：0 次命中</text>
<text class="ts" x="20" y="286" font-size="12" fill="#6b675e">标准库的版本 = node 的版本</text>
</svg>
</figure>

require('fs') 的段里没有一次文件打开。15 个 syscall 全是 mmap 和 munmap：fs 模块实例化时分配了几块内存缓冲，仅此而已。更彻底的验证是把整份 strace 输出拿来 grep「fs.js」，零次命中。Node 的全部标准库，`lib/` 下那些 JS，在编译期就被塞进了二进制，启动时随 V8 快照一起就位。所以「加载」标准库不走磁盘，进程起来的那一刻代码已经在内存里了。

CPython 系列拆过 Python 的 import：标准库是磁盘上的 pyc 文件，导入要按路径查找，靠时间戳判断新旧。Node 反着来，把标准库焊死在二进制里。好处是启动快、没有一堆文件要校验；代价是标准库和 node 版本同生共死，你没法单独换一个 fs.js。

本地模块是另一个故事。`require('./mymod.js')` 的 12 个里，磁盘全套都在：statx 探了三次（一次看当前目录，一次看目标文件，一次确认不是符号链接），open 打开，read 两次（一次拿内容，一次确认读到了头），close 关上。这条查找链往深里走还有讲究：node_modules 怎么逐级向上爬，package.json 的 exports 怎么读，CJS 和 ESM 怎么互不相认，都是模块加载篇的事。

## 同一次读文件的两种下穿

readFileSync 的 5 个 syscall，全部发生在主线程：

```text
MainThread  open("./hello.txt", O_RDONLY) = 17
MainThread  fcntl(17, F_SETFD, FD_CLOEXEC)
MainThread  statx(17)                            拿文件大小
MainThread  read(17, "hello node layers\n", 18) = 18
MainThread  close(17)
```

下穿路径：JS 的 fs.readFileSync（第一层），internalBinding（第二层），libuv 的 uv_fs 同步接口（第三层），syscall（第四层）。「同步」的含义在这里非常物理：主线程自己发起 syscall，自己站在原地等，调用栈一直压到内核返回为止。数据多半不落磁盘：文件在页缓存里时，内核从内存拷贝一份就返回了，内核系列的页缓存篇拆过这一层。

同一次读，换成 fs.readFile 交给回调，trace 变成了另一副样子。第一次异步文件操作会先把线程池叫醒：主线程 clone 出四个 worker，每个都调 prctl 给自己登记名字「libuv-worker」。然后这次读被拆成了四个任务：

```text
libuv-worker#39  open("./hello.txt") = 17       干完 write(fd16) 写 8 字节，打铃
MainThread       epoll 收到，read(fd16) 取铃，拿到 fd，派下一个任务
libuv-worker#40  statx(17) 拿文件大小           干完打铃
MainThread       取铃，派下一个
libuv-worker#41  read(17, "hello…", 18) = 18    干完打铃
MainThread       取铃，派下一个
libuv-worker#42  close(17)                      干完打铃
MainThread       取铃，你的回调在这里落地
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 420" role="img" aria-label="两种下穿对照：同步版 readFileSync 五个 syscall 在主线程一条线上顺序执行；异步版 fs.readFile 由主线程派单，open、statx、read、close 四个任务分别落在四条 libuv-worker 线程上，每步完成往 fd16 写 8 字节打铃，主线程从 epoll 取铃后编排下一步" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="nd1As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="nd1Ac1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同步版 readFileSync：5 个 syscall，全在主线程</text>
<text class="ts" x="20" y="64" font-size="12" fill="#6b675e">MainThread</text>
<rect class="bx" x="110" y="40" width="100" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="160" y="63" text-anchor="middle" font-size="13" fill="#2b2a26">open</text>
<line class="fl" x1="210" y1="58" x2="218" y2="58" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<rect class="bx" x="220" y="40" width="100" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="270" y="63" text-anchor="middle" font-size="13" fill="#2b2a26">fcntl</text>
<line class="fl" x1="320" y1="58" x2="328" y2="58" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<rect class="bx" x="330" y="40" width="100" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="380" y="63" text-anchor="middle" font-size="13" fill="#2b2a26">statx</text>
<line class="fl" x1="430" y1="58" x2="438" y2="58" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<rect class="bx" x="440" y="40" width="100" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="490" y="63" text-anchor="middle" font-size="13" fill="#2b2a26">read</text>
<line class="fl" x1="540" y1="58" x2="548" y2="58" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<rect class="bx" x="550" y="40" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="595" y="63" text-anchor="middle" font-size="13" fill="#2b2a26">close</text>
<text class="ts" x="110" y="98" font-size="12" fill="#6b675e">调用栈原地等内核返回：这期间没有任何别的 JS 在跑</text>
<line class="grid" x1="20" y1="120" x2="640" y2="120" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
<text class="ts" x="20" y="146" font-size="12" fill="#6b675e">异步版 fs.readFile：4 个任务 4 个 worker，段内共 123 个 syscall</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">MainThread</text>
<line class="flk" x1="110" y1="190" x2="640" y2="190" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="110" y="174" font-size="12" fill="#6b675e">每收一次铃，回 JS 编排下一步，再派下一个任务</text>
<text class="ts" x="20" y="312" font-size="12" fill="#6b675e">libuv-worker</text>
<line class="fl" x1="110" y1="306" x2="640" y2="306" stroke="#6b675e" stroke-width="1.6"/>
<line class="fl" x1="140" y1="194" x2="140" y2="300" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<text class="ts" x="148" y="262" font-size="12" fill="#6b675e">open #39</text>
<line class="flc" x1="205" y1="302" x2="205" y2="196" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#nd1Ac1)"/>
<text class="tc" x="211" y="228" font-size="12" fill="#b03a2e">打铃：write(fd16) 写 8 字节</text>
<line class="fl" x1="270" y1="194" x2="270" y2="300" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<text class="ts" x="278" y="262" font-size="12" fill="#6b675e">statx #40</text>
<line class="flc" x1="335" y1="302" x2="335" y2="196" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#nd1Ac1)"/>
<line class="fl" x1="400" y1="194" x2="400" y2="300" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<text class="ts" x="408" y="262" font-size="12" fill="#6b675e">read #41</text>
<line class="flc" x1="465" y1="302" x2="465" y2="196" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#nd1Ac1)"/>
<line class="fl" x1="530" y1="194" x2="530" y2="300" stroke="#6b675e" stroke-width="1.6" marker-end="url(#nd1As3)"/>
<text class="ts" x="538" y="262" font-size="12" fill="#6b675e">close #42</text>
<line class="flc" x1="595" y1="302" x2="595" y2="196" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#nd1Ac1)"/>
<text class="ts" x="110" y="330" font-size="12" fill="#6b675e">×4，首次异步文件操作时由主线程 clone 出生</text>
<text class="ts" x="20" y="362" font-size="12" fill="#6b675e">fd 16 是 libuv 的通知管道，挂在主线程的 epoll（fd 13）上</text>
<text class="ts" x="20" y="382" font-size="12" fill="#6b675e">promises 版同样拆四段；同步版 5 个 syscall，异步版 123 个，多出来的全是线程、管道与唤醒</text>
<text class="ts" x="20" y="402" font-size="12" fill="#6b675e">主线程自始至终没碰磁盘</text>
</svg>
</figure>

三个细节。第一，一次 readFile 不是一个任务，是四个：open、statx、read、close 各自派一次单，每步之间都要回到主线程，由 JS 层的编排代码决定下一步，再派出去。所以四段任务落在四个不同的 worker 手里，谁闲谁接。promises 版的 fs.promises.readFile 行为相同，段内 157 个 syscall，四任务拆分不变。第二，fd 16 是 libuv 的通知管道：worker 干完活往里写 8 个字节，管道另一头挂在主线程的 epoll 上，epoll_wait 返回可读，主线程把铃收回来。「异步」在物理上就是这两个动作：活挪到别的线程去干，消息通过管道和 epoll 回来。第三，这一窗口总共 123 个 syscall，是同步版 5 个的二十几倍。异步没有省工作，它把工作挪了地方，挪动本身有价钱。

这些 libuv-worker 是谁、为什么默认四个、为什么文件读取和 DNS 解析归它们管而网络 IO 不归，线程池篇会整篇拆。这里只需要记住一件事：主线程从头到尾没碰磁盘。

## 启动不是免费的

回到切分表的第一行：从 execve 到用户代码第一行，935 个 syscall；空脚本 `node -e ''` 全程约 1000 个（strace -c 统计，两次分别 1000 和 1005）。这一段都干了什么？`--trace-event` 可以把时间线画出来，类别选 node.bootstrap 和 node.environment：

```text
+0.00ms   nodeStart            进程起步
+3.15ms   v8Start              V8 平台初始化
+12.05ms  environment          V8 启动、快照反序列化、Environment 创建完成
+16.80ms  bootstrapComplete    内建模块注册完毕
+17.66ms  loopStart            事件循环开转
+17.68ms  loopExit             空脚本，立刻没活干，退出
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 210" role="img" aria-label="启动时间线：nodeStart 0 毫秒，v8Start 3.15 毫秒，environment 12.05 毫秒，bootstrapComplete 16.8 毫秒，loopStart 17.66 毫秒；三段区间分别是 V8 平台初始化、V8 启动与快照反序列化与 Environment 创建、内建模块注册；墙钟全程 27 到 38 毫秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="nd1As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">空脚本的启动：exec 到 loopStart 用了 17.7 毫秒（--trace-event 实录）</text>
<line class="axis" x1="40" y1="110" x2="620" y2="110" stroke="#6b675e" stroke-width="1.4" marker-end="url(#nd1As4)"/>
<path class="fl" d="M60 96 V90 H154 V96" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="107" y="80" text-anchor="middle" font-size="12" fill="#6b675e">V8 平台初始化</text>
<path class="fl" d="M154 96 V84 H421 V96" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="287" y="74" text-anchor="middle" font-size="12" fill="#6b675e">V8 启动 · 快照反序列化 · Environment 创建</text>
<path class="fl" d="M421 96 V90 H564 V96" fill="none" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="492" y="80" text-anchor="middle" font-size="12" fill="#6b675e">内建模块注册</text>
<line class="flk" x1="60" y1="104" x2="60" y2="116" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="60" y="136" text-anchor="middle" font-size="12" fill="#6b675e">nodeStart</text>
<text class="ts" x="60" y="152" text-anchor="middle" font-size="12" fill="#6b675e">0</text>
<line class="flk" x1="154" y1="104" x2="154" y2="116" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="154" y="136" text-anchor="middle" font-size="12" fill="#6b675e">v8Start</text>
<text class="ts" x="154" y="152" text-anchor="middle" font-size="12" fill="#6b675e">3.15ms</text>
<line class="flk" x1="421" y1="104" x2="421" y2="116" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="421" y="136" text-anchor="middle" font-size="12" fill="#6b675e">environment</text>
<text class="ts" x="421" y="152" text-anchor="middle" font-size="12" fill="#6b675e">12.05ms</text>
<line class="flk" x1="564" y1="104" x2="564" y2="116" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="556" y="136" text-anchor="end" font-size="12" fill="#6b675e">bootstrapComplete</text>
<text class="ts" x="556" y="152" text-anchor="end" font-size="12" fill="#6b675e">16.80ms</text>
<line class="flc" x1="590" y1="66" x2="590" y2="104" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="616" y="60" text-anchor="end" font-size="12" fill="#b03a2e">loopStart：17.66ms，环开转</text>
<text class="ts" x="60" y="182" font-size="12" fill="#6b675e">墙钟 time node -e '' 五次：27 到 38 毫秒</text>
</svg>
</figure>

进程起步到 loopStart，17.7 毫秒。墙钟更大：`time node -e ''` 五次分别 27、27、30、38、34 毫秒，多出来的是 exec、动态链接和进程拆除。这两个数字放在一起，解释了两件事。一是 CLI 工具和 serverless 的冷启动从哪来：17.7 毫秒是 Node 为任何一句 hello world 预付的固定成本，大头在 V8 启动和快照反序列化那 8.9 毫秒里。二是标准库进二进制没有白干：正因为没有几百个 JS 文件要从磁盘读，启动才压得进十七八毫秒。

坑记一个：文档里出现的 `--trace-event-file` 在 Node 24 上是 bad option，trace 文件默认落在当前目录，文件名 node_trace 加点 pid 点 log。

## 一次 readFileSync 卡停整个服务

地图铺完了，层也验证完了，最后用它解释一个人人见过、很少有人量化过的现象：一次同步的文件读取，为什么能卡停整个服务。

搭一个最小服务器，三个端点：/fast 立刻返回；/sync 用 readFileSync 读一个 256MB 的文件，读三遍；/async 用 readFile 把同一个文件读一遍。客户端分三段打：先打 300 个 fast 拿基线；然后发一个 /sync 但不等它，同时连续打 /fast 直到它返回；/async 同样。三轮：

```text
轮次   A 基线 p50    B 同步段      B 窗口内的 fast       C 异步段      C 窗口内的 fast
1      0.45ms        433.7ms       1 个，430.85ms        174.9ms       270 个，p50 0.43ms
2      0.20ms        340.3ms       1 个，338.34ms        147.6ms       331 个，p50 0.30ms
3      0.26ms        361.6ms       1 个，358.81ms        126.7ms       428 个，p50 0.18ms
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="两个窗口对照：同步窗口 340 毫秒里主线程被 readFileSync 占死，只服务了 1 个快请求，延迟 338 毫秒；异步窗口 148 毫秒里 libuv-worker 读文件，主线程照常服务 331 个快请求，p50 为 0.30 毫秒与基线无异；两行条形按同一比例尺" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一份 256MB 文件：同步读与异步读期间，服务分别在干什么（第二轮数据）</text>
<text class="ts" x="20" y="52" font-size="12" fill="#6b675e">B：readFileSync ×3，340ms</text>
<rect class="bx-sick" x="60" y="60" width="476" height="26" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="298" y="78" text-anchor="middle" font-size="12" fill="#2b2a26">主线程被占死：调用栈站在内核里</text>
<path class="fill-c" d="M536 90 L531 100 L541 100 Z" fill="#b03a2e"/>
<text class="tc" x="60" y="118" font-size="12" fill="#b03a2e">窗口里只服务了 1 个请求：那个 fast 拖到 338ms 才返回</text>
<text class="ts" x="20" y="152" font-size="12" fill="#6b675e">C：readFile 异步 ×1，148ms</text>
<rect class="bx" x="60" y="160" width="207" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="163" y="178" text-anchor="middle" font-size="12" fill="#2b2a26">libuv-worker 读文件</text>
<text class="ts" x="280" y="178" font-size="12" fill="#6b675e">主线程不在场，环照常转</text>
<line class="flk" x1="60" y1="206" x2="560" y2="206" stroke="#2b2a26" stroke-width="4" stroke-dasharray="0 11" stroke-linecap="round"/>
<text class="ts" x="60" y="228" font-size="12" fill="#6b675e">窗口内 331 个 fast，p50 0.30ms，与基线无异</text>
<text class="ts" x="640" y="244" text-anchor="end" font-size="12" fill="#6b675e">两行条形同一比例尺</text>
</svg>
</figure>

B 列窗口里只有 1 个 fast 请求，这个数字本身就是答案：同步读文件的 340 毫秒里，整个服务只接待了这一个客人。0.2ms 的接口被拖长一千多倍，它没有变慢，它排在了同步调用的后面，事件循环根本轮不到它。C 列：同样 256MB 的读丢给了 libuv-worker（127 到 175 毫秒，和同步版单遍读一个量级），主线程回到环里，窗口内 270 到 428 个 fast 的 p50 与基线无异。

机制用四层的话说就一句：你的 JS 只在 V8 上跑，而 V8 里跑你代码的只有主线程这一条。同步调用下穿到第四层时，主线程的调用栈站在内核里等返回，这期间没有任何第二条线程能执行你的 JS，所有回调、定时器、请求处理统统排队。异步版把「等内核」这件事丢给线程池，主线程留在环里，工作和等待就分开了。

这个「环」本身长什么样、闲下来时在干什么、setTimeout 和 setImmediate 各排在哪里，是下一篇事件循环篇的正题。

## 「单线程」的进程，挂着十一条线程

最后回到那句流传最广的话：Node 是单线程的。跑完上面这些实验，这句话可以说得精确一点。脚本结束时，strace 记录到进程里有十一条线程，全都有名字，名字直接从 trace 里的 prctl(PR_SET_NAME) 抄来：

```text
MainThread        ×1   你的 JS 唯一的执行线程
DelayedTaskSche   ×1   V8 的延迟任务调度
V8Worker          ×4   V8 的后台编译与 GC 帮手
SignalInspector   ×1   盯信号
libuv-worker      ×4   线程池：fs、dns.lookup、crypto 的活儿
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 290" role="img" aria-label="线程全家福：进程框内 MainThread 一条单独高亮，是执行用户 JS 的唯一线程；右侧启动期出生的有 V8Worker 四条、DelayedTaskSche 一条、SignalInspector 一条，首次异步文件操作才出生的有 libuv-worker 四条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">脚本结束时的 node 进程：11 条线程</text>
<rect class="bx-gone" x="20" y="36" width="620" height="212" rx="6" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<rect class="bx-q" x="44" y="64" width="180" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="134" y="92" text-anchor="middle" font-size="14" fill="#2b2a26">MainThread ×1</text>
<text class="ts" x="134" y="112" text-anchor="middle" font-size="12" fill="#6b675e">你的 JS 唯一的</text>
<text class="ts" x="134" y="128" text-anchor="middle" font-size="12" fill="#6b675e">执行线程</text>
<text class="ts" x="260" y="60" font-size="12" fill="#6b675e">启动期就出生：</text>
<rect class="bx" x="260" y="68" width="170" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">V8Worker ×4</text>
<text class="ts" x="345" y="104" text-anchor="middle" font-size="12" fill="#6b675e">后台编译与 GC 帮手</text>
<rect class="bx" x="440" y="68" width="180" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="530" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">DelayedTaskSche ×1</text>
<text class="ts" x="530" y="104" text-anchor="middle" font-size="12" fill="#6b675e">V8 的延迟任务调度</text>
<rect class="bx" x="260" y="120" width="170" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="138" text-anchor="middle" font-size="13" fill="#2b2a26">SignalInspector ×1</text>
<text class="ts" x="345" y="156" text-anchor="middle" font-size="12" fill="#6b675e">盯信号</text>
<text class="ts" x="260" y="196" font-size="12" fill="#6b675e">首次异步文件操作才出生：</text>
<rect class="bx-q" x="260" y="204" width="360" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="440" y="221" text-anchor="middle" font-size="13" fill="#2b2a26">libuv-worker ×4</text>
<text class="ts" x="440" y="238" text-anchor="middle" font-size="12" fill="#6b675e">线程池，文件与 DNS 的搬运工</text>
<text class="ts" x="20" y="270" font-size="12" fill="#6b675e">线程名 15 字符封顶：DelayedTaskSche 与 SignalInspector 都是被截了尾的</text>
</svg>
</figure>

「单线程」指的是 JS 执行只有一条线程。运行时自己的班底早就组好了队：V8 的四个 worker 帮着做后台编译和垃圾回收，libuv 的四个 worker 帮着读文件、查 DNS，还有一个专门盯信号。十一条线程里，属于你的只有一条。

两个数字也各有各的说法。V8Worker 在这台 12 核的宿主机上开了 4 个，数量由 V8 按核数自己定；libuv-worker 默认 4 个，可以用环境变量 UV_THREADPOOL_SIZE 调。该不该调、调多大，是线程池篇的题目。

## 这张地图的用处

系列后面的篇目都在这张地图上。事件循环和线程池在第三层的 libuv 里，下一篇就进；Buffer 的堆外内存和 GC 停顿在第三层的 V8 里，账最后落在第四层的 RSS 上；一次 HTTP 请求从 socket 到回调要把四层全穿一遍，llhttp 在中间当翻译；cluster 递给 worker 的 fd，是第四层的文件描述符。每篇开拆之前先找到它站在哪一层，边界就清楚了。

下一篇正式进 libuv，看事件循环的六个阶段：setTimeout(0) 和 setImmediate 到底排在哪一队，为什么它们的顺序在主模块里会摇摆、在 IO 回调里却稳定。

（实验环境：宿主机 Node v24.20.0，glibc，121MB 二进制；容器 nodelab:24 即 node:24-alpine 加装 strace 6.19，v24.21.0，musl libc。musl 下部分 syscall 的样子与 glibc 略有出入，它用 open 而 glibc 用 openat，require 段还多两对 mmap/munmap 的 stdio 缓冲，数量结论与线程归属不变。实验脚本编号 11、12、14、15，按惯例放在仓库外的 ~/node-lab，README 里有跑法。坑记录：--trace-event-file 在 24 上是 bad option，用默认的 node_trace 文件；strace -c 跨两次运行的差值不可比，启动段 syscall 数自身就有波动，切段要用运行内的标记；第一版实验里标记函数先 require 了 fs，段内的 require('fs') 成了缓存命中，证明不了内建模块在二进制里，标记换成 console.error 重跑，才拿到干净的「零次文件打开」。）
