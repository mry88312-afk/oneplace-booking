/** Explicitly authorized allowlist transfer. Never log values or raw errors. */
import { parse } from 'dotenv';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = process.argv[2];
if (!source) throw new Error('Pass the approved source environment file');
try {
  let values = parse(readFileSync(source === '--stdin' ? 0 : source));
  if (process.argv.includes('--staged-json')) {
    values = Object.fromEntries(readFileSync(source, 'utf8').trim().split('\n').map(line => {
      const at = line.indexOf('=');
      const value = line.slice(at + 1);
      return [line.slice(0, at), value.startsWith('"') ? JSON.parse(value) : value];
    }));
  }
  if (process.argv.includes('--zeabur')) {
    const token = values.ZEABUR_COMPANY_TOKEN;
    if (!token) throw new Error('No approved company API token');
    const response = await fetch('https://api.zeabur.com/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query { service(_id: "68ef04f8a21c40597899e7dd") { variables(environmentID: "68ef04edb2a6ab999f05f6b3", exposed: true) { key value } } }' }),
    });
    const data = await response.json();
    if (!response.ok || data.errors || !Array.isArray(data.data?.service?.variables)) {
      console.log(`ZEABUR_READ_BLOCKED: HTTP ${response.status}, API error=${Boolean(data.errors)}`);
      process.exit(2);
    }
    values = Object.fromEntries(data.data.service.variables.map((entry: { key: string; value: string }) => [entry.key, entry.value]));
  }
  const keys = ['BOOKING_DATABASE_URL', 'BOOKING_DATABASE_CA', 'BOOKING_DATASET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'];
  console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, Boolean(values[key])]))));
  if (!values.BOOKING_DATABASE_URL || !values.BOOKING_DATASET_ID || !values.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log('STAGING_BLOCKED: required source settings missing');
    process.exitCode = 2;
  } else {
    const db = new URL(values.BOOKING_DATABASE_URL);
    const matchesProject = db.hostname.includes('dwoahbduwzfzqmwpvadj') || decodeURIComponent(db.username).endsWith('.dwoahbduwzfzqmwpvadj');
    if (!matchesProject) throw new Error('Wrong database project');
    // Only the new trial uses a persistent session, so READ ONLY cannot affect
    // another service through a transaction pooler's recycled backend.
    if (db.hostname.endsWith('.pooler.supabase.com') && db.port === '6543') {
      db.port = '5432';
      values.BOOKING_DATABASE_URL = db.toString();
      console.log('TRIAL_SESSION_POOLER: 5432 (original service unchanged)');
    }
    JSON.parse(values.GOOGLE_SERVICE_ACCOUNT_JSON);
    mkdirSync('.cache', { recursive: true });
    const lines = keys.filter(key => values[key]).map(key => {
      if (values[key].includes("'")) throw new Error('Unsupported quote in environment value');
      return `${key}='${values[key]}'`;
    });
    const roundTrip = parse(lines.join('\n'));
    for (const key of keys.filter(key => values[key])) assert.equal(roundTrip[key], values[key]);
    writeFileSync('.cache/trial.env', [...lines, 'BOOKING_MIGRATION_TRIAL=true', 'BOOKING_WRITES_ENABLED=false', ''].join('\n'), { mode: 0o600 });
    console.log('STAGING_OK: intended OnePlace database, allowlisted settings only');
  }
} catch {
  console.error('STAGING_BLOCKED: source settings unavailable or invalid (values suppressed)');
  process.exitCode = 2;
}
