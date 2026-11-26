import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './browser.mjs';
import { start } from '../server.js';

const timeZone = 'Asia/Shanghai';
let app;
let page;
let dayStart;
const js = (source) => page.evaluate(source);
const selector = (css) => `document.querySelector(${JSON.stringify(css)})`;
const read = (css, expression) => js(`const e = ${selector(css)}; return ${expression};`);
const wait = (expression) => page.waitFor(expression);
const tasks = () => page.click('[data-sidebar-view="tasks"]');
const plan = () => page.click('[data-sidebar-view="plan"]');
const add = '[data-plan-add]';
const scheduled = () => js('return __wbState.view.scheduled.map(({id, taskId, startsAt, plannedSeconds}) => ({id, taskId, startsAt, plannedSeconds}));');

before(async () => { page = await launch({ timeZone }); });
beforeEach(async () => {
  app = await start({ port: 0, dbPath: ':memory:', timeZone, islandLauncher: null });
  await page.setViewport(1440, 900);
  await page.goto(app.url);
  await wait('window.__wbState?.view');
  dayStart = await js('return __wbState.view.range.start;');
  await page.click('[data-tour-later]');
});
afterEach(async () => {
  await page.goto('about:blank');
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
});
after(async () => { await page?.close(); });

function seedTask(id, title = id) { app.workbench.createTask({ id, title }); }
function seedBlock(id, taskId, minutes, duration) {
  const block = { id, taskId, startsAt: dayStart + minutes * 60, plannedSeconds: duration * 60 };
  app.workbench.saveSchedule({ block });
  return block;
}
async function reload() {
  await page.goto(app.url);
  await wait('window.__wbState?.view && document.querySelector("[data-plan-hour]")');
}
async function details(id = '目标') {
  await tasks();
  await page.click(`#pending [data-task-note="${id}"]`);
  await page.click('#taskEditorDetails');
}
async function mouse(x, y, button = 'left') {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button,
      buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
  }
}
async function point(css) {
  return js(`const e = ${selector(css)}; e.scrollIntoView({block:'center', behavior:'instant'});
    const r = e.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2];`);
}
async function press(key, code, vk) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
  }
}

test('B01 同名标签可区分，点选 ID 经改时长后仍写到正确待办', async () => {
  seedTask('one', '同名'); seedTask('two', '同名');
  await reload();
  await page.click(add);
  const chips = await js("return [...document.querySelectorAll('[data-plan-pick]')].map(e => [e.dataset.planPick,e.innerText]);");
  const [id] = chips[1];
  await page.click(`[data-plan-pick="${id}"]`);
  await page.click('[data-plan-minutes="15"]');
  const pressed = await read('[data-plan-pick][aria-pressed="true"]', 'e.dataset.planPick');
  await page.click('#planForm [type=submit]');
  await wait('__wbState.view.scheduled.length === 1');
  assert.equal((await scheduled())[0].taskId, id);
  assert.equal(pressed, id);
  assert.notEqual(chips[0][1], chips[1][1]);
  await page.click(add);
  await page.click(`[data-plan-pick="${id}"]`);
  await page.type('#planTitle', '新的事项');
  await page.click('#planForm [type=submit]');
  await wait('__wbState.view.scheduled.length === 2');
  assert.ok((await scheduled()).some(b => !['one','two'].includes(b.taskId)));
});

test('B02 空格激活聚焦的按钮，弹窗阻止数字、N、空格穿透', async () => {
  await page.click('#tools [data-page=focus]');
  await js("document.querySelector('#fontToggle').focus();");
  const initial = await read('#fontToggle', "e.getAttribute('aria-pressed')");
  await press(' ', 'Space', 32);
  assert.notEqual(await read('#fontToggle', "e.getAttribute('aria-pressed')"), initial);
  assert.equal(await js('return __wbState.view.openFocus;'), null);
  await page.click('#helpBtn');
  await js("document.querySelector('#dialog .close').focus();");
  const results = await js(`return ['2','n',' '].map(key => {
    const ev = new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true});
    document.activeElement.dispatchEvent(ev);
    return [ev.defaultPrevented,__wbState.page];
  });`);
  assert.deepEqual(results, Array(3).fill([false,'focus']));
});

