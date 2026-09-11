---
title: 一条 UPDATE 锁住了什么：记录、间隙与死锁
description: MySQL 系列第三篇。同一张五行表上，插 id=7 只要 2.4 毫秒、改 id=5 却等了 9.96 秒——因为锁住的未必是行，可能是「行之间的空隙」。本文用 performance_schema.data_locks 把每把锁拍在桌上逐把拆：等值命中退化成纯记录锁、打空落成纯间隙锁（X 锁竟能多方共存）、范围查询用 next-key 封隙、开上界锁到 supremum 伪记录——全表 UPDATE 的 5009 把锁 = 5000 行 + 9 个叶子页各自的「无穷」；RC 下一把间隙锁都不设，幻读敞开。再现场复现三种死锁（AB-BA、共享间隙双双 INSERT、双 S 升级），逐行读 LATEST DETECTED DEADLOCK——死锁日志的物理记录里能直接看到 DB_TRX_ID 的 hex；关掉检测器后只剩超时兜底。最后是 MDL 门链：一个挂着的事务加一个 ALTER，后续所有查询排队等死；KILL 掉 ALTER 的瞬间队伍毫秒级放行，比原事务提交早了整整 15 秒。
pubDate: 2026-09-12
category: mysql
tags: [MySQL, 数据库, 事务]
---

```text
03:08:36  B: INSERT INTO t_lock VALUES (7,700);   2.4 毫秒，落地。
03:08:37  B: UPDATE t_lock SET v=55 WHERE id=5;   9.96 秒，才放行。
```

同一时刻、同一张表、同一个对手 A（事务里 `SELECT ... FOR UPDATE` 之后挂着），B 的两条语句命运差了 4000 倍。上一篇（[《旧的那行去哪了》](/posts/mysql-innodb-mvcc/)）结尾留了一个现场：`data_locks` 里两把 `X,REC_NOT_GAP`，一把 GRANTED 一把 WAITING。这一篇把那把锁放到显微镜下：**一条 UPDATE 到底锁住了什么？** 答案远不止「行」——锁的对象可以是记录、可以是记录之间的空隙、可以是每个叶子页末尾那条「无穷」伪记录，甚至可以是一张还没动的表。

> 读完这一篇，你应该能回答四个问题：**为什么打空的 UPDATE 也能锁住插入？范围查询怎么把「不存在的位置」封死、幻读的封印落在哪里？死锁的现场长什么样、牺牲品怎么挑？为什么一个挂着的事务加上一个 ALTER，能让全表的查询跟着堵死？**

实验环境不变：docker 里的 MySQL 8.4.11。主角是一张五行表 `t_lock`（主键 id 为 1, 5, 10, 15, 20——主键之间的空隙就是舞台），量具四件：`performance_schema.data_locks`（行锁现场）、`metadata_locks`（MDL 现场，需先开 `wait/lock/metadata/sql/mdl` 探针）、`INNODB_TRX`（事务账本）、`SHOW ENGINE INNODB STATUS`（死锁验尸报告）。多会话时序用脚本交错控制，所有时间戳来自 `NOW(6)`。

## 锁的语法：LOCK_MODE 是几个单词的合成

先看 A 的第一条实验：事务里 `SELECT ... WHERE id=5 FOR UPDATE`，等值、命中、唯一索引。`data_locks` 抓到的全部家当：

```text
trx=99469  idx=NULL     IX              GRANTED  data=NULL
trx=99469  idx=PRIMARY  X,REC_NOT_GAP   GRANTED  data=5
```

两把锁，两种粒度。**IX 是表级意向锁**：行上有 X 之前先在表上插一面旗——判断「这张表里有没有行锁」不必翻叶子页，看旗就行（MVCC 篇抓锁现场时它已经在每帧里露脸）。**`X,REC_NOT_GAP` 是纯记录锁**：锁 id=5 这一行本身，不含任何空隙。而开头那组数字就此有了答案：B 插的 7 落在 (5,10) 之间，行锁管不着，2.4 毫秒过；B 改的 5 是行本体，等 A 提交，9.96 秒。

`LOCK_MODE` 的全部词汇就在这两个词根里拼装（本篇实验会集齐每一种）：

