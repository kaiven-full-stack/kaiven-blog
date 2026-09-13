---
title: 一份账本变多份：主从复制、GTID 与半同步
description: MySQL 系列第六篇。主库 INSERT 一行，20 毫秒后从库看得见；2 万行批量 88 毫秒。异步复制的窗口就这么宽，窗口里主库断电，从库就少这笔数据。本文搭一对 8.4.11 主从容器把复制拆到字节：ROW 格式 binlog 的五段式事件流（Gtid→BEGIN→Table_map→Update_rows→COMMIT），Update_rows 的 payload 里前像后像逐字节可读；GTID 断点续传实测（停复制→主库写 3 笔→重启后 1-21 自动补齐）；然后亲手制造分道扬镳：read_only 拦不住 root 的 SUPER 权限，从库写入野行，复制线程死于 1062 主键冲突，删除野行后复制自愈；半同步的代价同样量化：ACK 往返只花 22 毫秒，从库失联后提交等满 3 秒超时、状态从 ON 降级 OFF；最后是延迟从库：SQL_Delay=60 秒把新事务按住，误删操作有整整一分钟可以反悔。
pubDate: 2026-09-14
category: mysql
tags: [MySQL, 数据库, 复制]
---

主库 `INSERT` 一行，20 毫秒后从库才看得见；这 20 毫秒里主库断电而 binlog 没被拉走，从库就永远少了这一行。前五篇讲的是一台机器上的 InnoDB：页与树、undo 与版本、锁、redo、优化器。这一篇讲**同一份数据如何变成多份**。动机朴素：一台机器会坏（第四篇的 docker kill 就是彩排），一份数据会丢，读请求会挤爆。复制的本质是**把主库的 binlog 事件流，搬到另一台机器上按序重演**。听起来简单，深挖下去全是坑：多久的窗口算「已复制」？从库断了怎么知道从哪续？两台机器各写一笔怎么办？半同步到底同步了什么？

实验环境换新装：一对 docker 容器 `mysql84-master`（server-id=11，ROW 格式 binlog，GTID 开）与 `mysql84-replica`（server-id=12，read_only），挂在专属网络 `mysql-repl-net` 上互称主机名，都是 MySQL 8.4.11。量具：`SHOW REPLICA STATUS`（改名自 SHOW SLAVE STATUS，8.4 的「replica/source」新词汇全篇沿用）、`SHOW BINLOG EVENTS`、`performance_schema.replication_applier_status_by_worker`，以及毫秒级 shell 轮询。

## 复制的数据流：一条 UPDATE 的旅程

先看管道里流的到底是什么。主库 `UPDATE repl_demo SET v=v+1 WHERE id=500001`，`SHOW BINLOG EVENTS` 拍下这段流：

```text
binlog.000003  2410740  Gtid        SET @@SESSION.GTID_NEXT= 'fef4d928-…:18'
binlog.000003  2410819  Query       BEGIN
binlog.000003  2410902  Table_map   table_id: 85 (lab.repl_demo)
binlog.000003  2410959  Update_rows table_id: 85 flags: STMT_END_F
binlog.000003  2411029  Xid         COMMIT /* xid=77 */
```

五段式，每段一个事件。**Gtid** 事件给这笔事务发身份证（`uuid:序号`）；**Query/BEGIN** 开事务（注意 binlog 里没有这条 UPDATE 的 SQL：ROW 格式记的是行，不是语句）；**Table_map** 声明「接下来操作的表是 lab.repl_demo，table_id 85」；**Update_rows** 装着货；**Xid/COMMIT** 收尾。

Update_rows 的 payload 逐字节拆开（本篇把 binlog 文件拷出来手工解的，70 字节整个事件）：

```text
55 00 00 00 00 00 01 00 02 00 03 ff ff    ← 表 id、列数 3、前像列数 3（全列记录）
—— 前像（改之前）——
00 21 a1 07      ← id 列：长度 0x00，值大端 0x0007A121 = 500001
00 01 00 00 00   ← v 列：长度 0x00，值 = 1
99 ba d6 3d 55 04 63 40  ← ts 列：8 字节编码的 DATETIME(6) 微秒时间戳
—— 后像（改之后）——
00 21 a1 07      ← id：500001（定位用）
00 02 00 00 00   ← v：2
99 ba d6 3d 55 04 63 40  ← ts
```

