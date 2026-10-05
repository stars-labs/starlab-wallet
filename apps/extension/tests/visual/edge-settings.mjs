/** Presentation fixtures only; no cryptographic or network interoperability claim. */
const owner = '0x2fb6ae33558e46ec6baa39c9c98cd00f4b0f7548';
const contact = '0x46b471336610f695c6e3b42ea88dde5cc07f7412';
const unlimited = (2n ** 256n - 1n).toString();

export function edgeScenario(mode) {
 const scenario = {responses: {}, pendingMessages: [], storage: {}};
 if(mode === 'activity-loading') scenario.pendingMessages = ['getActivity'];
 if(mode === 'activity-error') scenario.responses.getActivity = {success:false,error:'Activity unavailable. Try again shortly.'};
 if(mode === 'backup-wrong-password') scenario.responses.importKeystore = {success:false,error:'Wrong password for this backup.'};
 if(mode === 'backup-busy') scenario.pendingMessages = ['importKeystore'];
 if(mode.startsWith('allowance-')) {
  scenario.storage.wallet_allowances = {edge:{owner,chainId:1,token:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',spender:contact,lastApproved:unlimited,updatedAt:1791108000000}};
  if(mode==='allowance-busy') scenario.pendingMessages=['rpcRequest'];
  if(mode==='allowance-error') scenario.responses.rpcRequest={error:{message:'Approval revoke rejected by the wallet.'}};
 }
 return scenario;
}

const card = (page, heading) => page.locator('.card').filter({has:page.getByRole('heading',{name:heading,exact:true})});
async function settings(page) { await page.getByRole('button',{name:'Settings',exact:true}).click(); }
async function restore(page) {
 await settings(page);
 await page.getByText('Restore from backup',{exact:true}).click();
 await page.locator('#restore-files').setInputFiles({name:'device-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({encrypted:true,data:'public-fixture'}))});
 await page.locator('#restore-password').fill('fixture-password');
 await page.getByRole('button',{name:'Restore wallet',exact:true}).click();
}
async function holdRpc(page) { await page.route('https://**/*', () => new Promise(()=>{})); }
async function allowance(page) {
 await page.route('https://**/*',async route=>{
  let request;try{request=route.request().postDataJSON();}catch{return route.abort();}
  const result=req=>({jsonrpc:'2.0',id:req.id,result:'0x'+(2n**256n-1n).toString(16)});
  await route.fulfill({contentType:'application/json',body:JSON.stringify(Array.isArray(request)?request.map(result):result(request))});
 });
 await settings(page);
 await card(page,'Token approvals').getByRole('button',{name:'Revoke',exact:true}).waitFor();
}

export async function captureEdgeSettings(capture) {
 for(const theme of ['light','dark']) {
  await capture(`activity-loading-${theme}`,'activity-loading',theme,380,async page=>{await page.getByText('Loading activity…',{exact:true}).waitFor();});
  await capture(`activity-error-${theme}`,'activity-error',theme,380,async page=>{await page.getByText('Activity unavailable. Try again shortly.',{exact:true}).waitFor();});
  await capture(`nft-loading-${theme}`,'funded',theme,380,async page=>{await holdRpc(page);await page.getByRole('button',{name:'Load collectibles',exact:true}).click();await page.getByRole('button',{name:'Scanning…',exact:true}).waitFor();});
  await capture(`nft-error-${theme}`,'funded',theme,380,async page=>{
   await page.route('https://**/*',async route=>{let req;try{req=route.request().postDataJSON();}catch{return route.abort();}const error=r=>({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Collectibles unavailable'}});await route.fulfill({contentType:'application/json',body:JSON.stringify(Array.isArray(req)?req.map(error):error(req))});});
   await page.getByRole('button',{name:'Load collectibles',exact:true}).click();await page.locator('.nft-gallery .state-error, .ng .state-error').waitFor();
  });
  for(const mode of ['backup-wrong-password','backup-busy']) await capture(`${mode}-${theme}`,mode,theme,380,async page=>{await restore(page);await page.getByText(mode==='backup-busy'?'Restoring…':'Wrong password for this backup.',{exact:true}).waitFor();});
  await capture(`contacts-invalid-${theme}`,'settings-populated',theme,380,async page=>{await settings(page);const section=card(page,'Address book');await section.getByPlaceholder('Name',{exact:true}).fill('Alex');await section.getByPlaceholder('0x…',{exact:true}).fill('invalid');await section.getByRole('button',{name:'Add',exact:true}).click();await section.getByText('Enter a valid 0x address',{exact:true}).waitFor();});
  await capture(`contacts-updated-${theme}`,'settings-populated',theme,380,async page=>{await settings(page);const section=card(page,'Address book');await section.getByPlaceholder('Name',{exact:true}).fill('Alex updated');await section.getByPlaceholder('0x…',{exact:true}).fill(contact);await section.getByRole('button',{name:'Add',exact:true}).click();await section.getByText('Alex updated',{exact:true}).waitFor();});
  await capture(`token-invalid-${theme}`,'settings-populated',theme,380,async page=>{await settings(page);const section=card(page,'Tokens');await section.getByPlaceholder('0x… token contract').fill('invalid');await section.getByRole('button',{name:'Add',exact:true}).click();await section.getByText('Enter a valid 0x token address',{exact:true}).waitFor();});
  await capture(`token-loading-${theme}`,'settings-populated',theme,380,async page=>{await settings(page);await holdRpc(page);const section=card(page,'Tokens');await section.getByRole('button',{name:'Discover',exact:true}).click();await section.getByRole('button',{name:'Scanning…',exact:true}).waitFor();});
  for(const mode of ['allowance-unlimited','allowance-busy','allowance-error']) await capture(`${mode}-${theme}`,mode,theme,380,async page=>{await allowance(page);if(mode!=='allowance-unlimited'){const section=card(page,'Token approvals');await section.getByRole('button',{name:'Revoke',exact:true}).click();await section.getByText(mode==='allowance-busy'?'Submitting revoke…':'Revoke failed: Approval revoke rejected by the wallet.',{exact:true}).waitFor();}});
  await capture(`custom-rpc-invalid-${theme}`,'funded',theme,380,async page=>{await settings(page);await page.getByRole('button',{name:'Add custom network',exact:true}).click();await page.locator('#network-name').fill('Invalid network');await page.locator('#network-rpc').fill('not-a-url');await page.locator('#network-chainid').fill('123');await page.locator('#network-symbol').fill('TEST');await page.getByRole('button',{name:'Save network',exact:true}).click();await card(page,'Add custom network').locator('.alert-danger').waitFor();});
 }
}
