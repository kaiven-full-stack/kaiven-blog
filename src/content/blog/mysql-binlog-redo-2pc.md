---
title: 提交的那一停：binlog、redo 与两阶段裁决
description: MySQL 系列第八篇。一笔提交 2.06ms，其中 99% 花在两次 fsync 上。本篇拆开这一停：为什么引擎先写 redo（prepare）、binlog 落盘后才敢说「提交」。sync_binlog × innodb_flush_log_at_trx_commit 矩阵实测双 1 2.06ms、双 0 20μs；关 binlog 退化成单阶段 0.84ms；8 路并发组提交把 fsync 摊薄到 0.38 次/事务。kill -9 三方核对：ack 2084、行数 2085、binlog XID 2085，崩溃窗口里那笔「引擎已 prepare、binlog 已落盘、ack 未发出」的事务被 binlog 裁决为提交；双 0 崩溃则留下 2085 个 binlog 超前于引擎的幽灵事务。外加外部 XA 跨重启存活实测，与 8.4 源码裁决逻辑逐行对上。
pubDate: 2026-09-18
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

插入程序狂奔到 ack 计数 2084 时 `kill -9`，mysqld 没有任何善后动作。重启后表里有 2085 行，binlog 里 2085 个 XID，客户端只收到过 2084 个 ack。多出来的那一行，是谁批准的？

上一篇文章写缓冲池，结尾留了个钩子：change buffer 的「推迟落盘」背后，是「改页前必须先记日志」的另一半。这一篇就停在那个**写路径上最贵的一瞬：提交（COMMIT）**。第四篇讲过 WAL（先记 redo 再改页），第六篇把 binlog 当复制素材拆过字节。但一笔提交从 `COMMIT` 语句到客户端收到 OK，中间要**跨两本日志、走一次内部两阶段提交（内部 XA）**：引擎先写 redo prepare，binlog 落盘之后才敢做 commit。为什么这么绕？谁裁决崩溃后的事务生死？实测会给出比文档更锋利的答案。

先量一笔提交的开销构成。量具：`performance_schema.events_waits_summary_global_by_event_name` 的 `wait/io/file/sql/binlog`（binlog 的 write+fsync 合计 io 次数）、`Innodb_os_log_fsyncs`（redo 的 fsync 计数）、`NOW(6)` 过程内计时（别在 shell 里 `time`，docker exec 的启动开销会污染毫秒级数字，这是我踩过的坑）。单行自动提交连续 500 笔，双 1 默认（`sync_binlog=1`、`innodb_flush_log_at_trx_commit=1`）：

```text
2,063.8 μs/提交
binlog 文件 io     1000 次（500 write + 500 fsync，恰好每事务 2 次）
redo fsync          711 次
```

**一笔 2 毫秒的提交，代码本身只值几十微秒，剩下 99% 都在等两次 fsync**。这两个参数各管一本日志的落盘纪律，是写路径上最重要的两个旋钮。矩阵跑起来。

## 四格矩阵：两本日志的落盘纪律

`sync_binlog` 管 binlog（0=交给 OS 缓存、1=每批 fsync、N=攒 N 个事务 fsync 一次）；`innodb_flush_log_at_trx_commit` 管 redo（0=每秒刷、1=每提交 fsync、2=每提交 write 进 OS 缓存）。同样 500 笔单行自动提交，各格实测（binlog io = write+fsync 合计；500 笔对照里 write 恒为 500 次，多出来的就是 fsync）：

| 组合 | μs/提交 | redo fsync | binlog io | 崩溃时丢什么 |
| --- | --- | --- | --- | --- |
| 双 1（默认） | 2,063.8 | ~711 | 1000（500w+500f） | **不丢已 ack 的** |
| (1, 0) | 810.0 | 0 | 1000（500w+500f） | 秒级 redo：**实例崩溃不丢，主机断电丢一秒** |
| (0, 1) | 1,025.1 | ~728 | 500（500w+0f） | binlog 只进 OS 缓存 |
| 双 0 | **20.4** | 1 | 500（500w+0f） | 两本都只有 OS 缓存兜底 |
| (1000, 2) | 42.6 | 1 | 500（500w+0f*） | 攒批 fsync + redo 进缓存 |

