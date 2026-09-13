---
title: 断电之后：WAL、redo 日志与崩溃恢复
description: MySQL 系列第四篇。docker kill -9 拔掉电源，3 秒后重启：已提交的 10001 行一行不少，未提交的 5000 行僵尸数据一行不留，CHECK TABLE 全绿。这份从容从哪来？本文把日志拆给你看：一条 UPDATE 的 redo 平均只有 75 字节（宽行 490），页头 LSN 单次前进 489，第一篇「三次 UPDATE 只改 17 字节」里页头页尾那 12 字节的谜底就此揭开；WAL 的证据是「日志已刷盘、21 个页还脏着、checkpoint 落后 5.3MiB」，6 秒后水位追平。然后真的拔两次电：第二次断电前 27MiB redo 未 checkpoint，重启后恢复日志只有一行进度条（源码实锤：回滚超过 1000 个行操作才打印，trx0roll.cc），undo 沿链逆向抄回把僵尸版抹干净。最后是 8.4 的新形态：redo 搬进 #innodb_redo 目录 32 文件环写、#ib_16384 双文件 doublewrite 16MiB 防「写一半的页」、checkpoint 改用消费者式推进。锁全在内存里，重启即散；数据没散，是因为每一笔都先落了日志。
pubDate: 2026-09-12
category: mysql
tags: [MySQL, 数据库, 事务]
---

10001 行已提交的数据，加上一个改了 5000 行还没提交的事务，95 个脏页还没写盘。`docker kill -9`，电源拔了，没有优雅停机，没有刷新。3 秒后服务回来：**已提交的一行不少，未提交的一行不留，CHECK TABLE 报 OK。** 第三篇结尾的问题在这里兑现：锁全住在内存里，重启即散。散的只有锁，数据凭什么没散？

这一篇就是答案：**WAL，先写日志，再写数据。** 每笔改动在碰页面之前先以极小体积落进 redo 日志；脏页慢慢刷、断电后照日志重放。四篇连起来看，InnoDB 的容错设计是一个整体：页与 B+ 树是资产（第一篇），undo 是后悔药（第二篇），锁是并发秩序（第三篇），redo 是断电后的重生（本篇）。

实验环境不变：docker 里的 MySQL 8.4.11。量具以 `SHOW GLOBAL STATUS LIKE 'Innodb_redo_log%'` 与 `SHOW ENGINE INNODB STATUS` 的 LSN 水位为主，核对靠 `docker logs`；本篇最重的一件仪器是 `docker kill -9`。生产事故的断电，在这里可以无限次免费重放。

## redo：一笔改动值多少字节

先看容量。8.4 的 redo 住在 `#innodb_redo/` 目录：32 个 `#ib_redo` 文件环成一个 100MiB 的圈（`innodb_redo_log_capacity`，可在线调），写满一圈回头复用。**redo 是一个环形缓冲区，不是无限追加的日志文件**。这与 8.0 前固定两个 ib_logfile 的设计完全不同，是 8.0.30 起的新形态。

这个圈的样子：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="redo 环形缓冲区：32 个 ib_redo 文件环成 100MiB 的圈，写入头不断前进，checkpoint 之前的部分被消费回收，写满一圈回头复用；checkpoint 推进速度是圈速的裁判，日志消费太慢写入线程就要等" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<circle class="grid" cx="180" cy="136" r="78" fill="none" stroke="#a29d90" stroke-width="30" opacity="0.35"/>
<path class="spine" d="M180 58 A78 78 0 1 1 107 162" fill="none" stroke="#b03a2e" stroke-width="26"/>
<text class="ts" x="180" y="130" text-anchor="middle" font-size="12" fill="#6b675e">100MiB</text>
<text class="ts" x="180" y="148" text-anchor="middle" font-size="11" fill="#6b675e">32 个 #ib_redo 文件</text>
<text class="tc" x="180" y="36" text-anchor="middle" font-size="11" fill="#b03a2e">写入头（current LSN）</text>
<text class="ts" x="88" y="196" text-anchor="middle" font-size="11" fill="#6b675e">checkpoint</text>
<text class="ts" x="320" y="60" font-size="12" fill="#6b675e">朱砂段：还没被 checkpoint 消费的日志</text>
<text class="ts" x="320" y="82" font-size="12" fill="#6b675e">灰段：已消费，等写入头绕回来复用</text>
<text class="ts" x="320" y="112" font-size="12" fill="#6b675e">容量在线可调（老设计要停机）</text>
<text class="tc" x="320" y="142" font-size="12" fill="#b03a2e">checkpoint 是圈速的裁判：</text>
<text class="tc" x="320" y="162" font-size="12" fill="#b03a2e">脏页刷得太慢、圈追上来，写入线程就得等</text>
<text class="ts" x="320" y="192" font-size="12" fill="#6b675e">观测量具：Innodb_log_waits，正常应为 0</text>
<text class="ts" x="320" y="214" font-size="12" fill="#6b675e">8.0.30 起取代 ib_logfile0/1 两个大文件</text>
</svg>
</figure>

