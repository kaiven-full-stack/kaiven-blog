---
title: 快照在后台，停顿发生在前台：Redis 的 fork 与写时复制
description: BGSAVE 的文件由子进程写，fork 却由主线程同步执行。本文沿一次快照的时间线，拆开 fork 停顿、页表复制、写时复制、内存统计、AOF 重写与全量同步，划清“后台保存”和“内存翻倍”各自的真实边界。延迟与内存数字全部来自 2GB 限额容器内的 7.4.11 实测。
pubDate: 2026-09-05
category: redis
tags: [Redis, 数据库]
---

`BGSAVE` 的文件由子进程写，但那一次 `fork` 是主线程亲手执行的：fork 期间事件循环暂停，数据量大的实例能停出可见的毫秒数；fork 返回之后，名字里的“后台”才真正开始。

`BGSAVE` 很像拍一张合影。快门落下的一瞬，所有人都要保持不动；照片定格以后，大厅重新营业，冲印交给暗房慢慢完成。Redis 的主线程负责按下快门，子进程负责冲印。这个比喻只在这一段用：下文都换成平实的说法，fork 停顿、后台保存、子进程写盘，但「前台一瞬、后台漫长」的分工值得先记住。

上一篇追查事件循环时，627MB 数据让 `BGSAVE` 的 `fork` 花了约 14 毫秒，RDB 落盘则持续约 1.6 秒。那一节只够留下一句：后台保存，始于一次前台停顿。这一篇沿着那条缝往里走，看看 `fork` 到底复制了什么，写时复制为何会涨内存，以及“快照期间内存会翻倍”究竟是一条保证、一个上界，还是一句被说顺口了的误会。

实验使用官方 Redis 7.4.11 镜像，在限制为 2GB 内存、2 个 CPU 的隔离容器中完成；测试端口只绑定本机，容器、网络和临时数据均已清理。所有延迟与内存数字只描述本次机器，不应直接写进生产容量承诺。源码名称与 Redis 7 的多段 AOF 行为，也都以 7.4.11 为准。

## “后台保存”的后台，从哪一步开始

一次普通 `BGSAVE` 可以拆成五个时刻：

```text
T0  主线程收到 BGSAVE
T1  主线程调用 fork()，事件循环暂停
T2  fork 返回；父进程恢复服务，子进程开始遍历数据
T3  父进程继续处理读写，子进程编码并写临时 RDB
T4  子进程完成 fsync 与 rename，退出
```

把父子两条时间线并排看，会更清楚：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="BGSAVE 父子双泳道时间线：主进程收到命令后经历 fork 停顿，随后继续服务 GET SET EXPIRE；子进程从 fork 返回那一刻诞生，遍历数据、编码、写临时 RDB，最后 fsync 加 rename 退出；fork 停顿只是主线程那一小段" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red7As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">前台一瞬，后台漫长</text>
<text class="t" x="20" y="66" font-size="12" fill="#2b2a26">主进程</text>
<line class="flk" x1="90" y1="50" x2="90" y2="86" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="90" y="44" text-anchor="middle" font-size="10" fill="#6b675e">T0 收到命令</text>
<rect class="bx-sick" x="110" y="58" width="46" height="20" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="133" y="72" text-anchor="middle" font-size="9" fill="#b03a2e">fork</text>
<text class="ts" x="133" y="44" text-anchor="middle" font-size="10" fill="#6b675e">T1→T2 停顿</text>
<rect class="bx-q" x="156" y="58" width="450" height="20" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="381" y="72" text-anchor="middle" font-size="10" fill="#6b675e">继续服务：GET / SET / EXPIRE 照常</text>
<line class="fl" x1="156" y1="78" x2="156" y2="112" stroke="#6b675e" stroke-width="1.6" marker-end="url(#red7As1)"/>
<text class="ts" x="164" y="100" font-size="10" fill="#6b675e">fork 返回，子进程诞生</text>
<text class="t" x="20" y="134" font-size="12" fill="#2b2a26">子进程</text>
<rect class="bx" x="156" y="120" width="380" height="20" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="346" y="134" text-anchor="middle" font-size="10" fill="#6b675e">遍历 fork 时刻的数据 · 编码 · 写临时 RDB</text>
<line class="flc" x1="536" y1="112" x2="536" y2="148" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="536" y="164" text-anchor="middle" font-size="10" fill="#b03a2e">T4：fsync + rename，退出</text>
<text class="ts" x="20" y="196" font-size="12" fill="#6b675e">latest_fork_usec 量 T1→T2 那一小段；rdb_last_bgsave_time_sec 量 T2→T4 的漫长段</text>
</svg>
</figure>