*sync_binlog=1000 在 500 笔内没攒满，fsync 一次未发。这就是它的语义：攒满 N 个才落一次盘。源码 `sync_binlog_file` 里 `sync_period && ++sync_counter >= sync_period` 的短路，0 与「不足 N」在单笔视角下同样不 fsync。

三组对照读出三个事实：

**(1,0) 0.81ms ≈ binlog 一停。** redo 不 fsync 了（计数 0，全靠每秒的 master thread 刷），省掉的恰是 2.06 − 0.81 ≈ 1.2ms：**两本日志的 fsync 各值约 1ms**，这就是 NVMe 上一次 fsync 的单价（容器里 dd oflag=dsync 实测同量级）。双 0 的 20μs 里 fsync 已全部消失（binlog 一列 500 次 io 全是 write），剩下的就是纯代码路径。

**(1000,2) 是「便宜的近似安全」。** 43μs 比双 0 贵一倍多，但换回的是：binlog 攒满 1000 个事务（或轮转/关库时）才落一次盘、redo 每笔都 write 进 OS 缓存。**mysqld 崩溃几乎不丢（OS 缓存还在），只有主机断电才丢窗口**。很多「我要安全但受不了双 1」的业务，落点其实是这一格而不是双 0。

**双 0 比双 1 快 100 倍，代价在崩溃那天结算。** 结算方式见下文 kill -9 实验，比「丢几行」有意思得多。

还有一个对照必须做：**binlog 整个关掉（skip-log-bin）会怎样？** 重启后同样 500 笔提交：

```text
skip-log-bin：  837.8 μs/提交，redo fsync 555 次（每事务恰好 1 次）
双 1（开着）：  2,063.8 μs/提交，redo fsync 711 次
```

关掉 binlog 后，**两阶段提交整个消失了**：没有 binlog 这个「第二参与者」，redo 不需要 prepare/commit 两段式，一笔 fsync 直达提交，快了 1.2ms。源码上这是 `total_ha_2pc`（具备两阶段能力的日志/引擎数）从 2 降到 1：协调者不需要裁决，事务单阶段完成。**binlog 的存在本身就是提交变慢的原因**，复制和恢复是一对明码标价的取舍。

六种配置的单价：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 248" role="img" aria-label="六种落盘配置的每笔提交耗时条形图：双 1 默认 2063.8 微秒最贵，binlog0 加 redo1 是 1025.1，关 binlog 837.8，binlog1 加 redo0 是 810，binlog1000 加 redo2 是 42.6，双 0 只要 20.4 微秒；每撤掉一次 fsync 条就短一截" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">500 笔单行自动提交：μs/笔（条长同一比例尺）</text>
<text class="ts" x="20" y="58" font-size="11" fill="#6b675e">双 1（默认）</text>
<rect class="bar" x="170" y="44" width="423" height="18" fill="#2b2a26"/>
<text class="onbar" x="178" y="57" font-size="10" fill="#f6f3ec">2063.8 · 两次 fsync 全上</text>
<text class="ts" x="20" y="86" font-size="11" fill="#6b675e">binlog=0, redo=1</text>
<rect class="bar" x="170" y="72" width="210" height="18" fill="#2b2a26"/>
<text class="ts" x="388" y="85" font-size="10" fill="#6b675e">1025.1 · binlog 只进 OS 缓存</text>
<text class="ts" x="20" y="114" font-size="11" fill="#6b675e">关 binlog</text>
<rect class="bar" x="170" y="100" width="172" height="18" fill="#6b675e"/>
<text class="ts" x="350" y="113" font-size="10" fill="#6b675e">837.8 · 单阶段，每事务恰好 1 次 fsync</text>
<text class="ts" x="20" y="142" font-size="11" fill="#6b675e">binlog=1, redo=0</text>
<rect class="bar" x="170" y="128" width="166" height="18" fill="#2b2a26"/>
<text class="ts" x="344" y="141" font-size="10" fill="#6b675e">810.0 · redo 靠每秒刷</text>
<text class="ts" x="20" y="170" font-size="11" fill="#6b675e">binlog=1000, redo=2</text>
<rect class="bar" x="170" y="156" width="9" height="18" fill="#2b2a26"/>
<text class="tc" x="187" y="169" font-size="10" fill="#b03a2e">42.6 · 攒批 fsync：便宜的近似安全</text>
<text class="ts" x="20" y="198" font-size="11" fill="#6b675e">双 0</text>
<rect class="bar" x="170" y="184" width="4" height="18" fill="#2b2a26"/>
<text class="tc" x="182" y="197" font-size="10" fill="#b03a2e">20.4 · 纯代码路径：fsync 全部消失</text>
<text class="ts" x="20" y="226" font-size="12" fill="#6b675e">一次 fsync 的单价约 1ms：每撤掉一次，条就短一截</text>
<text class="ts" x="20" y="244" font-size="12" fill="#6b675e">双 0 与 (1000,2) 的差距不在速度，在崩溃那天怎么结算</text>
</svg>
</figure>

