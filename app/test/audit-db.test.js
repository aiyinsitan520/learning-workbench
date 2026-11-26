import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.js';
import { contextSnapshot, factsHash, reviewHash, reviewMaterial } from '../lib/digest.js';

const day = '2026-11-01';
const zone = 'America/Los_Angeles'; // 25 小时的一天
const start = Date.parse(day + 'T00:00:00-07:00') / 1000;
function fixture(t, path = ':memory:') {
  const wb = openDatabase(path, { timeZone: zone, now: () => start });
  t.after(() => wb.close());
  return wb;
}
const note = { id: 'n', studyDate: day, title: 'title', blocks: [{ id: 'b', kind: 'text', body: 'original' }] };
const focus = { id: 'f', plannedSeconds: 60 };

test('M1 malformed blocks leave the note and revision intact, only [] clears', t => {
  const wb = fixture(t);
  wb.saveDayNote({ note, expectedRevision: null });
  const before = wb.readDayNote(day);
  const exec = wb.db.exec.bind(wb.db);
  let writes = 0;
  wb.db.exec = sql => { if (/BEGIN/i.test(sql)) writes++; return exec(sql); };
  for (const blocks of [undefined, null, {}, '']) {
    assert.throws(() => wb.saveDayNote({ note: { ...note, blocks }, expectedRevision: 0 }), { reason: 'invalid' });
    assert.deepEqual(wb.readDayNote(day), before);
  }
  assert.equal(writes, 0);
  wb.saveDayNote({ note: { ...note, blocks: [] }, expectedRevision: 0 });
  assert.deepEqual(wb.readDayNote(day).blocks, []);
});

for (const action of ['settle', 'pause', 'finish', 'early finish']) {
  test('M2 resumed deadline and elapsed time: ' + action, t => {
    const wb = fixture(t);
    wb.startFocus(focus);
    const change = (action, expectedRevision) => wb.changeFocus({ id: 'f', expectedRevision, action });
    wb.now = () => start + 10;
    change('pause', 0);
    wb.now = () => start + 210;
    change('resume', 1);
    wb.now = () => start + 211;
    assert.deepEqual(wb.settleExpired(), []);
    const early = action === 'early finish';
    wb.now = () => start + (early ? 221 : 300);
    if (action === 'settle') wb.settleExpired();
    else assert.equal(change(early ? 'finish' : action, 2).state, 'finished');
    const [row] = wb.readFocusLog(day);
    assert.equal(row.elapsedSeconds, early ? 21 : 60);
    assert.equal(row.stateChangedAt, start + (early ? 221 : 260));
    assert.equal(row.revision, 3);
    assert.deepEqual(wb.settleExpired(), []);
  });
}

test('M2 finishing after a clock rollback cannot predate the resume', t => {
  const wb = fixture(t);
  wb.startFocus(focus);
  wb.now = () => start + 10;
  wb.changeFocus({ id: focus.id, action: 'pause', expectedRevision: 0 });
  wb.now = () => start + 210;
  wb.changeFocus({ id: focus.id, action: 'resume', expectedRevision: 1 });
  wb.now = () => start + 200;
  wb.changeFocus({ id: focus.id, action: 'finish', expectedRevision: 2 });
  const [row] = wb.readFocusLog(day);
  assert.equal(row.stateChangedAt, start + 210);
  assert.equal(row.elapsedSeconds, 10);
});

test('M3 a WAL writer does not block a view without expired focus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-lock-'));
  try {
    const path = join(dir, 'test.sqlite');
    const wb = openDatabase(path, { now: () => start });
    const peer = new DatabaseSync(path);
    try {
      wb.db.exec('PRAGMA busy_timeout=0');
      wb.startFocus(focus);
      peer.exec('BEGIN IMMEDIATE');
      assert.deepEqual(wb.settleExpired(), []);
      assert.equal(wb.readDay(day).openFocus.id, focus.id);
      peer.exec('ROLLBACK');
      wb.now = () => start + 100;
      const exec = wb.db.exec.bind(wb.db);
      wb.db.exec = sql => {
        // Another connection wins the race between the read check and the write transaction.
        if (sql === 'BEGIN IMMEDIATE') peer.exec("UPDATE focus_sessions SET state='paused', revision=1");
        return exec(sql);
      };
      assert.deepEqual(wb.settleExpired(), []);
      assert.equal(wb.readDay(day).openFocus.state, 'paused');
    } finally { peer.close(); wb.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4 start retries preserve running, paused and finished sessions', t => {
  const wb = fixture(t);
  const result = wb.startFocus(focus);
  assert.deepEqual(wb.startFocus(focus), result);
  assert.throws(() => wb.startFocus({ ...focus, plannedSeconds: 30 }), { reason: 'conflict' });
  assert.throws(() => wb.startFocus({ ...focus, taskId: 'other' }), { reason: 'conflict' });
  assert.throws(() => wb.startFocus({ ...focus, id: 'another' }), { reason: 'conflict' });
  wb.changeFocus({ id: 'f', action: 'pause', expectedRevision: 0 });
  assert.deepEqual(wb.startFocus(focus), result);
  wb.changeFocus({ id: 'f', action: 'finish', expectedRevision: 1 });
  wb.startFocus({ ...focus, id: 'another' });
  assert.deepEqual(wb.startFocus(focus), result);
  assert.equal(wb.readFocusLog(day)[0].revision, 2);
});