```text
谁要：     X（排他）/ S（共享）
锁哪里：   REC_NOT_GAP（只行）/ GAP（只隙）/ 缺省（next-key = 行 + 前隙）
干什么用： INSERT_INTENTION（插入意向，等待者专属）
表级：     IX / IS（意向）
```

`LOCK_DATA` 标锚点：记录锁锚在主键值上；间隙锁锚在**间隙的右边界记录**上；最上界锚在 `supremum pseudo-record`——首篇页骨架里那条「最大记录」，它还有戏份。

## 间隙：锁住不存在的东西

第二条实验换个问法：A 去锁一行**不存在**的 id=7。

```text
trx=99479  PRIMARY  X,GAP   GRANTED  data=10
```

打空了，锁却出现了——`X,GAP@10`，锁住间隙 (5,10)。为什么挂右边界？**因为 B+ 树定位 7 时落在 (5,10) 的空隙里**，InnoDB 就地把「这个空隙」登记在它右边的记录 10 名下（首篇的树定位，在这里第二次兑现）。B 的 UPDATE id=5 畅通无阻——纯间隙锁唯一挡的是**插入**，已有行的修改归记录锁管。

接下来是全篇最反直觉的一帧。C 也来锁同一个不存在的 id=7：

```text
trx=99479  PRIMARY  X,GAP   GRANTED  data=10
trx=99482  PRIMARY  X,GAP   GRANTED  data=10   ← 又一把 X，同隙，同时 GRANTED
```

**两把 X 锁，同一个间隙，同时持有。** 排他锁不是排他的吗？——间隙锁锁的不是「东西」，是**期望**：「别在这里长出新行」。两个事务可以抱着同一个期望相安无事，因为持有阶段谁也没动这个空隙。它的兼容矩阵与记录锁完全不同：GAP 对 GAP、GAP 对 REC_NOT_GAP 都兼容，唯一的冲突是**有人要 INSERT**。

D 来插入 id=7，等待者登场：

```text
trx=99479  PRIMARY  X,GAP                  GRANTED  data=10
trx=99482  PRIMARY  X,GAP                  GRANTED  data=10
trx=99483  PRIMARY  X,GAP,INSERT_INTENTION WAITING   data=10
```

**插入意向锁**是间隙锁的反向请求：持有者说「我要落在这个空隙里」，得等**所有**封隙者离开。时间线精确到毫秒（三个会话的 NOW(6)）：

```text
43.389  C 拿到间隙锁
45.391  D 发出 INSERT，开始等待
50.382  A 提交，释放自己的间隙 —— D 没动，C 还持着
59.384  C 提交，释放最后的间隙
59.387  D 的 INSERT 完成 —— 距 C 提交 2.8 毫秒
```

D 一共等了 14 秒，**分两段**：先等 A 放（5 秒），再等 C 放（9 秒）。「所有封隙者离开」是一个一个清点的。顺带补一刀：UPDATE 打空同样封隙——`UPDATE ... WHERE id=2`（表中无 2，`ROW_COUNT()=0`）留下 `X,GAP@5`，B 插 id=3 被挡 4 秒。**WHERE 打中了 0 行，但它「可能打中」的位置被锁上了。**

## 范围：next-key 与 9 个「无穷」

范围当前读是间隙锁的主场。A 锁开区间 (5,15)：

```text
trx=99499  PRIMARY  X       GRANTED  data=10   ← next-key：10 这行 + 它前面的隙
trx=99499  PRIMARY  X,GAP   GRANTED  data=10   ← 疑似重复？见下
trx=99499  PRIMARY  X,GAP   GRANTED  data=15   ← 锁住 (10,15)
```

三把锁封住 (5,10) ∪ {10} ∪ (10,15)：**next-key = 记录 + 前隙**，左开右闭区间 (5,10]。B 插 id=8，正好落在封地中央，被挡 6 秒。`@10` 那两把（`X` 与 `X,GAP`）覆盖的地带其实首尾相接，账本上分成两条记，是 InnoDB 把「命中行的锁」和「扫过的隙」分开登记的结果。

把上界开到无穷：A 锁 `id>20`：

```text
trx=99503  PRIMARY  X   GRANTED  data=supremum pseudo-record
```