## 中间态长什么样：一条提交的四步

把 2.06ms 切开，一笔事务提交的真实次序（8.4 源码 `MYSQL_BIN_LOG::ordered_commit`）：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="一笔提交的四步：第一步引擎写 redo prepare 段并 fsync，第二步事务事件流写进 binlog 并 fsync，这两步各值约 1 毫秒、占掉 2.06 毫秒的 99%；第三步引擎写 redo commit 段不必立刻落盘；第四步客户端收到 OK" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my8As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">2.06ms 切开：四步里两步在等盘</text>
<rect class="bx-sick" x="12" y="44" width="145" height="80" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="84" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">① redo prepare</text>
<text class="ts" x="84" y="86" text-anchor="middle" font-size="10" fill="#6b675e">引擎日志写 + fsync</text>
<text class="tc" x="84" y="106" text-anchor="middle" font-size="11" fill="#b03a2e">≈1ms</text>
<line class="fl" x1="157" y1="84" x2="173" y2="84" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my8As1)"/>
<rect class="bx-sick" x="177" y="44" width="145" height="80" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="249" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">② binlog 落盘</text>
<text class="ts" x="249" y="86" text-anchor="middle" font-size="10" fill="#6b675e">事件流写 + fsync</text>
<text class="tc" x="249" y="106" text-anchor="middle" font-size="11" fill="#b03a2e">≈1ms</text>
<line class="fl" x1="322" y1="84" x2="338" y2="84" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my8As1)"/>
<rect class="bx" x="342" y="44" width="145" height="80" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="414" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">③ redo commit</text>
<text class="ts" x="414" y="86" text-anchor="middle" font-size="10" fill="#6b675e">写 commit 段</text>
<text class="ts" x="414" y="106" text-anchor="middle" font-size="10" fill="#6b675e">不用立刻落盘 · 微秒级</text>
<line class="fl" x1="487" y1="84" x2="503" y2="84" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my8As1)"/>
<rect class="bx-q" x="507" y="44" width="141" height="80" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="577" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">④ ack</text>
<text class="ts" x="577" y="86" text-anchor="middle" font-size="10" fill="#6b675e">客户端收到 OK</text>
<path class="flc" d="M12 138 L12 146 L322 146 L322 138" fill="none" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="167" y="164" text-anchor="middle" font-size="11" fill="#b03a2e">2.06ms 的 99% 花在这两次 fsync</text>
<text class="ts" x="20" y="190" font-size="12" fill="#6b675e">顺序是地基：① 必须先于 ②；关掉 binlog 后 ② 消失、①③ 并成单阶段，实测 0.84ms</text>
<text class="ts" x="20" y="208" font-size="12" fill="#6b675e">④ 排在 ③ 之后：崩溃裁决只认 ② 的凭证，ack 发没发不参与判定</text>
</svg>
</figure>

关键在 ①②③ 的**顺序**：redo 的 prepare 必须先于 binlog 落盘。为什么？看崩溃后重启时恢复程序手里的两张牌：引擎侧扫描 redo，找出所有 **prepared 状态**的事务（改动的页已在、但没走到 commit 段）；binlog 侧顺序扫描文件，收集每个 `Xid` 事件（= 事务在 binlog 里完整落盘的凭证）。然后裁决。8.4 的裁决逻辑在 `sql/xa/recovery.cc`，核心就一句：