**ROW 格式的 binlog 记的是「前像 + 后像」，不是 SQL。** 这带来三个深刻后果。其一，**复制是幂等重演**：从库拿到的是「把这行从 v=1 改成 v=2」，不依赖 SQL 语义，不会因从库的触发器、函数版本差异走样。其二，**binlog 与 undo 记的是同一份账的两个方向**：undo 记「旧值」（第二篇拆过它的字节），binlog ROW 记「旧值 + 新值」。所以 binlog 也能当闪回工具的原料：`mysqlbinlog` 解码出的前像，就是拼 UPDATE 回滚语句的材料。其三，代价是体积：一条 UPDATE 一个事件带两份行，宽表上 binlog 比 redo 更肥（redo 只记 diff，第四篇的 75 字节/行对照这里的 70 字节/事件，事件头占了大头，行本身越宽差距越明显）。

五段式与那 70 字节：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="ROW 格式一笔 UPDATE 的五段式事件流：Gtid 发身份证、Query BEGIN 开事务、Table_map 声明表、Update_rows 装货、Xid COMMIT 收尾；Update_rows 展开是前像 id=500001 v=1 与后像 v=2，binlog 里没有 SQL 文本" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my6As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一笔 UPDATE 在 binlog 里的五段式</text>
<rect class="bx" x="12" y="40" width="112" height="44" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="68" y="58" text-anchor="middle" font-size="11" fill="#2b2a26">Gtid</text>
<text class="ts" x="68" y="76" text-anchor="middle" font-size="9" fill="#6b675e">身份证 uuid:18</text>
<line class="fl" x1="124" y1="62" x2="136" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my6As1)"/>
<rect class="bx" x="138" y="40" width="112" height="44" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="194" y="58" text-anchor="middle" font-size="11" fill="#2b2a26">Query</text>
<text class="ts" x="194" y="76" text-anchor="middle" font-size="9" fill="#6b675e">BEGIN 开事务</text>
<line class="fl" x1="250" y1="62" x2="262" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my6As1)"/>
<rect class="bx" x="264" y="40" width="112" height="44" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="320" y="58" text-anchor="middle" font-size="11" fill="#2b2a26">Table_map</text>
<text class="ts" x="320" y="76" text-anchor="middle" font-size="9" fill="#6b675e">table_id 85 是哪张表</text>
<line class="fl" x1="376" y1="62" x2="388" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my6As1)"/>
<rect class="bx-sick" x="390" y="40" width="112" height="44" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="446" y="58" text-anchor="middle" font-size="11" fill="#2b2a26">Update_rows</text>
<text class="ts" x="446" y="76" text-anchor="middle" font-size="9" fill="#6b675e">货在这里 · 70 字节</text>
<line class="fl" x1="502" y1="62" x2="514" y2="62" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my6As1)"/>
<rect class="bx" x="516" y="40" width="112" height="44" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="572" y="58" text-anchor="middle" font-size="11" fill="#2b2a26">Xid</text>
<text class="ts" x="572" y="76" text-anchor="middle" font-size="9" fill="#6b675e">COMMIT 收尾</text>
<line class="fl" x1="446" y1="84" x2="446" y2="106" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#my6As1)"/>
<rect class="bx-q" x="60" y="110" width="540" height="80" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="195" y="130" text-anchor="middle" font-size="11" fill="#6b675e">前像（改之前）</text>
<text class="ts" x="195" y="150" text-anchor="middle" font-size="11" fill="#6b675e">id=500001 · v=1</text>
<text class="ts" x="195" y="168" text-anchor="middle" font-size="10" fill="#6b675e">ts：DATETIME(6) 8 字节</text>
<line class="fl" x1="290" y1="150" x2="366" y2="150" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#my6As1)"/>
<text class="tc" x="328" y="140" text-anchor="middle" font-size="11" fill="#b03a2e">v: 1 → 2</text>
<text class="ts" x="465" y="130" text-anchor="middle" font-size="11" fill="#6b675e">后像（改之后）</text>
<text class="ts" x="465" y="150" text-anchor="middle" font-size="11" fill="#6b675e">id=500001 · v=2</text>
<text class="ts" x="465" y="168" text-anchor="middle" font-size="10" fill="#6b675e">id 定位，v 是新值</text>
<text class="ts" x="20" y="216" font-size="12" fill="#6b675e">事件流里没有那条 UPDATE 的 SQL 文本：从库重演的是行级 diff，与语句语义无关</text>
<text class="ts" x="20" y="236" font-size="12" fill="#6b675e">前像就是闪回工具的原料：拼一条反向 UPDATE 所需的一切都在这里</text>
</svg>
</figure>