`rdbSaveBackground()` 最终通过统一的 `redisFork()` 创建 RDB 子进程。`fork()` 在主线程上同步发生；这段时间，上一篇那条事件循环没有机会处理其他普通命令。父分支返回后，主线程才重新进入事件循环。子分支则关闭不需要的监听资源，开始执行 `rdbSave()`。

所以两句话必须同时成立：

```text
BGSAVE 的主要保存工作在后台完成。
BGSAVE 并非从第一条指令起就不阻塞。
```

`INFO stats` 中的 `latest_fork_usec` 记录最近一次 `fork()` 系统调用的耗时；`INFO persistence` 中的 `rdb_last_bgsave_time_sec` 记录整次后台保存时长。二者测的是两段不同的时间，不能拿前者预测后者。停顿属于 fork 那一瞬，耗时最长的那段通常在子进程里。

## fork 复制的是地图，不是领土

“Redis fork 一个子进程”很容易被听成“Redis 复制了一整份内存”。若实例占 20GB，似乎 `fork()` 当场就要再搬 20GB；可真这样做，几毫秒到几十毫秒的停顿根本不够。

操作系统没有立即复制全部数据页。父进程和子进程先共享同一批物理页，只各自拥有一份描述虚拟地址怎样指向这些页的页表。概念上是这样：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="fork 后的共享结构：左边父进程页表、右边子进程页表，两份地图都指向居中的同一批物理页 A B C；页只有一份，每页引用计数加一，fork 的前台成本是建子进程和复制页表，数据页一页没动" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red7As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">地图两份，领土一份</text>
<rect class="bx" x="20" y="90" width="120" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="112" text-anchor="middle" font-size="12" fill="#6b675e">父进程页表</text>
<text class="ts" x="80" y="130" text-anchor="middle" font-size="10" fill="#6b675e">地图 ①</text>
<rect class="bx" x="520" y="90" width="120" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="580" y="112" text-anchor="middle" font-size="12" fill="#6b675e">子进程页表</text>
<text class="ts" x="580" y="130" text-anchor="middle" font-size="10" fill="#6b675e">地图 ②</text>
<line class="fl" x1="140" y1="100" x2="264" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As2)"/>
<line class="fl" x1="140" y1="116" x2="264" y2="116" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As2)"/>
<line class="fl" x1="140" y1="132" x2="264" y2="170" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As2)"/>
<line class="fl" x1="520" y1="100" x2="396" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As2)"/>
<line class="fl" x1="520" y1="116" x2="396" y2="116" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As2)"/>
<line class="fl" x1="520" y1="132" x2="396" y2="170" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As2)"/>
<rect class="bx-q" x="270" y="40" width="120" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">物理页 A</text>
<rect class="bx-q" x="270" y="96" width="120" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="120" text-anchor="middle" font-size="12" fill="#2b2a26">物理页 B</text>
<rect class="bx-q" x="270" y="152" width="120" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="176" text-anchor="middle" font-size="12" fill="#2b2a26">物理页 C</text>
<text class="ts" x="330" y="212" text-anchor="middle" font-size="11" fill="#6b675e">每页引用计数 +1</text>
<text class="ts" x="20" y="232" font-size="12" fill="#6b675e">fork 的前台成本 = 建子进程 + 复制页表与内核元数据；数据页一页没动</text>
</svg>
</figure>

地图变成了两份，领土仍只有一份。

`fork()` 的前台成本主要来自创建子进程、复制页表和其他内核元数据。实例占用的内存页越多，要整理的映射通常越多，停顿便越明显。Redis 官方延迟文档给过一个便于理解的算例：24GB 地址空间若按 4KB 页、每项 8 字节估算，仅页表条目就约有 48MB。

这只是数量级说明，不是一条固定换算公式。内核版本、页大小、虚拟化平台、NUMA 布局和当时系统负载都会改变 `fork` 速度。官方示例中，现代物理机和 HVM 虚拟机可以接近每 GB 十毫秒量级，旧式 Xen 环境则可能慢一个数量级以上。

因此，不能用“数据集每 GB 必停十毫秒”做服务等级承诺。能安全成立的只有方向：**同一平台上，页越多，fork 通常越贵；换个平台，比例可能完全不同。**

## 三档数据量，三次 fork 实测

我在三只独立、无额外负载的容器中放入不同规模的数据，再各触发一次 `BGSAVE`：

| 写入的值总量 | `used_memory` | `latest_fork_usec` | BGSAVE 命令返回 | RDB 后台阶段 |
| ---: | ---: | ---: | ---: | ---: |
| 约 50MB | 约 85MB | 2806μs | 约 10ms | 不足 1s |
| 约 200MB | 约 338MB | 8570μs | 约 13ms | 不足 1s |
| 约 500MB | 约 843MB | 20159μs | 约 25ms | 约 1s |

