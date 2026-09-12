---
title: 回复你 OK 的那一刻，还不算写进历史：Redis 的 AOF
description: SET 的回复已经送达，那行命令却仍在页缓存里等下一秒的 fsync。本文从一个 appendonlydir 目录解剖开去，拆开三档 appendfsync 的真实语义、协议翻译、WAITAOF 量出的持久化间隙、kill -9 与掉电的边界，以及多段 AOF 的重写轮转。全部数字来自官方 7.4.11 的容器实测。
pubDate: 2026-09-10
category: redis
tags: [Redis, 数据库]
---

13:49:31.200，客户端收到 `SET probe:1` 的 `OK`；这一刻，这行命令还在内存缓冲区里。直到 13:49:32.050，后台线程才把它 fsync 进 `appendonly.aof.1.incr.aof`。中间隔着 0.85 秒。掉电发生在 13:49:31 的话，这个键从未存在过。

客户端视角里，`OK` 就是承诺。可 `OK` 承诺的只是「Redis 进程记住了这件事」，不是「磁盘记住了这件事」。从回复到落盘之间的那段路，长短由 `appendfsync` 决定，走在哪条路上由操作系统和电源决定。

这是持久化话题的后半程。fork 篇讲的是 RDB 快照：子进程在后台生成某一刻的完整数据副本。AOF 是另一种思路：记流水。每一条写命令按执行顺序追加进文件，重启时把流水重放一遍，数据就回来了。快照问「哪个时刻的状态」，流水问「每一步是否留痕」。

本文的实验在官方 Redis 7.4.11 容器中完成，AOF 目录挂载在本机卷上；源码名称与多段 AOF 行为均以 7.4.11 为准。文中所有时间数字只描述本次机器，不应写进生产容量承诺。

## 先看目录：Redis 7 的 AOF 早就不是单个文件了

网上很多文章还在讲「appendonly.aof 这个文件」。在 Redis 7 上打开 AOF，`ls` 看到的是一个目录：

```text
/data/appendonlydir/
  appendonly.aof.1.base.rdb      89 字节
  appendonly.aof.1.incr.aof      58 字节
  appendonly.aof.manifest        88 字节
```

三个文件三种角色：

- **base**：上一次重写时刻的完整快照。默认 `aof-use-rdb-preamble yes`，base 直接就是 RDB 格式，所以扩展名是 `.rdb`；
- **incr**：重写之后的每一条写命令，RESP 协议原文追加。重写期间或重写失败后可能出现多个 incr 文件；
- **manifest**：清单。此刻内容是两行：

```text
file appendonly.aof.1.base.rdb seq 1 type b
file appendonly.aof.1.incr.aof seq 1 type i
```

`type b` 是 base，`type i` 是 incr，`seq` 是轮转序号。重启加载时，Redis 读 manifest，先重放 base，再按序号重放每个 incr，数据 = 快照 + 此后的流水。

为什么要把单文件拆成目录？旧架构里 AOF 重写是「生成新文件、替换旧文件」的一次性大动作，任何一步出错都容易留下说不清的状态。拆开以后，重写只是「新写一个 base、开一个新的 incr、更新 manifest 指针」，旧文件先标记为 history 再择机清理，每一步都是可恢复的小事务。后文重写实验会看到这套轮转的完整过程。

## 打开 incr：写进去的是协议，不是 SQL，也不是快照

往实例里写几条命令，然后直接 `cat` 那个 incr 文件：

```text
*3\r\n$3\r\nSET\r\n$5\r\nhello\r\n$5\r\nworld\r\n
*5\r\n$3\r\nSET\r\n$10\r\nsession:42\r\n$6\r\nkaiven\r\n$4\r\nPXAT\r\n$13\r\n1788971270269\r\n
*2\r\n$3\r\nDEL\r\n$5\r\nhello\r\n
```

这就是 RESP 协议原文：`*3` 是三个参数，`$5` 是五字节字符串。**AOF 记录的是命令，不是数据**：重启后重放一遍，效果等价于从头再执行这些命令。

细看会发现两处「不是原样照抄」：

第一处，我写入的命令是 `SET session:42 kaiven PX 9500000`，文件里却是 `PXAT 1788971270269`。相对时长被翻译成了绝对毫秒时间戳。原因想过就会明白：重放可能发生在很久以后，若照抄 `PX 9500000`，每次重启都给这个键重新续命 9500 秒。过期篇讲过的绝对时间戳语义，在这里被 AOF 忠实延续。`EXPIRE tmp 120` 同样被翻译成 `PEXPIREAT tmp <毫秒时间戳>`。