复制管道因此是三段接力：**主库 dump 线程**推 binlog 事件流 → **从库 IO 线程**收下写进中继日志（relay log）→ **从库 SQL 线程**（8.4 默认 4 个 worker 并行）从中继日志按序重演。binlog 是主库的账，relay log 是从库收件的副本，两份各自独立落盘，断点各记各的。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 176" role="img" aria-label="复制三段接力：主库 dump 线程推 binlog 事件流；从库 IO 线程收下写进 relay log，中继日志独立落盘；从库 SQL 线程带 4 个 worker 从中继日志按序重演" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my6As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三段接力：两份日志，各自落盘、各记断点</text>
<rect class="bx-q" x="20" y="44" width="180" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">主库</text>
<text class="ts" x="110" y="86" text-anchor="middle" font-size="10" fill="#6b675e">binlog：主库的账</text>
<text class="ts" x="110" y="102" text-anchor="middle" font-size="10" fill="#6b675e">dump 线程推事件流</text>
<line class="fl" x1="200" y1="82" x2="236" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my6As2)"/>
<rect class="bx" x="240" y="44" width="180" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">relay log</text>
<text class="ts" x="330" y="86" text-anchor="middle" font-size="10" fill="#6b675e">从库收件的副本</text>
<text class="ts" x="330" y="102" text-anchor="middle" font-size="10" fill="#6b675e">IO 线程写入，独立落盘</text>
<line class="fl" x1="420" y1="82" x2="456" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my6As2)"/>
<rect class="bx-q" x="460" y="44" width="180" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="550" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">从库重演</text>
<text class="ts" x="550" y="86" text-anchor="middle" font-size="10" fill="#6b675e">SQL 线程按序回放</text>
<text class="ts" x="550" y="102" text-anchor="middle" font-size="10" fill="#6b675e">8.4 默认 4 个 worker 并行</text>
<text class="ts" x="20" y="150" font-size="12" fill="#6b675e">Retrieved_Gtid_Set 记收到哪，Executed_Gtid_Set 记演到哪：收货与上架是两本账</text>
<text class="ts" x="20" y="170" font-size="12" fill="#6b675e">ACK 半同步等的是第一本（relay log 落盘），不等第二本</text>
</svg>
</figure>

## 异步的窗口：主库断电丢什么

默认复制是**异步**的：主库提交不等从库。提交在第四篇的「redo 落盘」那刻就返回了，binlog 被拉走是之后的事。窗口实测（主库写入完成到从库可查，毫秒级轮询）：

```text
单行 INSERT：      20 毫秒
500 行批量：       22 毫秒
2 万行批量：       88 毫秒
```

本机 docker 网络的窗口就这么宽；跨机房生产环境，这个数字是几十毫秒到几秒。**窗口的含义**：主库提交成功 → 客户端收到 OK → 窗口内主库断电且 binlog 没被拉走 → **从库永久少这笔数据**。异步复制的承诺从来不是「不丢」，是「最多丢窗口内的」。`Seconds_Behind_Source` 长期为 0 只说明追得快，不代表此刻没有窗口。