test('B03 连翻两个月，延迟返回的上月响应不会覆盖最新日历', async () => {
  await page.click('#tools [data-page=calendar]');
  await wait('__wbState.monthDays.length');
  await js(`const original = fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes('/api/month') && !window.releaseOldMonth) {
        await new Promise(resolve => { window.releaseOldMonth = resolve; });
      }
      return response;
    };`);
  await page.click('[data-month="1"]');
  await wait('window.releaseOldMonth');
  await page.click('[data-month="1"]');
  await wait('__wbState.monthDays[0].day.startsWith(__wbState.month)');
  await js('releaseOldMonth(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));');
  assert.equal(await js('return __wbState.monthDays[0].day.slice(0,7);'), await js('return __wbState.month;'));
});

test('B04 手机点击待办后编辑器顶部可见并避开粘性顶栏', async () => {
  seedTask('另一项'); seedTask('目标');
  await reload(); await page.setViewport(390, 844); await tasks();
  const target = '#pending [data-task-note="目标"]';
  await mouse(...await point(target));
  await wait("document.querySelector('#taskEditorTitle')?.innerText === '目标'");
  await page.waitFor(`(() => {
    const top = document.querySelector('#taskEditor').getBoundingClientRect().top;
    const bar = document.querySelector('header').getBoundingClientRect().bottom;
    return top >= bar - 1 && top < innerHeight / 2;
  })()`, {timeout: 2500});
});

test('B05 一分钟时间块保留刻度和时长，中心及扩展区域可打开指定任务', async () => {
  seedTask('短任务'); seedTask('其他');
  seedBlock('tiny','短任务',600,1);
  await reload(); await tasks(); await page.click('#pending [data-task-note="其他"]'); await plan();
  const css = '[data-block="tiny"]';
  const [x,y] = await point(css);
  const metrics = await read(css, `(() => {
    const r=e.parentElement.getBoundingClientRect(), x=r.x+r.width/2;
    let hits=0;
    for(let y=Math.ceil(r.top)-24;y<r.bottom+24;y++) if(document.elementFromPoint(x,y)===e) hits++;
    return {height:r.height,hits,top:e.parentElement.style.top};
  })()`);
  await mouse(x,y);
  assert.equal(await page.text('#taskEditorTitle'),'短任务');
  assert.ok(metrics.height >= 12 && metrics.hits >= 24, JSON.stringify(metrics));
  assert.equal(metrics.top,'192px');
  assert.equal((await scheduled())[0].plannedSeconds,60);
});

test('B06 早于 06:00 提示并保留历史排期，06:00 可保存', async () => {
  seedTask('目标'); const original = seedBlock('legacy','目标',300,30);
  await reload(); await details();
  assert.equal(await read('#at','e.value'),'05:00');
  await page.type('#at','05:59'); await page.click('#saveTime');
  assert.equal(await read('#dialog','e.open'),true);
  assert.match(await page.text('#dialogBody'),/日计划从 06:00 开始，请选 06:00 之后/);
  assert.deepEqual(await scheduled(),[original]);
  await page.type('#at','06:00'); await page.click('#saveTime');
  await wait(`__wbState.view.scheduled[0].startsAt === ${dayStart + 21600}`);
});

test('B07 右键删除时间块后，从提示条撤销可恢复原记录', async () => {
  seedTask('目标'); const original = seedBlock('slot','目标',600,37);
  await reload();
  await mouse(...await point('[data-block=slot]'),'right');
  await wait('document.querySelector("[role=menuitem]")');
  await js("Array.from(document.querySelectorAll('[role=menuitem]')).find(e => e.innerText.includes('删除时间块')).click();");
  await wait('__wbState.view.scheduled.length === 0');
  assert.equal(await page.text('#toast button'),'撤销');
  await mouse(...await point('#toast button'));
  await wait('__wbState.view.scheduled.length === 1');
  assert.deepEqual(await scheduled(),[original]);
  await details();
  await page.click('[data-removeblock=slot]');
  await wait('document.querySelector("#toast button")');
  await js('await new Promise(resolve => setTimeout(resolve, 3500));');
  assert.equal(await page.text('#toast button'),'撤销');
  await page.waitFor('!document.querySelector("#toast button")', {timeout:4500});
  assert.deepEqual(await scheduled(),[]);
});

test('B08 空时间不能提交，提示显示且焦点回到时间字段', async () => {
  seedTask('目标'); await reload(); await details();
  await page.type('#at',''); await page.click('#saveTime');
  assert.deepEqual(await read('#at','[e.required, e.validity.valid, document.activeElement===e, !!e.validationMessage]'),[true,false,true,true]);
  assert.equal(await read('#dialog','e.open'),true);
  assert.deepEqual(await scheduled(),[]);
});