这里“写入的值总量”与 `used_memory` 不相等，因为键、对象头、哈希表、分配器元数据和碎片都要占空间。页表的工作量与 RDB 文件大小无关，更接近的度量是进程实际映射和驻留的内存页。

三档数据上，`latest_fork_usec` 随实例变大而上升；BGSAVE 返回时间也只比 fork 多出少量命令与调度开销。后台写盘却是另一条曲线：它受键数量、值编码、压缩率、磁盘与文件系统影响，和 fork 停顿没有固定比例。

这个实验只能确认本机上的趋势。它不能证明 843MB 永远停 20 毫秒，也不能推导 84GB 就一定停两秒。更可靠的做法是在目标机器、目标内核和接近真实 RSS 的实例上测量，并持续记录 `latest_fork_usec`。

fork 停顿的时长按页表的规模算，不按 RDB 文件的大小算。

三档数据画成点：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 246" role="img" aria-label="三档数据量的 fork 停顿散点图：used_memory 85MB 时 latest_fork_usec 约 2806 微秒，338MB 时约 8570，843MB 时约 20159，停顿随实例占用近似线性上升，斜率约每 MB 24 微秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三档数据量、三次 BGSAVE：fork 停顿随实例占用上升</text>
<text class="ts" x="20" y="44" font-size="11" fill="#6b675e">latest_fork_usec</text>
<line class="grid" x1="70" y1="160" x2="610" y2="160" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="120" x2="610" y2="120" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="80" x2="610" y2="80" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="40" x2="610" y2="40" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="200" x2="70" y2="36" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="200" x2="620" y2="200" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="164" text-anchor="end" font-size="11" fill="#6b675e">5000</text>
<text class="ts" x="62" y="124" text-anchor="end" font-size="11" fill="#6b675e">10000</text>
<text class="ts" x="62" y="84" text-anchor="end" font-size="11" fill="#6b675e">15000</text>
<text class="ts" x="62" y="44" text-anchor="end" font-size="11" fill="#6b675e">20000</text>
<polyline class="curve-k" points="121,178 273,132 576,40" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="121" cy="178" r="4" fill="#b03a2e"/>
<circle class="fill-c" cx="273" cy="132" r="4" fill="#b03a2e"/>
<circle class="fill-c" cx="576" cy="40" r="4" fill="#b03a2e"/>
<text class="ts" x="131" y="172" font-size="11" fill="#6b675e">85MB · 2.8ms</text>
<text class="ts" x="283" y="126" font-size="11" fill="#6b675e">338MB · 8.6ms</text>
<text class="ts" x="566" y="62" text-anchor="end" font-size="11" fill="#6b675e">843MB · 20.2ms</text>
<text class="ts" x="190" y="218" text-anchor="middle" font-size="11" fill="#6b675e">200</text>
<text class="ts" x="310" y="218" text-anchor="middle" font-size="11" fill="#6b675e">400</text>
<text class="ts" x="430" y="218" text-anchor="middle" font-size="11" fill="#6b675e">600</text>
<text class="ts" x="550" y="218" text-anchor="middle" font-size="11" fill="#6b675e">800</text>
<text class="ts" x="620" y="238" text-anchor="end" font-size="11" fill="#6b675e">used_memory（MB）</text>
</svg>
</figure>

## 子进程看到的世界，停在 fork 那一刻

共享物理页带来一个问题：父进程恢复服务以后仍会处理 `SET`、`DEL` 和过期删除；子进程正在读取同一批数据，快照会不会前一半是旧值、后一半是新值？

答案藏在 `fork` 的时机和写时复制里。

Redis 不会在一条普通命令执行到一半时创建后台保存子进程。`fork` 发生在命令边界之外，所以快照定格时，键空间处在一条完整命令结束后的状态。子进程继承这一刻的地址映射。

