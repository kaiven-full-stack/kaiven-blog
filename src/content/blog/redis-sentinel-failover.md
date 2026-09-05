---
title: 所有哨兵都看见了，不等于已经选出新主库：Redis Sentinel 的故障转移
description: 一只 Sentinel 已经写下 ODOWN，故障转移却仍因拿不到多数票而中止。本文沿 SDOWN、quorum、leader 表决与状态机逐层拆解 Sentinel，并追到副本排序、脑裂写入和客户端服务发现。文中实验在 Redis 7.4.11 上复核。
pubDate: 2026-09-05
tags: [Redis, 数据库]
---

```text
12:27:25.950  三只 Sentinel 认定主库 ODOWN。
12:27:26.036  一只 Sentinel 获得多数票，成为 leader。
12:27:28.142  +switch-master，新主库地址正式公告。

另一场实验：
一只 Sentinel 已经写下 +odown 和 +try-failover。
它给自己投了一票，此后再没有 +switch-master。
```

两场实验都看见了主库故障。第一场完成切换，第二场却以 `-failover-abort-not-elected` 收场。

因为“主库是不是下线”与“谁有权执行故障转移”是两道不同的问题。quorum 让 Sentinel 形成客观下线判断，Sentinel 全体的多数票才授权一名 leader 行动。前者是听证，后者是表决；证词凑齐，不代表主持人已经选出。

这不是生产事故的复盘。现场由一主、两副本和三只 Sentinel 的隔离容器组成，全部使用 Redis 7.4.11；容器限制 CPU 与内存，不映射宿主机端口，实验结束后网络、数据与日志均已删除。为了让过程在有限时间内可见，实验把 `down-after-milliseconds` 从常见的 30000 毫秒缩短到 5000 毫秒，把 `failover-timeout` 从默认 180000 毫秒缩短到 30000 毫秒。文中时间只描述本次实验，不能直接当作生产切换时长。

上一篇说过，副本被提升后会生成新的 replication ID，并为旧历史保留一栏“曾用名”。这一篇往前追问：是谁决定提升哪只副本，这项决定要经过几道门，又为什么 Sentinel 都活着并不等于客户端已经来到新主库。

## 六只容器搭出的议事厅

基础拓扑是：

```text
        sentinel-1     sentinel-2     sentinel-3
             \             |             /
              \            |            /
               ▼           ▼           ▼
                         master
                        /      \
                 replica-1   replica-2
```

三份 Sentinel 配置都监控同一个名字：

```text
port 26379
sentinel monitor mymaster 172.21.0.2 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 30000
sentinel parallel-syncs mymaster 1
```

`mymaster` 是服务名，最后的 `2` 是 quorum。客户端不应把当前主库 IP 当成永远不变的地址，而应向 Sentinel 查询这个名字当前对应谁。

Sentinel 本身也是 Redis 进程，使用相同的事件循环，只是运行在 Sentinel 模式，开放一组受限命令与 `SENTINEL` 子命令。它不是嵌在主库中的线程，也不是由某个“中央 Sentinel”统一指挥。三只进程各自维护连接、计时器、配置纪元与对拓扑的看法。

这也是为什么三只 Sentinel 应部署在不同故障域。把它们全放在一台机器上，进程数量虽然是三，断电时却只剩零个判断者。

**进程数量只有落在不同故障域里，才真正形成独立证词。**

## Sentinel 平时在问什么

Sentinel 的判断来自周期性通信，而不是操作系统替它发送的一次“主库已死”通知。

对主库和副本，它维护命令连接和 Pub/Sub 连接。默认情况下：

- 大约每秒发送一次 `PING`；
- 大约每十秒获取一次 `INFO`；
- 大约每两秒向 `__sentinel__:hello` 发布自身与主库配置；
- 当实例处于故障转移或复制异常阶段，`INFO` 会加速到约每秒一次。

副本由主库 `INFO` 中的复制信息自动发现；Sentinel 则通过 `__sentinel__:hello` 互相发现。hello 消息带着 Sentinel 地址、run ID、当前 epoch、主库名字与 config epoch。收到更高版本的主库配置时，其他 Sentinel 会接受更新，而不是各自永远坚持旧地址。