test('M5 implicit harvest date survives a retry across midnight', t => {
  const wb = fixture(t);
  const card = { id: 'h', title: 'card' };
  wb.createHarvest(card);
  wb.now = () => start + 25 * 3600;
  assert.deepEqual(wb.createHarvest(card), { ok: true, created: false });
  assert.equal(wb.readHarvest('h').day, day);
  assert.throws(() => wb.createHarvest({ ...card, day: '2026-11-02' }), { reason: 'conflict' });
  assert.throws(() => wb.createHarvest({ ...card, title: 'different' }), { reason: 'conflict' });
});

function seed(wb) {
  const db = wb.db;
  const project = db.prepare('INSERT INTO projects(id,title,start_day,main_task_id,created_at) VALUES(?,?,?,?,?)');
  const task = db.prepare('INSERT INTO tasks(id,title,course,project_id,created_at,completed_at) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 12; i++) {
    project.run('p'+i,'project'+i,'2026-09-01','t'+i,start-500);
    task.run('t'+i,'task'+i,'subject','p'+i,start-200,i%2 ? null : start+10);
  }
  task.run('child','child','日计划','p0',start+1,null);
  db.prepare('INSERT INTO schedule_blocks(id, task_id, starts_at, planned_seconds) VALUES (?,?,?,60)')
    .run('b','child',start+24*3600);
  const session = db.prepare("INSERT INTO focus_sessions(id,task_id,state,planned_seconds,elapsed_seconds,started_at,state_changed_at) VALUES(?,?,'finished',60,45,?,?)");
  for (const [id,taskId,time] of [['old','t0',start-20*86400],['free',null,start-60],['f','child',start]]) {
    session.run(id,taskId,time,time+45);
  }
  for (const date of ['2026-10-01','2026-10-31',day]) wb.saveProjectLog({ projectId:'p0',day:date,note:date });
  wb.now = () => start-86400;
  wb.saveTaskNote('child','old',0);
  wb.now = () => start;
  wb.saveTaskNote('child','old\nnew',1);
  wb.saveDayNote({ note, expectedRevision:null });
  const card = db.prepare('INSERT INTO harvests(id,day,title,todos,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 200; i++) card.run('h'+i, i===0?'2026-10-31':day, 'card'+i,
    JSON.stringify(['child','t0','missing',null].map(taskId => ({text:'todo',taskId}))), 'p0',start,start);
  wb.saveDailyReview({ day:'2026-10-31',factsHash:'older',text:'history' });
}

test('M6 only changes belonging to the reviewed day invalidate its hash', t => {
  const wb = fixture(t);
  seed(wb);
  const read = () => reviewHash(reviewMaterial(wb, day));
  const before = read();
  wb.now = () => start+2*86400;
  wb.createTask({ id:'later', title:'later',projectId:'p0' });
  wb.db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(wb.now(),'child');
  assert.equal(read(), before);
  wb.updateTask({ taskId:'child', title:'renamed later' });
  wb.setProjectState({ projectId:'p0', action:'archive' });
  assert.equal(read(), before);
  wb.saveProjectLog({ projectId:'p0',day,note:'updated' });
  assert.notEqual(read(), before);
});

test('M6 existing legacy review matches until its day changes', t => {
  const wb = fixture(t);
  seed(wb);
  const material = reviewMaterial(wb, day);
  const old = factsHash({ digest: material.digest, notes: material.notes.map(n => [n.taskId,n.added ?? n.body]),
    harvests: material.harvests.map(h => [h.id,h.title,h.conclusion,h.points,h.todos]) });
  wb.db.prepare('INSERT INTO daily_reviews(day,facts_hash,text) VALUES(?,?,?)').run(day,old,'legacy');
  const current = () => reviewHash(reviewMaterial(wb, day));
  assert.equal(wb.readDailyReview(day).factsHash,current());
  wb.createHarvest({ day,id:'new',title:'same-day change' });
  assert.notEqual(wb.readDailyReview(day).factsHash,current());
});

test('M8 calendar keeps the skipped civil day in Pacific/Apia', t => {
  const wb = fixture(t);
  const month = wb.readMonth('2011-12', 'Pacific/Apia');
  assert.equal(month.length, 31);
  assert.equal(month[29].day, '2011-12-30');
  assert.equal(month[29].scheduledBlocks, 0);
});

// SHA-256 of the complete JSON returned by e43a3ae for this deterministic fixture.
// Comparing all serialized fields also catches ordering changes at equal timestamps.
const cases = [
  ['M7 view',20,wb => wb.readDay(day),'72f05945c90ded65b9473376e16666a2fe470a50db4855b92525e573dea5cf44'],
  ['M7 harvest',10,wb => wb.readHarvests({ limit:200 }),'e8a323244827bb51a1cb8667a79fe4802336228c89b0493743167fce3529bbbd'],
  ['M7 review',50,wb => reviewMaterial(wb,day),'76d0b7358df88058216794862bf9a39684c892360b8fd95f0ddcde577bf76238'],
  ['M7 context',100,wb => contextSnapshot(wb,{ endDay:day,days:14,includeNotes:true }),'513a86de0328e0e637d538678b7f10278bce514ee4aa682ad86c86546ca32213'],
  ['M8 month',1,wb => wb.readMonth('2026-11'),'35e35fc27f584b1c2660b34f1a7dddb1cf84292c8fed1ec133d8ce5d36643531'],
];
for (const [name,limit,read,expected] of cases) {
  test(name+' preserves baseline fields and bounds SQL prepares', t => {
    const wb = fixture(t);
    seed(wb);
    const prepare = wb.db.prepare.bind(wb.db);
    let count = 0;
    wb.db.prepare = sql => { count++; return prepare(sql); };
    const actual = createHash('sha256').update(JSON.stringify(read(wb))).digest('hex');
    assert.equal(actual,expected);
    assert.ok(count<=limit, name+' prepared '+count+' SQL statements (limit '+limit+')');
  });
}
