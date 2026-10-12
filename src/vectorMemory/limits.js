// 向量记忆的数值边界与默认值：**唯一真源**（零依赖，vectorMemory/* 与 storage/* 都可直接 import）。
//
// 为什么单独成文件：同一组数字此前在三个地方各手抄一份——
//   · providers.js 目录项（batchSize / timeoutMs）、
//   · vectorMemory/index.js 的 DEFAULT_*（归一化兜底 + xhrPostJson 的 defaultTimeoutMs）、
//   · storage/vector.js 的兜底字面量（设置页载荷的归一化）。
// 改一处忘两处就漂移，而漂移的后果是「设置页存的 batchSize 与真正发请求时用的 batchSize
// 不是同一个数」这类只有真机跑起来才看得见的错位。做法照两处先例：src/memory/memoryConstants.js
// （无依赖独立模块，供 prompt 层与存储层共用）与 src/tts/providers.js（声明表即单一来源）。
//
// 只收「曾经手抄多份」的数值。DEFAULT_MAX_TOTAL_CHARS / DEFAULT_MIN_SCORE 只在
// vectorMemory/index.js 内使用（单份），留在原地，不在这里制造第二层间接。
//
// ⚠️ 这里只放上限与默认值本身，**不放夹取规则**：夹取仍写在各调用点，因为两处语义不同——
// index.js 对 batchSize 在「未知 provider」时回落到默认值、已知时回落到目录项；
// storage/vector.js 只回落默认值。把夹取也搬进来会让这条差异被藏起来。
//
// ⚠️ 本模块**不得**引入任何 import：它被 storage/vector.js 间接依赖，保持零依赖才能保证
// 那条既有边（storage/vector.js → vectorMemory/providers.js）不会因新增文件而闭环
// （scripts/guard-structure.mjs 的循环依赖检查盯着这件事）。
export const VECTOR_TOP_K_MAX = 20;
export const VECTOR_TOP_K_DEFAULT = 5;
export const VECTOR_MAX_CHARS_MAX = 2000;
export const VECTOR_MAX_CHARS_DEFAULT = 400;
export const VECTOR_BATCH_SIZE_MAX = 64;
export const VECTOR_BATCH_SIZE_DEFAULT = 16;
export const VECTOR_TIMEOUT_MS_DEFAULT = 30000;