**锁的登记对象是首篇的「最大记录」supremum**——每个叶子页末尾那条永远存在、永远比一切大的伪记录。锁住它，等于锁住「比 20 大的所有可能」。B 插 id=25，等待帧里插入意向锁的另一种形态现身：

```text
trx=99504  PRIMARY  X,INSERT_INTENTION   WAITING   data=supremum pseudo-record
```

（普通间隙的插入意向带 `GAP` 后缀，supremum 上省略——同一个请求的两种拼写。）B 被挡 6 秒后放行。

退化规则至此集齐三张牌，值得钉死：**等值命中唯一索引 → 纯记录锁（不锁隙，邻居随便插）；等值落空 → 纯间隙锁（不锁行，本体随便改）；越过终点 / 开上界 → 锁到 supremum（封住无穷）。** 范围扫描的默认是 next-key，端点按这三条退化。

## 幻读的封印，与 RC 的取舍

RR 下的幻读靠两半合围：**快照读那一半靠 ReadView**（上一篇的三判例，新插的行事务号太新，不可见）；**当前读这一半靠间隙锁**（FOR UPDATE / UPDATE / DELETE 封住空隙，新行插不进来）。两半各管各的读法，缺一不可。

而 READ-COMMITTED 把后一半拆了。同样的实验在 RC 下重跑：

| 动作 | RR 下的锁 | RC 下的锁 | B 插 id=7 |
| --- | --- | --- | --- |
| FOR UPDATE 不存在的 id=7 | X,GAP@10 | **一把都没有（只剩表级 IX）** | 被挡 / **1.9 毫秒落地** |
| FOR UPDATE 区间 (5,15) | 三把，封满区间 | 只有 X,REC_NOT_GAP@7、@10（命中的行） | 被挡 / 落地 |

RC 的当前读只锁**语句开始时已存在的行**——幻读在当前读这一侧完全敞开，换来的是写入方不受封隙之苦。**隔离级别的选择，落到锁账本上就是「X,GAP 这一列的有无」**：RR 与 RC 的区别，上一篇是快照建几次，这一篇是间隙锁设不设。

## 死锁：环、牺牲品、与超时兜底

### AB-BA：教科书死锁

两个事务、两行、反着拿。用文件门同步：双方各自拿下第一把锁（`X,REC_NOT_GAP@1` 与 `@5`，两把都 GRANTED、零等待），门开，同时要对方的：

```text
A：持有 id=1，请求 id=5 → 等 B
B：持有 id=5，请求 id=1 → 等 A      ← 环成立
```

B 的客户端当场收到 `ERROR 1213 (40001): Deadlock found`，A 若无其事通过（第二把 UPDATE 0.4 毫秒到手）。验尸报告 `LATEST DETECTED DEADLOCK`（节选，逐字来自 SHOW ENGINE INNODB STATUS）：

```text
*** (1) TRANSACTION 99569, ACTIVE 19 sec ... 2 row lock(s), undo log entries 1
UPDATE t_lock SET v=v+1 WHERE id=5
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 20 page no 4 n bits 80 index PRIMARY of `lab`.`t_lock`
Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format
 0: len 4; hex 80000001; asc     ;;      ← 主键 id=1
 1: len 6; hex 0000000184f1; asc       ;;  ← DB_TRX_ID = 99569，A 自己
 2: len 7; hex 0100000607026b; asc       ;;← DB_ROLL_PTR：段1·页1543·偏移619
 3: len 4; hex 80000002; asc     ;;      ← v=2（A 的 v+1 已生效）
*** (1) WAITING FOR THIS LOCK TO BE GRANTED: ... hex 80000005   ← id=5
*** (2) TRANSACTION 99570 ... WAITING FOR ... hex 80000001       ← id=1
*** WE ROLL BACK TRANSACTION (2)
```

三样东西值得停车看。**其一，物理记录只有四个字段**——id、DB_TRX_ID、DB_ROLL_PTR、v，两张用户列加两枚隐藏列：第一篇 `N_FIELDS=6` 的「隐藏列占座」，在死锁日志里原样兑现。**其二，hex 直接可解**：`0000000184f1` = 99569，正是 A 的事务号；那 7 字节 ROLL_PTR 按上一篇的解码表是「段 1、页 1543、偏移 619」——死锁日志顺手给版本链留了入口。**其三，牺牲品怎么挑**：官方规则是回滚代价小者死——按行锁数与 undo 条数计价；本例双方账面完全对称（2 行锁、1 条 undo），InnoDB 选了 (2)——后起步的 B。