```cpp
if (info.commit_list ? info.commit_list->count(xid) != 0 : ...) {
  exec_status = ht.commit_by_xid(&ht, ...);   // binlog 里有它 → 提交
} else {
  exec_status = ht.rollback_by_xid(&ht, ...); // binlog 里没有 → 回滚
}
```

**binlog 是裁决书，引擎是执行者。** 所以 prepare 必须先落盘：如果 binlog 里有这笔事务、引擎侧却找不到 prepared 记录（redo 没落盘就崩了），就会出现「binlog 承诺了复制流、引擎却拿不出数据」，从库重演出主库不存在的行。顺序反过来的话（binlog 先落盘、redo 后落盘），崩溃点选在中间，就会破坏「主库表内容 ⊆ binlog 内容 ⊆ 从库内容」这条链。至于 ④ 的 ack，源码里发在引擎 commit 段（`process_commit_stage_queue` → `signal_done`）之后；但**崩溃裁决只认 ②**：只要 binlog 里有凭证，引擎的 commit 段没走到也会被恢复程序补提交。这就是「异步复制」里「异步」的确切位置：**客户端的 OK 比从库的重演早一步，比崩溃的安全性晚一步**。

那 binlog 里收集 XID 的具体位置在哪？`sql/binlog/log_sanitizer.cc` 的 `process_xid_event`：恢复程序逐事件读 binlog，每读到一个 `Xid_log_event`，就 `m_internal_xids.insert(ev.xid)`。这份集合传给 `ha_recover(&m_internal_xids, ...)`，就是上面那句裁决的 `commit_list`。整个「binlog 是裁决书」在源码里就这几行，朴素得惊人。

裁决的全流程：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 252" role="img" aria-label="崩溃恢复的裁决流程：引擎侧扫 redo 找出所有 prepared 状态的事务，binlog 侧顺序读 Xid 事件收集落盘凭证名单；recovery.cc 拿 prepared 事务的 XID 查名单，在名单里就 commit_by_xid 补提交，不在就 rollback_by_xid 回滚" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my8As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">重启后的裁决：两张牌，一个名单</text>
<rect class="bx" x="20" y="44" width="280" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="160" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">引擎侧 · 扫 redo</text>
<text class="ts" x="160" y="86" text-anchor="middle" font-size="10" fill="#6b675e">找出所有 prepared 状态的事务</text>
<rect class="bx" x="360" y="44" width="280" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="500" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">binlog 侧 · 顺序读</text>
<text class="ts" x="500" y="86" text-anchor="middle" font-size="10" fill="#6b675e">收集每个 Xid 事件 = 落盘凭证名单</text>
<line class="fl" x1="160" y1="100" x2="290" y2="132" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As3)"/>
<line class="fl" x1="500" y1="100" x2="370" y2="132" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As3)"/>
<rect class="bx-sick" x="190" y="136" width="280" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="330" y="160" text-anchor="middle" font-size="12" fill="#b03a2e">recovery.cc：XID 在名单里吗？</text>
<line class="fl" x1="260" y1="176" x2="180" y2="200" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As3)"/>
<line class="fl" x1="400" y1="176" x2="480" y2="200" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As3)"/>
<rect class="bx-q" x="40" y="204" width="270" height="34" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="175" y="225" text-anchor="middle" font-size="11" fill="#6b675e">在 → commit_by_xid：补提交</text>
<rect class="bx" x="350" y="204" width="270" height="34" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="485" y="225" text-anchor="middle" font-size="11" fill="#6b675e">不在 → rollback_by_xid：回滚</text>
</svg>
</figure>

## kill -9：ack、行数、XID 三个数字

机制讲完，来真的。外部脚本经 TCP 连接逐笔 INSERT（autocommit），每收到一个 ack 就落一次盘计数；3 秒后 `kill -9` mysqld（容器里 PID 1，一击毙命，buffer pool、OS 里 MySQL 自己的缓存都救不了它）。重启后核对三个数字：

```text
客户端 ack 计数：    2,084
表里行数：           2,085   ← 多一行！
binlog Xid 事件数：  2,085   ← 与行数严丝合缝
```