第二处，换库操作会插入 `SELECT`。往 db 1 写一个键，文件里先多一行 `*2\r\n$6\r\nSELECT\r\n$1\r\n1\r\n`，再跟那个 SET，否则重放到这里，命令会落错库。翻译发生在命令的传播路径上，所以 AOF 与复制副本收到的是同一套译文，两边不会说两种话。

## 三档 appendfsync：三种落盘时机

写命令进 AOF 分两步：`write()` 把字节交给内核页缓存，`fsync()` 要求内核把页缓存真正刷到磁盘。第一步很快，第二步要等盘，差距是数量级的。`appendfsync` 决定第二步什么时候做：

```text
always    每条命令回复前，同步 fsync
everysec  后台线程每秒 fsync 一次（默认）
no        从不主动 fsync，交给操作系统（约 30 秒）
```

三档在源码里的分岔点就是 `flushAppendOnlyFile()`：always 档在 `beforeSleep` 里先 fsync、再把回复写回 socket，所以「回复到达」与「已落盘」同时成立；everysec 档把 fsync 交给 bio 后台线程，主线程只负责 write；no 档连 fsync 都不做。

延迟直觉上 always 应该明显慢。实测未必如直觉。本机 NVMe 上单连接、64 字节值的 SET：

```text
appendfsync      平均       P99
everysec        0.015ms    0.039ms
always          0.015ms    0.063ms
no              0.023ms    0.047ms
```

always 与 everysec 几乎同速。实验没出错，这就是本机的真相：**快盘上一次 fdatasync 只要几十微秒**，摊在每次命令里感知不到。always 的代价只有在慢盘（机械盘、繁忙的网络盘）上才显露为数量级的差距。

但「平均延迟同速」不等于「语义相同」。三档买的是三种不同的承诺，速度只是表象，真正分开的是**回复之后、掉电之前**那条缝的宽度。

## WAITAOF：把那条缝量出来

Redis 7.2 起有个 `WAITAOF numlocal numreplicas timeout` 命令，语义是「阻塞直到 AOF 至少 fsync 到当前偏移」。拿它当秒表，能精确量出「回复到达」与「落盘完成」的间隙。

实验设计：单连接里先 `SET` 后 `WAITAOF`，连发五对。每对里 SET 的回复都立刻到达，WAITAOF 负责等它真正落盘：

```text
everysec 档：五对共耗时 4.26 秒   （平均每对约 0.85 秒）
always  档：五对共耗时 0.05 秒   （每对几乎为零）
```

每对约 0.85 秒，正是 everysec 的节拍：SET 的 OK 立刻返回，那一刻命令只活在页缓存里；WAITAOF 要等下一次秒级 fsync 轮到自己，平均等半拍多一点。而 always 档下 SET 返回时数据已经 fsync 完毕，WAITAOF 无所等待，立刻返回。

这两组数字就是三档语义的定量版：

```text
always    回复 ≈ 已落盘            缝宽 ≈ 0
everysec  回复 → 最多 1 秒后落盘   缝宽中位数 ≈ 0.5 秒，上界 1 秒
no        回复 → 内核高兴时落盘    缝宽上界 ≈ 30 秒
```

于是那个经典问题「everysec 会不会丢数据」有了精确的回答：**会，最多丢最近一秒**。且这里的「丢」专指掉电级别的事故；下一节会看到，进程崩溃根本丢不了。

## kill -9 存活测试：进程死了，页缓存还活着

everysec 档下写入一个键，50 毫秒后（远小于一秒，fsync 肯定没做）直接 `kill -9`：

```text
SET survive:kill9 yes    → OK
（50ms 后 SIGKILL，容器重启）
GET survive:kill9        → "yes"
```

键活下来了。为什么 everysec 的「最多丢一秒」没有应验？

因为 `write()` 早就完成了，数据已在**内核页缓存**里；`kill -9` 只撕掉进程，页缓存属于内核，安然无恙。容器重启、Redis 重新打开文件，那行命令还在：**进程级死亡不丢 everysec 的数据，掉电才丢。**

「最多丢一秒」的准确适用范围是：机器断电、内核崩溃、存储介质故障。这三类事故里页缓存也没了，最多一秒的已确认写入随之蒸发。给 everysec 做容灾评估时，要按这个口径算 RPO，不要按「Redis 进程可能崩溃」算，后者它根本不丢。

