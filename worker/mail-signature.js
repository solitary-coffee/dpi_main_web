const SIGNATURE_LINES = Object.freeze([
 'DPI-Bot 運営',
 '公式サイト: https://dpi-bot.com/',
 '公式サポートサーバー: https://discord.gg/qFuZcGUb4K',
 'お問い合わせ: support@dpi-bot.com',
]);

const escapeHtml=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

function linkHtml(value){
 const text=String(value),parts=[];
 let last=0;
 for(const match of text.matchAll(/https:\/\/[^\s<>"']+/gu)){
  parts.push(escapeHtml(text.slice(last,match.index)));
  parts.push(`<a href="${escapeHtml(match[0])}">${escapeHtml(match[0])}</a>`);
  last=match.index+match[0].length;
 }
 parts.push(escapeHtml(text.slice(last)));
 return parts.join('');
}

export function mailSignatureText({extraLines=[]}={}){
 return ['----------------------------------------',...SIGNATURE_LINES,...extraLines.map(String),'© 2026 DPI-Bot'].join('\n');
}

export function mailSignatureHtml({extraLines=[]}={}){
 const lines=[
  '<strong>DPI-Bot 運営</strong>',
  '<a href="https://dpi-bot.com/">公式サイト</a>',
  '<a href="https://discord.gg/qFuZcGUb4K">公式サポートサーバー</a>',
  '<a href="mailto:support@dpi-bot.com">support@dpi-bot.com</a>',
  ...extraLines.map(linkHtml),
  '© 2026 DPI-Bot',
 ];
 return `<p style="margin-top:24px;padding-top:16px;border-top:1px solid #d8dee6;font-size:13px;color:#596273">${lines.join('<br>')}</p>`;
}