`down-after-milliseconds` 测量的是本地 Sentinel 连续多久没收到有效回复。有效不只等于 `+PONG`：`-LOADING` 和 `-MASTERDOWN` 也能证明对方进程仍在回应；`-BUSY` 则可能触发一次 `SCRIPT KILL` 尝试。

因此，配置 5000 毫秒并不承诺故障恰好五秒后完成切换。它只是本地无有效回复窗口的下限，后面还有询问同伴、形成 ODOWN、选举、挑副本、提升、重挂与公告。

**检测计时器只决定何时开始作证，不决定决议何时执行完。**

## 第一份证词：SDOWN 只属于本地

单只 Sentinel 发现主库持续没有有效回复，会把它标为 subjective down，也就是 SDOWN，并发布 `+sdown` 事件。

“主观”不是说它随意猜测，而是强调这项判断只依赖本地观察。另一只 Sentinel 可能走不同网络、使用不同 `down-after-milliseconds`，此刻仍能正常收到主库回复。

实验把 sentinel-1 的阈值改为 2 秒，另外两只保持 30 秒，再让主库暂停 8 秒。结果只有 sentinel-1 出现：

```text
+sdown master mymaster 172.21.0.2 6379
```

另外两只仍把主库标作正常。主库恢复后，sentinel-1 又发出 `-sdown`；没有 `+odown`，更没有切换。

进入 SDOWN 后，Sentinel 会通过：

```text
SENTINEL is-master-down-by-addr <ip> <port> <epoch> <runid>
```

向同伴询问。同伴返回自己是否也认为该主库 SDOWN，以及它在相关 epoch 投给了谁。这条命令同时承载故障证词与后续选票，但两个阶段的用途必须分开。

SDOWN 可以作用于主库、副本或其他 Sentinel；ODOWN 与自动故障转移只针对被监控主库。

**SDOWN 是一只 Sentinel 的证词，不构成集体决议。**

## 第二道门：ODOWN 与 quorum

一只 Sentinel 已经本地 SDOWN 主库后，会统计自己与其他 Sentinel 的下线判断。数量达到该主库配置的 quorum，它就把主库标为 objective down，也就是 ODOWN。

```text
本地无有效回复达到阈值
          │
          ▼
       +sdown
          │  向其他 Sentinel 询问
          ▼
同意主库下线的数量 >= quorum
          │
          ▼
       +odown
```

本地 Sentinel 自己若处于 SDOWN，会计入这份数量；其他 Sentinel 的下线报告只在有限时间内有效，当前源码约五秒后就视为陈旧。源码甚至直接把 ODOWN 称作 weak quorum：它不承诺所有同意者在完全相同的一瞬间持有完全相同的状态，只要求当前收集到足够新鲜的证词。

quorum 太小，单个网络分区就容易让某侧形成 ODOWN；quorum 太大，少量 Sentinel 故障又会让检测永远过不了门槛。它是故障判断的敏感度配置，不是整个故障转移的唯一票数。

最重要的是：`+odown` 只表示“可以尝试发起故障转移”，不表示某个 Sentinel 已经得到执行授权。

**quorum 决定是否立案，不决定由谁主持。**

## ODOWN 以后，还要凑齐另一种多数

Sentinel 自动故障转移还要求选出一名 leader。这里的门槛不是配置里的 quorum，而是已知 Sentinel 总数的多数：

```text
majority = floor(number_of_known_sentinels / 2) + 1
```

候选 leader 还必须同时满足票数不少于 quorum。对三只 Sentinel、quorum=2 的常见部署，两道门碰巧都是 2，所以很容易被误以为它们是同一规则。换成五只 Sentinel、quorum=2，差异就出现了：两份证词足以形成 ODOWN，三票才足以授权 leader。

每次故障转移使用新的 epoch。每只 Sentinel 在一个 epoch 中只投一票，通常投给最先向它请求并符合条件的候选者。票数通过 `is-master-down-by-addr` 回复传播。获胜者需要获得多数派与 quorum 的双重认可。

```text
Sentinel A                           Sentinel B
    │  is-master-down-by-addr           │
    │  <master> <epoch> <A-runid>       │
    ├──────────────────────────────────>│
    │                                   ├─ 本 epoch 尚未投票
    │  down=1, leader=A, epoch=N        │
    │<──────────────────────────────────┤
```