重启后的过期语义也顺带验证了：`session:42` 重放后 `TTL` 返回 9,311 秒，与写入时的 9,500 秒减去流逝的约 3 分钟吻合。`PXAT` 的绝对时间戳在重放时不重置寿命，与写入时的语义严格一致。

## 重写：把流水变回快照

流水账的弱点显而易见：同一个键写一万次，文件里就有一万行，重启要重放一万次，但最终状态只是一行。AOF 重写解决这个问题：**用当前数据集生成一份新的 base，把此后的流水另起新册。**

重写不解析旧文件（那是「重放」）；它直接遍历内存里的键空间、生成新快照。实验先制造一段膨胀的流水：benchmark 流量加几次 SET/DEL 循环，incr 涨到 26MB。然后 `BGREWRITEAOF`：

```text
重写前：
  appendonly.aof.1.base.rdb     65 KB
  appendonly.aof.1.incr.aof     26 MB
  appendonly.aof.manifest       指向 seq 1

重写后：
  appendonly.aof.2.base.rdb     65 KB    ← 新快照
  appendonly.aof.2.incr.aof      0 字节  ← 新流水，从零开始
  appendonly.aof.manifest       指向 seq 2，旧文件已清理
```

26MB 的历史被压回 65KB。中途 SET 三次又 DEL 的 `heavy` 键在新 base 里不存在，因为重写只保留**最终状态**，中间过程全部蒸发。这正是重写的双重意义：文件变小，重启重放变快。

整个过程和 fork 篇的 `BGSAVE` 共享同一套 fork 路径：父进程 fork 出子进程，子进程按 fork 时刻的数据集写新 base；fork 之后父进程的新命令不停，写进切换后的新 incr。fork 篇讲过的写时复制指标（`aof_last_cow_size`）在这里同样适用，`no-appendfsync-on-rewrite` 默认还会在子进程存活期间暂停 everysec 的 fsync，避免两个重 I/O 任务互相踩踏。

Redis 7 拆目录的收益也在这个流程里显形：fork 前，父进程先把 manifest 切到新 incr；子进程写完 temp 文件再改名安装、更新 manifest、把旧文件标记为 history 后台清理。中途任何一步失败，manifest 指向的还是完整可用的旧组合：**不存在「重写了一半的 AOF 文件」这种东西**，只有完整的旧组合和完整的新组合。

## 自动重写：两个阈值

手动 `BGREWRITEAOF` 只是兜底手段，日常靠两个阈值自动触发：

```text
auto-aof-rewrite-percentage  100   （默认）
auto-aof-rewrite-min-size    64MB  （默认）
```

语义是：当前 AOF 总大小 ≥ 64MB，**且**比上次重写后的 base 大小增长 ≥ 100%，就在 serverCron 里触发后台重写。

实验把阈值降到 32KB / 100% 验证。当前 base 65,851 字节，写入 1000 个约 120 字节的键后，总大小到了 89,745 字节，超过 65,851 的两倍，重写触发：

```text
写入前    aof_current_size: 65,851     aof_rewrite_base_size: 65,851
写入后    aof_current_size: 89,745     目录里出现了 seq 3 的新 base
```

注意触发的时机细节：比较用的是**当前总大小**（base + incr）对 **base 大小**的增长率。也就是说 incr 自己膨胀 100% 并不够，还要总大小先过 min-size 这道门槛。低流量实例可能长期停在「incr 缓慢增长但从不触发重写」的状态，靠 min-size 避免了为几 KB 的文件反复 fork。

失败也有保护：连续失败 3 次（`AOF_REWRITE_LIMITE_THRESHOLD`）后进入指数退避，避免磁盘故障时重写循环打满 CPU。

## everysec 的慢盘自我保护

everysec 还有一段值得单独讲的防御逻辑。fsync 在后台线程做，如果盘慢到上一次 fsync 还没完成，主线程会怎么办？

源码的选择是**最多等两秒**。新的写命令到来时若发现上一次 fsync 仍在进行，先把本次 flush 推迟（记住开始时间）；下一轮再看，若仍未完成且已等满两秒，就带着数据硬写（write 不需要等 fsync），同时 `aof_delayed_fsync` 计数加一，日志里留下 "Asynchronous AOF fsync is taking too long"。