**2085 个提交，客户端只确认了 2084 个。** 多出来的那笔是崩溃窗口里的事务：引擎 redo 已 prepare（落盘）、binlog 的 Xid 事件已落盘、**唯独 ack 还没发回客户端**。重启时裁决逻辑翻 binlog：XID 在名单里 → `commit_by_xid`。**表里多出一行客户端从不知道自己拥有的数据**。对应用程序这是一记警钟：**「没收到 OK」不等于「没发生」**。重试插行前先 SELECT（或 INSERT ... ON DUPLICATE KEY），别把「超时」直接当「失败」。双 1 下的结算规则就是这样：不丢已 ack 的、可能多出没 ack 的。

那笔事务的时间线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="第 2085 笔事务的时间线：redo prepare 落盘、binlog Xid 落盘之后，kill -9 落在 ack 发出之前；重启裁决查 binlog 名单命中，commit_by_xid 补提交，于是表行数与 XID 数都是 2085，比客户端 ack 的 2084 多一笔" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">kill -9 落在 ② 与 ④ 之间：崩溃窗口</text>
<line class="axis" x1="40" y1="80" x2="620" y2="80" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="120" y1="68" x2="120" y2="92" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="120" y="58" text-anchor="middle" font-size="10" fill="#6b675e">① redo prepare 落盘</text>
<line class="flk" x1="270" y1="68" x2="270" y2="92" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="270" y="58" text-anchor="middle" font-size="10" fill="#6b675e">② binlog Xid 落盘</text>
<line class="flc" x1="420" y1="62" x2="420" y2="98" stroke="#b03a2e" stroke-width="2.4"/>
<text class="tc" x="420" y="52" text-anchor="middle" font-size="11" fill="#b03a2e">kill -9</text>
<line class="fl" x1="550" y1="68" x2="550" y2="92" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="4 3"/>
<text class="tc" x="550" y="58" text-anchor="middle" font-size="10" fill="#b03a2e">④ ack：永远没发出</text>
<text class="ts" x="120" y="120" text-anchor="middle" font-size="10" fill="#6b675e">引擎有了 prepared 凭证</text>
<text class="ts" x="270" y="120" text-anchor="middle" font-size="10" fill="#6b675e">裁决书已写下</text>
<text class="ts" x="420" y="120" text-anchor="middle" font-size="10" fill="#6b675e">mysqld 一击毙命</text>
<text class="ts" x="20" y="152" font-size="12" fill="#6b675e">重启裁决：XID 2085 在 binlog 名单里 → commit_by_xid 补提交</text>
<text class="tc" x="20" y="176" font-size="12" fill="#b03a2e">ack 2084 · 行数 2085 · XID 2085：没收到 OK，不等于没发生</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">客户端侧的纪律：把超时当「结果未知」，先 SELECT 再决定重试</text>
</svg>
</figure>

同一实验里还有一个隐藏角色：**TC 日志**（事务协调者的备忘）。MySQL 在 binlog 开启时用 binlog 本身当 TC；关 binlog 且引擎不认账的极端场景才退回 `TC_LOG_MMAP`（内存映射文件）。8.4 把这套 XID 记录挪进了 binlog 的恢复流程（`Binlog_recovery`），旧版本散在 `tc_log.cc` 的逻辑收拢成了 `log_sanitizer` + `recovery.cc` 两个文件。这也是 8.4 源码里这一段突然变好读的原因。

## 双 0 崩溃：幽灵事务

把两个旋钮都拧到 0 再崩一次。插入程序狂奔到 ack 69036 时 kill -9，重启后核对：

```text
客户端 ack 计数：    69,036
表里行数：           69,037   ← 仍然多一行（redo 的 prepare 在双 0 下……等等）
binlog Xid 事件数：  71,122   ← 比行数多 2,085 个！
```

两个结果都值得细看：

**引擎只多了一行，不是两千行。** 双 0 下 redo 不是不写，只是不主动 fsync（每秒批量刷）。但事务的事件要写进 binlog 缓存之前，组提交的 leader 会先做一次 `ha_flush_logs(true)`。源码 `fetch_and_process_flush_stage_queue` 的注释明写：*"We flush prepared records of transactions to the log of storage engine in a group right before flushing them to binary log"*。**binlog 每次真落盘（这里每 500 事务一次）之前，都会把队列里全体的 redo prepare 先刷下去**。所以引擎侧的 prepared 凭证意外地齐，裁决照常、行数基本守恒（多的那一行同上一节：ack 没发出但裁决为提交）。

