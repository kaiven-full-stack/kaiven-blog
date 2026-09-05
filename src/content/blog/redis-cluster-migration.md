---
title: 槽还没搬完，客户端已经换了门：Redis Cluster 的重定向与迁移
description: 同一个槽迁移期间，旧键仍在源节点，新键却能经 ASK 先落到目标节点。本文以一张搬家清单为线索，拆开 16384 个槽、MOVED、ASKING、MIGRATE、TRYAGAIN 与 configEpoch。文中实验在 Redis 7.4.11 上复核。
pubDate: 2026-09-05
tags: [Redis, 数据库]
---

```text
21:05:10  槽 5061 开始从 m1 搬往 m2，旧键 bar 仍在 m1。
21:05:11  客户端向 m1 写一个不存在的新键 {bar}new。
          m1 回答：-ASK 5061 172.28.0.12:6379。
21:05:12  客户端向 m2 发送 ASKING，再执行 SET：OK。
          槽的正式主人仍是 m1，新键已经住进 m2。
21:05:30  最后一只键搬完，槽位改属 m2。
          m1 从此回答：-MOVED 5061 172.28.0.12:6379。
```

客户端在门牌正式改掉以前，已经临时换过一次门。

`ASK` 与 `MOVED` 都会把客户端指向另一个节点，却不能按同一种方式处理。`ASK` 只说“这一条命令先去那里”，客户端不得更新长期槽位表；`MOVED` 才说“槽已经换了主人”，客户端应刷新地址簿。前者发生在箱子还分散于两端的迁移窗口，后者发生在钥匙正式交接以后。

这不是生产事故的复盘。实验使用六只受限的 Redis 7.4.11 容器组成三主三副本 Cluster，运行在 internal Docker 网络，不映射宿主机端口；键数量很少，所有容器、匿名卷和网络均已清理。故障转移与传播时间只描述本次机器。

上一篇特意说明，Sentinel 没有 `MOVED`、`ASK`、`ASKING` 和槽位。Sentinel 负责告诉客户端当前主库是谁；Cluster 则把“你敲错门了”写进每次请求的协议。本文不从一致性哈希环讲起，而是沿一张真实的槽迁移清单，逐项看数据和门牌怎样分开移动。

## 六个节点，三份槽位

实验集群有三个主节点和三个副本：

```text
m1  172.28.0.11  slots 0-5460       ← replica r2
m2  172.28.0.12  slots 5461-10922   ← replica r3
m3  172.28.0.13  slots 10923-16383  ← replica r1
```

节点启用：

```text
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000
```

`cluster-enabled` 默认关闭，且不能运行中热改。每个节点除客户端端口外，还有 Cluster bus 端口；未单独配置时，它等于客户端端口加 10000。bus 上传递 PING、PONG、FAIL、UPDATE、选票和 gossip，不接受普通 Redis 命令。

节点先由 `CLUSTER MEET` 建立信任，再通过 gossip 发现其余成员。槽位则用 `ADDSLOTS` 或建群工具分给主节点。实验用：

```sh
redis-cli --cluster create \
  172.28.0.11:6379 172.28.0.12:6379 172.28.0.13:6379 \
  172.28.0.21:6379 172.28.0.22:6379 172.28.0.23:6379 \
  --cluster-replicas 1 --cluster-yes
```

最终每个槽有且只有一个正式 owner。客户端不必连接某个中央代理，可以连接任意节点；若敲错门，节点通过重定向告诉它下一步去哪里。

**Cluster 没有一扇统一入口，它依靠所有节点共同维护一张槽位地址簿。**

## 第零步：先有 16384 个门牌

Redis Cluster 把键空间划成 16384 个 hash slot：

```text
slot = CRC16_XMODEM(key) & 0x3FFF
```

也就是对 CRC16 的结果取低 14 位。这里使用的是 XMODEM 参数：多项式 0x1021、初值 0，而不是所有被泛称为“CCITT CRC-16”的变种。

