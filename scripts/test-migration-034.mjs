import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const mig034 = fs.readFileSync(
  path.resolve('supabase/migrations/034_atomic_draft_lock_index_and_pin_ratelimit.sql'),
  'utf8'
);

// 1. Matching REGEXP_REPLACE expression index & ANALYZE
assert.match(
  mig034,
  /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_quiz_submissions_code_norm_name_class\s+ON\s+public\.quiz_submissions\s*\(/i,
  'Expected idx_quiz_submissions_code_norm_name_class index creation'
);
assert.match(
  mig034,
  /LOWER\(REGEXP_REPLACE\(TRIM\(COALESCE\(student_name,\s*''\)\),\s*'\\s\+',\s*' ',\s*'g'\)\)/i,
  'Expected index expression to match REGEXP_REPLACE student_name predicate from 031'
);
assert.match(
  mig034,
  /public\.normalize_roster_class_label\(student_class\)/i,
  'Expected index to include normalize_roster_class_label(student_class)'
);
assert.match(
  mig034,
  /ANALYZE\s+public\.quiz_submissions\s*;/i,
  'Expected ANALYZE public.quiz_submissions'
);

// 2. Atomic save_student_exam_draft lock acquisition & schema safety
const draftFnMatch = mig034.match(
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.save_student_exam_draft\([\s\S]*?\$\$;[\s\S]*?GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.save_student_exam_draft\([^\)]*\)\s+TO\s+anon,\s*authenticated;/i
);
assert.ok(draftFnMatch, 'Expected save_student_exam_draft function and EXECUTE grant');
const draftFn = draftFnMatch[0];

assert.match(draftFn, /INTERVAL '10 minutes'/i, 'Expected 10-minute lock-write skip');
assert.match(
  draftFn,
  /ON\s+CONFLICT\s*\(draft_key\)\s+DO\s+UPDATE[\s\S]*?WHERE\s+public\.exam_draft_locks\.owner_token_hash\s*=\s*EXCLUDED\.owner_token_hash[\s\S]*?INTERVAL '24 hours'[\s\S]*?RETURNING\s+TRUE\s+INTO\s+v_lock_acquired/i,
  'Expected atomic conditional ON CONFLICT ... WHERE ... RETURNING TRUE INTO v_lock_acquired'
);
assert.match(
  draftFn,
  /IF\s+NOT\s+COALESCE\(v_lock_acquired,\s*FALSE\)\s+THEN\s+RETURN\s+FALSE;/i,
  'Expected FALSE return when lock acquisition fails under concurrent contention'
);
const appConfigStmt = draftFn.match(/INSERT\s+INTO\s+public\.app_config[\s\S]*?;/i)?.[0] || '';
assert.ok(appConfigStmt.length > 0, 'Expected app_config INSERT statement');
assert.doesNotMatch(
  appConfigStmt,
  /updated_at/i,
  'Must never reference app_config.updated_at'
);

// 3. Class-normalized verify_student_pin & EXECUTE grant
const pinFnMatch = mig034.match(
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.verify_student_pin\([\s\S]*?\$\$;[\s\S]*?GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.verify_student_pin\([^\)]*\)\s+TO\s+anon,\s*authenticated;/i
);
assert.ok(pinFnMatch, 'Expected verify_student_pin function and EXECUTE grant');
const pinFn = pinFnMatch[0];

assert.match(
  pinFn,
  /v_clean_class\s+TEXT\s*:=\s*public\.normalize_roster_class_label\(p_class\)/i,
  'Expected verify_student_pin to normalize p_class via normalize_roster_class_label'
);
assert.match(
  pinFn,
  /v_scope\s+TEXT\s*:=\s*'student_pin:'\s*\|\|\s*v_clean_name\s*\|\|\s*'::'\s*\|\|\s*v_clean_class/i,
  'Expected rate-limit v_scope to use normalized v_clean_class'
);

console.log('PASS: Migration 034 verification checks passed (all assertions satisfied).');