这是一项受多数派选举思想启发的单用途协议，但不应简单写成“Sentinel 使用 Raft”。它没有 Raft 的复制日志和 commit index；选票授权的是谁来执行一次故障转移，不是提交一条一致性日志。

**故障可以各自看见，主持故障转移的人只能选出一位。**

## quorum 凑齐了，多数派仍可能缺席

为了把两道门分开，实验保留三只 Sentinel，把 quorum 临时改成 1，然后关闭其中两只 Sentinel，只留下 sentinel-1。接着暂停主库。

sentinel-1 很快给出完整的前半段记录：

```text
+sdown master mymaster 172.21.0.2 6379
+odown master mymaster 172.21.0.2 6379 #quorum 1/1
+new-epoch 1
+try-failover master mymaster 172.21.0.2 6379
+vote-for-leader <sentinel-1-runid> 1
```

quorum=1，所以它自己的证词足以形成 ODOWN。它也给自己投了一票。可已知 Sentinel 总数仍是 3，多数派门槛为 2，另外两票永远没有回来。

`SENTINEL CKQUORUM mymaster` 返回：

```text
NOQUORUM 1 usable Sentinels.
Not enough available Sentinels to reach the majority and authorize a failover
```

选举超时后，日志出现：

```text
-failover-abort-not-elected master mymaster 172.21.0.2 6379
```

没有副本被提升，没有 `+switch-master`。这就是标题里的“不等于”：一只 Sentinel 已经看见故障，已经形成 ODOWN，甚至已经开始尝试切换，却没有得到多数派授权。

若使用五只 Sentinel、quorum=2，保留两只而隔离三只，也会得到同一种结构：两只可以形成 ODOWN，三票多数却无法取得。分母是已知全体 Sentinel，不是“此刻还能相互说话的那些 Sentinel”。

**凑齐证词与凑齐选票，是两道不同的门。**

## 表决通过以后，是一段状态机

正常实验中，主库停止后，三只 Sentinel 在约 100 毫秒内先后写下 SDOWN；sentinel-2 率先形成 quorum，并发起 epoch 2 的选举：

```text
12:27:25.950  +odown #quorum 2/2
12:27:25.952  +new-epoch 2
12:27:25.952  +try-failover
12:27:26.036  +elected-leader
```

ODOWN 到 leader 当选只花了约 84 毫秒。这是本次隔离机器的观察，不是协议保证。

leader 当选以后，故障转移才进入真正的状态机：

```text
WAIT_START
    ↓
SELECT_SLAVE
    ↓
SEND_SLAVEOF_NOONE
    ↓
WAIT_PROMOTION
    ↓
RECONF_SLAVES
    ↓
UPDATE_CONFIG
```

每一段都有对应事件和失败出口。选不出 leader 会产生 `-failover-abort-not-elected`；没有合格副本是 `-failover-abort-no-good-slave`；提升命令迟迟没有在 `INFO` 中被确认，则可能以 `-failover-abort-slave-timeout` 结束。中止以后不会在原流程中随意跳过一段，而是等待重试窗口，再进入新的 epoch 或选举。

`failover-timeout` 也不只是一只包住全流程的总计时器。它参与限制选举、提升、重挂与下一次尝试间隔；当前实现的 leader 选举等待还取 `min(10s, failover-timeout)`。把它调小会加快失败与重试，也可能让正常但稍慢的同步来不及完成。

**故障转移是一段有确认、有超时、有回退的流程，不是一个布尔开关。**

## 谁来接班，先看座次再看进度

进入 `SELECT_SLAVE` 后，leader 先排除不合格副本：

- 本身处于 SDOWN 或 ODOWN；
- 命令连接断开；
- 最近可用时间或 INFO 太旧；
- `replica-priority` 为 0；
- 与旧主断开太久，超过算法允许的窗口。

剩余副本按三层规则排序：

```text
1. replica-priority 数字更小者优先
2. priority 相同，复制 offset 更大者优先
3. offset 仍相同，run ID 字典序更小者优先
```

“Sentinel 总会选择数据最新的副本”因此不准确。复制进度只在 priority 相同时参与比较。运维可以用 priority 表达拓扑偏好，例如让同机房副本优先或永不晋升；代价是更高优先级的副本可能比另一只稍旧。

实验把一只副本设置为 `replica-priority 0`，等 Sentinel 的下一次 `INFO` 确认配置后触发切换。它即使在线，也不进入晋升候选。