为什么不是完整的 65536 个槽？槽位 bitmap 会进入节点心跳。16384 位刚好是 2KB，65536 位会变成 8KB；再结合 Cluster 预期支持的主节点规模，16384 是传播成本与分片粒度的工程折中，不是“16 位除以四”的数学必然。

实验验证：

```text
CLUSTER KEYSLOT foo  -> 12182
CLUSTER KEYSLOT bar  -> 5061
```

Hash Tag 可以让若干键进入同一槽：

```text
user:{1000}:name
user:{1000}:email
{1000}balance
```

三者都只对 `1000` 计算槽位。规则却不是“看见花括号就取里面”：只找第一枚 `{` 及它右侧第一枚 `}`；若中间为空或没有右括号，就哈希整个键。因此：

```text
foo{}{bar}     -> 对整个 key 哈希
foo{{bar}}zap  -> 对 "{bar" 哈希
foo{bar}{zap}  -> 对 "bar" 哈希
```

不同槽的多键命令直接被拒绝：

```text
CROSSSLOT Keys in request don't hash to the same slot
```

Hash Tag 解决跨键原子操作的同槽要求，却也可能把大量热点集中在同一主节点。它是一项布局选择，不是免费绕过分片。

## MOVED：正式地址簿已经改变

裸客户端连接 m1 读取 `foo`，而槽 12182 属于 m3：

```text
172.28.0.11:6379> GET foo
(error) MOVED 12182 172.28.0.13:6379
```

`MOVED` 表示本节点知道这个槽的正式 owner 不是自己。客户端应把请求发往给出的地址，并刷新自己的槽位表。官方当前推荐使用 `CLUSTER SHARDS` 获取拓扑；`CLUSTER SLOTS` 仍可用，但已经标为 deprecated。

为什么建议刷新整张表，而不是只改这一个槽？一次主节点故障转移会把该主节点的整批槽同时交给副本；一次 rebalance 也可能迁移多个槽。单点修补可以先恢复当前请求，整表刷新才能减少后续一串 `MOVED`。

`redis-cli -c` 会自动跟随重定向：

```sh
redis-cli -c -h 172.28.0.11 GET foo
```

实验中的非交互模式静默完成跳转，没有额外打印 `Redirected` 行。普通 `PING`、`INFO` 等无键命令不经过槽位路由；副本若未执行 `READONLY`，面对自己主库负责的槽也会把请求 `MOVED` 到主库。

`MOVED` 不是 Cluster 出故障，而是客户端路由表陈旧时的正常纠正协议。

## ASK：只借下一条命令一张通行证

迁移期间，源节点仍是槽的正式 owner，却可以把某些请求暂时引到目标节点：

```text
-ASK 5061 172.28.0.12:6379
```

客户端不能把它当成轻量版 `MOVED`。正确流程是：

```text
client                 source m1                 target m2
  │ GET/SET key            │                         │
  ├───────────────────────>│                         │
  │ <──── ASK slot m2 ─────┤                         │
  │                                                  │
  │ ASKING                                          │
  ├─────────────────────────────────────────────────>│
  │ command                                         │
  ├─────────────────────────────────────────────────>│
  │ <────────────────────────────── result ──────────┤
```

`ASKING` 在客户端连接上设置一次性 `CLIENT_ASKING` 标志。下一条普通命令执行后，标志会被清除；在 `MULTI` 中有延后到事务结束的特殊处理。实验连续发送：

```text
ASKING
GET key
GET key
```

第一条 `GET` 可在 importing 节点执行，第二条再次得到 `MOVED`。每一条经 `ASK` 跳转的命令，都要重新发送 `ASKING`。

更重要的是，收到 `ASK` 不得更新长期槽位表。下一次请求仍应先去原 owner。若客户端把目标节点记成永久 owner，目标在没有 `ASKING` 的情况下会 `MOVED` 回源节点，客户端便可能在两端之间来回跳。

