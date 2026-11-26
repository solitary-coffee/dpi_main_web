import {FEATURE_DEFINITIONS,featureLabel,missingFeatureDependency,withBasicFeatures} from './plan-features.js';
import {activeCustomPlanConfirmation,customPlanEstimate,customPlanValidationError,newCustomPlanConfirmation,sendCustomPlan,stripeCheckoutUrl} from './custom-plan-api.js';

let requests=[];
let current=null;
let plannedItems=[];// 準備中の画像配信（日本語名はサーバーの定義を使う）
let contractAccount=null;
let contractRequestId='';
let contractSaved=false;
const $=id=>document.getElementById(id);
const STATUS_LABELS={submitted:'受付済み',estimating:'見積もり中',answered:'回答あり',accepted:'申込み済み',consulting:'ご相談中',objected:'異議あり',withdrawn:'取り下げ',closed:'終了'};
const WANT_LABELS={yes:'○',maybe:'△',no:'—'};
const MARK_LABELS={yes:'○',partial:'△',no:'—'};
const PLAN_LABELS={supporter:'Basic',plus:'Plus',pro:'Pro',custom:'準備中'};

async function api(path,method='GET',body){const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`操作に失敗しました（HTTP ${response.status}）。`);return data;}
function setStatus(message,type=''){const node=$('global-status');node.className=`status${message?` ${type||'info'}`:''}`;node.textContent=message||'';}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function formatDate(value){if(!value)return '—';const date=new Date(Number(value)*1000);return Number.isNaN(date.getTime())?String(value):new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short'}).format(date);}
function formatDateOnly(value){const date=value instanceof Date?value:new Date(Number(value)*1000);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Tokyo'}).format(date);}// 書類の狭い欄で折り返さない 2026/11/26 形式
function unwrap(data){return data.item||data.request||data;}
function definitions(item){const names=new Set([...Object.keys(item.request?.wants||{}),...Object.keys(item.answer?.marks||{})]);const known=new Set(FEATURE_DEFINITIONS.map(def=>def.name));return [...FEATURE_DEFINITIONS.filter(def=>names.has(def.name)||def.plan==='supporter').map(def=>({...def,label:featureLabel(def.name)})),...[...names].filter(name=>!known.has(name)).map(name=>({name,label:plannedLabel(name),plan:'custom'}))];}
function plannedLabel(name){return plannedItems.find(item=>item.name===name)?.label||'準備中の機能';}
function keepPlanned(data){if(Array.isArray(data?.plannedItems))plannedItems=data.plannedItems;return data;}
function summary(item){const request=item.request||{},answer=item.answer||{};const dl=el('dl','summary-grid');for(const [term,value] of [['メールアドレス',request.email||'—'],['ご予算',request.budget||'未記入'],['金額の目安',answer.amount||'—'],['サーバー',answer.servers??request.servers??'—'],['チャンネル',answer.channels??request.channels??'—'],['ルール',answer.rules??request.rules??'—']]){const box=document.createElement('div');box.append(el('dt','',term),el('dd','',String(value)));dl.append(box);}return dl;}
function renderList(){const root=$('request-list');root.replaceChildren();if(!requests.length){root.append(el('p','empty-list','該当するご要望はありません。'));return;}for(const item of requests){const button=document.createElement('button');button.type='button';button.append(el('strong','',item.contact||item.request?.email||item.request?.contact||`ご要望 ${item.id}`),el('span','',STATUS_LABELS[item.status]||item.status),el('small','',formatDate(item.updatedAt||item.createdAt)));button.addEventListener('click',()=>loadDetail(item.id));root.append(button);}}
async function loadList(){setStatus('ご要望を読み込み中…');try{const status=$('status-filter').value;const data=keepPlanned(await api(`/site/supporter-admin/api/custom-requests${status?`?status=${encodeURIComponent(status)}`:''}`));requests=Array.isArray(data)?data:data.items||[];renderList();setStatus('');}catch(error){setStatus(error.message,'error');}}
function renderFeatureTable(item){const answer=item.answer||{},request=item.request||{};const table=el('table','feature-table');const thead=document.createElement('thead');const head=document.createElement('tr');for(const label of ['機能','含まれる標準プラン','ご希望','提供','備考'])head.append(el('th','',label));thead.append(head);const tbody=document.createElement('tbody');for(const def of definitions(item)){const tr=document.createElement('tr');tr.dataset.feature=def.name;const wanted=def.plan==='supporter'?'yes':request.wants?.[def.name]||'no';const select=document.createElement('select');select.className='answer-mark';select.setAttribute('aria-label',`${def.label}の提供`);for(const [value,label] of Object.entries(MARK_LABELS)){const option=document.createElement('option');option.value=value;option.textContent=`${label} ${value==='yes'?'提供':value==='partial'?'一部提供':'提供なし'}`;option.selected=value===(answer.marks?.[def.name]||'no');select.append(option);}const note=document.createElement('input');note.className='answer-note';note.maxLength=120;note.value=answer.notes?.[def.name]||'';note.placeholder='運営の備考';const provide=document.createElement('td');provide.append(select);const noteCell=document.createElement('td');if(request.wantNotes?.[def.name])noteCell.append(el('small','request-feature-note',`ご希望：${request.wantNotes[def.name]}`));noteCell.append(note);tr.append(el('th','',def.label),el('td','',PLAN_LABELS[def.plan]||'—'),el('td','mark',WANT_LABELS[wanted]||'—'),provide,noteCell);tbody.append(tr);}table.append(thead,tbody);$('feature-table').replaceChildren(table);}
function fillAnswer(item){const request=item.request||{},answer=item.answer||{};for(const [id,value] of [['answer-amount',answer.amount??request.budget??''],['answer-estimator',answer.estimator??''],['answer-servers',answer.servers??request.servers??1],['answer-channels',answer.channels??request.channels??2],['answer-rules',answer.rules??request.rules??5],['answer-memo',answer.memo??'']])$(id).value=String(value);}
function setDocumentText(id,value){$(id).textContent=value===null||value===undefined||value===''?'—':String(value);}
function renderPrintDocument(item){
 const request=item.request||{},answer=item.answer||{};
 setDocumentText('document-request-id',item.id);setDocumentText('document-received-at',formatDateOnly(item.createdAt));setDocumentText('document-answered-at',formatDateOnly(item.answeredAt));setDocumentText('document-printed-at',formatDateOnly(new Date()));
 setDocumentText('document-name',request.contact);setDocumentText('document-email',request.email);setDocumentText('document-discord-id',item.discordUserId);setDocumentText('document-budget',request.budget||'未記入');
 setDocumentText('document-quantities',`サーバー ${answer.servers??'—'}／チャンネル ${answer.channels??'—'}／ルール ${answer.rules??'—'}`);setDocumentText('document-amount',answer.amount);setDocumentText('document-estimator',answer.estimator);
 setDocumentText('document-request-note',request.request||'記入なし');setDocumentText('document-admin-memo',answer.memo||'記入なし');
 const body=$('document-feature-body');body.replaceChildren();
 for(const def of definitions(item)){
  const wanted=def.plan==='supporter'?'yes':request.wants?.[def.name]||'no';
  const notes=[request.wantNotes?.[def.name]&&`ご希望：${request.wantNotes[def.name]}`,answer.notes?.[def.name]&&`提供：${answer.notes[def.name]}`].filter(Boolean).join('／');
  const row=document.createElement('tr');
  for(const value of [def.label,def.plan==='custom'?'準備中':PLAN_LABELS[def.plan]||'—',WANT_LABELS[wanted]||'—',MARK_LABELS[answer.marks?.[def.name]||'no']||'—',notes||'—'])row.append(el('td','',value));
  body.append(row);
 }
}
function renderDetail(item){current=item;$('detail-section').hidden=false;$('detail-title').textContent=`ご要望 ${item.id}`;$('detail-status').textContent=STATUS_LABELS[item.status]||item.status;$('request-summary').replaceChildren(el('p','',`メール：${item.request?.email||'—'} ／ お名前：${item.request?.contact||'—'} ／ 受付：${formatDate(item.createdAt)} ／ 更新：${formatDate(item.updatedAt)}`),summary(item));renderFeatureTable(item);renderPrintDocument(item);$('print').disabled=false;$('request-note').replaceChildren(el('h3','','そのほかのご要望'),el('p','',item.request?.request||'記入なし'),...(item.decisionMessage?[el('h3','',item.status==='objected'?'異議の内容':'利用者からのメッセージ'),el('p','',item.decisionMessage)]:[]));fillAnswer(item);const canAnswer=['submitted','estimating'].includes(item.status);$('answer-form').hidden=!canAnswer;$('estimating').hidden=!['submitted','consulting','objected'].includes(item.status);$('load-contract').hidden=item.status!=='accepted';$('contract-workflow').hidden=item.status!=='accepted';if(item.status==='accepted')loadContractWorkflow(item);$('detail-section').scrollIntoView({behavior:'smooth',block:'start'});}
async function loadDetail(id){setStatus('詳細を読み込み中…');try{current=unwrap(keepPlanned(await api(`/site/supporter-admin/api/custom-requests/${encodeURIComponent(id)}`)));renderDetail(current);setStatus('');}catch(error){setStatus(error.message,'error');}}
function answerPayload(){const marks={},notes={};for(const row of document.querySelectorAll('#feature-table [data-feature]')){const name=row.dataset.feature;marks[name]=row.querySelector('.answer-mark').value;const note=row.querySelector('.answer-note').value.trim();if(note)notes[name]=note;}return {estimator:$('answer-estimator').value.trim(),amount:$('answer-amount').value.trim(),memo:$('answer-memo').value.trim(),servers:Number($('answer-servers').value),channels:Number($('answer-channels').value),rules:Number($('answer-rules').value),marks,notes};}
async function updateStatus(status){if(!current)return;try{await api(`/site/supporter-admin/api/custom-requests/${encodeURIComponent(current.id)}/status`,'POST',{status,revision:current.revision});setStatus('状態を更新しました。','success');await loadDetail(current.id);await loadList();}catch(error){setStatus(error.message,'error');}}
function selectedContractFeatures(){return [...document.querySelectorAll('#contract-feature-list input[data-feature]:checked')].map(node=>node.dataset.feature).sort();}
function syncContractFeatureDependencies(name,checked){
 const boxes=new Map([...document.querySelectorAll('#contract-feature-list input[data-feature]')].map(box=>[box.dataset.feature,box]));
 if(checked){const requires=FEATURE_DEFINITIONS.find(item=>item.name===name)?.requires||[];if(requires.length&&!requires.some(item=>boxes.get(item)?.checked)){boxes.get(requires[0]).checked=true;syncContractFeatureDependencies(requires[0],true);}}
 else for(const item of FEATURE_DEFINITIONS){if(item.requires.length&&boxes.get(item.name)?.checked&&!item.requires.some(required=>boxes.get(required)?.checked)){boxes.get(item.name).checked=false;syncContractFeatureDependencies(item.name,false);}}
 invalidateContractSave();updateContractEstimate();
}
function renderContractFeatures(names){
 const selected=new Set(withBasicFeatures(names));const root=$('contract-feature-list');root.replaceChildren();
 for(const item of FEATURE_DEFINITIONS){
  const label=el('label','contract-feature-option');const box=document.createElement('input');box.type='checkbox';box.dataset.feature=item.name;box.checked=selected.has(item.name);box.disabled=item.plan==='supporter';box.addEventListener('change',()=>syncContractFeatureDependencies(item.name,box.checked));
  label.append(box,el('span','',item.label),el('small','',item.plan==='supporter'?'Basic（必須）':`${PLAN_LABELS[item.plan]}以上`));root.append(label);
 }
}
function amountNumber(value){const match=String(value||'').match(/[0-9][0-9,]*/);return match?Number(match[0].replaceAll(',','')):'';}
function contractPayload(action){return {discordUserId:$('contract-uid').value.trim(),confirmDiscordUserId:$('contract-confirm').value.trim(),name:'カスタムプラン',channels:Number($('contract-channels').value),servers:Number($('contract-servers').value),rules:Number($('contract-rules').value),monthlyYen:Number($('contract-price').value),features:selectedContractFeatures(),secondaryReuse:false,reason:`カスタムプランご要望 ${current?.id||''} を反映`,requestId:contractRequestId,expectedRevision:Number(contractAccount?.customPlan?.revision||0),action};}
function updateContractEstimate(){const price=customPlanEstimate(contractPayload('save'));$('contract-estimate').textContent=Number.isFinite(price)?`${price.toLocaleString('ja-JP')}円／月（参考値）`:'—';}
function setStepResult(id,message,type=''){const node=$(id);node.className=`step-result${type?` ${type}`:''}`;node.textContent=message||'';}
function invalidateContractSave(){if(!contractSaved)return;contractSaved=false;$('contract-checkout').disabled=true;setStepResult('contract-save-result','内容が変更されました。もう一度保存してください。');setStepResult('contract-checkout-result','');}
function contractStatusText(account){
 if(!account)return '対象のDiscord IDは有料プランに未登録です。';
 const plan=account.customPlan;if(!plan)return '既存のカスタム契約はありません。';
 const label={offered:'提示中',active:'有効',canceled:'停止'}[plan.status]||plan.status;
 return `既存のカスタム契約：${label}（revision ${plan.revision}）`;
}
async function loadContractWorkflow(item){
 const id=item.id;contractSaved=false;contractAccount=null;contractRequestId=id;$('contract-checkout').disabled=true;setStepResult('contract-save-result','回答内容を読み込み中…');setStepResult('contract-checkout-result','');$('contract-state').textContent='既存契約を確認中…';
 try{
  const [features,accountData]=await Promise.all([api(`/site/supporter-admin/api/custom-requests/${encodeURIComponent(id)}/features`),api('/site/supporter-admin/api/accounts')]);
  if(current?.id!==id)return;
  contractAccount=(accountData.accounts||[]).find(account=>account.discordUserId===item.discordUserId)||null;
  $('contract-state').textContent=contractStatusText(contractAccount);
  $('contract-uid').value=item.discordUserId||'';$('contract-confirm').value=item.discordUserId||'';
  $('contract-servers').value=String(features.servers??'');$('contract-channels').value=String(features.channels??'');$('contract-rules').value=String(features.rules??'');$('contract-price').value=String(amountNumber(item.answer?.amount));
  renderContractFeatures(features.features||[]);updateContractEstimate();setStepResult('contract-save-result','内容を確認し、必要に応じて編集して保存してください。');
 }catch(error){setStepResult('contract-save-result',error.message,'error');$('contract-state').textContent='契約情報を取得できませんでした。';}
}
async function saveContract(event){
 event.preventDefault();if(!current||!event.currentTarget.reportValidity())return;
 const payload=contractPayload('save'),validationError=customPlanValidationError(payload,missingFeatureDependency,featureLabel);
 if(validationError){setStepResult('contract-save-result',validationError,'error');return;}
 const button=$('contract-save');button.disabled=true;setStepResult('contract-save-result','カスタムプランを保存中…');
 try{
  if(contractAccount?.customPlan?.status==='active'){
   const preview=await sendCustomPlan({...payload,action:'preview'});if(!preview.quote)throw new Error('料金プレビューを取得できませんでした。');
   if(!window.confirm(activeCustomPlanConfirmation(preview.quote))){setStepResult('contract-save-result','変更を取り消しました。');return;}
  }else if(!window.confirm(newCustomPlanConfirmation(payload))){setStepResult('contract-save-result','設定の保存を取り消しました。');return;}
  const data=await sendCustomPlan(payload);contractAccount={...(contractAccount||{}),discordUserId:payload.discordUserId,customPlan:data.customPlan||contractAccount?.customPlan};contractRequestId=crypto.randomUUID();contractSaved=true;
  setStepResult('contract-save-result',data.message||'カスタムプランとして保存しました。','success');
  if(data.url)renderCheckoutUrl(data.url,data.message);
  const canCheckout=contractAccount.customPlan?.status==='offered';$('contract-checkout').disabled=!canCheckout;
  if(!canCheckout&&!data.url)setStepResult('contract-checkout-result','既存の有効な契約は新規の支払いURL作成対象ではありません。');
  $('contract-state').textContent=contractStatusText(contractAccount);
 }catch(error){setStepResult('contract-save-result',error.message,'error');contractSaved=false;$('contract-checkout').disabled=true;}
 finally{button.disabled=false;}
}
function renderCheckoutUrl(value,message='支払いURLを作成しました。'){
 const url=stripeCheckoutUrl(value),root=$('contract-checkout-result');root.className='step-result success';root.replaceChildren(el('p','',message));
 const actions=el('div','checkout-actions');const link=el('a','','作成した支払いURLを開く');link.href=url;link.target='_blank';link.rel='noopener noreferrer';const copy=el('button','secondary-btn','コピー');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(url);setStepResult('contract-checkout-result','支払いURLをコピーしました。','success');root.append(actions);}catch{setStepResult('contract-checkout-result','支払いURLをコピーできませんでした。','error');root.append(actions);}});actions.append(link,copy);root.append(actions);
}
async function createCheckout(){
 if(!contractSaved)return;const payload=contractPayload('checkout'),validationError=customPlanValidationError(payload,missingFeatureDependency,featureLabel);if(validationError){setStepResult('contract-checkout-result',validationError,'error');return;}
 const button=$('contract-checkout');button.disabled=true;setStepResult('contract-checkout-result','支払いURLを作成中…');
 try{const data=await sendCustomPlan(payload);renderCheckoutUrl(data.url,data.message);contractRequestId=crypto.randomUUID();}
 catch(error){setStepResult('contract-checkout-result',error.message,'error');}
 finally{button.disabled=!contractSaved;}
}
async function loadContract(){if(!current)return;try{const data=await api(`/site/supporter-admin/api/custom-requests/${encodeURIComponent(current.id)}/features`);const draft={requestId:current.id,discordUserId:current.discordUserId||current.userId||'',features:data.features||[],servers:data.servers,channels:data.channels,rules:data.rules};sessionStorage.setItem('supporter-admin-custom-draft',JSON.stringify(draft));location.href='./?customDraft=1';}catch(error){setStatus(error.message,'error');}}