之后父进程要修改共享页，内核不会让它直接改坏子进程正在读的数据。写入会触发写时复制：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 278" role="img" aria-label="写时复制两步：fork 后父子两张页表指向同一旧页 P；父进程要写 P 时内核复制出一页新页 P撇，父进程页表改指新页并在其上修改，子进程页表仍指旧页继续读 fork 时刻的数据，全程不需要全局锁" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="red7As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">第一步 · fork 刚结束：父子指向同一旧页</text>
<rect class="bx" x="30" y="44" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="95" y="66" text-anchor="middle" font-size="11" fill="#6b675e">父进程页表</text>
<rect class="bx" x="30" y="90" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="95" y="112" text-anchor="middle" font-size="11" fill="#6b675e">子进程页表</text>
<line class="fl" x1="160" y1="62" x2="296" y2="78" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As3)"/>
<line class="fl" x1="160" y1="108" x2="296" y2="92" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As3)"/>
<rect class="bx-q" x="300" y="66" width="110" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="355" y="90" text-anchor="middle" font-size="12" fill="#2b2a26">旧页 P</text>
<text class="ts" x="430" y="90" font-size="11" fill="#6b675e">只读共享，引用计数 2</text>
<text class="ts" x="355" y="140" text-anchor="middle" font-size="11" fill="#6b675e">父进程准备写 P：写保护缺页，内核复制一页</text>
<line class="flc" x1="355" y1="146" x2="355" y2="166" stroke="#b03a2e" stroke-width="1.6"/>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">第二步 · 复制完成：各写各的，各读各的</text>
<rect class="bx" x="30" y="196" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="95" y="218" text-anchor="middle" font-size="11" fill="#6b675e">父进程页表</text>
<rect class="bx" x="30" y="240" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="95" y="262" text-anchor="middle" font-size="11" fill="#6b675e">子进程页表</text>
<line class="fl" x1="160" y1="214" x2="296" y2="210" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As3)"/>
<line class="fl" x1="160" y1="258" x2="296" y2="254" stroke="#6b675e" stroke-width="1.4" marker-end="url(#red7As3)"/>
<rect class="bx-sick" x="300" y="192" width="110" height="36" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="355" y="214" text-anchor="middle" font-size="12" fill="#b03a2e">新页 P'</text>
<rect class="bx-q" x="300" y="238" width="110" height="36" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="355" y="260" text-anchor="middle" font-size="12" fill="#2b2a26">旧页 P</text>
<text class="ts" x="430" y="206" font-size="11" fill="#6b675e">父进程在 P' 上修改：新分配的一页，</text>
<text class="ts" x="430" y="222" font-size="11" fill="#6b675e">保存窗口额外内存的来源之一</text>
<text class="ts" x="430" y="252" font-size="11" fill="#6b675e">子进程继续读 fork 时刻的旧世界</text>
<text class="ts" x="430" y="268" font-size="11" fill="#6b675e">RDB 写的就是这一份</text>
</svg>
</figure>

父进程看到最新数据，子进程仍看到 `fork` 时刻的数据。二者不需要为整次 RDB 保存持有一把全局锁。

过期篇说过，过期时间以绝对时间戳进入 RDB。这里可以补上另一半：RDB 中的键和值来自 fork 时刻的内存视图；之后父进程发生的修改，不会回头改变子进程眼里的那份数据。

**快照的一致性不是靠保存期间禁止写入，而是靠子进程继续持有旧世界。**

## 写时复制，复制的是被碰过的页

Copy-on-write 的名字很准确：只有写发生时，复制才发生；而复制的基本单位是内存页，不是 Redis 键。

若父进程只处理 `GET`，数据页没有被修改，父子可以一直共享。若父进程改动一字节，内核也不能只复制一字节，而要为相关内存页建立私有副本。于是 COW 成本取决于“保存窗口内有多少共享页被写到”，而不只是“执行了多少条写命令”。

几种操作都可能让共享页变脏：

- 原地更新对象或其元数据；
- 向键空间字典插入、删除条目；
- 过期与淘汰键；
- 修改分配器管理信息；
- 字典扩容或 rehash 搬动大量桶。

Redis 为最后一种情况专门收紧策略。有活跃子进程时，父进程尽量避免普通的字典扩缩容，减少成片写页；但不是无条件禁止。负载达到硬阈值时仍会扩容，以免哈希桶退化得过于严重。子进程内部则禁止这类 resize。

Redis 7 还会让子进程在序列化完某些大对象后，通过 `madvise` 放弃已经读完的页。这样父进程以后再写对应地址时，不必总为保留子进程副本而复制一页。这是优化，不改变基本模型：真正的额外页来自保存窗口内的写入触碰。

## 静默的实例，没有凭空翻倍

三档 BGSAVE 实验都在没有写负载的情况下运行。它们最后报告的 `rdb_last_cow_size` 约为 745KB、766KB 和 762KB；即使最大一档 `used_memory` 已达约 843MB，COW 仍只有不到 1MB 的基线量级。

这点足以推翻一句流传很广的话：

```text
BGSAVE 一开始，Redis 内存就会翻倍。
```

若 fork 当场复制完整数据，843MB 实例应该立即多出接近一份数据；实际没有。父子共享绝大多数页，只为正常簿记和少量写入产生私有脏页。