窗口的形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 196" role="img" aria-label="异步复制的窗口时间线：主库提交后客户端立刻收到 OK，binlog 还在被拉走的路上，20 毫秒后从库才可查；若断电落在窗口内且 binlog 未被拉走，从库永久少这笔数据；单行 20 毫秒、2 万行批量 88 毫秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">提交返回与从库可查之间：binlog 在路上的时间</text>
<rect class="bx-sick" x="170" y="66" width="290" height="16" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<line class="axis" x1="60" y1="74" x2="620" y2="74" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="110" y1="62" x2="110" y2="86" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="110" y="52" text-anchor="middle" font-size="10" fill="#6b675e">主库提交</text>
<line class="flk" x1="170" y1="62" x2="170" y2="86" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="170" y="106" text-anchor="middle" font-size="10" fill="#6b675e">客户端收到 OK</text>
<line class="flc" x1="310" y1="58" x2="310" y2="90" stroke="#b03a2e" stroke-width="2.4"/>
<text class="tc" x="310" y="48" text-anchor="middle" font-size="10" fill="#b03a2e">断电落在这里</text>
<text class="tc" x="310" y="108" text-anchor="middle" font-size="10" fill="#b03a2e">binlog 没被拉走 → 从库永久少这笔</text>
<line class="flc" x1="460" y1="62" x2="460" y2="86" stroke="#b03a2e" stroke-width="2"/>
<text class="ts" x="460" y="52" text-anchor="middle" font-size="10" fill="#6b675e">从库可查</text>
<text class="ts" x="315" y="132" text-anchor="middle" font-size="10" fill="#6b675e">窗口：单行 20ms · 500 行 22ms · 2 万行 88ms（本机 docker）</text>
<text class="ts" x="20" y="160" font-size="12" fill="#6b675e">跨机房生产环境，这个窗口是几十毫秒到几秒</text>
<text class="ts" x="20" y="182" font-size="12" fill="#6b675e">异步的承诺：不是「不丢」，是「最多丢窗口内的」</text>
</svg>
</figure>

## GTID：断点续传的身份证

从库断了三天，重连时怎么知道「从哪继续」？老答案靠 binlog 文件名 + 偏移（`MASTER_LOG_FILE='binlog.000003', MASTER_LOG_POS=2411060`）。文件会轮转、偏移会失效，运维的噩梦。8.4 的默认答案是 **GTID**：每笔事务一个全局标识 `uuid:序号`，主库的 `gtid_executed` 记「已发货清单」，从库的记「已收货清单」，**续传 = 发货清单减去收货清单**。

实测断点续传全程：

```text
从库 STOP REPLICA;
主库写 3 笔：gtid_executed: fef4d928-…:1-21（从 1-18 涨上去）
从库此刻：  SELECT COUNT(*) WHERE id>=800001;  → 0     ← 三笔都没到

从库 START REPLICA;
Retrieved_Gtid_Set: fef4d928-…:1-21     ← IO 线程把缺的 19-21 拉全
Executed_Gtid_Set:  fef4d928-…:1-21     ← SQL 线程补演完毕
SELECT COUNT(*) WHERE id>=800001;  → 3
```

**没有任何人工指定位点。** `SOURCE_AUTO_POSITION=1` 下，从库把自己的 `gtid_executed` 报给主库，主库从差集开始发。断三天、换 binlog 文件、主库 IP 换了，都不影响。GTID 顺手解决另一个问题：从库也能开 binlog（`log-replica-updates`）记下自己收的内容，于是**从库的从库**照同一套 GTID 接力。级联复制的拓扑里，任何一台都能报出「我这里有 1-21，缺 22」。

续传就是一道减法：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 182" role="img" aria-label="GTID 断点续传：主库发货清单 gtid_executed 是 1 到 21，从库收货清单停在 1 到 18，差集 19 到 21 就是要补的部分；START REPLICA 后 IO 线程自动拉全、SQL 线程补演完毕，无需人工指定文件名和偏移" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">续传 = 发货清单 − 收货清单</text>
<text class="ts" x="20" y="58" font-size="11" fill="#6b675e">主库 · 已发货</text>
<rect class="bar" x="140" y="44" width="380" height="18" fill="#2b2a26"/>
<rect class="bx-sick" x="520" y="44" width="60" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="onbar" x="150" y="57" font-size="10" fill="#f6f3ec">1-18：两边都有的部分</text>
<text class="tc" x="550" y="57" text-anchor="middle" font-size="10" fill="#b03a2e">19-21</text>
<text class="ts" x="20" y="100" font-size="11" fill="#6b675e">从库 · 已收货</text>
<rect class="bar" x="140" y="86" width="380" height="18" fill="#6b675e"/>
<text class="onbar" x="150" y="99" font-size="10" fill="#f6f3ec">gtid_executed = uuid:1-18（STOP REPLICA 期间停在原地）</text>
<text class="tc" x="550" y="128" text-anchor="middle" font-size="11" fill="#b03a2e">差集 = 待补的 3 笔</text>
<line class="flc" x1="550" y1="62" x2="550" y2="112" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3"/>
<text class="ts" x="20" y="152" font-size="12" fill="#6b675e">START REPLICA 后：IO 线程拉全 1-21，SQL 线程补演，SELECT 数出那 3 行</text>
<text class="ts" x="20" y="172" font-size="12" fill="#6b675e">换 binlog 文件、换主库 IP、断三天：都不需要人工指位点</text>
</svg>
</figure>

