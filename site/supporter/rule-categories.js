export const CATEGORIES = [
 {
  id: 'eew',
  name: '緊急地震速報',
  types: [['eew', '緊急地震速報'], ['eew-map', '緊急地震速報（警報）の図']]
 },
 {
  id: 'earthquake',
  name: '地震・津波関連',
  types: [['earthquake', '地震情報'], ['earthquake-map', '地震情報（図）'], ['pending:estimated-intensity', '推計震度分布（準備中）'], ['tsunami-map', '津波警報・注意報・津波観測（地図・表）']]
 },
 {
  id: 'warning',
  name: '気象警報・注意報関連',
  types: [['weather-map', '気象警報・注意報の地図'], ['warning-table', '気象警報・注意報の表'], ['warning-timeseries', '気象警報・注意報の時系列予想']]
 },
 {
  id: 'weather',
  name: '気象情報関連',
  types: [['weather', '気象情報'], ['pending:rainband', '気象防災速報：線状降水帯（準備中）'], ['pending:tornado', '気象防災速報：竜巻注意情報（準備中）'], ['pending:record-rain', '気象防災速報：記録的短時間大雨情報（準備中）']]
 },
 {
  id: 'volcano',
  name: '火山関連',
  types: [['pending:volcano-warning', '噴火速報・噴火警報（準備中）'], ['pending:ashfall', '降灰予報（準備中）']]
 },
 {
  id: 'radar',
  name: '気象関連（その他）',
  types: [['rain-radar', '雨雲レーダー（簡略版）'], ['hires-radar', '雨雲レーダー（高解像度版）'], ['pending:thunder', '雷レーダー（準備中）'], ['pending:typhoon', '台風（準備中）'], ['pending:rain-forecast', '今後の雨（準備中）'], ['pending:himawari', '気象衛星（準備中）'], ['pending:wdist', '天気分布予報（準備中）'], ['pending:amedas', 'アメダス（準備中）']]
 }
];

export function categoryOf(type) {
 for (const cat of CATEGORIES) {
  if (cat.types.some(([val]) => val === type)) return cat.id;
 }
 return CATEGORIES[0].id;
}

export function typeChoices(categoryId, availableTypes) {
 const cat = CATEGORIES.find(c => c.id === categoryId) || CATEGORIES[0];
 const choices = [];
 for (const [val, label] of cat.types) {
  if (val.startsWith('pending:')) {
   choices.push([val, label, true]);
  } else {
   const avail = availableTypes.find(a => a[0] === val);
   if (avail) choices.push([val, avail[1], false]);
  }
 }
 return choices;
}