不过“COW 很小”也不是新的普遍结论。静默实例只是控制组，说明数据集大小本身不会自动制造等量副本。高写入实例在子进程存活期间可能触碰大量页，额外内存可以持续上升；极端情况下，被修改的页覆盖大部分数据集，峰值才可能逼近额外一份。

更准确的表述是：

```text
额外 COW ≈ 保存窗口内被修改过的共享页总量
上界受数据集规模约束，实际值受写入分布与窗口时长影响
```

“最多接近两倍”是容量规划必须尊重的最坏边界，**不是每次 BGSAVE 的默认代价。**

## 我踩的坑：RSS 涨了，COW 却没涨

为了让写时复制显形，我原本设计了一个很直观的对照：BGSAVE 期间，一组持续覆盖旧键，一组持续写入新键。我以为覆盖旧键会复制旧页，而新增键只是分配新页，两条 COW 曲线应该明显分开。

结果没有按剧本走。

三万个 10KB 旧值被逐个覆盖后，`rdb_last_cow_size` 约 1.04MB；新增三万个 10KB 键后，它约 1.11MB。两者都接近空闲实验的基线，远小于预期。可是父进程 RSS 给出了完全不同的读数：

```text
覆盖旧键：RSS 大致保持在 382MB
新增键：  RSS 从约 382MB 上升到约 749MB
```

新增键确实消耗了三百多 MB，只是这些页是在 fork 以后由父进程新分配的，子进程从未共享过它们，所以它们不是 COW。它们属于父进程自己的新增数据。

旧值覆盖的 COW 也没有大幅上涨，说明“修改一个 Redis 键”等于“原地改写它原来的所有页”这个假设不成立。字符串替换可能释放旧块、另行分配新块；真正写到的共享区域主要落在对象头、字典与分配器元数据上。键级操作与页级复制之间，还隔着对象编码和分配器行为。

这次打脸留下两个结论：

- RSS 上升不等于 COW 上升；
- 一条写命令触发多少 COW，不能只从值的字节长度推算。

COW 是内核按页记的账，Redis 命令只是可能改动这些页的原因。

## 只读、写新键与原地写，不是同一条曲线

另一轮实验在约 500MB 原始数据上对比两种负载。

只读阶段用 50 个连接完成十万次 `GET`。BGSAVE 窗口约 3.1 秒，父进程 RSS 大致稳定，COW 仍在不足 1MB 的基线附近。

写入阶段持续新增十万个 10KB 键。父进程 RSS 从约 641MB 增长到 867MB，BGSAVE 窗口也从 3.1 秒拉长到约 7.6 秒；但 COW 峰值采样只有约 1.3MB。新增页让主进程本身变大，子进程与写入进程争用 CPU，又拖长了保存时间，却没有把新增内存变成旧快照的副本。

这说明快照期的内存压力至少要拆成三类：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 172" role="img" aria-label="快照期内存压力的三笔账堆叠条：最大一段是父进程 fork 后新分配的数据页，子进程从未共享过不算 COW；中间一小段是共享页被写后复制出的 COW，实测峰值仅约 1.3MB；最后一段是子进程私有页、文件缓存与输出缓冲等其他开销" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">快照期的内存压力，拆成三笔账（宽度示意，非同一实验的等比数据）</text>
<rect class="bar" x="40" y="48" width="300" height="26" fill="#2b2a26"/>
<text class="onbar" x="190" y="65" text-anchor="middle" font-size="11" fill="#f6f3ec">① 父进程正常新增的数据</text>
<rect class="bx-sick" x="340" y="48" width="40" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="360" y="65" text-anchor="middle" font-size="10" fill="#b03a2e">②</text>
<rect class="bx" x="380" y="48" width="140" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="450" y="65" text-anchor="middle" font-size="11" fill="#6b675e">③ 其他开销</text>
<text class="ts" x="40" y="100" font-size="11" fill="#6b675e">① fork 后父进程新分配的页：子进程从未共享过它们，不算 COW</text>
<text class="ts" x="40" y="122" font-size="11" fill="#6b675e">② 共享页被写后的复制：写入实验里峰值也只有约 1.3MB</text>
<text class="ts" x="40" y="144" font-size="11" fill="#6b675e">③ 子进程私有页、文件缓存、客户端输出缓冲</text>
<text class="ts" x="40" y="164" font-size="11" fill="#6b675e">写入实验里的大头是 ①：RSS 从 641MB 涨到 867MB，而 ② 只有约 1.3MB</text>
</svg>
</figure>

监控只看 `used_memory_rss`，容易把三者全叫作“COW”；只看 `current_cow_size`，又会漏掉父进程正常增长和客户端缓冲。