**binlog 超前了 2085 个事务。** `sync_binlog=0` 意味着 binlog 的 write/fsync 全交给了 OS 缓存。mysqld 死了，**内核还在**，缓存里的数据被内核照常写完（容器 kill 的是 mysqld，不是主机）。于是 binlog 文件里留下了 xid 69038..71183 共 2085 个 `Xid` 事件：**从库会重演它们，主库引擎却从来没提交它们**。重启后的主库没有这些行，从库（如果接上）会有。主从裂开一道 2085 行宽的缝，而且不报错、不告警，只等某天 SELECT 出不一致才现形。

这就是双 0 真正的代价：**不是「丢一秒数据」这么体面，是「复制流里长出主库没有的事务」**。双 1 丢的是什么都不丢（引擎裁决书完整）；双 0 丢的是 binlog 与引擎的一致性。参数表格里那行「崩溃时丢什么」，写「主从一致性」比写「1 秒事务」准确得多。

幽灵是怎么长出来的：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="双 0 崩溃的幽灵事务机制：mysqld 被 kill 时 binlog 的 write 还停在 OS 缓存里，内核照常把它写完，文件里多出 2085 个 Xid 事件；引擎侧因组提交 leader 在 binlog 落盘前批量刷过 redo prepare，行数基本守恒在 69037；从库重演 binlog 会多出主库没有的 2085 行" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my8As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">kill -9 杀死的是 mysqld，不是内核</text>
<rect class="bx-sick" x="20" y="40" width="180" height="52" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="110" y="60" text-anchor="middle" font-size="11" fill="#6b675e">mysqld 死</text>
<text class="ts" x="110" y="78" text-anchor="middle" font-size="10" fill="#6b675e">binlog 只在 OS 缓存里</text>
<line class="fl" x1="200" y1="66" x2="236" y2="66" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As5)"/>
<rect class="bx" x="240" y="40" width="180" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="60" text-anchor="middle" font-size="11" fill="#6b675e">内核照常写盘</text>
<text class="ts" x="330" y="78" text-anchor="middle" font-size="10" fill="#6b675e">缓存里的字节落了地</text>
<line class="fl" x1="420" y1="66" x2="456" y2="66" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As5)"/>
<rect class="bx-sick" x="460" y="40" width="180" height="52" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="550" y="60" text-anchor="middle" font-size="11" fill="#b03a2e">binlog 多出 2085 个 Xid</text>
<text class="ts" x="550" y="78" text-anchor="middle" font-size="10" fill="#6b675e">xid 69038..71183</text>
<rect class="bx-q" x="40" y="126" width="240" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="160" y="148" text-anchor="middle" font-size="12" fill="#2b2a26">重启后的主库</text>
<text class="ts" x="160" y="168" text-anchor="middle" font-size="11" fill="#6b675e">行数 69037：引擎从没提交过它们</text>
<line class="flc" x1="280" y1="154" x2="376" y2="154" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="5 4"/>
<text class="tc" x="328" y="144" text-anchor="middle" font-size="11" fill="#b03a2e">2085 行的缝</text>
<rect class="bx-sick" x="380" y="126" width="240" height="56" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="500" y="148" text-anchor="middle" font-size="12" fill="#2b2a26">接上的从库</text>
<text class="ts" x="500" y="168" text-anchor="middle" font-size="11" fill="#6b675e">忠实重演 binlog：多出行来</text>
<text class="ts" x="20" y="212" font-size="12" fill="#6b675e">引擎侧为何基本守恒：binlog 落盘前，组提交 leader 先批量刷全队的 redo prepare</text>
<text class="ts" x="20" y="232" font-size="12" fill="#6b675e">这道缝不报错、不告警，只等某天 SELECT 出不一致才现形</text>
</svg>
</figure>

## 组提交：fsync 的拼车

2ms 一笔、99% 在 fsync，高并发下这买卖怎么做？答案是人多好办事：**组提交（group commit）**。多个并发事务的 binlog 写入拼成一班，一次 fsync 全带走。8 路 docker-exec 并发、每路 250 笔、双 1：