offset 对照更难做，因为小数据集的副本能在毫秒内追平。实验最终用约 106MB 数据让一只副本处在全量同步中，此时它向 Sentinel 报告的 offset 停在 55246828，另一候选为 55247391。priority 相同时，后者被选中。若两者 offset 相同，run ID 才负责给出确定结果。

这里还踩过一个坑：用 `CLIENT PAUSE` 或长时间暂停副本来制造 offset 差，可能让副本先因连接或断链时长被排除，实验测到的就不再是排序，而是资格审查。

**数据最新是同一座次里的决胜项，不是第一判据。**

## 提升不是一条命令结束的瞬间

选中副本后，Sentinel 7.4.11 实际发送的仍是兼容命令 `SLAVEOF NO ONE`，包在一组事务命令中；`REPLICAOF` 是现代名称，但协议兼容路径仍保留旧拼写。

Sentinel 不以命令发送成功作为提升完成。它继续轮询 `INFO`，直到候选副本明确报告自己是 master，才发出 `+promoted-slave` 并进入重挂阶段。

正常实验的后半段是：

```text
12:27:26.092  +selected-slave 172.21.0.4:6379
12:27:26.092  +failover-state-send-slaveof-noone
12:27:26.144  +failover-state-wait-promotion
12:27:27.011  +promoted-slave
12:27:27.011  +failover-state-reconf-slaves
12:27:28.058  +slave-reconf-done
12:27:28.142  +switch-master 172.21.0.2 6379 172.21.0.4 6379
```

`parallel-syncs` 控制重挂阶段同时允许多少只副本与新主同步，默认是 1。值小，切换后的只读副本逐个恢复，减少同一时刻不可用的副本数量；值大，整体收敛更快，却可能让多只副本同时加载全量数据。

本次拓扑晋升一只后只剩一只副本需要重挂，因此把 `parallel-syncs` 从 1 改成 2 没有产生可见差异。这个结果符合机制，却不能作为两种配置性能差异的证据；要真正比较并发批次，需要至少三只剩余副本。

从 SDOWN 到 `+switch-master` 约 2.3 秒，从主库停止到客户端可见公告约 8.5 秒。这些数字包含人为设置的 5 秒 down-after，只能作为状态顺序的证据。

**提名与就任之间，还隔着命令执行和一次 INFO 确认。**

## 旧主库不知道自己已经下野

Sentinel 多数派在另一侧选出新主时，网络分区中的旧主库不会收到一纸“你已不是主库”的通知。只要客户端仍能连接它，它仍认为自己是 master，默认继续接受写入。

实验把旧主库从 Redis/Sentinel 的内部网络断开，但保留进程运行，并从它仍可达的一侧写入：

```text
SET split:brain old-side-write
OK
```

另一侧 Sentinel 达成多数、提升新主。网络恢复以后，Sentinel 把旧主加入新主的副本列表，随后发送 `SLAVEOF <new-master>`。旧主加载新主的数据集，那笔只存在于少数派的 `split:brain` 写入消失。

```text
旧主一侧                           多数派一侧
客户端 ── SET 成功                 Sentinel × 3
       │                               │
       ▼                               ├─ ODOWN / 选举
     旧主                              ▼
                                      新主
       └──── 网络恢复 ──> 旧主被降级并重同步，孤立写入被覆盖
```

这不是 Sentinel 选错主库，而是异步复制的保证边界。故障转移解决的是在多数派一侧恢复一个被认可的主库，不会合并两侧分叉的数据历史。

可配置：

```text
min-replicas-to-write 1
min-replicas-max-lag 8
```

把风险窗口收窄。实验断开副本后两秒内旧主仍接受写入，因为 ACK 还没有过期；约十三秒后，写入被 `NOREPLICAS` 拒绝。它把“分区期间无限接受写”改成“最多在 lag 窗口内继续写”，代价是副本全部故障时主库主动牺牲写可用性。

这仍不是同步共识。lag 窗口内的写仍可能丢，和上一篇中 `WAIT` 只能降低风险、不能自动提供强一致是同一条边界。

**旧主库并不知道自己已经下野，它只知道追随者暂时没有回信。**

## 旧主恢复，不会自动夺回席位