写负载还可能拉长子进程存活时间。时间窗越长，后续写入越有机会碰到更多共享页；CPU 和磁盘竞争也可能推高尾延迟。COW 风险因此是一条反馈链：写入增加竞争，竞争延长保存，保存延长又扩大可能发生写入的窗口。

## COW 指标，是一次有采样间隔的近似

Redis 7.4 在 `INFO persistence` 中提供一组快照期指标：

```text
rdb_bgsave_in_progress
current_cow_size
current_cow_peak
current_cow_size_age
current_fork_perc
current_save_keys_processed
current_save_keys_total
rdb_last_cow_size
```

进行中的子进程会读取自身 `/proc/self/smaps`，汇总 `Private_Dirty`，再通过 `child_info_pipe` 把 COW、进度与已处理键数报告给父进程。结束时，峰值被保存为 `rdb_last_cow_size`；AOF 重写有对应的 `aof_last_cow_size`。

这里有三层边界。

第一，`Private_Dirty` 是从子进程视角得到的近似，不是一枚能逐字节标注“这就是 COW”的硬件计数器。子进程自身少量私有写入也可能进入结果，父进程新增的独占页则不在其中。

第二，读取 `smaps` 本身可能很慢。Redis 7 会根据上次采样耗时进行节流，把这项观测控制在较低占空比。因此 `current_cow_size` 带有采样年龄，不保证刚好反映你发出 `INFO` 的那一微秒。

第三，子进程退出后，“current” 字段会重置。判断有没有快照任务，应先看 `rdb_bgsave_in_progress` 或 `aof_rewrite_in_progress`；复盘已经结束的任务，则看 `rdb_last_cow_size` 或 `aof_last_cow_size`。

`child_info_pipe` 传的也不是 RDB 数据。它只传这些统计与进度；真正的 RDB 要么写文件，要么在无盘复制时走专用管道。

指标很有用，但它是定期采样出来的近似值，不能当实时的逐页观测用。

## 两个 RSS 相加，会重复计算共享页

fork 以后查看进程列表，常会看到父进程 RSS 和子进程 RSS 都接近原实例大小。把两个数字一加，似乎内存已经翻倍。

可 RSS 统计的是“这个进程当前驻留了多少页面”，共享页会同时出现在父、子的 RSS 中。两个数字各自说“我能访问这页”，不代表物理内存里真的有两页。

概念上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="父子 RSS 相加的陷阱：父进程 800MB 与子进程 780MB 两条横条的大部分是同一批共享物理页，各记一次；相加得到的 1580MB 远大于物理新增，深色小段才是各自的私有页" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">两个 RSS 直接相加，共享页会被数两次</text>
<text class="ts" x="20" y="62" font-size="12" fill="#6b675e">父 RSS</text>
<rect class="bx" x="90" y="48" width="350" height="22" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bar" x="440" y="48" width="50" height="22" fill="#2b2a26"/>
<text class="ts" x="265" y="63" text-anchor="middle" font-size="11" fill="#6b675e">共享物理页（大部分）</text>
<text class="ts" x="500" y="63" text-anchor="middle" font-size="10" fill="#f6f3ec">私有</text>
<text class="ts" x="20" y="106" font-size="12" fill="#6b675e">子 RSS</text>
<rect class="bx" x="90" y="92" width="350" height="22" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bar" x="440" y="92" width="40" height="22" fill="#2b2a26"/>
<line class="flc" x1="265" y1="70" x2="265" y2="92" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="3 2"/>
<text class="tc" x="272" y="86" font-size="11" fill="#b03a2e">同一批物理页，两边各记一次</text>
<text class="ts" x="90" y="140" font-size="12" fill="#6b675e">800MB + 780MB = 1580MB？物理内存的新增远小于这个和</text>
<text class="ts" x="90" y="162" font-size="12" fill="#6b675e">smaps 把 shared / private / clean / dirty 分开记，才是能相加的口径</text>
<text class="ts" x="90" y="184" font-size="12" fill="#6b675e">额外复制页的近似值看 rdb_last_cow_size，不看两个 RSS 的和</text>
</svg>
</figure>

更细的 `/proc/<pid>/smaps` 或 `smaps_rollup` 会区分 shared、private、clean、dirty；容器的 `memory.current` 与宿主机内存统计又有自己的记账规则。Redis 的 COW 指标则从子进程 `Private_Dirty` 近似额外复制页。

容量判断应同时观察：

- Redis 自身的 `used_memory` 与 `used_memory_rss`；
- `current_cow_size` / `current_cow_peak`；
- 子进程是否正在运行；
- 容器或主机的实际内存余量；
- swap、内存压力与 OOM 事件。

把父子 RSS 简单相加，等于把同一批共享页统计了两次。