**`MOVED` 是正式改址通知，`ASK` 是只对下一件行李有效的临时取件单。**

## 为什么迁移期间必须有两种重定向

迁移不是把整槽数据瞬间从 A 复制到 B。键按批搬运，所以同一个槽在一段时间内有两个物理落点：

```text
slot 5061 正式 owner: m1

m1: bar, {bar}old, {bar}left
m2: {bar}new, {bar}moved
```

旧键如果仍在源节点，源节点直接服务。已搬走的键若再次请求源节点，源节点发现本地不存在，返回 `ASK`。一个从未存在的新键也会被引向目标节点，让迁移期间的新数据尽量落在新家。

目标节点虽然已经持有一些键，却尚未成为正式 owner。若没有 `ASKING`，它仍按全局槽位表返回 `MOVED` 指向源节点。这阻止一个持有过期路由表的客户端绕过迁移协议，直接在目标节点制造另一份键。

```text
源 m1 的本地视图： [5061 ->- m2]  MIGRATING
目标 m2 的本地视图：[5061 -<- m1] IMPORTING
第三方 m3 的视图：  5061 -> m1      正式归属未变
```

`ASK` 解决的正是这段双落点窗口：让请求按键是否已搬运临时分流，同时不宣布槽位整体完成迁移。

## 清单第一、二项：先 IMPORTING，再 MIGRATING

手工迁移槽 5061 的前两步是：

```text
在目标 m2：CLUSTER SETSLOT 5061 IMPORTING <m1-id>
在源端 m1：CLUSTER SETSLOT 5061 MIGRATING <m2-id>
```

顺序很重要。若先让源进入 MIGRATING，源可能马上对不存在的新键返回 `ASK`；而目标尚未 IMPORTING，没有 `ASKING` 豁免入口，只会 `MOVED` 回源端。

两份状态都是本地数组：

```text
migrating_slots_to[5061]
importing_slots_from[5061]
```

它们不进入 Cluster bus 心跳，也不通过 gossip 广播。实验在 `CLUSTER NODES` 中看到：源节点显示 `[5061->-目标ID]`，目标显示 `[5061-<-源ID]`，第三方节点没有任何迁移标记。

这是一条重要边界：Cluster 全局传播正式槽位 owner 与 `configEpoch`，不会替迁移工具保存每一步搬家状态。控制端若崩溃，需要从源、目标两端重新检查并恢复。

**迁移状态属于搬家两端，正式归属才属于整个集群。**

## 清单第三项：按批搬键

迁移工具循环做两件事：

```text
CLUSTER GETKEYSINSLOT 5061 <count>
MIGRATE <target> ... KEYS <key1> <key2> ...
```

实验把 `bar` 和 `{bar}new` 从 m1 搬到 m2：

```text
MIGRATE 172.28.0.12 6379 "" 0 5000 KEYS bar {bar}new
OK
```

再次迁移已不存在的键返回 `NOKEY`，这不是失败；键可能已被上一批搬走，也可能在取清单后自然过期。

`MIGRATE` 通过 DUMP 格式序列化对象，连接目标并执行恢复。Cluster 模式下，目标收到的是内部 `RESTORE-ASKING`，它带有允许在 importing 槽写入的命令标志。成功以后源节点删除本地键，并把删除传播给自己的副本和持久化路径。

默认语义是移动，不是复制。`COPY` 会保留源键，`REPLACE` 允许覆盖目标已有同名键，`AUTH2` 可带用户名密码。`timeout` 表示通信空闲上限，不是整批命令必须在该总时长内完成。

正常完成时，`MIGRATE` 阻塞两端以维持单键移动语义。但发生 IOERR 或超时时，键可能同时存在两端，也可能仍只在源端；官方保证不会因此丢失，却不保证没有重复。其他普通 `ERR` 通常使键留在源端。