切换时，Sentinel 会把旧主地址加入新主的副本列表，等它回来。恢复后的旧主如果仍报告自己是 master，在当前新主配置看起来稳定以后，Sentinel 会把它转成副本，并发布 `+convert-to-slave`。

实验中的旧主重启后最终显示：

```text
role:slave
master_host:172.21.0.4
master_link_status:up
```

它没有因为曾经是主库而自动获得优先权，也不会把分区期间的写合并进新主。它只是成为新复制历史的一名追随者。

若双方历史仍能通过上一篇的 replication ID、第二 ID 与 backlog 对上，它可能部分同步；若对不上，就会全量加载。Sentinel 负责发送拓扑命令，PSYNC 负责决定数据怎样追上，两套机制各管一段。

在实验里，旧主以空数据恢复，最终通过同步得到新主的三个键。拓扑决议没有绕过复制协议，只是改变了谁向谁复制。

**Sentinel 决定方向，PSYNC 决定补账还是重抄。**

## `+switch-master` 是公告，不是传送门

Sentinel 完成配置更新后发布：

```text
+switch-master mymaster <old-ip> <old-port> <new-ip> <new-port>
```

它还会让相关普通客户端连接重建，以促使支持 Sentinel 的客户端重新查询。但一个只知道旧 IP、从不连接 Sentinel 的客户端，不会被神秘地搬到新主库。

客户端通常需要：

1. 配置多个 Sentinel 地址；
2. 用 `SENTINEL get-master-addr-by-name mymaster` 查询当前主库；
3. 连接返回地址；
4. 监听连接失败与 `+switch-master`，重新查询并重连；
5. 对切换窗口中的失败命令采取明确的重试与幂等策略。

实验中，两个 Sentinel 都返回相同的新主地址，客户端据此完成 `SET`、`GET` 与 `INCRBY`。这份一致来自配置 epoch 的传播，不是虚拟 IP 自动漂移。

Sentinel 体系也没有 Redis Cluster 的 `MOVED`、`ASK`、`ASKING` 或槽位。把 Cluster 客户端重定向机制套到 Sentinel，是把两套高可用模型混在了一起。

**故障转移公布了新地址，客户端仍要自己走到那里。**

## epoch 是决议编号，不是数据版本

Sentinel 使用几个容易混淆的版本概念。

`current_epoch` 是本 Sentinel 已知的最高选举纪元；`leader_epoch` 记录某个主库在某个 epoch 投给了谁；`config_epoch` 则标识一次主库配置的版本。晋升成功后，leader 把本次 failover epoch 赋给主库配置，并通过 hello 消息传播。

收到更高 config epoch 的 Sentinel 会接受新主地址。晚到的 Sentinel 不必重新举行一场表决，它只需承认更新的纪要。

Sentinel 会把 myid、监控配置、已知实例与 epoch 写回可写配置文件。因此 Sentinel 必须用可重写的配置启动；配置文件不是一份永远只读的部署模板。容器环境若每次启动都丢弃这份状态，就可能让 Sentinel 以新身份重新加入，增加拓扑收敛的不确定性。

TILT 模式处理另一种危险：Sentinel 定时器若发现时钟回拨，或两次执行相隔超过约两秒，会进入 TILT。接下来约三十秒，它继续收集监控信息，却不发起故障转移，对下线询问也按安全方式回应。这防止长时间进程暂停或时钟跳变让一批过期计时器同时触发。

我没有为了实验主动修改宿主机时间或制造 TILT。系统时钟属于共享环境，不应为得到一条漂亮日志而随意扰动。

**epoch 是决议的编号；复制 offset 才是数据流的页码。**

## 容器里的地址也会参加表决

Sentinel 通过 hello 消息传播自己的地址，通过主库 `INFO` 发现副本地址。这意味着 NAT、端口重映射与错误公告会直接污染拓扑。

若容器内部 Sentinel 监听 26379，却向同伴公告一个外部不可达地址；或副本在 `INFO` 中报告的地址只能在自身网络里使用，其他 Sentinel 就会发现一个无法建立连接的节点。看起来像多数派不足，根因却是地址不可达。

相关配置包括：

```text
sentinel announce-ip
sentinel announce-port
replica-announce-ip
replica-announce-port
sentinel resolve-hostnames
sentinel announce-hostnames
```