## 透明大页，把一页放大成两兆

普通 Linux 内存页常见为 4KB。若透明大页把匿名内存聚合成 2MB 页，父进程只改其中少量字节，也可能触发更大粒度的复制。原本一次 4KB 的 COW，最坏会被放大成 2MB。

```text
普通页：改 1 字节 → 复制相关 4KB 页
透明大页：改 1 字节 → 可能复制相关 2MB 巨页
```

这也是高写入快照期间有人真正观察到内存快速接近翻倍的原因之一。写命令随机落在许多巨页上，少量逻辑修改就可能触及很大比例的进程内存。

Redis 官方长期建议关闭 THP。7.4.11 又增加了启动检查，并默认尝试通过 `disable-thp yes` 对 Redis 主线程禁用透明大页；不过系统配置、内核支持和旧版本行为仍需单独核对。实验宿主机处于 `madvise` 模式，我没有修改系统级 THP，也没有为了制造漂亮曲线重启或重配宿主机。

THP 是系统层策略，不应在未经评估的生产机器上为了复现实验临时切换。文章能安全带走的结论只有：页越大，一次写时复制的最小单位就越大。

## SAVE 与 BGSAVE 是两条执行路径

`SAVE` 与 `BGSAVE` 都能生成 RDB，却不是同一条执行路径。

`SAVE` 不 fork。主线程直接调用 `rdbSave()`，从遍历数据、编码、写临时文件到最终替换，事件循环全程不能服务普通命令。实验中，约 500MB 数据集执行 `SAVE` 花了约 328 毫秒，客户端探针看见约 294 毫秒的黑窗；`total_forks` 保持不变。

同一规模执行 `BGSAVE`，`fork` 约 20 毫秒，命令很快返回；子进程继续写盘时，父进程仍能提供服务。

| 行为 | `SAVE` | `BGSAVE` |
| --- | --- | --- |
| 是否 fork | 否 | 是 |
| 主线程停顿范围 | 整个保存过程 | 主要是 fork 与少量收尾 |
| 保存期能否继续服务 | 不能 | 通常可以 |
| COW 额外内存 | 没有子进程 COW | 取决于保存期间的写页 |
| 主要风险 | 长时间不可用 | fork 停顿、内存峰值、CPU/磁盘竞争 |

这不是说 `SAVE` 永远比 `BGSAVE` 差。离线工具、启动脚本或明确接受停机的维护流程，可能宁愿用同步保存换取没有父子并存的内存峰值。但在线实例执行 `SAVE`，必须把完整保存时间当作服务中断，而不是普通慢命令。

`SHUTDOWN SAVE` 也有相同边界：若配置要求最终 RDB，Redis 退出前可能在主进程同步保存；若已有 BGSAVE 子进程，还会先处理子进程再生成最终快照。关机不是自动免除停顿的特殊路径。

## AOF 重写，也要 fork 一次

`BGREWRITEAOF` 与 `BGSAVE` 生成的文件不同，却共享同一类 `redisFork()` 路径。父进程短暂停在 fork，子进程根据 fork 时刻的数据集生成新的 AOF 基础文件；父进程继续接收后续写入。

这里尤其要区分 Redis 7 与旧版本。

Redis 7 使用多段 AOF：base 文件、一个或多个 incremental 文件，以及 manifest。重写前，父进程切换到新的 INCR 文件；之后的新写命令继续写这个增量文件，子进程独立生成新的 base。完成后，父进程更新 manifest，并把旧文件移入历史集合等待清理。

因此，下面这段常见描述只适合 Redis 7 以前的单文件架构：

```text
AOF 重写期间，父进程把所有新命令积在内存 diff buffer；
子进程完成后，再一次性追加到新 AOF。
```

7.4.11 的源码中已经没有那套 rewrite buffer。重写期间的主要额外内存问题重新集中到 COW、父进程正常缓冲和客户端负载上，而不是旧版的整段内存差异日志。

RDB、AOF 和模块后台子进程还要互斥，避免同一时刻启动多个重 I/O 的后台任务。`BGREWRITEAOF` 遇到活跃 RDB 子进程会进入调度状态；`BGSAVE` 默认会拒绝，也可以用 `BGSAVE SCHEDULE` 请求稍后执行。

版本一换，快照机制没变，文件的组织方式已经不同。

## 关掉 RDB，不代表不会 fork

有些实例配置了：

```text
save ""
appendonly no
```

于是得出结论：这台 Redis 没有持久化，不会 fork。

复制会推翻这句话。副本无法部分同步、需要全量同步时，主库必须给它一份一致的数据集。Redis 7.4 默认采用无盘复制，仍会创建 RDB 类型的子进程；区别只是快照流经管道和网络，而不是先写成本地 `dump.rdb`。

