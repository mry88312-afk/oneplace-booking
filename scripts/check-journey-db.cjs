// 正式容器內執行；專用角色真實連線，測試寫入全部回滾，不輸出租客與秘密。
const {Client}=require('/app/node_modules/pg');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
async function main(){
  const url=new URL(process.env.BOOKING_DATABASE_URL);
  for(const k of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(k);
  const db=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.BOOKING_DATABASE_CA?{ca:process.env.BOOKING_DATABASE_CA.replace(/\\n/g,'\n')}:{})},statement_timeout:10000});
  const id=randomUUID();
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("INSERT INTO booking.journey_links(id,line_uid) VALUES($1,'U00000000000000000000000000000000')",[id]);
    assert.equal((await db.query("SELECT line_uid FROM booking.journey_links WHERE id=$1 AND created_at>now()-interval '180 days'",[id])).rowCount,1);
  } finally {await db.query('ROLLBACK');assert.equal((await db.query('SELECT id FROM booking.journey_links WHERE id=$1',[id])).rowCount,0);await db.end();}
  const mirror=new Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false},statement_timeout:10000});
  await mirror.connect();
  try {
    await mirror.query(`SELECT DISTINCT t.primary_name AS name,p.short_name AS property,u.unit_no AS room,c.end_date::text
      FROM contract.tenants t LEFT JOIN contract.tenant_contract_parties pa ON pa.tenant_id=t.id
      LEFT JOIN contract.tenant_contracts c ON c.id=pa.tenant_contract_id AND c.deleted_at IS NULL
      LEFT JOIN property.properties p ON p.id=c.property_id LEFT JOIN property.units u ON u.id=c.unit_id
      WHERE t.line_uid=$1 AND t.deleted_at IS NULL ORDER BY end_date DESC NULLS LAST LIMIT 30`,['U00000000000000000000000000000000']);
  } finally {await mirror.end();}
  console.log('BOOKING 專用角色讀寫及租客查詢通過；測試資料已回滾。');
}
main().catch(e=>{console.error('驗證失敗',e.code||e.name);process.exitCode=1;});