这是 everysec 档最容易被误解的地方：它的设计目标不是「每秒最多丢一秒」这个承诺本身，而是**不让 fsync 阻塞主线程**。慢盘上宁可容忍短暂超出理论窗口，也不让写命令排队等磁盘。`INFO persistence` 里的 `aof_delayed_fsync` 就是这个时刻的计数器。生产实例上它持续增长，说明盘的 fsync 能力已经跟不上写入速率，那是容量问题，不是配置能解决的。

实验里这个计数始终为 0（NVMe 上 fsync 太快，轮不到防御出场），这份「没观察到」本身也说明本机盘够快。

## RDB 还是 AOF：不是二选一

写到这里可以把两篇的机制放在一起比：

```text
          RDB 快照                AOF 流水
文件       二进制紧凑格式          base(RDB) + 协议流水
恢复       快（直接加载）          慢（重放命令）
丢失窗口   两次 save 之间          always≈0 / everysec≤1s / no≤30s
主线程开销  fork 停顿 + COW        write 微秒级 + fsync 分档
体积       稳定（状态压缩）        增长（重写压制）
```

两个机制不互斥，官方推荐的常见组合是 RDB 做底（重启快、灾备可搬运）+ AOF everysec 做近线（丢失窗口一秒）。7.x 的多段 AOF 里 base 本来就是 RDB 格式，重写就是「AOF 定期把自己重新快照化」：流水方案内部已经内嵌了快照，两条路线在实现上早已合流，区别只剩「你想要多窄的丢失窗口」。

## 核对入口，以及它不管的事

日常核对 AOF 状态的入口：

```text
INFO persistence
  aof_enabled / aof_rewrite_in_progress
  aof_current_size / aof_rewrite_base_size     （自动重写的阈值读数）
  aof_last_bgrewrite_status:ok
  aof_delayed_fsync                            （慢盘防御的计数器）
  aof_last_write_status                        （写错误状态）

WAITAOF 1 0 1000                               （现场量一次落盘延迟）
ls appendonlydir/                              （seq 轮转就是重写的历史）
```

边界也要如实交代。AOF 保护的是**已确认写入的丢失窗口**，不保护这些：`aof-use-rdb-preamble` 关掉时重放更慢；`appendfsync no` 在默认 30 秒的内核刷写下 RPO 可达半分钟；MULTI/EXEC 事务写进 AOF 的仍是逐条命令，重放时不具备原子性；掉电窗口内的数据 loss 概率与盘的 fsync 速度、写入速率成正比，本机 NVMe 的数字换到网络盘上完全是另一组结果。这些都在 AOF 的承诺范围之外，谈不上缺陷。

## 三档的丢失窗口

AOF 记的是命令流水，不是数据快照：重启靠重放恢复，相对过期被翻译成绝对时间戳，跨库插入 SELECT，译文与复制副本共享同一套传播路径。三档 appendfsync 是三种落盘时机：always 回复即落盘；everysec 后台线程每秒刷一次；no 全交内核。快盘上三档吞吐几乎无差，差别全在掉电时的丢失窗口。进程崩溃与掉电是两种事故：everysec 下 `kill -9` 一条不丢，write 早已进页缓存；「最多丢一秒」只在断电、内核崩溃、介质故障时成立。WAITAOF 实测 everysec 的落盘平均滞后回复约 0.85 秒，always 约为零。重写是流水的自我快照化：遍历内存生成新 base，流水另起新册，26MB 历史压回 65KB，中间状态全部蒸发；自动重写由 100% 增长率与 64MB 门槛共同触发，连续失败有指数退避。Redis 7 的多段 AOF 让重写变成小事务：base、incr、manifest 各司其职，轮转序号记录历史，任何一步失败旧组合仍然完整，「重写了一半的文件」这种状态不存在了。

`OK` 是进程的承诺，`fsync` 是磁盘的承诺。AOF 的全部设计，就是在两者之间架一条足够快的通路，并诚实地告诉你：这条通路上永远有一段正在飞行的数据，`appendfsync` 的每一档，只是把这段飞行时间的上限写成不同的数字。

选择哪一档，本质是回答一个问题：**你的业务，能为「最多丢一秒」或「一条不丢」分别付出多少延迟和磁盘寿命？**

---

本文是 Redis 系列的第九篇。fork 与写时复制的机制见《快照在后台，停顿发生在前台》，本文的重写子进程与 `aof_last_cow_size` 沿用同一套路径；过期语义的绝对时间戳见《过期的键，不会准时消失》。
