/**
 * 知识图谱手工数据：知识点归属 + 跨系列精选关联。
 *
 * 维护方式（发新文章后可选补充，不补也能凭标签自动进图谱）：
 * - concepts：给新文章的 id 加进相应知识点的 posts 数组；没有合适的知识点就新增一条；
 * - relatedLinks：跨系列的强关联文章对（正文明确对照过对方主题、但正文里没有超链接的），
 *   备注 ≤16 字；注意不要与正文里已有的 /posts/ 链接重复，构建时会校验并报错。
 *
 * 知识点 id 全局唯一；按「跨系列 → 各系列内部」分组排列，
 * 跨系列知识点是图谱里最有价值的部分，排在最前。
 */

/** 知识点：一个跨文章的技术概念 */
export interface ConceptMeta {
  /** kebab-case 英文 id */
  id: string;
  /** 中文标签（2-8 字） */
  label: string;
  /** 一句话说明 */
  description?: string;
  /** 关联文章的 id（文件名 slug） */
  posts: string[];
}

/** 精选关联：跨系列的强关联文章对 */
export interface RelatedLink {
  from: string;
  to: string;
  /** 推荐理由，如「镜像：应用层淘汰 vs 内核回收」 */
  note?: string;
}

export const concepts: ConceptMeta[] = [
  // ---- 跨系列知识点（多篇分属不同系列） ----
  {
    id: 'allocator',
    label: '内存分配器',
    description: '分配策略显式化：pymalloc、slab 与调用方传入的分配器',
    posts: ['zig-allocator', 'zig-object-model', 'zig-slice-lifetime', 'zig-strings', 'zig-testing', 'cpython-pymalloc-rss', 'kernel-slab-slub'],
  },
  {
    id: 'concurrency',
    label: '并发与原子',
    description: '原子操作、内存顺序与数据竞争',
    posts: ['zig-atomic-ordering', 'cpython-free-threading'],
  },
  {
    id: 'cow',
    label: '写时复制',
    description: 'fork 后共享页，写时才按页复制',
    posts: ['kernel-copy-on-write', 'redis-fork-cow'],
  },
  {
    id: 'error-handling',
    label: '错误处理',
    description: '错误值与零成本异常表两种错误路径',
    posts: ['zig-error-handling', 'zig-safety-modes', 'zig-transition-guide', 'cpython-exception-tables'],
  },
  {
    id: 'event-loop',
    label: '事件循环',
    description: '单线程轮转 I/O 与定时事件',
    posts: ['redis-event-loop', 'cpython-asyncio-task-future-event-loop'],
  },
  {
    id: 'eviction-reclaim',
    label: '内存回收与淘汰',
    description: '资源见底时按打分丢弃占用者',
    posts: ['redis-eviction-policy', 'kernel-oom-killer', 'mysql-innodb-buffer-pool-lru'],
  },
  {
    id: 'cache-locality',
    label: '缓存与局部性',
    description: '中点插入与时间窗：一次访问不足以驻留',
    posts: ['kernel-page-cache-writeback', 'mysql-innodb-buffer-pool-lru'],
  },
  {
    id: 'fsync-durability',
    label: '落盘语义',
    description: 'write 只进页缓存，fsync 才等设备',
    posts: ['redis-aof-append-fsync', 'kernel-page-cache-writeback', 'mysql-binlog-redo-2pc'],
  },
  {
    id: 'hash-table',
    label: '哈希表',
    description: '链地址渐进迁移与开放寻址探测',
    posts: ['cpython-dict-internals', 'cpython-set-open-addressing', 'redis-incremental-rehash'],
  },
  {
    id: 'huge-page',
    label: '透明大页',
    description: '2MiB 巨页换 TLB 命中率，代价是碎片与拆分',
    posts: ['kernel-page-tables', 'kernel-buddy-allocator', 'kernel-copy-on-write', 'redis-fork-cow'],
  },
  {
    id: 'integer-overflow',
    label: '整数溢出',
    description: '任意精度无墙，对望显式溢出',
    posts: ['cpython-int-arbitrary-precision', 'zig-integer-overflow'],
  },
  {
    id: 'memory-layout',
    label: '内存布局',
    description: '对象头、对齐填充与字节排布契约',
    posts: [
      'cpython-object-layout',
      'cpython-str-internals',
      'cpython-int-arbitrary-precision',
      'zig-memory-layout',
      'zig-c-interop',
      'zig-integer-overflow',
      'zig-tagged-union',
    ],
  },
  {
    id: 'page-table',
    label: '页表',
    description: '虚拟地址到物理页的翻译地图',
    posts: ['kernel-primer', 'kernel-page-tables', 'kernel-copy-on-write', 'redis-fork-cow'],
  },
  {
    id: 'ordered-index',
    label: '有序结构',
    description: 'B+ 树、跳表与开放寻址的取舍',
    posts: ['redis-skiplist-zset', 'mysql-innodb-pages-btree'],
  },
  {
    id: 'page-unit',
    label: '页式管理',
    description: '固定大小页作为分配与 I/O 的最小单位',
    posts: ['kernel-page-tables', 'kernel-buddy-allocator', 'kernel-page-cache-writeback', 'mysql-innodb-pages-btree'],
  },
  {
    id: 'strings',
    label: '字符串与编码',
    description: '字节切片加约定，编码显式认领',
    posts: ['zig-strings', 'zig-pointer-family', 'cpython-str-internals'],
  },
  {
    id: 'resharding',
    label: '扩容搬家',
    description: '槽迁数据、REORGANIZE 重排行、取模只改规则三种搬法',
    posts: ['redis-cluster-migration', 'mysql-partitioning', 'kafka-partitions-keys'],
  },

  // ---- Redis 系列 ----
  {
    id: 'async-free',
    label: '异步释放',
    description: '大对象析构移交后台线程',
    posts: ['redis-lazyfree-unlink', 'redis-event-loop'],
  },
  {
    id: 'hash-slots',
    label: '哈希槽分片',
    description: '16384 槽与 MOVED/ASK 两级重定向',
    posts: ['redis-cluster-migration'],
  },
  {
    id: 'key-expiration',
    label: '键过期机制',
    description: '绝对时间戳配惰性与主动两路清理',
    posts: ['redis-key-expiration'],
  },
  {
    id: 'object-encoding',
    label: '对象编码',
    description: '同一类型多种底层实现按大小切换',
    posts: ['redis-object-encoding'],
  },
  {
    id: 'replication',
    label: '主从复制',
    description: 'replid+offset+backlog 判定增量续传',
    posts: ['redis-replication-sync'],
  },
  {
    id: 'sentinel-failover',
    label: '哨兵故障转移',
    description: 'quorum 判定与多数派选主切换',
    posts: ['redis-sentinel-failover'],
  },
  {
    id: 'skiplist',
    label: '跳表',
    description: '概率层高有序链表，期望对数查找',
    posts: ['redis-skiplist-zset'],
  },
  {
    id: 'transaction-cas',
    label: '事务与乐观锁',
    description: 'MULTI 打包隔离，WATCH 弃单式 CAS',
    posts: ['redis-multi-exec-watch'],
  },

  // ---- Zig 系列 ----
  {
    id: 'async-model',
    label: '异步模型',
    description: '无染色函数与 async 删除史',
    posts: ['zig-async-removal'],
  },
  {
    id: 'c-interop',
    label: 'C 互操作',
    description: '跨 ABI 的翻译与所有权规则',
    posts: ['zig-c-interop', 'zig-cc-cross-compilation', 'zig-memory-layout'],
  },
  {
    id: 'comptime',
    label: '编译期求值',
    description: '宏、模板、反射都交给编译期执行',
    posts: ['zig-comptime', 'zig-error-handling', 'zig-build-system', 'zig-strings'],
  },
  {
    id: 'illegal-behavior',
    label: '非法行为',
    description: '四种构建模式与显式语义的边界',
    posts: ['zig-safety-modes', 'zig-undefined', 'zig-integer-overflow', 'zig-testing'],
  },
  {
    id: 'lifetime',
    label: '生命周期与所有权',
    description: '切片只借用不持有，期限靠契约',
    posts: ['zig-slice-lifetime', 'zig-allocator', 'zig-transition-guide'],
  },
  {
    id: 'object-model',
    label: '对象模型',
    description: 'struct 三重身份与接口两副面孔',
    posts: ['zig-object-model', 'zig-async-removal'],
  },
  {
    id: 'pointer-family',
    label: '指针与切片',
    description: '边界、哨兵、可空写进指针类型',
    posts: ['zig-pointer-family', 'zig-c-interop'],
  },
  {
    id: 'result-location',
    label: '结果位置语义',
    description: '类型与位置自外层向内传播',
    posts: ['zig-result-location'],
  },
  {
    id: 'tagged-union',
    label: '标签联合',
    description: '状态只记一遍，穷尽 switch 分派',
    posts: ['zig-tagged-union', 'zig-object-model'],
  },
  {
    id: 'testing',
    label: '测试体系',
    description: 'test 是语法，泄漏与故障注入进测试',
    posts: ['zig-testing'],
  },
  {
    id: 'toolchain',
    label: '构建与交叉编译',
    description: '构建即代码，URL 换哈希',
    posts: ['zig-build-system', 'zig-cc-cross-compilation'],
  },

  // ---- CPython 系列 ----
  {
    id: 'adaptive-specialization',
    label: '自适应特化',
    description: '操作点内联缓存与可撤销 guard',
    posts: ['cpython-adaptive-specialization', 'cpython-dict-internals', 'cpython-attribute-descriptors'],
  },
  {
    id: 'compile-pipeline',
    label: '编译流水线',
    description: 'tokenizer、PEG、symtable 到 CFG',
    posts: ['cpython-compile-pipeline'],
  },
  {
    id: 'coroutine',
    label: '协程与生成器',
    description: '内嵌帧的暂停、send 恢复与驱动',
    posts: ['cpython-generators-await-send', 'cpython-asyncio-task-future-event-loop'],
  },
  {
    id: 'descriptor',
    label: '描述符',
    description: '属性四层仲裁、MRO 与 super',
    posts: ['cpython-attribute-descriptors'],
  },
  {
    id: 'dynamic-array',
    label: '动态数组',
    description: '指针数组、过度分配与均摊搬家',
    posts: ['cpython-list-internals'],
  },
  {
    id: 'eval-loop',
    label: '求值循环',
    description: '执行帧、指令指针与操作数栈',
    posts: ['cpython-frames-eval-loop', 'cpython-generators-await-send'],
  },
  {
    id: 'garbage-collection',
    label: '垃圾回收',
    description: '补引用计数盲区的循环引用回收',
    posts: ['cpython-reference-counting', 'cpython-gc-generations', 'cpython-free-threading'],
  },
  {
    id: 'ieee754',
    label: '浮点表示',
    description: '双精度编码、舍入与 2^53 悬崖',
    posts: ['cpython-float-ieee754'],
  },
  {
    id: 'jit',
    label: '即时编译',
    description: 'micro-op trace 与 copy-and-patch',
    posts: ['cpython-tier2-jit'],
  },
  {
    id: 'pyc-cache',
    label: '字节码缓存',
    description: 'pyc 的 marshal 载荷与新鲜度判定',
    posts: ['cpython-import-pyc'],
  },
  {
    id: 'reference-counting',
    label: '引用计数',
    description: '名字绑定与对象生死的计数账本',
    posts: ['cpython-reference-counting', 'cpython-free-threading'],
  },
  {
    id: 'string-interning',
    label: '字符串驻留',
    description: '单例、编译期与 sys.intern 三套',
    posts: ['cpython-str-internals'],
  },
  {
    id: 'type-slots',
    label: '类型槽分派',
    description: '运算符沿类型槽协商与序列后备',
    posts: ['cpython-type-slots-dispatch'],
  },

  // ---- MySQL 系列 ----
  {
    id: 'innodb-space',
    label: 'InnoDB 空间管理',
    description: '页/区/段三层结构与碎片区到整区的成长',
    posts: ['mysql-innodb-pages-btree', 'mysql-innodb-mvcc', 'mysql-innodb-locks', 'mysql-innodb-buffer-pool-lru', 'mysql-online-ddl', 'mysql-partitioning'],
  },
  {
    id: 'partitioning',
    label: '分区表',
    description: '逻辑表切多个 .ibd，按片删除与归档',
    posts: ['mysql-partitioning'],
  },
  {
    id: 'mdl',
    label: 'MDL 与 DDL 门链',
    description: '元数据锁排队把全表查询拖进等待',
    posts: ['mysql-innodb-locks', 'mysql-online-ddl'],
  },
  {
    id: 'buffer-pool',
    label: '缓冲池与 LRU 变体',
    description: 'young/old 子链、中点插入与三道闸的晋升规则',
    posts: ['mysql-innodb-buffer-pool-lru', 'mysql-innodb-pages-btree', 'mysql-innodb-query-optimizer'],
  },
  {
    id: 'btree',
    label: 'B+ 树',
    description: '矮胖多叉，叶子链表，索引即数据',
    posts: ['mysql-innodb-pages-btree', 'mysql-innodb-query-optimizer'],
  },
  {
    id: 'clustered-index',
    label: '聚簇与二级索引',
    description: '数据住在主键树上，二级索引存主键回表',
    posts: ['mysql-innodb-pages-btree', 'mysql-innodb-query-optimizer'],
  },
  {
    id: 'undo-log',
    label: 'undo 日志与版本链',
    description: '旧值按事务进 undo 表空间，ROLL_PTR 串成链',
    posts: ['mysql-innodb-mvcc', 'mysql-innodb-redo-recovery'],
  },
  {
    id: 'mvcc',
    label: 'MVCC 与快照可见性',
    description: 'ReadView 三规则定隔离级别，purge 收版本链',
    posts: ['mysql-innodb-mvcc', 'mysql-innodb-locks'],
  },
  {
    id: 'row-lock',
    label: '行锁与间隙锁',
    description: '记录/间隙/next-key 三种对象与退化规则',
    posts: ['mysql-innodb-locks'],
  },
  {
    id: 'deadlock',
    label: '死锁',
    description: '等待环、牺牲品挑选与检测/超时双层兜底',
    posts: ['mysql-innodb-locks'],
  },
  {
    id: 'wal',
    label: 'WAL 与崩溃恢复',
    description: '先记日志再改页面，redo 重放 undo 回滚；Kafka 把日志本身做成产品',
    posts: ['mysql-innodb-redo-recovery', 'mysql-binlog-redo-2pc', 'kafka-log-segments'],
  },
  {
    id: '2pc',
    label: '两阶段提交',
    description: 'prepare 落盘在前，binlog 裁决崩溃窗口',
    posts: ['mysql-binlog-redo-2pc', 'mysql-replication-gtid'],
  },
  {
    id: 'cost-model',
    label: '代价模型与口径',
    description: 'cost 按行计价；磁盘页、页访问次数与行数三种口径',
    posts: ['mysql-innodb-query-optimizer', 'mysql-join-algorithms', 'mysql-performance-schema'],
  },
  {
    id: 'observability',
    label: '事件仪器与观测',
    description: '四层事件金字塔与计数器的分辨率分层',
    posts: ['mysql-performance-schema', 'mysql-innodb-query-optimizer'],
  },
  {
    id: 'join-execution',
    label: '连接算法',
    description: '嵌套循环、索引点查与 hash join 的 build/probe 分工',
    posts: ['mysql-join-algorithms', 'mysql-innodb-query-optimizer'],
  },
  {
    id: 'mysql-replication',
    label: '主从复制与 GTID',
    description: 'binlog 前后像重演、GTID 断点续传与半同步窗口',
    posts: ['mysql-replication-gtid'],
  },

  // ---- Linux 内核系列 ----
  {
    id: 'buddy-system',
    label: '伙伴系统',
    description: '物理页按阶管理，伙伴成对合并',
    posts: ['kernel-buddy-allocator'],
  },
  {
    id: 'page-fault',
    label: '缺页异常',
    description: '首次触碰才分配，读落零页写转正',
    posts: ['kernel-primer', 'kernel-page-tables', 'kernel-copy-on-write'],
  },
  {
    id: 'vma',
    label: '虚拟内存区域',
    description: '地址空间按 VMA 记账与合并',
    posts: ['kernel-vma-malloc'],
  },
  // ---- 消息队列系列 ----
  {
    id: 'mq-decouple',
    label: '解耦与异步',
    description: 'RT 与下游脱钩，下游生死不再传染上游',
    posts: ['mq-basics-decouple-async-peak'],
  },
  {
    id: 'mq-pubsub',
    label: '发布订阅',
    description: '一份事实多家各自订阅消费，一堆任务多家竞争分摊',
    posts: ['mq-basics-decouple-async-peak'],
  },
  {
    id: 'exchange',
    label: '交换机与路由',
    description: 'exchange 绑定队列，fanout 不看内容一律转发',
    posts: ['mq-basics-decouple-async-peak'],
  },
  {
    id: 'peak-shaving',
    label: '削峰',
    description: '峰值搬进队列摊平成下游消化得起的平均速率',
    posts: ['mq-basics-decouple-async-peak'],
  },
  {
    id: 'delivery-semantics',
    label: '投递语义',
    description: 'at-most / at-least / exactly-once 三档语义与各自的代价',
    posts: ['mq-basics-delivery-semantics'],
  },
  {
    id: 'dead-letter',
    label: '死信',
    description: '处理不了的消息带着 x-death 头转存到死信队列',
    posts: ['mq-basics-delivery-semantics'],
  },
  {
    id: 'idempotency',
    label: '幂等消费',
    description: '重复投递的解药：去重表、版本与天然幂等',
    posts: ['mq-basics-delivery-semantics'],
  },
  {
    id: 'partition',
    label: '分区',
    description: '哈希定落点：顺序性与并行度的交换单位',
    posts: ['kafka-message-journey', 'kafka-partitions-keys'],
  },
  {
    id: 'partitioner',
    label: '分区器',
    description: 'toPositive(murmur2(key)) 对分区数取模，可手算、跨语言一致',
    posts: ['kafka-partitions-keys'],
  },
  {
    id: 'repartition-rehash',
    label: '加分区重哈希',
    description: '分母变了 key 改落点，历史劈开顺序破，只增不减',
    posts: ['kafka-partitions-keys'],
  },
  {
    id: 'total-order',
    label: '顺序性边界',
    description: '落日志的顺序铁定，写入顺序在重试、多实例、跨分区处漏',
    posts: ['kafka-message-journey', 'kafka-partitions-keys', 'kafka-ordering-boundaries'],
  },
  {
    id: 'inflight-reorder',
    label: '在途翻序',
    description: '多批未确认同时在途，重试与延迟都翻序，幂等可挡',
    posts: ['kafka-ordering-boundaries'],
  },
  {
    id: 'idempotent-producer',
    label: '幂等生产者',
    description: 'kafkajs 每 broker 互斥锁串行化，Java 靠 PID+序列号 broker 卡门',
    posts: ['kafka-ordering-boundaries'],
  },
  {
    id: 'kafka-isr',
    label: 'ISR 与副本',
    description: '花名册记谁跟上了：心跳会话 fence 与落后超时两条除名路径',
    posts: ['kafka-replicas-isr'],
  },
  {
    id: 'high-watermark',
    label: '高水位',
    description: 'ISR 最小 LEO，提交与可读的边界，ack 成功不等于可见',
    posts: ['kafka-replicas-isr'],
  },
  {
    id: 'unclean-election',
    label: 'unclean 选举',
    description: '立陈旧副本上岗：拿实丢 100 条换可用，原副本归队即截断',
    posts: ['kafka-replicas-isr'],
  },
  {
    id: 'acks-durability',
    label: 'acks 与 min.insync',
    description: '等几份回执与花名册底线：拒收和降级的分岔点',
    posts: ['kafka-replicas-isr'],
  },
  {
    id: 'consumer-offset',
    label: '位移',
    description: '消费者的书签：提交到 __consumer_offsets',
    posts: ['kafka-message-journey'],
  },
  {
    id: 'lag',
    label: 'lag',
    description: '读者落后作者的距离：日志末端减提交位移',
    posts: ['kafka-message-journey'],
  },
  {
    id: 'log-segment',
    label: '日志段',
    description: '文件名即 baseOffset，写满滚动，删除的单位',
    posts: ['kafka-log-segments'],
  },
  {
    id: 'sparse-index',
    label: '稀疏索引',
    description: 'offset↔position 路标，二分加短扫',
    posts: ['kafka-log-segments'],
  },
  {
    id: 'retention',
    label: '保留策略',
    description: '按时间/大小截断整段，清理线程周期巡逻',
    posts: ['kafka-log-segments'],
  },
];