一条 UPDATE 值多少 redo？实测两种行宽（`Innodb_redo_log_current_lsn` 前后差值）：

| 表 | 每事务 | redo 总量 | 每行 |
| --- | --- | --- | --- |
| churn（v 列 1 字节） | 5000 行 | 378,199 字节 | **75 字节** |
| churn_fat（pad 列 200 字节） | 5000 行 | 2,450,180 字节 | **490 字节** |

窄行每行 75 字节，宽行每行 490 字节，差值 415 ≈ 旧值加新值的字节量。**redo 记的是「改了什么」，不是「改完长什么样」**：物理页上的旧字节 → 新字节，加上页号定位，一条紧凑记录。这就是 WAL 的经济学：改 16KiB 的一页只在日志里花几十字节，提交的代价与「改了多少」成正比、与「数据多大」无关。

这笔账画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 176" role="img" aria-label="WAL 经济学：一次 UPDATE 改动的是一个 16KiB 的页，但落进 redo 日志的只有旧字节到新字节的物理 diff 加页号定位，窄行 75 字节、宽行 490 字节，差值恰是旧值加新值的字节量" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my4As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">改动的对象是页，落日志的只有 diff</text>
<rect class="bx-q" x="30" y="44" width="130" height="84" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="95" y="80" text-anchor="middle" font-size="12" fill="#2b2a26">数据页</text>
<text class="ts" x="95" y="100" text-anchor="middle" font-size="11" fill="#6b675e">16KiB</text>
<line class="fl" x1="160" y1="86" x2="216" y2="86" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my4As2)"/>
<text class="ts" x="188" y="76" text-anchor="middle" font-size="10" fill="#6b675e">一次 UPDATE</text>
<rect class="bx-sick" x="224" y="56" width="12" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="244" y="70" font-size="11" fill="#6b675e">窄行（v 1 字节）：75 B/行</text>
<rect class="bx-sick" x="224" y="92" width="78" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="310" y="106" font-size="11" fill="#6b675e">宽行（pad 200 字节）：490 B/行</text>
<text class="tc" x="450" y="70" font-size="11" fill="#b03a2e">差 415 字节</text>
<text class="ts" x="450" y="88" font-size="11" fill="#6b675e">≈ 旧值 + 新值的字节量</text>
<text class="ts" x="450" y="106" font-size="11" fill="#6b675e">条内还有页号定位</text>
<text class="ts" x="20" y="154" font-size="12" fill="#6b675e">提交的代价与「改了多少」成正比、与「数据多大」无关：5000 行窄行总共 378KB 日志</text>
</svg>
</figure>

页自己也有记录。还记得第一篇卖的那个关子吗：三次 UPDATE 前后导出对比，17 个字节变了，其中 12 个在页头页尾，当时一笔带过。现在拆开：

```text
页 4 头部 @16，8 字节：FIL_PAGE_LSN = 2172500093 → 2172503745（前进 3652）
页 4 尾部 @16376，4 字节：旧版校验和（现已废弃）的遗物
页 4 头部 @0，4 字节：CRC32 校验和，随内容变
```