所以迁移控制器必须能重试、检查两端并处理幂等，而不是把一次 `OK` 之外的所有结果都理解成同一种失败。

## 清单第四项：多键请求要重新对账

单键路由只需问“这个键现在在哪”。同槽多键命令还要问“这些键是否都在同一端”。源节点的路由逻辑分三种：

```text
MIGRATING 槽上的同槽多键命令
  │
  ├─ 所有键仍在源端       -> 源端执行
  ├─ 所有键都不在源端     -> ASK 到目标端
  └─ 部分在、部分不在     -> TRYAGAIN
```

实际错误是：

```text
TRYAGAIN Multiple keys request during rehashing of slot
```

文案里的 `rehashing` 是历史措辞。它不表示 Redis 正在做普通字典 rehash，而是说同槽键已被迁移拆到两端，无法安全执行一条要求同时看见所有键的命令。

目标节点带 `ASKING` 时也要检查多键完整性：全部键已到目标才能执行；若仍有键留在源端，同样返回 `TRYAGAIN`。

这与 `CROSSSLOT` 不同：

- `CROSSSLOT`：命令里的键本来就属于不同槽；
- `TRYAGAIN`：键属于同一个槽，却在迁移窗口中分居两端。

迁移期间多键命令并非一律不可用。键仍完整位于同一侧时，它仍可执行；只有物理分散时才需要稍后重试。

## 清单第五项：中断以后，别急着撕掉标记

迁移工具中途退出并不一定立即造成不可读。只要源保持 MIGRATING、目标保持 IMPORTING，已搬到目标的键仍能通过 `ASK` 找到，未搬的键仍由源服务。槽处于 open 状态，却还有一条临时路由维持可达性。

实验只把 `foo` 从槽 12182 的 owner m3 搬到另一个节点，然后执行：

```text
CLUSTER SETSLOT 12182 STABLE
```

清掉两端迁移标记。正式 owner 仍是 m3，但 `foo` 的物理副本留在另一端。结果：

```text
m3 GET foo       -> (nil)
另一端 GET foo    -> MOVED 12182 m3
redis-cli -c GET  -> (nil)
```

键没有从内存消失，却从正常路由中消失了。没有 MIGRATING，owner 不再发 `ASK`；没有 IMPORTING，目标即使收到 `ASKING` 也不再接受这条临时路径。

更隐蔽的是，在非 owner 节点直接执行 `MIGRATE` 把其物理持有的键搬回 owner，也可能先被 Cluster 路由层 `MOVED` 拒绝。实验修复方式是临时在持键节点重新设置对应 IMPORTING 状态，允许 `MIGRATE` 执行，再把键搬回正式 owner，最后清 STABLE。

源节点还有一道护栏：只要它仍持有该槽的键，便拒绝把槽正式指派给其他节点：

```text
ERR Can't assign hashslot 5061 to a different node
while I still hold keys for this hash slot.
```

**半途停止不可怕，忘记临时路由为何存在才危险。**

## 清单第六项：先把钥匙交给目标

所有键搬完以后，要用 `CLUSTER SETSLOT <slot> NODE <target-id>` 正式修改 owner。顺序仍然重要：

```text
1. 先在目标节点，把槽指派给目标自己
2. 再在源节点，把槽指派给目标
3. 再通知其他主节点，或等待 gossip 传播
```

为什么目标先？若先让源放弃槽，而目标在承认自己是 owner 以前崩溃，槽可能短暂没有主人，并形成重定向环。Redis 的 `redis-cli --cluster` 源码专门以历史问题说明这一顺序。

目标节点从 IMPORTING 状态接过槽时，会清除 importing 标记，并在需要时通过 `clusterBumpConfigEpochWithoutConsensus()` 抬高自己的 `configEpoch`，随后广播 PONG。这里不经过一次全体投票；它取一个比当前已知配置更新的 epoch。若并发变化造成 epoch 碰撞，节点 ID 的确定性规则会让一方再抬高 epoch。