### 共享间隙死锁：最阴的一种

A、C 同时 FOR UPDATE 不存在的 id=7（上一节已经看到：两把 X,GAP 共存，相安无事），然后**双双 INSERT 进这个间隙**：

```text
A：持间隙，INSERT 7 → 等所有封隙者（即等 C）
C：持间隙，INSERT 7 → 等所有封隙者（即等 A）      ← 环成立
```

持有阶段毫无冲突（连锁都「共享」了），环在两人同时 INSERT 的瞬间闭合——C 被回滚。这是生产环境最常见的隐形死锁：两个任务「礼貌地」检查了同一个不存在的行，然后同时想把祂造出来。

### S 锁升级死锁

A、B 双双 `FOR SHARE` id=1——两把 `S,REC_NOT_GAP` 同时 GRANTED（共享锁的本分），然后各自 UPDATE 这一行（S → X 升级）：

```text
A：持 S，请求 X → 等其它 S 释放（即等 B）
B：持 S，请求 X → 等其它 S 释放（即等 A）      ← 环成立
```

B 被回滚。**FOR SHARE 不是免费的保险**：读时人人可进，升级写锁时人人互堵。想避开「先读后写」的这笔记账，还有一条乐观的路——读与写之间不上锁，落笔时校验读到的版本还在不在，不在就整个重来（Redis 的 WATCH 走的就是这条路）。冲突很少发生时乐观赢，冲突频繁时重试的成本反超锁等待——乐观与悲观从来不是对错之争，是赌注的方向不同。

### 检测器与超时：两层兜底

以上环都是在**死锁检测器**（`innodb_deadlock_detect=ON`，默认）画出的等待图里抓到的——毫秒级发现、立即回滚一方。把它关掉重跑 AB-BA：

```text
SET GLOBAL innodb_deadlock_detect=OFF;
-- 环依然成立，但没人画图了。5 秒后（innodb_lock_wait_timeout=5）：
ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
```

等待者 A 超时出局，B 再过 7 秒提交成功——**环靠超时解开了，代价是 5 秒僵局**。生产里这个开关确实有理由关：极高并发热点下，逐把锁画等待图本身成为开销（官方给的场景：每秒上千次同行热点更新）。默认 50 秒的行锁超时对交互式应用太长，而兜底的兜底——`lock_wait_timeout`——默认 31536000 秒，**整整一年**：这个数字是留给下一篇前最后一节的主角 MDL 的，它默认永远等。

## 5009 把锁的账本

全表 UPDATE churn（5000 行）之后，两本账同时打开：

```text
data_locks：  IX 1 把 + X 5009 把；去重锚点 5001 个
INNODB_TRX：  trx_rows_locked = 5009
```

两本账分毫不差（第 5009 = 5000 + 9，但先看**多出来的 9 把锁钉在哪**）：

```text
SELECT LOCK_DATA, COUNT(*) ... GROUP BY LOCK_DATA HAVING COUNT(*)>1;
→ supremum pseudo-record：9 把
```

5000 行 / 9 叶 ≈ 每叶 556 行，**9 个叶子页，每页一把 supremum 锁**。全表范围 UPDATE 一路锁到每个叶子页的「无穷」，5000 行 + 9 个页尾伪记录 = 5009。首篇 156 行/页的树、MVCC 篇 undo_001 里 13312 页的段账本，加上这一帧，第三次「两个独立来源对上账」。顺带一提：`trx_rows_locked` 把 supremum 也计入行数——排查「锁了 5009 行」的日志时，别忘了有 9 行是「不存在的那一行」。

## MDL：一把不在 InnoDB 里的锁

最后一种锁不住行、不住叶子页，甚至不在存储引擎里——**MDL（元数据锁）住在 server 层**，管的是「表结构这一刻能不能变」。三会话实验：

- A：开事务读一行 t_mdl，挂 22 秒不提交——持 `SHARED_READ`；
- B（3 秒后）：`ALTER TABLE t_mdl ADD COLUMN pad INT`；
- C（6 秒后）：一条最普通的 `SELECT`。