## 分道扬镳：亲手制造一次不一致

复制的最大谎言是「从库永远等于主库」。亲手破坏一次，看看裂口怎么开、怎么合。

**第一步：从库写入野行。** 从库明明开着 `read_only=1`，可 root 带着 SUPER 权限，`read_only` 形同虚设：`INSERT` 直接成功，从库多了一行 id=900001/v=999（主库没有的）。

**第二步：主库同 id 写入。** 主库 `INSERT INTO repl_demo VALUES (900001, 1, ...)` 成功提交，复制流把这行推给从库。SQL 线程重演时撞上从库那行野数据：

```text
Last_SQL_Error: Worker 1 failed executing transaction 'fef4d928-…:22'
  Could not execute Write_rows event on table lab.repl_demo;
  Duplicate entry '900001' for key 'repl_demo.PRIMARY', Error_code: 1062
Replica_SQL_Running: No        ← 整条复制停摆，卡在 :22
```

**ERROR 1062 主键冲突，SQL 线程停在 GTID :22**。从库的数据从此比主库少一截，自己还多了一行私货。错误日志里 InnoDB 的警告写得很诚实："possibly leaving data in inconsistent state"。它不知道谁对谁错，只是停下来等人。

**第三步：裁决与修复。** 裁决权在人：哪边是对的？本例从库是野写，主库是正身。删从库野行、重启复制：

```sql
SET SESSION sql_log_bin=0;             -- 从库的修理动作自己不记 binlog（否则将来当主时会再复制出去）
DELETE FROM repl_demo WHERE id=900001; -- 清掉野行
START REPLICA;                          -- :22 重演成功，继续追
```

修复后 `Replica_SQL_Running: Yes`，900001 的值来自主库。**分道扬镳的修复没有魔法：找到分歧的事务，人工裁决，让卡住的那笔能重演。** 生产上这个裁决可能意味着丢一笔业务数据。这也是为什么 `super_read_only` 该在从库上开（它连 SUPER 一起拦），为什么「从库上执行的所有修理必须 `sql_log_bin=0`」（否则从库升主后，修理动作会沿着新拓扑再复制一轮）。