export const relatedLinks: RelatedLink[] = [
  { from: 'kernel-page-cache-writeback', to: 'redis-aof-append-fsync', note: 'AOF 三档落内核回写时间线' },
  { from: 'kernel-page-tables', to: 'redis-fork-cow', note: 'fork 页表成本在此落地' },
  { from: 'kernel-copy-on-write', to: 'redis-fork-cow', note: 'THP 放大 COW 说法复核' },
  { from: 'kernel-oom-killer', to: 'redis-fork-cow', note: 'overcommit 建议出处' },
  { from: 'redis-incremental-rehash', to: 'kernel-copy-on-write', note: 'rehash 为写时复制让路' },
  { from: 'cpython-gc-generations', to: 'redis-fork-cow', note: '冻结代减少写时复制页' },
  { from: 'cpython-set-open-addressing', to: 'redis-incremental-rehash', note: '开放寻址对望链地址' },
  { from: 'cpython-list-internals', to: 'redis-object-encoding', note: '动态数组对望 quicklist' },
  { from: 'cpython-import-pyc', to: 'redis-key-expiration', note: '时间戳校验同款软肋' },
  { from: 'zig-transition-guide', to: 'cpython-reference-counting', note: '对照 PyObject 对象头' },
  { from: 'zig-transition-guide', to: 'cpython-object-layout', note: '值语义对照对象头开销' },
  { from: 'zig-transition-guide', to: 'cpython-str-internals', note: '对照 Python 码点计长' },
  { from: 'redis-skiplist-zset', to: 'mysql-innodb-pages-btree', note: '跳表对望 B+ 树：内存盘上各得其所' },
  { from: 'kernel-copy-on-write', to: 'mysql-innodb-mvcc', note: '读不加锁的两条路：复制页 vs 多版本' },
  { from: 'redis-multi-exec-watch', to: 'mysql-innodb-locks', note: 'WATCH 对望行锁：乐观赌与悲观等' },
  { from: 'redis-replication-sync', to: 'mysql-replication-gtid', note: '两个世界的主从：全量 RDB vs 增量 binlog' },
  { from: 'redis-eviction-policy', to: 'mysql-innodb-buffer-pool-lru', note: '近似淘汰对望子链分区：各有一套办法' },
  { from: 'kernel-page-cache-writeback', to: 'mysql-innodb-buffer-pool-lru', note: '内核页缓存与缓冲池：两层的冷热分级' },
  { from: 'redis-aof-append-fsync', to: 'mysql-innodb-buffer-pool-lru', note: '写缓冲推迟落盘的三种档位' },
  { from: 'redis-aof-append-fsync', to: 'mysql-binlog-redo-2pc', note: 'everysec 对望双 1：落盘纪律同题' },
  { from: 'kernel-page-cache-writeback', to: 'mysql-binlog-redo-2pc', note: 'OS 缓存兜底与主机断电的分界' },
  { from: 'mq-basics-decouple-async-peak', to: 'mysql-binlog-redo-2pc', note: '等的是谁：同步链的 2 秒下游，提交链的两次 fsync' },
  { from: 'mq-basics-delivery-semantics', to: 'mysql-binlog-redo-2pc', note: '半途的工作谁说了算：重投兜底与 binlog 裁决' },
  { from: 'mq-basics-delivery-semantics', to: 'mysql-replication-gtid', note: 'GTID 去重与消费幂等：同一道题的两处解法' },
  { from: 'kafka-message-journey', to: 'mysql-replication-gtid', note: '位点与位移：拉日志的两种读者' },
  { from: 'kafka-log-segments', to: 'mysql-innodb-pages-btree', note: '顺序追加与随机 I/O：同一块磁盘的两种用法' },
  { from: 'kafka-partitions-keys', to: 'redis-cluster-migration', note: '扩容两法：搬数据与改规则' },
  { from: 'kafka-partitions-keys', to: 'mysql-partitioning', note: '加分区：MySQL 搬数据，Kafka 劈历史' },
  { from: 'kafka-partitions-keys', to: 'cpython-float-ieee754', note: '2^53 悬崖咬到 murmur2 浮点实现' },
  { from: 'kafka-ordering-boundaries', to: 'mysql-replication-gtid', note: '串行流并行重演也提不了速：同一堵墙' },
  { from: 'kafka-replicas-isr', to: 'mysql-replication-gtid', note: '副本不够时：半同步降级 vs 拒收' },
  { from: 'kafka-replicas-isr', to: 'redis-sentinel-failover', note: '两道多数票 vs 控制器直接指定' },
  { from: 'kafka-replicas-isr', to: 'redis-replication-sync', note: '异步复制与 acks=0：同一姿态两个名字' },
];