**FIL_PAGE_LSN 是页的「最后修改时间戳」**，即最后一次改动它的事务在全局 LSN 上的位置。受控实验更精确：单行表一次 UPDATE，页 4 的 FIL_PAGE_LSN 前进 489 字节（这条 redo 链还包含页内链表调整等元数据更新）。恢复时它有妙用，下文见。

## WAL：先记日志，再改页面

现在把提交时刻的现场拍下来。插 2 万行（约 8MiB 数据）并提交，`innodb_flush_log_at_trx_commit=1`（默认），提交返回的**那一瞬间**：

```text
Log sequence number          2347537359   ← 已产生的日志末尾
Log flushed up to            2347537359   ← 已刷盘的日志（与上面相等！）
Last checkpoint at           2342232939   ← 检查点，落后 5.3MiB
Modified db pages           21            ← 21 个脏页还没写盘
```

提交那一刻，**redo 已 100% 落盘**（flushed = current）。这就是 `innodb_flush_log_at_trx_commit=1` 的含义，也是「提交成功」的全部实质。但数据页还躺在内存里（21 个脏页），checkpoint 落后 5.3MiB。6 秒后再看：`Modified db pages 0`，水位全部追平。

**WAL 的秩序是：日志先行，页面随意。** 只要日志在，脏页什么时候刷盘无所谓，最坏情况它们没刷，重启时照日志重放一遍。checkpoint 的任务就是给「重放」划一条起跑线：脏页陆续刷盘后，checkpoint 推进，**日志里 checkpoint 之前的部分就可以被回收复用**（环形缓冲区的圈就是这么转起来的）。

提交瞬间的三个水位：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="提交返回那一瞬间的 LSN 水位：current 与 flushed 相等都在 2347537359，redo 百分之百落盘；checkpoint 停在 2342232939 落后 5.3MiB；另有 21 个脏页还在内存里，6 秒后全部刷完、水位追平" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">插 2 万行提交返回的那一瞬间（双 1 默认）</text>
<line class="axis" x1="40" y1="80" x2="620" y2="80" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="330" y1="66" x2="330" y2="94" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="330" y="56" text-anchor="middle" font-size="11" fill="#6b675e">Last checkpoint</text>
<text class="ts" x="330" y="112" text-anchor="middle" font-size="10" fill="#6b675e">2342232939</text>
<line class="flc" x1="560" y1="62" x2="560" y2="98" stroke="#b03a2e" stroke-width="2.4"/>
<text class="tc" x="560" y="52" text-anchor="middle" font-size="11" fill="#b03a2e">current = flushed</text>
<text class="ts" x="560" y="112" text-anchor="middle" font-size="10" fill="#6b675e">2347537359</text>
<path class="flc" d="M330 124 L330 132 L560 132 L560 124" fill="none" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="445" y="150" text-anchor="middle" font-size="11" fill="#b03a2e">5.3MiB 日志未 checkpoint：重放的起跑线还在这里</text>
<text class="ts" x="40" y="176" font-size="12" fill="#6b675e">Modified db pages = 21：数据页还躺在内存里；6 秒后归 0，水位全部追平</text>
<text class="ts" x="40" y="196" font-size="12" fill="#6b675e">「提交成功」的全部实质 = 日志已落盘；数据页什么时候写盘，没人催</text>
</svg>
</figure>

断电前那组数字（第二次实验）正好是这个秩序的极端现场：**27MiB 日志未 checkpoint、95 个脏页没刷盘**。按「先写数据」的直觉，这 27MiB 涉及的已提交改动应该丢了。结局是没丢，因为它们在 redo 环里。

## 拔电源

两次断电实验，现场相同：已提交数据 + 一个挂着的未提交事务（`docker exec -d` 的容器内会话，挂 300 秒），`docker kill -9` 直接杀容器，**没有优雅停机、没有 SHUTDOWN、没有最后的刷盘**。

第一次：t_crash 表 10001 行已提交（SUM(v)=50015001），未提交事务正在给前 5000 行做 v+1000000，95 脏页。第二次规模放大：churn_fat 肥行表先灌 30 轮已提交 UPDATE（约 73MiB redo），再挂一个 5000 行肥行未提交事务，断电前 `logical_size=26,959,872`，**27MiB 日志在 checkpoint 前面**。