源节点在还有键时不会交出槽，这是上一节的护栏。交出最后一个槽的主节点在允许 replica migration 的配置下，还可能转为目标节点的副本。

```text
控制端              target m2               source m1              others
  │ SETSLOT NODE m2      │                       │                     │
  ├─────────────────────>│                       │                     │
  │                      ├─ bump configEpoch     │                     │
  │                      ├─ broadcast PONG ──────────────────────────>│
  │ SETSLOT NODE m2                              │                     │
  ├─────────────────────────────────────────────>│                     │
  │                                              ├─ clear MIGRATING    │
  │ SETSLOT NODE m2                                                    │
  ├───────────────────────────────────────────────────────────────────>│
```

**槽位正式改属发生在 `SETSLOT NODE`，不发生在第一只键抵达目标时。**

## 清单第七项：地址簿怎样传遍集群

Cluster bus 心跳带着节点声称拥有的槽位 bitmap 和 `configEpoch`。其他节点看到某槽无人认领，或者一个更高 epoch 的节点声称拥有它，会更新本地映射；如果发现对方持有旧配置，还可以发送 UPDATE 纠正。

这与 Sentinel 的 config epoch 名字相似，职责不同。Sentinel epoch 版本化一次主库配置决议；Cluster configEpoch 则裁决节点对槽位归属的冲突。故障转移时，当选副本用新的 epoch 一次性继承旧主全部槽；手工迁移时，目标 owner 在接槽时抬高自己的 epoch。

传播不是所有节点同一纳秒切换。主动 `SETSLOT NODE` 通知各节点可以大幅缩短窗口，gossip 最终仍允许短暂的旧视图存在。客户端因此必须能处理 `MOVED`，而不是假设自己启动时获取的槽位表永久正确。

实验在目标、源和第三方节点上依次执行 `SETSLOT NODE`，第三方立即改为 `MOVED` 到 m2；由于主动通知，未观察到可见的 gossip 延迟。这只能证明工具主动更新有效，不能证明纯 gossip 在任何环境下零延迟。

地址簿最终一致，重定向负责跨过传播窗口。

## 搬家途中，旧房子塌了

槽迁移状态不通过 gossip 广播，也不进入副本复制流。若源主节点在搬到一半时故障，它的副本即使被选为新主，也只继承正式槽位归属和复制数据，不会自动获得原主进程内存中的 `MIGRATING` 指针。

此时可能出现：

```text
新晋升的源副本：正式拥有槽，却不知道要 ASK 到目标
目标节点：仍处于 IMPORTING，已经持有部分搬来的键
```

访问那些已搬到目标、又不在新 owner 副本数据集中的键，可能得到 nil，而不是 ASK。迁移控制端需要识别 open slot，重新建立迁移状态，决定把目标上的键搬回新 owner，还是继续把剩余键搬到目标再正式改属。

本次实验完成了普通主节点故障转移：停止 m3 后约十秒，其副本 r1 晋升，并一次性接管 10923-16383；客户端路由从：

```text
MOVED 12182 172.28.0.13:6379
```

修正为：

```text
MOVED 12182 172.28.0.21:6379
```

正常复制中的键完整存在。迁移中途故障的路由窟窿则来自实现边界：本地迁移标记没有被复制。它不是“副本选举失败”，而是搬家清单必须由外部控制器恢复。

**故障转移继承正式门牌，不继承半张搬家清单。**

## MOVED 以外，还有三种 CLUSTERDOWN

`MOVED` 和 `ASK` 都是在集群可以服务请求时提供路由。集群本身失去服务条件，则返回 `CLUSTERDOWN`。

Redis 7.4 的主要变体包括：

```text
CLUSTERDOWN The cluster is down
CLUSTERDOWN Hash slot not served
CLUSTERDOWN The cluster is down and only accepts read commands
```