test('B09 空库也能从灵动岛开始 25 分钟自由专注', async () => {
  await page.click('#islandMain');
  assert.equal(await read('#islandAct','e.disabled'),false);
  await page.click('#islandAct');
  await wait('__wbState.view.openFocus');
  assert.deepEqual(await js('const f=__wbState.view.openFocus; return [f.taskId,f.plannedSeconds,f.state];'),[null,1500,'running']);
});

// 验证实际命中（包括透明伪元素），不把相邻控件或被遮盖区域算入尺寸。
async function hasTouchSquare(css) {
  await point(css);
  return read(css,`(() => {
    const r=e.getBoundingClientRect();
    const hit=(x,y)=> document.elementFromPoint(x,y)===e;
    for(let x=Math.ceil(r.left)-12;x<=r.right;x++){
      for(let y=Math.ceil(r.top)-24;y<=r.bottom;y++){
        if([0,11,23].every(dx => [0,11,23].every(dy => hit(x+dx,y+dy)))) return true;
      }
    }
    return false;
  })()`);
}
test('B10 完成框、两端拖柄和字体按钮都有至少 24×24 的实际命中区', async () => {
  seedTask('目标'); seedBlock('regular','目标',600,60); seedBlock('short','目标',680,1);
  await reload(); await tasks();
  for (const css of ['#pending .check','#fontToggle',
    '[data-resize-plan-start=regular]','[data-resize-plan=regular]',
    '[data-resize-plan-start=short]','[data-resize-plan=short]']) {
    assert.equal(await hasTouchSquare(css),true,css);
  }
});

test('B11 六套皮肤的完成按钮、保存提示、新任务占位文字均达到 4.5:1', async (t) => {
  seedTask('目标'); await reload(); await tasks(); await page.click('#pending .tasktitle');
  for (const skin of ['candy','mint','latte','mocha','nord','rose']) {
    const ratios = await js(`document.documentElement.dataset.skin=${JSON.stringify(skin)};
      await new Promise(resolve => setTimeout(resolve, 260));
      const ctx=document.createElement('canvas').getContext('2d');
      const luminance=color=>{
        ctx.fillStyle=color; ctx.fillRect(0,0,1,1);
        const [r,g,b]=Array.from(ctx.getImageData(0,0,1,1).data,c=>{
          const v=c/255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
        });
        return .2126*r+.7152*g+.0722*b;
      };
      return Object.fromEntries(['#taskEditorDone','#taskNoteStatus','#newTitle'].map(css=>{
        const e=document.querySelector(css);
        const color=getComputedStyle(e,css==='#newTitle'?'::placeholder':null).color;
        let bg=e;
        while(bg && getComputedStyle(bg).backgroundColor==='rgba(0, 0, 0, 0)')bg=bg.parentElement;
        const a=luminance(color), b=luminance(getComputedStyle(bg).backgroundColor);
        return [css,(Math.max(a,b)+.05)/(Math.min(a,b)+.05)];
      }));`);
    t.diagnostic(`${skin} 完成 / 保存 / 占位 ${Object.values(ratios).map(v => v.toFixed(2)).join(' / ')}`);
    for(const [css,ratio] of Object.entries(ratios)) assert.ok(ratio>=4.5,`${skin} ${css}: ${ratio.toFixed(2)}`);
  }
});

test('B12 未编辑可点遮罩关闭，手动选择或输入后保留草稿，Esc 返回触发按钮', async () => {
  seedTask('目标'); await reload();
  const open = async () => { await mouse(...await point(add)); await wait('document.querySelector("#dialog").open'); };
  await open(); await mouse(5,5);
  assert.equal(await read('#dialog','e.open'),false);
  assert.equal(await read(add,'document.activeElement===e'),true);
  for(const change of [()=>page.type('#planTitle','草稿'),()=>page.click('[data-plan-minutes="15"]'),()=>page.click('[data-plan-pick]')]) {
    await open(); await change(); await mouse(5,5);
    assert.equal(await read('#dialog','e.open'),true);
    await press('Escape','Escape',27);
    assert.equal(await read(add,'document.activeElement===e'),true);
  }
});

test('今日工作台三种宽度在奶糖、摩卡夜下没有横向溢出', async () => {
  seedTask('目标'); seedBlock('tiny','目标',600,1); await reload();
  for(const skin of ['candy','mocha']){
    await js(`document.documentElement.dataset.skin=${JSON.stringify(skin)};`);
    for(const width of [1440,1024,390]){
      await page.setViewport(width,900);
      assert.equal(await js('return document.documentElement.scrollWidth <= innerWidth;'),true,`${skin} ${width}px`);
    }
  }
});