7.4 中 hostname 解析与公告默认都关闭。若使用主机名，应在整个部署中保持统一，不要让一部分节点用 IP、另一部分用只能局部解析的 hostname。

实验使用一只内部 Docker 网络和固定容器地址，没有端口映射，目的就是把 Sentinel 算法与 NAT 问题分开。生产环境若存在 Kubernetes、跨网段或服务网格，地址公告必须作为高可用设计的一部分，而不是部署完成后的网络细节。

**错误地址不会改变多数派公式，却会让本应存在的票永远送不到。**

## 一次没有发生的切换，该从哪里查

Sentinel 日志本身就是一条状态机记录。排查时可以按门槛逐层核对，而不是笼统地说“哨兵没有反应”。

| 现象 | 首要证据 |
| --- | --- |
| 没有 SDOWN | `last-ok-ping-reply`、连接状态、`down-after-milliseconds` |
| 有 SDOWN，没有 ODOWN | 同伴连通性、各自 `+sdown`、quorum |
| 有 ODOWN，没有 leader | `SENTINEL CKQUORUM`、`+vote-for-leader`、已知 Sentinel 总数 |
| leader 已选，中途失败 | `failover-state`、`-failover-abort-*`、`failover-timeout` |
| 不理解候选结果 | `SENTINEL REPLICAS` 的 priority、offset、run ID、断链时长 |
| 切换后副本恢复慢 | `parallel-syncs`、PSYNC/full sync、RDB 加载状态 |
| 切换后仍有写丢失 | 旧主分区时间、异步复制、`min-replicas-to-write` |
| 客户端仍连旧主 | `get-master-addr-by-name`、客户端重连逻辑、`+switch-master` |
| Sentinel 不行动 | `sentinel_tilt`、epoch、配置文件与公告地址 |

常用命令包括：

```text
SENTINEL MASTER mymaster
SENTINEL REPLICAS mymaster
SENTINEL SENTINELS mymaster
SENTINEL CKQUORUM mymaster
SENTINEL INFO-CACHE mymaster
SENTINEL MYID
INFO sentinel
```

`SENTINEL FAILOVER` 可手动发起切换，适合有意维护和隔离实验，不应拿来掩盖自动选举为何失败。它绕过正常故障检测与 leader 选举，不能证明 quorum 和 majority 配置正确。

**一次没有发生的故障转移，通常是停在某一道门，而不是整个 Sentinel 同时失灵。**

## 看见、表决、接管是三道门

**SDOWN 是本地证词，ODOWN 是 quorum 形成的弱集体判断。** 单只 Sentinel 看见故障不够；ODOWN 也只是允许进入下一阶段。

**leader 必须获得全体 Sentinel 的多数授权。** quorum 与 majority 可能恰好相等，也可能完全不同。不可达 Sentinel 仍留在多数派分母中，这是避免少数派各自切主的关键。

**故障转移是一段状态机。** 选副本、发送提升命令、等待角色确认、重挂其余副本和更新配置各有独立事件与超时，任何一段都可能中止。

**副本排序先看 priority，再看 offset。** `replica-priority 0` 表示永不晋升；“最新副本必然当选”只有在优先级相同且候选资格都通过时才成立。

**旧主库与客户端不会自动消失。** 分区旧主可能继续接受最终会丢失的写，客户端也必须重新查询新地址。`min-replicas-to-write` 能收窄风险窗口，却不能把异步复制变成共识。

Sentinel 真正提供的不是“主库一断就无感切换”，而是一套可观察、可投票、可恢复的拓扑决议程序。它用多数派约束谁有权改主库，用 epoch 传播最终配置，却把数据一致性与客户端重连的最后责任留给复制协议和应用。

---

```text
12:27:25.950  三份证词凑齐，ODOWN 成立。
12:27:26.036  多数票选出 leader，故障转移获得授权。
12:27:28.142  +switch-master，新地址写入 epoch 2 的纪要。

另一场实验里：
一份证词足以 ODOWN，一张选票不足以选出 leader。
容器最终被删除，那场没有开成的表决也停在原地。
```

Sentinel 不会因为看见故障就立刻行动。它先各自作证，再凑法定人数，接着选出一名 leader，由它把提升、重挂与公告逐段做完。任何一道门没开，前面的看见都只是一份记录在案的证词。

26379 端口安静下来以前，最后一行纪要上写着新的 epoch。