两次重启的完整恢复日志（`docker logs`，一字未删）：

```text
0 [System] [InnoDB] InnoDB initialization has started.
0 [System] [InnoDB] InnoDB initialization has ended.
0 [System] [Server] Starting XA crash recovery...
0 [System] [Server] XA crash recovery finished.
InnoDB: Progress in percents: 1 2 3 4 ... 100
0 [System] [Server] ready for connections
```

3 秒后服务可用。两行 System 之间的 0.9 秒是 redo 重放；那条唯一的进度条是 undo 回滚（下一节）。然后是核对：

```text
第一次：SELECT COUNT(*), SUM(v) FROM t_crash;
        → 10001 行，50015001 —— 与断电前完全一致
        SELECT id, v WHERE id IN (1, 5000, 5001, 10001) → 全是原值
        CHECK TABLE t_crash → OK
        INNODB_TRX → 0 个活跃事务

第二次：SELECT SUM(pad='J') AS committed, SUM(pad='Z') AS zombie FROM churn_fat;
        → 5000, 0 —— 已提交的 5000 行全在，僵尸版一个不留
```

**崩溃恢复就三步**：重放 redo（物理层面把所有改动重演一遍，无论提交与否）；回滚未提交（undo 层面沿链逆向抄回）；然后开门营业。没有神秘力量，只有日志。

三步与日志的对应：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 218" role="img" aria-label="崩溃恢复三步：第一步重放 redo，物理层面把所有改动重演一遍不问提交，本次实验耗时 0.9 秒；第二步回滚未提交事务，用 undo 沿版本链逆向抄回 5000 行僵尸改动，进度条 0.3 秒；第三步开门营业 ready for connections" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my4As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">kill -9 之后 3 秒，三步走完</text>
<rect class="bx-sick" x="20" y="44" width="190" height="94" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="115" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">① 重放 redo</text>
<text class="ts" x="115" y="86" text-anchor="middle" font-size="10" fill="#6b675e">物理重演所有改动</text>
<text class="ts" x="115" y="102" text-anchor="middle" font-size="10" fill="#6b675e">不问提交与否</text>
<text class="ts" x="115" y="122" text-anchor="middle" font-size="10" fill="#6b675e">本次 0.9 秒</text>
<line class="fl" x1="210" y1="91" x2="231" y2="91" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my4As4)"/>
<rect class="bx" x="235" y="44" width="190" height="94" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">② 回滚未提交</text>
<text class="ts" x="330" y="86" text-anchor="middle" font-size="10" fill="#6b675e">页面里躺着僵尸改动：</text>
<text class="ts" x="330" y="102" text-anchor="middle" font-size="10" fill="#6b675e">undo 沿链逆向抄回 5000 行</text>
<text class="ts" x="330" y="122" text-anchor="middle" font-size="10" fill="#6b675e">进度条 0.3 秒</text>
<line class="fl" x1="425" y1="91" x2="446" y2="91" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my4As4)"/>
<rect class="bx-q" x="450" y="44" width="190" height="94" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="545" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">③ 开门营业</text>
<text class="ts" x="545" y="86" text-anchor="middle" font-size="10" fill="#6b675e">ready for connections</text>
<text class="ts" x="545" y="102" text-anchor="middle" font-size="10" fill="#6b675e">10001 行一行不少</text>
<text class="ts" x="545" y="122" text-anchor="middle" font-size="10" fill="#6b675e">僵尸版一行不留</text>
<text class="ts" x="20" y="170" font-size="12" fill="#6b675e">恢复日志的对应：两行 System 之间是重放；Progress in percents 那行是回滚</text>
<text class="ts" x="20" y="192" font-size="12" fill="#6b675e">锁不在这三步里：它们住在内存，断电即散，重启后从零开始</text>
</svg>
</figure>

### redo 重放：拿着 FIL_PAGE_LSN 挑活儿

