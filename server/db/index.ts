// Barrel export — 公開預約服務只用到 DB connection（不需要其他 db helper）
export { getDb, closeDb, isDatabaseHealthy } from "./connection";