B 和 C 双双挂起，processlist 里同一句 `Waiting for table metadata lock`；`metadata_locks` 拍下的现场：

```text
t_mdl  SHARED_READ       GRANTED   ← A：事务期间的读锁
t_mdl  SHARED_UPGRADABLE GRANTED   ← B：ALTER 第一阶段，可升级持有
t_mdl  EXCLUSIVE         PENDING   ← B：第二阶段，等 A
t_mdl  SHARED_READ       PENDING   ← C：排在 B 的 EXCLUSIVE 之后
```

**门链的关键在最后一行**：C 只想要读锁，A 的读锁与它完全兼容——但 C 排在 B 后面。MDL 的队列讲先来后到：EXCLUSIVE 在等，后面所有 SHARED 就得陪等，不然 ALTER 永远被插队饿死。于是**一个挂着的事务 + 一个 ALTER = 全表后续读写集体堵死**，这是生产事故的标准剧本。

解法实测：`KILL` 掉 B 的 ALTER 连接，**C 的 SELECT 毫秒级完成——比 A 提交早了整整 15 秒**（C 完成于 03:23:57，A 提交于 03:24:12）。门链的钥匙从来不是 A 的锁，是 B 的排队。而 ALTER 被杀后表结构原封未动（无 pad 列）——`SHARED_UPGRADABLE` 阶段还没动表。也是在这里，那个「一年」的 `lock_wait_timeout` 有了着落：**DML 默认 50 秒认输，DDL 默认等一年**——ALTER 堵住全表的场景里，一年是给你足够时间发现并处理它的。

## 合上账本以前

**锁的对象有三种：行、位置、无穷。** 记录锁钉住存在的东西（X,REC_NOT_GAP），间隙锁钉住不存在但可能存在的东西（X,GAP，锚在右边界），next-key 把两者钉成左开右闭的区间；开上界锁到 supremum——每个叶子页的「最大记录」都是一条可以上锁的伪记录。退化三张牌：等值命中纯记录、等值落空纯间隙、越过终点锁到无穷。

**幻读的封印是两半的。** RR 里快照读靠 ReadView（看不见新行），当前读靠间隙锁（插不进新行）；RC 拆掉后一半——间隙锁缺席，1.9 毫秒的 INSERT 畅通无阻。隔离级别的选择，在锁账本上就是 X,GAP 那一列的有无。

**死锁是等待图里的环，三种最短的成环路径都实测复现了。** AB-BA 互换两行；共享间隙 + 双双 INSERT（持有阶段毫无冲突迹象的隐形环）；双 S 升级 X（FOR SHARE 不是免费保险）。牺牲品按回滚代价挑，验尸报告逐把锁、逐条物理记录可读——日志里的 hex 连 DB_TRX_ID 和 ROLL_PTR 都看得见。检测器毫秒级拆环，关掉它就只剩超时兜底，默认 50 秒。

**账本第三次对上。** 5009 把 X 锁 = 5000 行 + 9 个叶子页的 supremum，`data_locks` 与 `trx_rows_locked` 分毫不差。锁不是「大概加上了」，是逐把登记、逐把可数的。

**最危险的锁不在引擎里。** MDL 住 server 层：一个挂着的事务加一个 ALTER，靠队列的先来后到把全表查询拖进等待——KILL 掉 ALTER 的瞬间队伍毫秒级放行，比原事务提交早 15 秒。行锁超时 50 秒，DDL 的 MDL 等待默认一年。

---

```text
03:08:36  插 id=7：2.4 毫秒；改 id=5：9.96 秒。锁的不是行，是位置。
03:17:51  两把 X,REC_NOT_GAP 就位，门开，环闭——B 出局，日志里 hex 可读。
03:23:57  KILL 掉排队 4 秒的 ALTER，等待中的 SELECT 毫秒级放行——A 还要 15 秒才提交。
```

系列从这里继续。锁全住在内存里——断电重启的瞬间，所有 GRANTED 与 WAITING 凭空消失，可未提交的改动还躺在页面上、旧版本还躺在 undo 里：谁来收拾残局？第四篇拆 redo 日志与崩溃恢复——第一篇页尾的 LSN、第二篇 undo 的逆向抄回，在那里合龙。