重放不是无脑全量。第一篇讲页骨架时提过页头 LSN，现在它上岗：**每个 redo 记录自带它全局 LSN，每页头上有 FIL_PAGE_LSN**。恢复程序拿 redo 记录的 LSN 与目标页头上的 LSN 对表：

- redo 的 LSN ≤ 页的 FIL_PAGE_LSN：这页已经比这条日志新了，**跳过**；
- redo 的 LSN > 页的 FIL_PAGE_LSN：页面落后，**重放这条**。

所以 95 个脏页里，凡是断电前恰好已被后台线程刷下去的，重放时会被页头 LSN 挡回来：**每页只补自己缺的那几笔**，不重不漏。这也顺带解释了 CRC32 校验和的用途：重放前先验页身，撕裂页（见 doublewrite 节）当场现形。

对表的逻辑：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="redo 重放的挑选逻辑：每条 redo 记录自带全局 LSN，每个页头有 FIL_PAGE_LSN 记录最后修改位置；记录 LSN 小于等于页头 LSN 说明页比日志新、跳过，大于则页面落后、重放这条；重放前先验 CRC32，撕裂页当场现形" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my4As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">重放不是无脑全量：每条记录先和页头对表</text>
<rect class="bx-q" x="30" y="44" width="250" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="155" y="64" text-anchor="middle" font-size="11" fill="#6b675e">redo 记录</text>
<text class="ts" x="155" y="82" text-anchor="middle" font-size="11" fill="#6b675e">自带全局 LSN = X</text>
<rect class="bx-q" x="380" y="44" width="250" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="505" y="64" text-anchor="middle" font-size="11" fill="#6b675e">目标页 · 页头</text>
<text class="ts" x="505" y="82" text-anchor="middle" font-size="11" fill="#6b675e">FIL_PAGE_LSN = Y</text>
<line class="fl" x1="155" y1="92" x2="290" y2="116" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my4As5)"/>
<line class="fl" x1="505" y1="92" x2="370" y2="116" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my4As5)"/>
<rect class="bx" x="250" y="120" width="160" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="141" text-anchor="middle" font-size="11" fill="#6b675e">对表：X 与 Y 谁大？</text>
<line class="fl" x1="280" y1="154" x2="180" y2="172" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my4As5)"/>
<line class="fl" x1="380" y1="154" x2="480" y2="172" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my4As5)"/>
<rect class="bx" x="30" y="176" width="290" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="175" y="197" text-anchor="middle" font-size="11" fill="#6b675e">X ≤ Y：页比日志新，跳过</text>
<rect class="bx-sick" x="340" y="176" width="290" height="34" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="485" y="197" text-anchor="middle" font-size="11" fill="#b03a2e">X &gt; Y：页面落后，重放这条</text>
</svg>
</figure>

### undo 回滚：那个进度条在数什么

重放完成后，数据库处于一个尴尬的状态：**页面里躺着未提交事务的改动**（重放是物理的，不问提交）。恢复程序扫一遍所有活跃事务标记，找到没有 COMMIT 记录的，启动回滚，**用第二篇的老朋友 undo，沿版本链逆向抄回**。5000 行的僵尸改动就这样被抹掉。

那条 `Progress in percent: 1 2 3 … 100` 的进度条，源码在 `trx0roll.cc`：

```c
/* We print rollback progress info if we are in crash recovery
   and the transaction has at least 1000 row operations to undo. */
if (trx == trx_roll_crash_recv_trx && trx_roll_max_undo_no > 1000) { ... }
```

**恢复期回滚超过 1000 个行操作才打印进度条**，我们的 5000 行刚好过线。0.3 秒刷完是实验规模小；生产上断电前的百万行大事务回滚起来以小时计，这条进度条是 DBA 在日志里唯一的安慰。

另一组数字值得留意：**回滚比提交贵**。提交只需把 undo 写好（向前抄一次）；回滚要把每环 undo 逐条读回、逐行改回（沿链逆向走一遍）。这也解释了为什么 InnoDB 需要 MVCC 篇讲的 purge 异步回收：把清理挪出关键路径，提交才能便宜。

