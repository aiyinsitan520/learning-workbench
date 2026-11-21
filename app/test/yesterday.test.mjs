import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { dayRange, localDateOf, shiftDate } from '../lib/time.js';
import { launch } from './browser.mjs';

test('昨日看板：本地模板、日期边界、AI 失败与生成、缓存和 PNG 下载', async t => {
  const tz = 'Asia/Taipei';
  const app = await start({dbPath:':memory:',timeZone:tz});
  t.after(() => { app.server.closeAllConnections(); return new Promise(resolve => app.server.close(resolve)); });
  const wb = app.workbench;
  const yesterday = shiftDate(localDateOf(wb.now(), tz), -1);
  const range = dayRange(yesterday, tz);
  const page = await launch({url:app.url, timeZone:tz});
  t.after(() => page.close());
  const read = () => page.evaluate("const {yesterdayReview}=await import('/js/review-data.js');return yesterdayReview();");
  assert.equal((await read()).facts.day,yesterday);
  assert.equal((await read()).facts.completed.length,0);
  for (const [id,title,at] of [['a','整理采样笔记',range.start],['b','今天完成',range.end]]) {
    wb.createTask({id,title});
    wb.db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(at,id);
  }
  wb.saveTaskNote('a','私人正文',0);
  wb.saveSchedule({block:{id:'slot',taskId:'a', startsAt:range.start+900,plannedSeconds:600}});
  const data = await read();
  assert.deepEqual(data.facts.completed,['整理采样笔记']);
  assert.equal(data.facts.scheduled,1);
  assert.equal(data.facts.sessions,0);
  assert.ok(!JSON.stringify(data).includes('私人正文'));
  await page.evaluate(`
    const original = window.fetch;
    window.reviewRequests = [];
    window.fetch = async (url, init) => {
      if (url !== 'https://api.deepseek.com/chat/completions') return original(url,init);
      window.reviewRequests.push(JSON.parse(init.body));
      return window.reviewRequests.length === 1 ? new Response('',{status:401}) :
        Response.json({choices:[{message:{content:'昨天你整理了采样笔记。'}}]});
    };
  `);
  const open = async () => {
    await page.waitFor('document.querySelector("#tools [data-page=review]")');
    await page.click('#tools [data-page=review]');
    await page.waitFor('document.querySelector(".review-page canvas")?.width > 300');
  };
  await open();
  assert.equal(await page.evaluate("return window.reviewRequests.length;"),0);
  assert.match(await page.evaluate('return document.querySelector("canvas").ariaLabel;'), /整理采样笔记/);
  await page.click('.review-ai summary');
  await page.type('.review-ai input','placeholder');
  await page.click('.review-ai button');
  await page.waitFor('document.querySelector(".review-status").textContent.includes("无效")');
  await page.click('.review-ai button');
  await page.waitFor('document.querySelector(".review-status").textContent.includes("已生成")');
  const requests = await page.evaluate('return window.reviewRequests;');
  assert.equal(requests.length,2);
  assert.match(JSON.stringify(requests), /整理采样笔记/);
  assert.doesNotMatch(JSON.stringify(requests), /私人正文|今天完成|placeholder/);
  await page.goto(app.url);
  await open();
  assert.equal(await page.evaluate('return document.querySelector(".review-ai input").value;'),'');
  assert.match(await page.evaluate('return document.querySelector("canvas").ariaLabel;'),/昨天你整理了采样笔记/);
  await page.setViewport(390,800);
  assert.ok(await page.evaluate('return document.documentElement.scrollWidth <= innerWidth;'));
  const downloads = await mkdtemp(join(tmpdir(),'yesterday-png-'));
  try {
    await page.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    await page.click('[data-export]');
    const path = join(downloads,yesterday+'-昨日总结.png');
    let png;
    for (let i=0; i<120 && !png; i++) {
      png = await readFile(path).catch(() => null);
      if (!png) await new Promise(resolve => setTimeout(resolve,75));
    }
    assert.equal(png?.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),1520);
  } finally { await rm(downloads,{recursive:true,force:true}); }
  assert.deepEqual(page.pageErrors,[]);
});