$('refresh').addEventListener('click',loadList);$('status-filter').addEventListener('change',loadList);$('print').addEventListener('click',()=>{if(!current)return;setDocumentText('document-printed-at',formatDateOnly(new Date()));window.print();});$('estimating').addEventListener('click',()=>updateStatus('estimating'));$('close-request').addEventListener('click',()=>{if(confirm('このご要望を終了にしますか？'))updateStatus('closed');});$('load-contract').addEventListener('click',loadContract);
$('contract-form').addEventListener('submit',saveContract);$('contract-checkout').addEventListener('click',createCheckout);$('contract-form').addEventListener('input',event=>{if(event.target.matches('input')){invalidateContractSave();updateContractEstimate();}});
window.addEventListener('beforeprint',()=>{if(current)setDocumentText('document-printed-at',formatDateOnly(new Date()));});
$('copy-request').addEventListener('click',()=>{if(!current)return;for(const row of document.querySelectorAll('#feature-table [data-feature]')){const wanted=current.request?.wants?.[row.dataset.feature]||'no';row.querySelector('.answer-mark').value=wanted==='yes'?'yes':wanted==='maybe'?'partial':'no';}});
$('answer-form').addEventListener('submit',async event=>{event.preventDefault();if(!current||!event.currentTarget.reportValidity())return;try{await api(`/site/supporter-admin/api/custom-requests/${encodeURIComponent(current.id)}/answer`,'POST',{answer:answerPayload(),revision:current.revision});setStatus('回答を送信しました。','success');await loadDetail(current.id);await loadList();}catch(error){setStatus(error.message,'error');}});
loadList();