裂口怎么开、怎么合：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 224" role="img" aria-label="分道扬镳三步：第一步 root 带 SUPER 绕过 read_only 在从库写入野行 id=900001；第二步主库写同 id，复制流重演时撞野行，1062 主键冲突，SQL 线程停在 GTID 22；第三步人工裁决，sql_log_bin=0 删野行再 START REPLICA，22 重演成功，值来自主库" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my6As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">亲手制造一次不一致，再亲手合上</text>
<rect class="bx" x="20" y="44" width="195" height="100" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="117" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">① 从库写野行</text>
<text class="ts" x="117" y="88" text-anchor="middle" font-size="10" fill="#6b675e">root 带 SUPER：</text>
<text class="ts" x="117" y="104" text-anchor="middle" font-size="10" fill="#6b675e">read_only 形同虚设</text>
<text class="ts" x="117" y="124" text-anchor="middle" font-size="10" fill="#6b675e">id=900001 落地（主库没有）</text>
<line class="fl" x1="215" y1="94" x2="231" y2="94" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my6As5)"/>
<rect class="bx-sick" x="235" y="44" width="195" height="100" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="332" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">② 复制流撞野行</text>
<text class="ts" x="332" y="88" text-anchor="middle" font-size="10" fill="#6b675e">主库写同 id，重演时 1062</text>
<text class="tc" x="332" y="106" text-anchor="middle" font-size="10" fill="#b03a2e">Replica_SQL_Running: No</text>
<text class="ts" x="332" y="124" text-anchor="middle" font-size="10" fill="#6b675e">整条复制停在 GTID :22</text>
<line class="fl" x1="430" y1="94" x2="446" y2="94" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my6As5)"/>
<rect class="bx-q" x="450" y="44" width="190" height="100" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="545" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">③ 人工裁决修复</text>
<text class="ts" x="545" y="88" text-anchor="middle" font-size="10" fill="#6b675e">sql_log_bin=0 · 删野行</text>
<text class="ts" x="545" y="104" text-anchor="middle" font-size="10" fill="#6b675e">START REPLICA</text>
<text class="ts" x="545" y="124" text-anchor="middle" font-size="10" fill="#6b675e">:22 重演成功，值来自主库</text>
<text class="ts" x="20" y="176" font-size="12" fill="#6b675e">从库不自愈：它不知道谁对谁错，只是停下来等人裁决</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">修理动作必须 sql_log_bin=0：否则从库升主后，修理会沿新拓扑再复制一轮</text>
<text class="ts" x="20" y="218" font-size="12" fill="#6b675e">防线：super_read_only 连 SUPER 一起拦</text>
</svg>
</figure>

## 半同步：把窗口换成一笔等待

异步的窗口能不能关上？**半同步**（semi-sync）的方案：主库提交时多等一步，**至少一个从库 ACK「我把这笔的中继日志落盘了」**，提交才返回。插件装上、开关打开（`rpl_semi_sync_source_enabled=1` + 从库 `rpl_semi_sync_replica_enabled=1` + 重启 IO 线程握手），实测同一笔 INSERT：

```text
半同步 ON：  提交耗时 22 毫秒，Rpl_semi_sync_source_yes_tx = 1（ACK 等到了）
             其中 tx_wait_time = 183 微秒（真正花在等 ACK 上的时间）
```

ACK 往返本机只要 183 微秒，**半同步的常态代价小到几乎免费**。转折在从库失联时：`STOP REPLICA IO_THREAD` 模拟断网，再写一笔：

```text
从库失联：  提交耗时 3022 毫秒（等满 timeout=3000ms）
             Rpl_semi_sync_source_no_tx = 1（ACK 没等到）
             Rpl_semi_sync_source_status: ON → OFF     ← 降级！
```

等满 3 秒，超时，**半同步自动降级回异步**：这笔按异步走（no_tx 计数），后续事务也不再等（status=OFF），直到从库回来重新握手。**半同步的本质是「窗口换等待」**：常态用 183 微秒买掉 20 毫秒的窗口；断连时用 3 秒超时买可用性，它绝不让主库无限等一个死掉的从库。代价要读全：ACK 只保证「中继日志落盘」，**不保证从库 SQL 线程已重演**。从库收货了但还没上架，此刻读从库仍读到旧值。半同步把「丢数据窗口」关到近零，把「读到旧值窗口」留在那里；要两边都关，得等 `AFTER_SYNC`（默认）之上的 `AFTER_COMMIT` 或 lossless 复制语义，那是另一个话题的深水区。