```text
串行（1 路 × 500 笔）：   redo fsync 711 次 / 500 事务 = 1.42 次/事务
并发（8 路 × 250 笔）：   redo fsync 757 次 / 2000 事务 = 0.38 次/事务
```

**同样双 1，并发把 fsync 摊薄到 0.38 次/事务**：三笔事务拼一辆车，每笔均摊成本掉到 1/4。机制在 `ordered_commit` 的三阶段流水线：flush 阶段（收队列、刷引擎日志、写 binlog 缓存）→ sync 阶段（leader 独自 fsync，follower 等待）→ commit 阶段（挨个做引擎 commit）。第一个到的当 leader，后到的一批 follower。**等待 fsync 的时间本身就是攒批窗口**，fsync 越慢、批越大，天然负反馈。

拼车的机制与账单：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="组提交三阶段流水线：flush 阶段收队列刷引擎日志写 binlog 缓存，sync 阶段 leader 独自 fsync 而 follower 等待，commit 阶段挨个做引擎 commit；串行 500 事务花 711 次 redo fsync 每事务 1.42 次，8 路并发 2000 事务只花 757 次每事务 0.38 次" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my8As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">ordered_commit 的三阶段流水线</text>
<rect class="bx" x="20" y="40" width="190" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="115" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">flush</text>
<text class="ts" x="115" y="82" text-anchor="middle" font-size="10" fill="#6b675e">收队列 · 刷引擎日志</text>
<text class="ts" x="115" y="96" text-anchor="middle" font-size="10" fill="#6b675e">写 binlog 缓存</text>
<line class="fl" x1="210" y1="72" x2="228" y2="72" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As6)"/>
<rect class="bx-sick" x="232" y="40" width="190" height="64" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="327" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">sync</text>
<text class="ts" x="327" y="82" text-anchor="middle" font-size="10" fill="#6b675e">leader 独自 fsync</text>
<text class="ts" x="327" y="96" text-anchor="middle" font-size="10" fill="#6b675e">follower 等待 = 攒批窗口</text>
<line class="fl" x1="422" y1="72" x2="440" y2="72" stroke="#6b675e" stroke-width="1.5" marker-end="url(#my8As6)"/>
<rect class="bx" x="444" y="40" width="190" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="539" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">commit</text>
<text class="ts" x="539" y="82" text-anchor="middle" font-size="10" fill="#6b675e">挨个做引擎 commit</text>
<text class="ts" x="539" y="96" text-anchor="middle" font-size="10" fill="#6b675e">之后发 ack</text>
<text class="ts" x="20" y="140" font-size="11" fill="#6b675e">串行 1 路 × 500 笔：</text>
<rect class="bar" x="170" y="128" width="20" height="14" fill="#2b2a26"/>
<rect class="bar" x="196" y="128" width="20" height="14" fill="#2b2a26"/>
<rect class="bar" x="222" y="128" width="20" height="14" fill="#2b2a26"/>
<text class="ts" x="252" y="140" font-size="11" fill="#6b675e">…每事务一趟车：711 次 fsync，1.42 次/事务</text>
<text class="ts" x="20" y="176" font-size="11" fill="#6b675e">并发 8 路 × 250 笔：</text>
<rect class="bar" x="170" y="164" width="60" height="14" fill="#2b2a26"/>
<text class="onbar" x="200" y="175" text-anchor="middle" font-size="9" fill="#f6f3ec">拼车</text>
<text class="ts" x="240" y="176" font-size="11" fill="#6b675e">三笔事务一辆车：757 次 fsync / 2000 事务 = 0.38 次/事务</text>
<text class="ts" x="20" y="208" font-size="12" fill="#6b675e">binlog_group_commit_sync_delay 是手动挡：leader 故意多等一会儿攒更大的批，</text>
<text class="ts" x="20" y="226" font-size="12" fill="#6b675e">实测 fsync 更省但有连接因尾延迟超时掉队：用尾延迟换吞吐，OLTP 慎拧</text>
</svg>
</figure>

8.4 还给了个手动挡：`binlog_group_commit_sync_delay`（微秒）。leader 在 fsync 前故意多等这一下，攒更大的批。实测 delay=5000μs：

```text
默认（0）：     fsync/事务 0.378，binlog io 1242 次/2000 事务
delay=5000μs：  fsync/事务 0.318，binlog io  702 次/1838 事务（部分连接超时掉队）
```