## doublewrite：页是 16KiB，磁盘的最小写入不是

WAL 防的是「改动丢失」，还有另一种祸：「**写了一半的页**」。16KiB 的页刷盘时，操作系统对文件的写请求通常按 4KiB 分解，断电可能停在中间，页面半新半旧。重放 redo 能补齐新的一半，但**旧一半已经损坏**：redo 记录的是「旧字节 → 新字节」的物理 diff，旧字节没了，diff 无从套起。这叫**撕裂页（torn page）**。

解法朴素到发笑：**先把整页抄去一个中立地点，再写原位。** 8.4 的实现是 `#innodb_redo` 旁边的两个文件：

```text
#ib_16384_0.dblwr   4,194,304 字节
#ib_16384_1.dblwr  12,582,912 字节
```

合计 16MiB = 128 页 × 16KiB × 2（`innodb_doublewrite_pages=128`）。批刷流程：脏页先顺序写入 dblwr 文件，fsync，再写到各自 .ibd 里的原位。若原位写撕裂，**dblwr 里那份完好的副本还在**，恢复时直接整页拷回，再走 redo。实测灌 3 万行肥数据前后，两个 dblwr 文件尺寸一点没变：**它是循环复用的缓冲区，不是追加型文件**，与 redo 的环形设计呼应。

两道写与那道祸：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 256" role="img" aria-label="doublewrite 防撕裂页：16KiB 页被操作系统按 4KiB 分解写盘，断电可能停在中间形成半新半旧的撕裂页；批刷时脏页先顺序写入 dblwr 文件并 fsync，再写 ibd 原位，原位撕裂就用 dblwr 的完好副本整页拷回再走 redo diff" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my4As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">先抄一份，再写原位</text>
<rect class="bx-q" x="20" y="70" width="110" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="75" y="94" text-anchor="middle" font-size="11" fill="#6b675e">脏页</text>
<text class="ts" x="75" y="112" text-anchor="middle" font-size="11" fill="#6b675e">16KiB</text>
<line class="fl" x1="130" y1="84" x2="176" y2="64" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my4As6)"/>
<text class="ts" x="146" y="62" font-size="10" fill="#6b675e">①</text>
<rect class="bx" x="180" y="40" width="190" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="275" y="60" text-anchor="middle" font-size="11" fill="#2b2a26">#ib_16384_0/1.dblwr</text>
<text class="ts" x="275" y="78" text-anchor="middle" font-size="10" fill="#6b675e">顺序写整页 + fsync · 16MiB 循环复用</text>
<line class="fl" x1="130" y1="112" x2="156" y2="134" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my4As6)"/>
<text class="ts" x="128" y="136" font-size="10" fill="#6b675e">②</text>
<rect class="bx" x="160" y="112" width="180" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="250" y="132" text-anchor="middle" font-size="11" fill="#2b2a26">各自 .ibd 的原位</text>
<text class="tc" x="250" y="150" text-anchor="middle" font-size="10" fill="#b03a2e">16KiB 按 4KiB 分四次写</text>
<rect class="bx-sick" x="380" y="112" width="26" height="44" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="406" y="112" width="26" height="44" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-gone" x="432" y="112" width="26" height="44" fill="none" stroke="#a29d90" stroke-dasharray="3 2"/>
<rect class="bx-gone" x="458" y="112" width="26" height="44" fill="none" stroke="#a29d90" stroke-dasharray="3 2"/>
<text class="ts" x="496" y="130" font-size="10" fill="#6b675e">断电停在中间：</text>
<text class="ts" x="496" y="146" font-size="10" fill="#6b675e">前两片新、后两片旧</text>
<text class="ts" x="496" y="162" font-size="10" fill="#6b675e">= 撕裂页</text>
<line class="fl" x1="360" y1="92" x2="360" y2="192" stroke="#6b675e" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#my4As6)"/>
<text class="ts" x="368" y="180" font-size="10" fill="#6b675e">副本还在</text>
<rect class="bx-q" x="60" y="196" width="430" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="275" y="217" text-anchor="middle" font-size="11" fill="#6b675e">恢复：dblwr 的完好副本整页拷回 → 再走 redo 补 diff</text>
<text class="ts" x="510" y="214" font-size="11" fill="#6b675e">CRC32 验页身，</text>
<text class="ts" x="510" y="230" font-size="11" fill="#6b675e">撕裂当场现形</text>
<text class="ts" x="20" y="250" font-size="12" fill="#6b675e">WAL 防「丢改动」，dblwr 防「坏基线」：redo 是物理 diff，旧字节没了就无从套起</text>
</svg>
</figure>