第一种表示集群状态为 FAIL；第二种表示当前命令的槽没有 owner；第三种发生在 `cluster-allow-reads-when-down yes` 时，集群失败状态仍允许部分读取，却拒绝写入。

默认 `cluster-require-full-coverage yes`，任何槽未覆盖或 owner 被判 FAIL，都可能让整个集群进入 FAIL。另一个条件是可达的持槽主节点不足多数。`cluster-allow-reads-when-down` 默认关闭。

所以收到 `CLUSTERDOWN` 时，客户端不应像处理 `MOVED` 那样盲目换节点。它表达的是集群状态或槽位覆盖异常，不是普通路由陈旧。

## 客户端搬家须知

Cluster-aware 客户端至少要遵守这些规则：

1. **MOVED**：把当前命令发送到新地址，并刷新 `CLUSTER SHARDS` 拓扑；
2. **ASK**：只重试当前命令，目标连接先发 `ASKING`，不要改长期槽表；
3. **ASKING**：通常只对下一条命令有效，连接池不能假设标志会保留；
4. **TRYAGAIN**：迁移中同槽多键暂时分散，退避后重试；
5. **CROSSSLOT**：请求设计本身跨槽，重试不会改变结果；
6. **CLUSTERDOWN**：集群或槽位不可服务，应进入错误处理而非无限重定向；
7. **MOVED 空 endpoint**：若地址只有 `:port`，沿用当前连接的 host；
8. pipeline、事务与连接池必须让 `ASKING` 和对应命令落在同一连接、正确顺序中。

服务端没有规定客户端必须重试几次。重试上限、退避、幂等和超时属于客户端策略。无限跟随重定向会把错误迁移状态变成请求风暴；完全不重试又会把正常 reshard 当成业务故障。

Redis Cluster 也不是一致性哈希的直接实现。它拥有固定、可枚举、可指派的 16384 个槽；节点变化以槽为最小迁移单位，服务端用显式重定向纠正客户端。客户端不是在一条哈希环上自行找后继节点，而是在维护一张由集群不断修正的槽位表。

## 搬家清单，最后核对一遍

一次完整迁移可以压缩为七项：

```text
[1] 目标：SETSLOT <slot> IMPORTING <source>
[2] 源端：SETSLOT <slot> MIGRATING <target>
[3] 源端：GETKEYSINSLOT，按批 MIGRATE
[4] 反复检查本地键数与 TRYAGAIN 窗口
[5] 中断时保留临时状态，或先把键搬回再 STABLE
[6] 目标先 SETSLOT NODE，源端随后交出槽
[7] 通知其余节点，并等待 configEpoch / gossip 收敛
```

每一格都对应一个容易说错的事实。

`IMPORTING` 必须先于 `MIGRATING`，否则 ASK 没有落点；`ASK` 不能更新槽表，否则两端乒乓；`MIGRATE` 超时可能留下重复键，控制器要对账；半途 `STABLE` 会切断临时路由；目标先接槽，是为了避免无 owner 窗口；第三方节点看不见迁移过程，只认最终 owner 与 epoch。

`MOVED` 是新的户籍，`ASK` 是搬家途中的一次临时通行。二者地址可能完全相同，客户端行为却必须不同。

---

```text
21:05:11  第一个新键经 ASK 落进 m2，旧键仍留在 m1。
21:05:20  MIGRATE 搬走 bar，源端开始对它回答 ASK。
21:05:29  最后一批键离开 m1，源端允许交出槽。
21:05:30  m2 接过 owner，configEpoch 向前一格。
21:05:31  m1 对后来者回答 MOVED，长期地址簿正式改变。
21:12:00  六只容器删除，门牌、箱子与清单一并消失。
```

客户端很早就换过一次门，但那张 `ASKING` 通行证只允许处理下一件行李。真正的改址发生在清单最后几格完成、目标节点成为正式 owner 的时刻。

Redis Cluster 不会移动正在敲门的客户端。它只改写门牌，然后等下一次敲错。