fsync 更省了，但 8 路里有连接因为单笔延迟过高而超时掉队（完成 1838/2000）。**用尾延迟换吞吐的旋钮**，OLTP 单笔敏感的业务慎拧。顺带一提 redo 侧的同款：prepare 的 fsync 也能被 leader 一并批量刷（上节双 0 实验里 `ha_flush_logs` 的组刷就是它），两本日志都在拼车。

## 外部 XA：把裁决权还给应用

内部 XA 的裁决书是 binlog，因为两个参与者（binlog、InnoDB）同属一台服务器。真正的分布式事务（跨库、跨服务）里没有谁能单方面裁决，这时候用**外部 XA**：`XA START → ... → XA PREPARE → （协调者决策）→ XA COMMIT/XA ROLLBACK`，裁决权在应用程序手里。实测它跨崩溃的行为，和内部 XA 形成漂亮的对偶：

```text
XA START 'crash_xa_1'; INSERT t_xa VALUES (1,100); XA PREPARE 'crash_xa_1';
  → XA RECOVER 列出 crash_xa_1；表里查不到这行（还没提交）
  → binlog 里已经写下 XA_prepare 事件（复制流知道"有个事务在等裁决"）
kill -9 → 重启：
  → 日志：Starting XA crash recovery... finished.
  → XA RECOVER 仍然列出 crash_xa_1   ← prepared 事务跨重启活了下来
  → 表里仍然没有这行
XA COMMIT 'crash_xa_1'（人工，几天后也行）：
  → 行落地；binlog 追加 XA COMMIT 事件，从库同序重演
```

三个对照记住这张对偶表：**内部 XA 的 prepared 事务，重启后被 binlog 自动裁决（提交或回滚），无需人工；外部 XA 的 prepared 事务，重启后原样悬置，等协调者发令。** binlog 在两种 XA 里都扮演「让从库能重演」的载体，区别只在于谁来填最后的裁决：服务器自己（查 Xid 名单），还是应用（发 XA COMMIT）。代价也直白：外部 XA 的 prepared 状态会**占着 undo 和锁**直到裁决到来，悬置越久代价越大。分布式事务尽量短、prepare 后立刻决，是比「能不能用」更重要的纪律。

## 那一停的全部含义

一笔提交的 2ms，99% 花在两本日志的落盘上。redo prepare 先落盘、binlog 后落盘、引擎 commit 收尾，这个顺序是崩溃裁决的地基：binlog 是裁决书，引擎照单执行。关掉 binlog（skip-log-bin）实测提交从 2.06ms 掉到 0.84ms：**两阶段的复杂性本来就是为「复制+恢复」付的税**，单机不欠这笔钱。

双 1 的承诺精确到 ack。kill -9 三方核对：ack 2084、行数 2085、XID 2085，崩溃窗口里「prepare 了、binlog 有凭证、ack 未发出」的事务被裁决提交。**不丢已 ack 的，但可能多出没 ack 的**：重试逻辑别把超时当失败，先查再写。

双 0 输掉的是一致性：binlog 超前引擎 2085 个事务，从库会重演出主库没有的行，主从一致性在无告警中裂开。`sync_binlog=0` 的风险表述应该是「复制流与引擎脱钩」，而不是「丢一秒」。中间还有 (1000, 2) 这种「实例崩溃基本不丢、只防不住断电」的落点。

并发是 fsync 的解药：组提交把双 1 的 fsync 从 1.42 次/事务摊到 0.38 次/事务，fsync 等待本身就是攒批窗口。`binlog_group_commit_sync_delay` 能再榨一层，代价是单笔尾延迟。吞吐和延迟在这个旋钮上明码标价。

裁决权有三个归属：服务器查 binlog 名单（内部 XA，重启即决）、应用程序发令（外部 XA，prepared 跨重启悬置等人）、人工 TC 日志（无 binlog 的单机，8.4 已收进 binlog 恢复流程）。**同一台服务器里的「分布式事务」，分布式的是日志，不是机器。**

下一篇进入查询执行侧：同一个 JOIN，三条走法能差出 109 倍。嵌套循环、索引点查、hash join 与 join buffer 溢写，逐条实测。
