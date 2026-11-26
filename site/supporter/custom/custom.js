import {FEATURE_DEFINITIONS, FEATURE_SECTIONS} from '../plan-features.js';

let session=null;
let items=[];
let plannedItems=[];
let contract=null,paymentUrl='';
const $=id=>document.getElementById(id);
const STATUS_LABELS={submitted:'受付済み',estimating:'見積もり中',answered:'回答あり',accepted:'申込み済み',consulting:'ご相談中',objected:'異議あり',withdrawn:'取り下げ',closed:'終了'};
const WANT_LABELS={yes:'○',maybe:'△',no:'—'};
const MARK_LABELS={yes:'○',partial:'△',no:'—'};
const PLAN_LABELS={supporter:'Basic',plus:'Plus',pro:'Pro'};

async function api(path,method='GET',body){
 const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json','x-reuse-csrf':session?.csrfToken||''},body:body?JSON.stringify(body):undefined});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.message||`操作に失敗しました（HTTP ${response.status}）。`);
 return data;
}
function setStatus(message){$('status').textContent=message||'';}
function formatDate(value){if(!value)return '—';const date=new Date(Number(value)*1000);return Number.isNaN(date.getTime())?String(value):new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short'}).format(date);}
function countValue(id){const value=$(id).value;return value===''?null:Number(value);}
function allDefinitions(){
 const known=new Set(FEATURE_DEFINITIONS.map(item=>item.name));
 return [...FEATURE_DEFINITIONS,...plannedItems.filter(item=>!known.has(item.name)).map(item=>({name:item.name,label:item.label||'準備中の機能',section:'planned',plan:'custom',requires:[],note:item.note||'',planned:true}))];
}
function sectionTitle(section){if(section==='planned')return '準備中の画像配信';return FEATURE_SECTIONS.find(([key])=>key===section)?.[1]||section;}
function featureHint(item){
 const parts=[item.plan==='supporter'?'常に含まれます':item.plan==='custom'?'個別相談':`${PLAN_LABELS[item.plan]}に含まれます`];
 if(item.requires?.length)parts.push(`※${item.requires.map(name=>FEATURE_DEFINITIONS.find(def=>def.name===name)?.label||name).join(' または ')}と一緒に`);
 if(item.note)parts.push(item.note);
 return parts.join(' ／ ');
}
function createChoices(name,value='no',disabled=false){
 const group=document.createElement('div');group.className='choice-group';group.dataset.choice=name;
 for(const [key,label] of Object.entries(WANT_LABELS)){
  const button=document.createElement('button');button.type='button';button.dataset.value=key;button.textContent=`${label} ${key==='yes'?'必要':key==='maybe'?'できれば':'不要'}`;button.disabled=disabled;
  button.setAttribute('aria-pressed',String(key===value));button.addEventListener('click',()=>{for(const other of group.children)other.setAttribute('aria-pressed','false');button.setAttribute('aria-pressed','true');});group.append(button);
 }
 return group;
}
function renderFeatureForm(request={}){
 const roots={regular:$('feature-form'),planned:$('planned-form')};for(const root of Object.values(roots))root.replaceChildren();
 const definitions=allDefinitions();$('planned-block').hidden=!definitions.some(item=>item.planned);
 for(const section of [...FEATURE_SECTIONS.map(([key])=>key),'planned']){
  const list=definitions.filter(item=>item.section===section);if(!list.length)continue;
  const container=document.createElement('section');container.className='feature-section';const heading=document.createElement('h3');heading.textContent=sectionTitle(section);container.append(heading);
  for(const item of list){
   const row=document.createElement('div');row.className='feature-row';row.dataset.feature=item.name;
   const copy=document.createElement('div');copy.className='feature-copy';const strong=document.createElement('strong');strong.textContent=item.label;const small=document.createElement('small');small.textContent=featureHint(item);copy.append(strong,small);
   const basic=item.plan==='supporter';const choices=createChoices(item.name,basic?'yes':request.wants?.[item.name]||'no',basic);
   const note=document.createElement('input');note.type='text';note.className='feature-note';note.maxLength=80;note.placeholder='備考（任意）';note.value=request.wantNotes?.[item.name]||'';row.append(copy,choices,note);container.append(row);
  }
  (section==='planned'?roots.planned:roots.regular).append(container);
 }
}
function collectRequest(){
 const wants={},wantNotes={};for(const row of document.querySelectorAll('[data-feature]')){const name=row.dataset.feature;const selected=row.querySelector('[aria-pressed="true"]');wants[name]=selected?.dataset.value||'no';const note=row.querySelector('.feature-note').value.trim();if(note)wantNotes[name]=note;}
 return {email:$('email').value.trim(),contact:$('contact').value.trim(),budget:$('budget').value.trim(),servers:countValue('servers'),channels:countValue('channels'),rules:countValue('rules'),wants,wantNotes,request:$('request-text').value.trim()};
}
function resetForm(){
 $('request-form').reset();$('request-id').value='';$('request-revision').value='0';$('servers').value='1';$('channels').value='2';$('rules').value='5';$('submit-request').textContent='ご要望を送信';$('cancel-edit').hidden=true;renderFeatureForm();updateFormVisibility();
}
// 進行中（受付済み・見積もり中・回答あり）のご要望があるあいだは新しく送れない（サーバーも断る）ので、入力欄は編集のときだけ出す
let requestsEnabled=true;
const ACTIVE_STATUSES=new Set(['submitted','estimating','answered']);
function updateFormVisibility(){
 const editing=!!$('request-id').value,active=items.some(item=>ACTIVE_STATUSES.has(item.status));
 // 運営が契約を用意しているあいだも、入力欄は出さない（確定内容を先に見せる）
 $('request-section').hidden=!requestsEnabled||((active||!!contract)&&!editing);
}
function editItem(item){
 const request=item.request||{};$('request-id').value=item.id;$('request-revision').value=String(item.revision||0);
 for(const key of ['email','contact','budget','servers','channels','rules'])$(key).value=request[key]??'';$('request-text').value=request.request||'';renderFeatureForm(request);$('submit-request').textContent='変更を保存';$('cancel-edit').hidden=false;updateFormVisibility();$('request-section').scrollIntoView({behavior:'smooth',block:'start'});
}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function summary(request,answer){
 const dl=el('dl','summary-grid');const rows=[['メールアドレス',request.email||'—'],['ご予算',request.budget||'未記入'],['金額の目安',answer?.amount||'—'],['サーバー',answer?.servers??request.servers??'—'],['チャンネル',answer?.channels??request.channels??'—'],['ルール',answer?.rules??request.rules??'—']];
 for(const [term,value] of rows){const box=document.createElement('div');box.append(el('dt','',term),el('dd','',String(value)));dl.append(box);}return dl;
}
function featureTable(item){
 const request=item.request||{},answer=item.answer||{},confirmed=Boolean(item.answer);const wrap=el('div','feature-table-wrap');const table=el('table','feature-table');const thead=document.createElement('thead');const head=document.createElement('tr');
 for(const label of ['機能','含まれる標準プラン','ご希望',...(confirmed?['提供']:[]),'備考'])head.append(el('th','',label));thead.append(head);const tbody=document.createElement('tbody');
 const names=new Set([...Object.keys(request.wants||{}),...Object.keys(answer.marks||{}),...FEATURE_DEFINITIONS.filter(def=>def.plan==='supporter').map(def=>def.name)]);
 for(const definition of allDefinitions().filter(def=>names.has(def.name))){const tr=document.createElement('tr');const requested=definition.plan==='supporter'?'yes':request.wants?.[definition.name]||'no';tr.append(el('th','',definition.label),el('td','',definition.plan==='custom'?'個別相談':PLAN_LABELS[definition.plan]||'—'),el('td','mark',WANT_LABELS[requested]||'—'));if(confirmed)tr.append(el('td','mark',MARK_LABELS[answer.marks?.[definition.name]||'no']||'—'));const notes=[request.wantNotes?.[definition.name]&&`ご希望：${request.wantNotes[definition.name]}`,confirmed&&answer.notes?.[definition.name]&&`運営：${answer.notes[definition.name]}`].filter(Boolean).join('\n');tr.append(el('td','',notes||'—'));tbody.append(tr);}
 table.append(thead,tbody);wrap.append(table);return wrap;
}
function printInfo(rows){
 const dl=el('dl','print-info print-block');
 for(const [term,value] of rows){const box=document.createElement('div');box.append(el('dt','',term),el('dd','',String(value??'—')));dl.append(box);}
 return dl;
}
// 書類には、希望した機能と提供される機能だけを 1 つの表で載せる（全機能を並べると長くなるため）
function printFeatureTable(item){
 const request=item.request||{},answer=item.answer;const table=el('table','print-table print-features');const thead=document.createElement('thead');const head=document.createElement('tr');
 for(const label of ['種類','機能名','含まれる標準プラン','ご希望',...(answer?['提供']:[]),'備考'])head.append(el('th','',label));thead.append(head);const tbody=document.createElement('tbody');
 // 有料プランの一覧と同じく、種類ごとに行をまとめて左端に種類を出す
 const order=id=>{const i=FEATURE_SECTIONS.findIndex(([key])=>key===id);return i<0?99:i;};
 const rows=allDefinitions().filter(definition=>(definition.plan==='supporter'?'yes':request.wants?.[definition.name]||'no')!=='no'||(answer?.marks?.[definition.name]||'no')!=='no').sort((a,b)=>order(a.section)-order(b.section));
 rows.forEach((definition,index)=>{
  const requested=definition.plan==='supporter'?'yes':request.wants?.[definition.name]||'no';const mark=answer?.marks?.[definition.name]||'no';
  const kind=sectionTitle(definition.section);
  const standardPlan=definition.planned?'準備中':PLAN_LABELS[definition.plan]||'—';
  const notes=[request.wantNotes?.[definition.name]&&`ご希望：${request.wantNotes[definition.name]}`,answer?.notes?.[definition.name]&&`提供：${answer.notes[definition.name]}`].filter(Boolean).join('／')||'—';
  const tr=document.createElement('tr');
  if(index===0||sectionTitle(rows[index-1].section)!==kind){let span=1;while(rows[index+span]&&sectionTitle(rows[index+span].section)===kind)span++;const th=el('th','print-kind',kind);th.scope='rowgroup';th.rowSpan=span;tr.append(th);}
  tr.append(el('th','',definition.label),el('td','',standardPlan),el('td','print-mark',`${WANT_LABELS[requested]||'—'} ${requested==='yes'?'必要':requested==='maybe'?'できれば':'不要'}`),...(answer?[el('td','print-mark',MARK_LABELS[mark]||'—')]:[]),el('td','',notes));tbody.append(tr);
 });
 if(!tbody.children.length){const tr=document.createElement('tr');const td=el('td','','ご希望の機能はありません。');td.colSpan=answer?6:5;tr.append(td);tbody.append(tr);}
 table.append(thead,tbody);return table;
}
function printAnswer(item){
 const answer=item.answer;if(!answer)return null;const section=el('section','print-block print-answer');section.append(el('h2','','運営の回答'));
 section.append(printInfo([['金額の目安',answer.amount||'—'],['メモ',answer.memo||'—']]));
 return section;
}
function buildPrintDocument(item){
 const root=$('print-document');const request=item.request||{};root.replaceChildren();
 root.append(el('h1','','カスタムプラン ご要望書（控え）'));
 root.append(printInfo([['ご要望番号',item.id],['受付日',formatDate(item.createdAt)],['更新日',formatDate(item.updatedAt)],['印刷日',new Intl.DateTimeFormat('ja-JP',{dateStyle:'long'}).format(new Date())]]));
 root.append(printInfo([['お名前',request.contact||'未記入'],['メールアドレス',request.email||'—'],['ご予算',request.budget||'未記入'],['サーバー数',request.servers??'—'],['チャンネル数',request.channels??'—'],['ルール数',request.rules??'—']]));
 const features=el('section','print-block print-features-section');features.append(el('h2','','ご希望の機能'),printFeatureTable(item));root.append(features);
 const free=el('section','print-block print-free');free.append(el('h2','','そのほかのご要望'),el('p','',request.request||'記入なし'));root.append(free);
 const answer=printAnswer(item);if(answer)root.append(answer);
 root.append(el('p','print-notice','この書類は控えです。契約・請求は運営が確定するまで発生しません。'));
}
function updatePrintSelection(){
 const select=$('print-request');const selected=select.value;select.replaceChildren();
 for(const item of items){const option=document.createElement('option');option.value=String(item.id);option.textContent=`ご要望 ${item.id}`;select.append(option);}
 if(items.some(item=>String(item.id)===selected))select.value=selected;
 const unavailable=items.length===0;select.disabled=unavailable;$('print').disabled=unavailable;
 if(unavailable){const option=document.createElement('option');option.value='';option.textContent='ご要望がありません';select.append(option);}
}
function printSelectedRequest(){
 const item=items.find(candidate=>String(candidate.id)===$('print-request').value);
 if(!item){setStatus('印刷するご要望を選んでください。');return;}
 buildPrintDocument(item);window.print();
}
function actionButton(label,className,handler){const button=el('button',className,label);button.type='button';button.addEventListener('click',handler);return button;}
async function decide(item,decision,message=''){
 if(decision==='withdraw'&&!confirm('このご要望を取り下げますか？'))return;
 try{await api(`/api/supporter/custom-requests/${encodeURIComponent(item.id)}/decision`,'POST',{decision,revision:item.revision,message});setStatus(decision==='accept'?'この内容で申し込みました。':decision==='object'?'異議の申し出を受け付けました。運営からご連絡します。':'ご連絡を受け付けました。');await loadRequests();}catch(error){setStatus(error.message);}
}
function renderItem(item){
 const request=item.request||{},answer=item.answer||{};const card=el('article','request-card');card.dataset.status=item.status;
 const head=el('div','request-card-head');const title=el('h3','',`ご要望 ${item.id}`);const badge=el('span',`status-badge ${item.status}`,STATUS_LABELS[item.status]||item.status);head.append(title,badge);card.append(head,el('p','meta',`受付：${formatDate(item.createdAt)} ／ 更新：${formatDate(item.updatedAt)}`),el('h4','document-title',item.answer?'カスタムプラン 最終確認書':'カスタムプラン ご要望書'),summary(request,answer),featureTable(item));
 const free=el('section','request-notes');free.append(el('h4','','そのほかのご要望'),el('p','',request.request||'記入なし'));card.append(free);
 if(item.answer){const confirmation=el('section','confirmation-box');confirmation.append(el('h4','','運営の確認'),el('p','',`作成者：${answer.estimator||'—'}\n金額の目安：${answer.amount||'—'}\nサーバー：${answer.servers??'—'} ／ チャンネル：${answer.channels??'—'} ／ ルール：${answer.rules??'—'}\nメモ：${answer.memo||'—'}`));card.append(confirmation);}
 if(item.status==='submitted'){const row=el('div','button-row screen-only');row.append(actionButton('ご要望を編集','secondary-btn',()=>editItem(item)),actionButton('取り下げ','withdraw-btn',()=>decide(item,'withdraw')));card.append(row);}
 if(item.status==='answered'){
  const panel=el('section','decision-panel screen-only');panel.append(el('strong','','運営の回答を確認してお選びください。'));const message=el('textarea','decision-message');message.rows=3;message.maxLength=500;message.placeholder='相談したい内容を一言ご記入ください。';const actions=el('div','decision-actions');actions.append(actionButton('この内容で申し込む','primary-btn',()=>decide(item,'accept')),actionButton('相談したい','secondary-btn',()=>{if(!message.value.trim()){message.focus();setStatus('相談内容を一言ご記入ください。');return;}decide(item,'consult',message.value.trim());}),actionButton('取り下げ','withdraw-btn',()=>decide(item,'withdraw')));panel.append(message,actions);card.append(panel);
 }
 if(item.status==='accepted'){
  card.append(el('p','accepted-note',contract?'運営が契約を用意しました。上の「運営が確定した契約内容」をご確認ください。':'運営が契約を用意したら、このページと有料プランの画面からお支払いできます。'));
  // 確定内容や回答に納得できないときは、理由を添えて異議を申し出られる
  const panel=el('section','decision-panel screen-only');panel.append(el('strong','','内容に異議がある場合'));const message=el('textarea','decision-message');message.rows=3;message.maxLength=500;message.placeholder='異議の内容（どの点が、どう違うか）をご記入ください。';
  const actions=el('div','decision-actions');actions.append(actionButton('異議を申し出る','withdraw-btn',()=>{if(!message.value.trim()){message.focus();setStatus('異議の内容をご記入ください。');return;}if(!confirm('異議を申し出ますか？運営が内容を確認してご連絡します。'))return;decide(item,'object',message.value.trim());}));panel.append(message,actions);card.append(panel);
 }
 if(item.decisionMessage&&['consulting','objected'].includes(item.status))card.append(el('p','accepted-note',`${item.status==='objected'?'異議の内容':'ご相談の内容'}：${item.decisionMessage}`));
 return card;
}
// 運営が確定した契約（カスタムプラン）。提示中なら支払いへの案内を出す
function renderContract(){
 const root=$('contract');if(!root)return;root.replaceChildren();root.hidden=!contract;if(!contract)return;
 const sections=new Map(FEATURE_SECTIONS);const labels=new Map(FEATURE_DEFINITIONS.map(item=>[item.name,`${sections.get(item.section)||''}：${item.label}`]));
 root.append(el('h2','','運営が確定した契約内容'));
 const dl=el('dl','summary-grid');for(const [term,value] of [['プラン名',contract.name||'カスタムプラン'],['月額',`${Number(contract.monthlyYen||0).toLocaleString('ja-JP')}円`],['サーバー',contract.servers],['チャンネル',contract.channels],['ルール',contract.rules]]){const box=el('div');box.append(el('dt','',term),el('dd','',String(value)));dl.append(box);}root.append(dl);
 const list=el('ul','contract-features');for(const name of contract.features||[])list.append(el('li','',labels.get(name)||name));root.append(el('h3','','含まれる機能'),list);
 if(contract.status==='offered'){root.append(el('p','accepted-note','お支払いが完了すると契約が始まります。'));if(paymentUrl){const pay=document.createElement('a');pay.className='primary-btn screen-only';pay.href=paymentUrl;pay.textContent='お支払いへ進む（有料プランの画面）';root.append(pay);}}
 else root.append(el('p','accepted-note','この内容で契約中です。'));
}
function renderItems(){renderContract();const root=$('items');root.replaceChildren();if(!items.length)root.append(el('p','empty-list','まだ送信したご要望はありません。'));else for(const item of items)root.append(renderItem(item));updatePrintSelection();$('items-section').hidden=false;}
async function loadRequests(){const data=await api('/api/supporter/custom-requests');plannedItems=Array.isArray(data.plannedItems)?data.plannedItems:[];items=Array.isArray(data.items)?data.items:[];contract=data.contract||null;paymentUrl=typeof data.paymentUrl==='string'&&data.paymentUrl.startsWith('/')?data.paymentUrl:'';$('preparing').hidden=data.enabled!==false;requestsEnabled=data.enabled!==false;if(!$('request-id').value)renderFeatureForm();renderItems();updateFormVisibility();}
async function initialize(){
 $('print').addEventListener('click',printSelectedRequest);$('cancel-edit').addEventListener('click',resetForm);
 $('request-form').addEventListener('submit',async event=>{event.preventDefault();if(!$('request-form').reportValidity())return;const id=$('request-id').value;const body={request:collectRequest()};const method=id?'PUT':'POST';if(id)body.revision=Number($('request-revision').value);$('submit-request').disabled=true;try{await api(id?`/api/supporter/custom-requests/${encodeURIComponent(id)}`:'/api/supporter/custom-requests',method,body);setStatus(id?'ご要望を更新しました。':'ご要望を送信しました。');resetForm();await loadRequests();}catch(error){setStatus(error.message);}finally{$('submit-request').disabled=false;}});
 try{session=await api('/api/reuse/session');if(!session.authenticated){$('user').textContent='Discordログインが必要です。';setStatus('このページの利用にはDiscordログインが必要です。');return;}$('user').textContent=session.user?.username||'ログイン済み';$('login-link').hidden=true;await loadRequests();}catch(error){setStatus(error.message);}
}
initialize();