两种状态的账单：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 212" role="img" aria-label="半同步两种状态对照：常态下提交多等一次 ACK，tx_wait_time 仅 183 微秒几乎免费，买掉 20 毫秒的丢失窗口；从库失联时提交等满 3000 毫秒超时，状态从 ON 自动降级 OFF，后续事务不再等，直到从库回来重新握手" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">窗口换等待：两种状态的账单</text>
<rect class="bx-q" x="20" y="40" width="300" height="100" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">常态 · 从库在线</text>
<text class="ts" x="170" y="84" text-anchor="middle" font-size="11" fill="#6b675e">提交前多等一步：至少一个从库</text>
<text class="ts" x="170" y="100" text-anchor="middle" font-size="11" fill="#6b675e">ACK「relay log 已落盘」</text>
<text class="tc" x="170" y="122" text-anchor="middle" font-size="11" fill="#b03a2e">tx_wait_time = 183μs：几乎免费</text>
<rect class="bx-sick" x="340" y="40" width="300" height="100" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="490" y="62" text-anchor="middle" font-size="12" fill="#2b2a26">从库失联</text>
<text class="ts" x="490" y="84" text-anchor="middle" font-size="11" fill="#6b675e">提交等满 timeout（实测 3022ms）</text>
<text class="tc" x="490" y="104" text-anchor="middle" font-size="11" fill="#b03a2e">status: ON → OFF 自动降级</text>
<text class="ts" x="490" y="124" text-anchor="middle" font-size="11" fill="#6b675e">后续事务不再等，直到重新握手</text>
<text class="ts" x="20" y="170" font-size="12" fill="#6b675e">关上的窗口：丢数据（ACK = 日志已在另一台机器落盘）</text>
<text class="ts" x="20" y="192" font-size="12" fill="#6b675e">没关上的窗口：读到旧值（ACK 不等于 SQL 线程已重演，收货 ≠ 上架）</text>
</svg>
</figure>

## 并行与延迟：从库的两味药

**并行重演（MTS）。** 从库默认 4 个 worker 并行执行中继日志（`replica_parallel_workers=4, LOGICAL_CLOCK` 调度）。但别指望它救写入洪峰：LOGICAL_CLOCK 按**主库同一时刻并行提交的事务**分组，同组可并行，**并行度受限于主库的并发模样**。主库单线程写出的串行事务流，从库 4 个 worker 也只能排队。实测 200 笔串行小事务，从库起跑后约 10 秒追平，SQL 线程逐笔执行。并行复制救的是「主库本来就很忙」的场景，救不了「单笔大事务」。

**延迟从库。** `CHANGE REPLICATION SOURCE TO SOURCE_DELAY=60`：SQL 线程故意慢 60 秒。实测主库 INSERT，3 秒后从库查不到（`SQL_Remaining_Delay` 在倒数），把 delay 改回 0 立即放行。这是**给误删留的反悔时间**：`DELETE FROM 重要表 WHERE 少写了 WHERE` 在主库瞬间生效，60 秒后才传到延迟从库。这一分钟里，去延迟从库把数据 dump 出来，闪回就有了原料（binlog 的前像，本篇第二节）。延迟从库是「故意落后」的设计：它不参与日常读，专职当事故快照。

## 复制的边界

binlog ROW 格式记的是前像 + 后像，不是 SQL：五段式事件流（Gtid→BEGIN→Table_map→Update_rows→COMMIT）里 Update_rows 的 70 字节 payload 逐字节可读。复制因此是幂等重演，不依赖语句语义；binlog 与 undo 是同一份账的两个方向，闪回工具的原料就在前像里。

异步复制有窗口，主库断电丢的就是窗口：本机 docker 单行 20 毫秒、2 万行 88 毫秒。`Seconds_Behind_Source=0` 是「追得快」，不是「没有窗口」。半同步用 183 微秒的 ACK 等待买掉这个窗口；从库失联时 3 秒超时自动降级回异步，**绝不为一个死掉的从库赌上主库的可用性**。

GTID 让断点续传变成自动的：每笔事务 `uuid:序号`，从库报收货清单，主库发差集，断三天、换文件、换拓扑都不用人工指位点。级联复制里每台都认同一套 GTID。

分道扬镳没有自愈，只有人工裁决：read_only 拦不住 SUPER（用 super_read_only），野行撞上复制流就是 1062 卡死；修复 = 裁决 + 清理 + `sql_log_bin=0`。从库上每一笔绕开复制流的写入，都是未来的 1062。

从库的两味药各有适应症：并行复制救「主库并发写入」（LOGICAL_CLOCK 按主库提交分组），救不了单笔大事务；延迟从库防误删，专职事故快照，不参与日常读。

单机的数据（前五篇）到多份的数据（本篇），一条线走通了。下一篇回到单机看内存侧：页在缓冲池里怎么进、怎么留、怎么被赶走，全表扫描为什么冲不掉热页。中点插入与 young/old 子链，逐条实测。