（有人会问：redo 自己会不会撕裂？redo 记录有校验和、块内也有填充机制，重放时验坏即停，撕裂的日志尾巴会被识别并丢弃，不影响已完成部分。另外 `innodb_flush_method=O_DIRECT` 绕开页缓存、自 8.0.20 起 doublewrite 恒开，这两道闸门就不展开了。）

## 8.4 的三处换代

这一篇的实验里，8.4 与老教程对不上的地方有三处，值得单独记下：

**redo 从「两个大文件」变成「环写目录」。** 老资料里的 `ib_logfile0/1` 在 8.0.30 后已被 `#innodb_redo/` 目录的 32 个小文件取代，`innodb_redo_log_capacity` 在线可调（老设计改尺寸要求停机）。容量不是越大越好：**checkpoint 才是圈速的裁判**。日志消费太慢、圈追上来，写入线程就得等（`Innodb_log_waits` 计数器，正常应为 0；本实验全程 0）。

**checkpoint 从「追脏页」变成「消费者式推进」。** 老资料爱画「checkpoint 等待最老脏页」的图；8.4 的 `Innodb_redo_log_checkpoint_lsn` 是消费者式推进，配合后台 flush 线程的节奏。对使用者影响不大，对读老教程的人是坑：日志里看到 checkpoint LSN 与脏页数不同步，不是异常，是新设计。

**undo 与 redo 彻底分家。** 第二篇已经拆过 undo 的独立表空间；这里补一句分工：**undo 管「回到过去」（回滚、MVCC），redo 管「重演未来」（重放）**。两本日志一进一退，撑起 ACID 的 A 与 D；C（一致性）是前两篇的锁与隔离级别在撑。四篇至此合龙。

## 断电之后靠什么

redo 记的是 diff，不是照片：窄行 75 字节、宽行 490 字节一条；页头的 FIL_PAGE_LSN 随每次改动前进（单次 UPDATE +489），第一篇 17 字节差异里的 12 字节页头页尾之谜，至此全部拆开。

提交的实质是「日志已落盘」，不是「数据已写盘」：提交瞬间 flushed = current，而 21 个脏页还在内存里、checkpoint 落后 5.3MiB。断电丢不丢，只看日志刷没刷；`innodb_flush_log_at_trx_commit=1` 的每次提交 fsync，就是为这一刻付的钱。

崩溃恢复三步走：重放、回滚、开门。redo 重放拿页头 LSN 挑活儿，每页只补缺的；未提交事务由 undo 沿链逆向抹掉（>1000 行操作才有进度条，trx0roll.cc 实锤）；两次 kill -9 的核对结果完全一致：已提交的一行不少、僵尸版一行不留。

撕裂页的解法是「先抄一份再写原位」：doublewrite 双文件 16MiB 循环复用，防的是 redo 补不了的那半页。WAL 管「丢改动」，dblwr 管「坏基线」，两道防线各管一祸。

锁是内存的秩序，日志是磁盘的秩序。第三篇那些 GRANTED 与 WAITING 断电即散；数据不散，是因为每一笔在成为页上的事实之前，先成为了日志里的事实。四篇合起来：资产（页与树）→ 后悔药（undo）→ 并发（锁与 MVCC）→ 重生（redo），InnoDB 的容错设计没有单点神迹，只有层层核对。

存储、MVCC、锁、日志，前四篇到这里齐了。接下来转向查询侧：第一篇回表的 1717 倍、EXPLAIN 的 Covering 标注，那些「为什么这么走」的问题，下一篇从优化器开始拆。
