const REGION_NAMES = Object.freeze([
 ['北海道','hokkaido'],
 ['東北','tohoku'],
 ['関東甲信','kanto-koshin'],
 ['北陸','hokuriku'],
 ['東海','tokai'],
 ['近畿','kinki'],
 ['中国','chugoku'],
 ['四国','shikoku'],
 ['九州北部','kyushu-north'],
 ['九州南部','kyushu-south-amami'],
 ['奄美','kyushu-south-amami'],
 ['沖縄','okinawa'],
 ['全国','all'],
]);

const REGION_LABELS = new Map([
 ['all','全国'],
 ['hokkaido','北海道'],
 ['tohoku','東北'],
 ['kanto-koshin','関東甲信'],
 ['hokuriku','北陸'],
 ['tokai','東海'],
 ['kinki','近畿'],
 ['chugoku','中国'],
 ['shikoku','四国'],
 ['kyushu-north','九州北部'],
 ['kyushu-south-amami','九州南部・奄美'],
 ['okinawa','沖縄'],
]);

const IMAGE_TYPES = new Set(['hires-radar','thunder-radar','tsunami-map','weather-map','earthquake-map','eew-map','warning-table','warning-timeseries']);

function regionLabels(regions) {
 return (Array.isArray(regions)?regions:[]).map(id=>REGION_LABELS.get(String(id))).filter(Boolean);
}

export function normalizeWarningTableSelection(tables,regions) {
 const selectedTables=Array.isArray(tables)?[...tables]:[];
 const needsRegions=selectedTables.includes('regional')||selectedTables.includes('timeseries');
 return {tables:selectedTables,regions:needsRegions&&Array.isArray(regions)?[...regions]:[]};
}

export function nextCheckboxSelection(selected,value,checked) {
 const current=Array.isArray(selected)?selected:[];
 return checked?(current.includes(value)?[...current]:[...current,value]):current.filter(item=>item!==value);
}

export function imageRuleTargetSummary(rule) {
 if(!IMAGE_TYPES.has(rule?.type))return '';
 if(rule.type==='warning-table'){
  const {tables,regions}=normalizeWarningTableSelection(rule.tables,rule.regions);
  const parts=[];
  if(tables.includes('national'))parts.push('全国の表');
  if(tables.includes('regional'))parts.push(`地方の表：${regionLabels(regions).join('・')||'未選択'}`);
  if(tables.includes('timeseries'))parts.push(`時系列予想：${regionLabels(regions).join('・')||'未選択'}`);
  return parts.join('／')||'表：未選択';
 }
 if(rule.type==='warning-timeseries')return `時系列予想：${regionLabels(rule.regions).join('・')||'未選択'}`;
 if(rule.type==='eew-map')return Array.isArray(rule.regions)&&rule.regions.length?`地方：${regionLabels(rule.regions).join('・')||'未選択'}`:'全国';
 return `対象：${REGION_LABELS.get(String(rule.region||'all'))||'未選択'}`;
}

function selectedRegionIds(rule) {
 if(rule.type==='warning-table'){
  const {tables,regions}=normalizeWarningTableSelection(rule.tables,rule.regions);
  return [...(tables.includes('national')?['all']:[]),...(tables.some(id=>id==='regional'||id==='timeseries')?regions:[])];
 }
 if(rule.type==='warning-timeseries')return Array.isArray(rule.regions)?rule.regions:[];
 if(rule.type==='eew-map')return Array.isArray(rule.regions)&&rule.regions.length?rule.regions:['all'];
 return [String(rule.region||'all')];
}

export function findRuleTargetMismatches(rules) {
 const mismatches=[];
 for(const rule of Array.isArray(rules)?rules:[]){
  if(!IMAGE_TYPES.has(rule?.type))continue;
  const matches=REGION_NAMES.filter(([name])=>String(rule.name||'').includes(name));
  // 地方名なし、または複数の地方名を含む名前は利用者の意図を決めつけない。
  if(matches.length!==1)continue;
  const selected=[...new Set(selectedRegionIds(rule).map(String))];
  if(selected.length===1&&selected[0]===matches[0][1])continue;
  mismatches.push({name:String(rule.name||''),selection:imageRuleTargetSummary(rule)});
 }
 return mismatches;
}
