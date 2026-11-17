import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { claimOutreach } from "./claimOutreach";

// Only explicitly provisioned disposable Postgres; never use the production DB URL.
test("two concurrent workers, a restart, and an accidental status reset still claim exactly once",
  { skip: !process.env.HUB_FIXTURE_PG }, async t => {
    const url = process.env.HUB_FIXTURE_PG!;
    if (new URL(url).hostname !== "fixture-db" || new URL(url).pathname !== "/fixture") throw Error("fixture DB only");
    const pool = new Pool({connectionString:url}); t.after(() => pool.end());
    await pool.query(`create schema outreach;
      create table outreach.settings (id int, test_redirect_uid text);
      create table outreach.schedule (id text primary key, status text, vars jsonb, suppressed_reason text,
        last_error text, last_attempt_at timestamptz, attempt_count int, updated_at timestamptz,sent_at timestamptz);
      insert into outreach.schedule(id,status) values ('a','confirmed'),('b','confirmed');`);
    const query = async (sql:string,params:string[]) => (await pool.query(sql,params)).rows;
    const attempts = await Promise.all(Array.from({length:12},()=>claimOutreach("a",query)));
    assert.equal(attempts.filter(Boolean).length,1);
    assert.equal(await claimOutreach("a",query),false,"worker crashed after submitting the card");
    await pool.query("update outreach.schedule set status='confirmed' where id='a'");
    assert.equal(await claimOutreach("a",query),false,"manual edit cannot replay ambiguous card");
    assert.equal((await pool.query("select attempt_count from outreach.schedule where id='a'")).rows[0].attempt_count,1);
    await pool.query("insert into outreach.settings values(1,'owner-test')");
    assert.equal(await claimOutreach("b",query),false,"test mode enabled during dispatch");
  });
