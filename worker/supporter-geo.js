// Geographic catalogue shared by dashboard validation and the delivery snapshot.
// JMA's class20s identifiers are 7-digit warning-area codes, not arbitrary city names.
export const PREFECTURES = Object.freeze([
 ['01','北海道','hokkaido'],['02','青森県','tohoku'],['03','岩手県','tohoku'],['04','宮城県','tohoku'],['05','秋田県','tohoku'],['06','山形県','tohoku'],['07','福島県','tohoku'],
 ['08','茨城県','kanto-koshin'],['09','栃木県','kanto-koshin'],['10','群馬県','kanto-koshin'],['11','埼玉県','kanto-koshin'],['12','千葉県','kanto-koshin'],['13','東京都','kanto-koshin'],['14','神奈川県','kanto-koshin'],['19','山梨県','kanto-koshin'],['20','長野県','kanto-koshin'],
 ['15','新潟県','hokuriku'],['16','富山県','hokuriku'],['17','石川県','hokuriku'],['18','福井県','hokuriku'],
 ['21','岐阜県','tokai'],['22','静岡県','tokai'],['23','愛知県','tokai'],['24','三重県','tokai'],
 ['25','滋賀県','kinki'],['26','京都府','kinki'],['27','大阪府','kinki'],['28','兵庫県','kinki'],['29','奈良県','kinki'],['30','和歌山県','kinki'],
 ['31','鳥取県','chugoku'],['32','島根県','chugoku'],['33','岡山県','chugoku'],['34','広島県','chugoku'],
 ['35','山口県','kyushu-north'],['40','福岡県','kyushu-north'],['41','佐賀県','kyushu-north'],['42','長崎県','kyushu-north'],['43','熊本県','kyushu-north'],['44','大分県','kyushu-north'],
 ['36','徳島県','shikoku'],['37','香川県','shikoku'],['38','愛媛県','shikoku'],['39','高知県','shikoku'],
 ['45','宮崎県','kyushu-south-amami'],['46','鹿児島県','kyushu-south-amami'],['47','沖縄県','okinawa']
].map(([code,name,region])=>Object.freeze({code,name,region})));
const PREF_BY_CODE = new Map(PREFECTURES.map(row=>[row.code,row]));
const DATA_URL='https://www.jma.go.jp/bosai/common/const/area.json';
let cached=null,expires=0;

export async function loadSupporterAreaCatalogue(now=Date.now()){
 if(cached&&now<expires)return cached;
 let response;
 try {response=await fetch(DATA_URL,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});}
 catch {throw Object.assign(new Error('気象庁の市区町村一覧を取得できません。地域設定の保存は再試行してください。'),{status:503});}
 if(!response.ok)throw Object.assign(new Error('気象庁の地域データが利用できません。'),{status:503});
 const raw=await response.text();
 if(raw.length>900000)throw Object.assign(new Error('地域データが想定サイズを超過しています。'),{status:503});
 let source;
 try{source=JSON.parse(raw);}catch{throw Object.assign(new Error('地域データの形式が不正です。'),{status:503});}
 const class20s=source?.class20s||{},class15s=source?.class15s||{},class10s=source?.class10s||{};
 const municipalities=[],districtIndex=new Map();
 for(const [code,entry] of Object.entries(class20s)){
  if(!/^[0-9]{7}$/.test(code)||typeof entry?.name!=='string'||!PREF_BY_CODE.has(code.slice(0,2)))continue;
  const parent=class15s[String(entry.parent||'')],districtCode=String(parent?.parent||'');
  const district=class10s[districtCode];
  const prefectureCode=code.slice(0,2);
  const districtName=prefectureCode==='01'&&district?.name?district.name:'';
  const row={code,name:entry.name,prefectureCode,districtCode:districtName?districtCode:'',districtName};
  municipalities.push(row);
  if(districtName)districtIndex.set(districtCode,{code:districtCode,name:districtName,prefectureCode});
 }
 if(municipalities.length<1000)throw Object.assign(new Error('市区町村データが不完全です。'),{status:503});
 municipalities.sort((a,b)=>a.code.localeCompare(b.code));
 cached={prefectures:PREFECTURES,municipalities,districts:[...districtIndex.values()].sort((a,b)=>a.code.localeCompare(b.code)),source:'気象庁 地域コード'};
 expires=now+6*60*60*1000;
 return cached;
}

export function geographicEntitlements(subscriptions=[]){
 const plans=new Set(subscriptions.filter(s=>s?.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(s?.status)).map(s=>s.planId));
 const custom=subscriptions.find(s=>s?.planId==='custom'&&s?.recognizedPlan===true&&['active','trialing'].includes(s?.status));
 return {prefecture:!!custom?.municipalityBranching||plans.has('plus')||plans.has('pro'),municipality:!!custom?.municipalityBranching||plans.has('plus')||plans.has('pro'),strictMunicipality:!!custom?.contentExtraction||plans.has('pro')};
}

export function normalizeGeographicRule(rule,region,limits,catalogue){
 const prefecture=String(rule?.prefecture||'all').trim(),district=String(rule?.district||'all').trim(),municipality=String(rule?.municipality||'all').trim();
 const strictMunicipality=rule?.strictMunicipality===true;
 const pref=catalogue?.prefectures?.find(item=>item.code===prefecture);
 if(prefecture!=='all'&&(!limits.prefecture||!pref||pref.region!==region))
  throw Object.assign(new Error('都道府県を指定するにはPlus以上の契約と正しい地方選択が必要です。'),{status:400});
 if(district!=='all'){
  if(prefecture!=='01'||!catalogue?.districts?.some(item=>item.code===district&&item.prefectureCode==='01'))
   throw Object.assign(new Error('北海道内の地方区分を確認してください。'),{status:400});
 }
 if(municipality!=='all'){
  const city=catalogue?.municipalities?.find(item=>item.code===municipality);
  if(!limits.municipality||!city||city.prefectureCode!==prefecture||(district!=='all'&&city.districtCode!==district))
   throw Object.assign(new Error('市区町村を指定するにはPlus以上の契約と正しい地域コードが必要です。'),{status:400});
 }
 if(strictMunicipality&&(!limits.strictMunicipality||municipality==='all'))
  throw Object.assign(new Error('市区町村だけの情報を配信する機能はProプランで、対象市区町村の指定時のみ利用できます。'),{status:400});
 const districtCityCodes=district==='all'?[]:catalogue.municipalities.filter(item=>item.districtCode===district).map(item=>item.code);
 return {prefecture,district,municipality,strictMunicipality,districtCityCodes};
}

export function geographicRuleAllowed(rule,entitlements){
 if(rule?.prefecture&&rule.prefecture!=='all'&&!entitlements.prefecture)return false;
 if(rule?.municipality&&rule.municipality!=='all'&&!entitlements.municipality)return false;
 if(rule?.strictMunicipality===true&&!entitlements.strictMunicipality)return false;
 return true;
}
