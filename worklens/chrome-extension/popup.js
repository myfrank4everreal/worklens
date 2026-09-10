const $ = selector => document.querySelector(selector);
const defaults = ['accounts.google.com','pay.google.com','paypal.com','stripe.com','wise.com','binance.com'];
function show(text, kind='') { $('#status').textContent=text; $('#status').className=`status ${kind}`; }
async function load() {
  const config = await chrome.storage.local.get({ enabled:false, connectionKey:'', excludedDomains:defaults, lastResult:null });
  $('#key').value=config.connectionKey; $('#enabled').checked=config.enabled; $('#excludes').value=config.excludedDomains.join('\n');
  if(config.lastResult?.ok) show(`Connected · last sync imported ${config.lastResult.accepted} new visits`, 'ok');
  else if(config.lastResult?.error) show(config.lastResult.error, 'bad');
  else show(config.enabled?'Enabled, not synced yet':'Paused');
}
async function save() {
  const connectionKey=$('#key').value.trim();
  const excludedDomains=$('#excludes').value.split(/\s+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  const enabled=$('#enabled').checked;
  if(enabled&&!connectionKey){show('Paste the connection key first.','bad');return}
  await chrome.storage.local.set({connectionKey,excludedDomains,enabled});
  show(enabled?'Saved. Testing connection…':'Sync paused.');
  if(enabled) await runSync(Date.now()-60*60*1000);
}
async function runSync(since=Date.now()-24*60*60*1000){
  show('Syncing…');
  const result=await chrome.runtime.sendMessage({type:'sync',since});
  if(result?.error) show(result.error,'bad'); else show(`Connected · imported ${result.accepted||0} new visits`,'ok');
}
$('#save').addEventListener('click',save); $('#sync').addEventListener('click',()=>runSync()); load();
