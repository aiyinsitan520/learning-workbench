const $ = s => document.querySelector(s);
const paths = {
 book:'M3 4q5-1 9 2 4-3 9-2v15q-5-1-9 2-4-3-9-2z M12 6v15',
 home:'M3 3h8v8H3z M14 3h7v5h-7z M3 14h8v7H3z M14 11h7v10h-7z',
 calendar:'M3 6h18v15H3z M7 3v6 M17 3v6 M3 11h18', focus:'M9 2h6 M12 5a8 8 0 1 0 .1 0 M12 9v5l3 1',
 notes:'M5 3h14v18H5z M9 3v18 M12 8h4 M12 12h4', flow:'M8 2h8v5H8z M2 16h7v5H2z M15 16h7v5h-7z M12 7v5 M5.5 16v-4h13v4',
 activity:'M3 19V9 M9 19V4 M15 19v-7 M21 19V6', folder:'M3 6h6l2 3h10v11H3z',
 paw:'M7 14q5-8 10 0 4 6-1 6-4-2-8 0-5 0-1-6z M3 10l1 2 M8 5l1 3 M15 5l-1 3 M20 10l-1 2',
 play:'M7 4l12 8-12 8z', edit:'M4 16L16 4l4 4L8 20l-5 1z M13 7l4 4', bulb:'M9 16c0-3-4-4-4-8a7 7 0 0 1 14 0c0 4-4 5-4 8z M9 19h6 M10 22h4', clock:'M12 3a9 9 0 1 0 .1 0 M12 7v6l4 2'
};
const icon = name => '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="'+paths[name]+'"/></svg>';
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const esc = value => String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const pages={home:'今日工作台',calendar:'日历',focus:'番茄钟',notes:'学习笔记',flow:'学习流程',activity:'学习统计'};
let tasks=[
 {id:1,name:'画出采样前后的频谱',course:'通信原理',min:25,at:'14:00',short:'采样与频谱'},
 {id:2,name:'整理泰勒公式例题',course:'高等数学',min:40,at:'16:00',short:'泰勒公式'},
 {id:3,name:'整理电路实验数据',course:'电路基础',min:30},
 {id:4,name:'预习线性空间',course:'线性代数',min:20},
 {id:5,name:'阅读英文摘要',course:'学术英语',min:15},
 {id:6,name:'复习欧拉公式',course:'高等数学',min:25,done:true,at:'09:00',end:'09:25',short:'欧拉公式'},
 {id:7,name:'复习 20 个英语单词',course:'大学英语',min:20,done:true,at:'10:30',end:'10:50',short:'英语词汇'}
];
let current='home',selected=1,nextId=8,note='采样会让原信号的频谱周期性重复。先画原频谱，再标出每份频谱的中心。\n待确认：采样频率降低时，相邻两份频谱从哪里开始重叠？',noteTitle='采样以后，频谱去了哪里？';
let cards=[{type:'question',label:'难点卡',title:'为什么会出现频谱混叠？',body:'试着画出采样频率减半后的频谱。'},{type:'process',label:'流程卡',title:'频谱绘图步骤',body:'画原谱　→　标周期　→　检查重叠'}];
let remaining=1500, deadline=0, bound=null, finished=false, focusCount=2, focusedMinutes=45,dragFrom=null;
const get=id=>tasks.find(t=>t.id===id);
const selectedTask=()=>get(selected);
function notify(msg){$('#toast').textContent=msg;$('#toast').className='on';clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#toast').className='',1800)}
function modal(html){$('#dialogBody').innerHTML=html;$('#dialog').showModal()}
function closeDialog(){$('#dialog').close()}
function sidebars(){
 const pending=tasks.filter(t=>!t.done), completed=tasks.filter(t=>t.done);
 $('#count').textContent=pending.length; $('#doneCount').textContent=completed.length;
 $('#pending').innerHTML=[true,false].map(scheduled=>{
  const group=pending.filter(t=>!!t.at===scheduled);
  return '<section class="taskgroup"><div class="group"><b>'+(scheduled?'已安排':'待安排')+'</b><span>'+group.length+'</span></div>'+group.map(t=>'<div class="task '+(selected===t.id?'active':'')+'"><button class="check" data-complete="'+t.id+'" aria-label="完成'+esc(t.name)+'"></button><div><button class="tasktitle" data-task="'+t.id+'">'+esc(t.name)+'</button><div class="meta"><span class="course">'+esc(t.course)+'</span>· '+(t.at||'待排期')+' · '+t.min+' 分钟</div></div></div>').join('')+'</section>';
 }).join('');
 $('#tools').innerHTML=Object.entries(pages).map(([key,label])=>'<button class="tool '+(current===key?'selected':'')+'" data-page="'+key+'" aria-pressed="'+(current===key)+'">'+icon(key)+label+'</button>').join('');
 const pct=Math.round(completed.length/tasks.length*100);
 $('#percent').textContent=pct+'%';$('#progress').style.width=pct+'%';
 $('#done').innerHTML=completed.map(t=>'<div class="doneitem"><button data-undo="'+t.id+'" title="撤销完成" aria-label="撤销完成'+esc(t.name)+'">✓</button><div><b>'+esc(t.name)+'</b><small>'+esc(t.course)+(t.end?' · '+esc(t.end)+' 完成':' · 刚刚完成')+'</small></div></div>').join('');
 $('#minutes').textContent=focusedMinutes;$('#sessions').textContent=focusCount;
}
function taskDialog(id){
 const t=get(id);
 modal('<div class="cardlabel">'+esc(t.course)+'</div><h2>'+esc(t.name)+'</h2><p class="soft">预计 '+t.min+' 分钟</p><div class="dialogrow"><label>安排到今天 <input type="time" id="at" value="'+(t.at||'15:00')+'"></label><button class="light" id="saveTime">保存</button></div>'+(t.done?'':'<div class="dialogrow"><button class="primary" id="selectTask">让贾维斯喵陪我学这项</button></div>'));
 $('#saveTime').onclick=()=>{if(!$('#at').value)return;t.at=$('#at').value;closeDialog();draw();notify('已更新时间线')};
 if($('#selectTask'))$('#selectTask').onclick=()=>{selected=id;closeDialog();gotoPage('home')};
}
function spectrum(){
 return '<figure class="spectrum"><figcaption>频谱草图<small>采样后的周期延拓</small></figcaption><svg viewBox="0 0 400 65" role="img" aria-label="三个三角形频谱副本，中心分别位于负采样频率、零和正采样频率"><path d="M5 44h385m-7-4 7 4-7 4 M200 46V6" fill="none" stroke="#899cae"/><path d="M33 43l37-30 37 30zm260 0 37-30 37 30z" fill="#dfebf5" stroke="#86a5c0" stroke-width="1.6"/><path d="M163 43l37-30 37 30z" fill="#c3d8f1" stroke="#4876ab" stroke-width="1.9"/><g fill="#566e85" font-family="Georgia,serif" font-size="13" text-anchor="middle"><text x="70" y="61">−fₛ</text><text x="200" y="61">0</text><text x="330" y="61">fₛ</text><text x="396" y="47">f</text></g></svg></figure>';
}
function notebook(){return '<article class="notebook"><div class="notehead"><span class="cardlabel">'+icon('notes')+'课堂笔记</span><span class="soft">'+icon('edit')+' 点击正文编辑</span></div><div class="notepage"><h3 contenteditable="plaintext-only" id="noteTitle" aria-label="笔记标题">'+esc(noteTitle)+'</h3><div contenteditable="plaintext-only" class="noteedit" id="note" aria-label="笔记正文">'+esc(note)+'</div>'+(current==='home'?spectrum():'')+'</div></article>'}
function cardHTML(card,i){return '<article class="studycard '+card.type+'" draggable="true" data-index="'+i+'"><button class="grip" data-move="'+i+'" title="调整卡片顺序" aria-label="调整卡片顺序">⠿</button><div class="cardlabel">'+icon(card.type==='question'?'bulb':'flow')+esc(card.label)+'</div><h3>'+esc(card.title)+'</h3><p>'+esc(card.body)+'</p></article>'}
const scheduled=()=>tasks.filter(t=>t.at).sort((a,b)=>a.at.localeCompare(b.at));
function home(){
 const t=get(bound)||selectedTask(), canFocus=!!bound||(t&&!t.done);
 return '<div class="subhead"><h2>今日时间线</h2><small>'+scheduled().length+' 个安排</small></div><div class="timeline">'+scheduled().map(t=>'<button class="slot '+(t.done?'past':t.id===selected?'next':'')+'" data-task="'+t.id+'"><time>'+t.at+'</time><i></i><span>'+esc(t.short||t.name)+'</span></button>').join('')+'</div><section class="hero"><div class="copy"><div class="byline">'+icon('paw')+' 贾维斯喵管家</div><h2>'+(canFocus?(bound?'本轮专注，':'下一步，')+esc(t.name)+'。':'今天的任务都完成了。')+'</h2><p>'+(canFocus?'留出 25 分钟，我陪你专心做这一件事。':'把今天最值得记住的发现写下来吧。')+'</p><div class="actions">'+(canFocus?'<button class="primary" data-action="start">'+icon('play')+(bound?'回到专注':'开始专注')+'</button><button class="link" data-action="choose">换个任务</button>':'<button class="primary" data-page="notes">整理笔记</button>')+'</div></div><img src="desk.png" alt="白猫贾维斯喵伏在学习笔记旁"></section><div class="subhead"><h2>我的学习手记</h2><button class="light" data-action="addCard">＋ 添加内容</button></div>'+notebook()+'<div class="cards">'+cards.map(cardHTML).join('')+'</div>';
}
function timerLabel(){const sec=deadline?Math.max(0,Math.ceil((deadline-Date.now())/1000)):remaining;return String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0')}
function focusPage(){
 const task=get(bound)||selectedTask();
 return '<div class="focusart"><div class="byline">'+icon('paw')+' 贾维斯喵陪伴中</div><img src="desk.png" alt="贾维斯喵与学习手记"><h2>'+esc(task?.name||'自由专注')+'</h2><div class="clock" id="clock">'+timerLabel()+'</div><p class="soft">'+(finished?'本轮专注已记入学习记录':deadline?'计时中 · 可以切回手记继续写':'给这项任务留出一段完整的时间')+'</p><div class="actions"><button class="primary" data-action="toggle">'+(deadline?'暂停计时':finished?'再专注一轮':bound?'继续专注':'开始 25 分钟')+'</button>'+(bound&&!finished?'<button class="light" data-action="end">结束并记录</button>':'')+'</div></div><div class="subhead"><h2>随手记</h2></div>'+notebook();
}
function otherPage(){
 if(current==='notes')return notebook();
 if(current==='flow')return '<div class="sheet"><span class="cardlabel">'+icon('flow')+' 通信原理</span><h2>频谱绘图步骤</h2>'+['画出原始信号的频谱，标记最高频率。','以采样频率为间隔，标出每份频谱的中心。','检查相邻频谱是否重叠，并记录结论。'].map((s,i)=>'<div class="listrow"><b>'+(i+1)+'</b>'+s+'</div>').join('')+'</div>';
 if(current==='activity')return '<div class="sheet"><h2>11 月 20 日学习统计</h2><div class="listrow">累计专注 <strong>'+focusedMinutes+' 分钟</strong></div><div class="listrow">已记录 <strong>'+focusCount+' 次专注</strong></div><div class="listrow">任务完成 <strong>'+tasks.filter(t=>t.done).length+' / '+tasks.length+'</strong></div></div>';
 return '<div class="sheet"><h2>2026 年 11 月</h2><div class="cal">'+[...'一二三四五六日',...Array(6).fill(''),...Array.from({length:30},(_,i)=>i+1)].map(d=>'<span class="'+(d===20?'sel':'')+'">'+d+'</span>').join('')+'</div></div><div class="sheet"><h3>11 月 20 日的安排</h3>'+scheduled().map(t=>'<div class="listrow"><time>'+t.at+'</time><button data-task="'+t.id+'">'+esc(t.name)+'</button></div>').join('')+'</div>';
}
function draw(){sidebars();$('#main').innerHTML='<div class="topline"><h1>'+pages[current]+'</h1><span class="datecode">Nov. 20</span></div>'+(current==='home'?home():current==='focus'?focusPage():otherPage())}
const scrolls={};
function gotoPage(page){scrolls[current]=window.scrollY;current=page;draw();window.scrollTo(0,scrolls[page]||0)}
function choose(){modal('<h2>想先学哪一项？</h2>'+tasks.filter(t=>!t.done).map(t=>'<div class="listrow"><button data-choose="'+t.id+'">'+esc(t.name)+'</button></div>').join(''))}
function addCard(){modal('<h2>添加学习卡片</h2><form id="cardForm"><div class="dialogrow"><select id="type" aria-label="卡片类型"><option>难点卡</option><option>流程卡</option><option>思考卡</option></select><input required maxlength="50" id="ct" aria-label="卡片标题" placeholder="标题"></div><div class="dialogrow"><input id="cb" maxlength="120" placeholder="记下一个想法…" aria-label="卡片内容"><button class="primary">添加</button></div></form>');$('#cardForm').onsubmit=e=>{e.preventDefault();const title=$('#ct').value.trim();if(!title)return;cards.push({label:$('#type').value,type:$('#type').value==='流程卡'?'process':'question',title,body:$('#cb').value});closeDialog();draw()}}
function start(){if(!bound||finished){bound=selected;remaining=1500;finished=false}deadline=Date.now()+remaining*1000;draw()}
function finish(){const left=deadline?Math.max(0,Math.ceil((deadline-Date.now())/1000)):remaining;focusedMinutes+=Math.floor((1500-left)/60);focusCount++;remaining=0;deadline=0;bound=null;finished=true;draw();notify('已记录本轮专注')}
$('#newTask').onsubmit=e=>{e.preventDefault();const name=$('#newTitle').value.trim();if(!name)return;const t={id:nextId++,name,course:'自选学习',min:25};tasks.push(t);if(!selected)selected=t.id;$('#newTitle').value='';draw();notify('已加入待安排任务')};
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;const d=b.dataset;
 if(d.page)return gotoPage(d.page);
 if(d.task)return taskDialog(+d.task);
 if(d.choose){selected=+d.choose;closeDialog();gotoPage('home');return}
 if(d.complete||d.undo){const t=get(+(d.complete||d.undo));t.done=!!d.complete;if(!selectedTask()||selectedTask().done)selected=tasks.find(t=>!t.done)?.id;draw();return}
 if(d.move!=null){if(cards.length<2)return;const i=+d.move;cards.splice((i+1)%cards.length,0,cards.splice(i,1)[0]);draw();return}
 if(d.action==='choose'){if(bound)notify('结束本轮专注后即可更换任务');else choose()}if(d.action==='addCard')addCard();
 if(d.action==='start'){gotoPage('focus');if(!bound)start()}
 if(d.action==='toggle'){if(deadline){remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));deadline=0;draw()}else start()}
 if(d.action==='end')finish();
});
$('#main').addEventListener('input',e=>{if(e.target.id==='note')note=e.target.innerText;if(e.target.id==='noteTitle')noteTitle=e.target.innerText});
$('#main').addEventListener('dragstart',e=>{const card=e.target.closest('[data-index]');if(card){dragFrom=+card.dataset.index;e.dataTransfer.setData('text/plain',String(dragFrom))}});
$('#main').addEventListener('dragover',e=>{if(e.target.closest('[data-index]'))e.preventDefault()});
$('#main').addEventListener('drop',e=>{const to=e.target.closest('[data-index]');if(!to||dragFrom===null)return;e.preventDefault();cards.splice(+to.dataset.index,0,cards.splice(dragFrom,1)[0]);dragFrom=null;draw()});
$('#main').addEventListener('dragend',()=>{dragFrom=null});
setInterval(()=>{if(!deadline)return;if(Date.now()>=deadline)return finish();if($('#clock'))$('#clock').textContent=timerLabel()},250);
draw();