实验在约 500MB、51200 个键的主库上连接一只新副本。`sync_full` 增加一次，主库 `total_forks` 从 1 变成 2，最近 fork 约 19.9 毫秒；副本随后完成全量加载。

```text
关闭自动 RDB 保存 ≠ 禁止所有 RDB 快照
关闭本地落盘     ≠ 复制不需要一致视图
```

无盘同步省掉的是主库本地快照文件，不是创建一致快照所需的 fork。主从重连频繁、复制 backlog 太小或副本批量上线，都可能让一台“无持久化”实例重新 fork。

## 内存余量，是为保存窗口留的

Redis 官方建议 Linux 配置 `vm.overcommit_memory=1`。实验宿主机当时是启发式模式 0，Redis 每次启动都会打印警告：低内存条件下，后台保存或复制可能失败。因为 `fork` 与后续 COW 的内存承诺，不适合只按当前空闲页做保守判断。

我没有为实验修改宿主机参数，也没有刻意制造 fork 失败。系统级内存策略不该为了文章跑分被临时改动；而且在容器中，宿主机 overcommit 与 cgroup 硬上限还是两道不同的门。

即使 overcommit 允许 fork，容器的 `memory.max` 或主机物理内存也不会因此变多。父进程新增数据、COW、子进程私有页、客户端缓冲和文件相关开销仍要真实占用内存。接近上限时，后台子进程可能失败或被 OOM killer 终止，严重时主进程也会受影响。

`maxmemory` 更不能当作容器总内存保险丝。它主要约束 Redis 数据集与淘汰行为，不替 cgroup 预留 fork、COW、复制缓冲和进程开销。

容量预算不该只写一句“再留一倍”，也不该假设“COW 通常很小，所以不用留”。至少要带上这些变量：

```text
平时的 RSS 与碎片
保存或重写的持续时间
窗口内的写入速率与写入分布
是否有 THP、swap 或虚拟化放大
AOF、复制和客户端缓冲
容器或主机的硬上限
```

翻倍是需要防守的最坏边界，不是适合每台机器的固定预留公式。

## 快照出问题时，先看哪些指标

一次快照出问题时，可以按时间线收集证据。

fork 阶段看：

```text
INFO stats
  latest_fork_usec
  total_forks

LATENCY LATEST / HISTORY
  fork
```

后台保存阶段看：

```text
INFO persistence
  rdb_bgsave_in_progress
  rdb_current_bgsave_time_sec
  current_fork_perc
  current_save_keys_processed
  current_save_keys_total
```

内存复制阶段看：

```text
current_cow_size
current_cow_peak
current_cow_size_age
rdb_last_cow_size
aof_last_cow_size
```

再把它们与操作系统和容器指标对齐：父子进程、RSS、private/shared dirty、`memory.current`、内存压力、磁盘吞吐、CPU 争用和 OOM 事件。

若 `latest_fork_usec` 很高，而子进程很快完成，问题在 fork；若 fork 很短，保存却持续很久，要查磁盘、CPU、数据编码和文件系统；若 COW 不高而 RSS 持续上涨，要检查父进程新增数据、输出缓冲或碎片；若 COW 很高，则要追保存窗口内哪些写入触碰了大量共享页。

不同阶段要看不同的指标。把所有问题都归为“BGSAVE 慢”，只会让排查重新回到猜测。

## 两个窗口

fork 不会立即复制整个数据集：它复制页表与进程元数据，数据页先共享，前台停顿主要受页数、内核和虚拟化环境影响。BGSAVE 的后台从 fork 返回后开始：主线程会在 fork 时刻停住，但不必等待整个 RDB 文件写完，`SAVE` 才是在主线程完成全程保存。COW 只复制被写到的共享页：静默实例几乎不增加 COW，高写入实例则可能在整个保存窗口中持续复制，键大小与 COW 字节之间没有简单一一对应。RSS 上涨不一定是 COW：新键、客户端缓冲和分配器增长都能让父进程变大，父子 RSS 又会重复统计共享页，必须结合 COW 指标与系统内存统计判断。每一种后台任务都有前台起点：BGSAVE、AOF 重写和复制全量同步都要创建一致视图，磁盘文件、增量日志和网络流只是快照离开子进程的不同出口。

工程上真正要守的是两个窗口：fork 的停顿窗口，以及子进程存活期间的写入窗口。前者决定请求会突然停多久，后者决定内存可能多长得多高。所谓后台，从来不是没有前台成本；它只是把可以延后的工作留给另一条时间线，并在两条时间线分开的那一刻，付出一次必须同步完成的代价。
