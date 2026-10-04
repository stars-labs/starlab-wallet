/** Render the production popup with public browser-API fixtures.
 * No secret shares, production debug hooks, real RPCs, or protocol assertions.
 * Usage: WALLET_VISUAL_BUILD=/tmp/starlab-design-build/chrome-mv3 node tests/visual/capture-wallet.mjs
 */
import {capturePremium} from './premium-captures.mjs';
import {edgeScenario as settingsScenario,captureEdgeSettings} from './edge-settings.mjs';
import {edgeScenario as approvalScenario,captureEdgeApprovals} from './edge-approvals.mjs';
const edgeScenario=mode=>{const a=settingsScenario(mode),b=approvalScenario(mode);return {responses:{...a.responses,...b.responses},pendingMessages:[...(a.pendingMessages??[]),...(b.pendingMessages??[])],storage:{...a.storage,...b.storage},state:{...a.state,...b.state}};};
import { chromium } from '@playwright/test';
import { encodeAbiParameters } from 'viem';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const build = resolve(process.env.WALLET_VISUAL_BUILD ?? '/tmp/starlab-design-build/chrome-mv3');
const output = resolve(process.env.WALLET_VISUAL_OUTPUT ?? '/tmp/starlab-extension-design-shots');
await mkdir(output, { recursive: true });
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm':'application/wasm' };
const server = createServer(async (req,res) => {
 try { const path=resolve(build,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(build+'/'))throw Error('invalid path');res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');res.end(await readFile(path)); } catch { res.statusCode=404;res.end(); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/popup.html`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROME_PATH ?? '/nix/store/g0yvxs8p2ijrvmxpd5mim1ni0fyk9bnh-chromium-154.0.8037.57/bin/chromium',args:['--no-sandbox']});
const manifest=[];
const selectedCases=(process.env.WALLET_VISUAL_CASES??"").split(",").filter(Boolean);
const skippedCases=(process.env.WALLET_VISUAL_SKIP_CASES??'').split(',').filter(Boolean);
async function fixture(page, mode, theme) {
 const descriptor = typeof edgeScenario === "function" ? edgeScenario(mode) : {};
 await page.addInitScript(({mode,theme,descriptor})=>{
  localStorage.setItem('starlab_theme',theme);
  const nativeChain=mode.startsWith('receive-')?mode.slice(8):'ethereum';
  const address=nativeChain==='bitcoin'?'bc1pjtaxg3publicdesignfixture00000000000000000000000000000000':nativeChain==='solana'?'11111111111111111111111111111111':nativeChain==='sui'?'0x'+'11'.repeat(32):nativeChain==='qr-error'?'0x'+'11'.repeat(3000):'0x2fb6ae33558e46ec6baa39c9c98cd00f4b0f7548';
  const wallet={id:'public-demo-wallet',name:'Everyday wallet',blockchain:'ethereum',address,threshold:2,total:3,curve:'secp256k1'};
  const walletList=mode==='wallet-multiple'?[wallet,{...wallet,id:'public-savings-wallet',name:'Savings wallet'}]:[wallet];
  const data={signalRoom:'public-design-fixture-room',wallet_accounts:[],wallet_current_account:null};
  if(mode==='settings-populated'){
   data.starlab_dapp_permissions={'https://app.example.org':{origin:'https://app.example.org',connectedAccounts:[address],lastConnected:1791108000000,chainId:'0x1'}};
   data.wallet_address_book={publiccontact:{name:'Alex',address:'0x46b471336610f695c6e3b42ea88dde5cc07f7412',chain:'ethereum'}};
   data.wallet_allowances={publicapproval:{owner:address,chainId:1,token:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',spender:'0x46b471336610f695c6e3b42ea88dde5cc07f7412',lastApproved:'100000000',updatedAt:1791108000000}};
  }
  const state={deviceId:'This browser',connecteddevices:['Desktop','Phone'],wsConnected:mode!=='offline',sessionInfo:null,invites:[],meshStatus:{type:2},dkgState:7,dkgGroupPublicKey:'038be5c44944aea884c2a5f5ecee75d506c19c7ffd55dcb2d10f562f4afd1bf900',ecdsaGroupPublicKey:'032affa8a1c464656c918705206638118d36adc42fb4310f9b12f6b027a0a53b8b',dkgAddress:address,ethereumAddress:address,chain:'ethereum',curve:'secp256k1',dkgLastResult:{threshold:2,total:3},webrtcConnections:{},uiPreferences:{language:'en'},setupComplete:true};
  if(mode==='onboarding'){state.dkgState=0;state.dkgGroupPublicKey='';state.ecdsaGroupPublicKey='';}
  const session={accepted_devices:['This browser','Desktop','Phone'],session_id:'public-ceremony-fixture',wallet_name:'Everyday wallet',session_type:'dkg',proposer_id:'Desktop',participants:['This browser','Desktop','Phone'],threshold:2,total:3,blockchain:'ethereum',curve:'secp256k1',group_public_key:state.dkgGroupPublicKey,signing_message_hex:'44657369676e20726576696577'};
  if(['setup-waiting','setup-primes','setup-keygen','save-wallet'].includes(mode)){state.sessionInfo=session;state.dkgState=mode==='setup-waiting'?0:mode==='save-wallet'?7:6;state.ecdsaDkgStatus=mode==='setup-primes'?'waiting-primes':mode==='setup-keygen'?'keygen':null;state.ecdsaPrimes={ready:2,total:4,generating:true};state.pendingKeystoreReady=mode==='save-wallet';}
  if(mode==='invite')state.invites=[session];
  if(mode==='dkg-failed'){state.sessionInfo=session;state.dkgState=8;}
  if(mode==='signing-progress')state.sessionInfo={...session,session_type:'signing'};
  if(mode==='hardware'||mode==='watch-only'){data.wallet_accounts=[{id:'public-hardware-account',name:mode==='hardware'?'Ledger account':'Watch-only account',address,blockchain:'ethereum',type:mode==='hardware'?'hardware':'watch-only',deviceType:mode==='hardware'?'ledger':undefined}];data.wallet_current_account='public-hardware-account';}

  if(mode.startsWith('receive-')&&nativeChain!=='qr-error'){state.chain=nativeChain;wallet.blockchain=nativeChain;}
  if(mode.startsWith('password-'))state.locked=true;
  Object.assign(data,descriptor.storage??{});Object.assign(state,descriptor.state??{});
  const event={addListener(){},removeListener(){}};
  const portfolio={native:{symbol:'ETH',balance:mode==='zero'?'0':'1.284',fiat:mode==='zero'?0:3528.84},tokens:[{symbol:'USDC',name:'USD Coin',balance:'250',fiat:250,address:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'},{symbol:'USDT',name:'Tether USD',balance:'100',fiat:100,address:'0xdAC17F958D2ee523a2206206994597C13D831ec7'},{symbol:'DAI',name:'Dai',balance:'25',fiat:25,address:'0x6B175474E89094C44Da98b954EedeAC495271d0F'},{symbol:'USDC',name:'Unverified custom token',balance:'10',address:'0x1111111111111111111111111111111111111111'},{symbol:'USDC',name:'No contract provided',balance:'4'}],totalFiat:3903.84};
  if(mode==='long-assets'){portfolio.native.balance='123456789123456.123456';portfolio.native.fiat=987654321098765.43;portfolio.tokens[0].name='An exceptionally long asset name without a short display alias';portfolio.tokens[0].balance='987654321098765.123456';portfolio.tokens[0].fiat=123456789123456.78;}
  if(mode==='premium-funded')for(const token of portfolio.tokens)if(token.fiat===undefined)token.balance='0';
  if(mode==='hero-missing-prices'){portfolio.native.fiat=undefined;portfolio.tokens=[];portfolio.totalFiat=0;}
  if(mode.startsWith('hero-reset')){portfolio.tokens=[];portfolio.native.fiat=123;portfolio.totalFiat=123;}
  window.__fixturePortfolio=portfolio;window.__fixturePendingPortfolio=false;window.__fixturePortfolioResolvers=[];
  function response(msg){if(mode==='hardware-discovery-error'&&msg.type==='discoverYubiKeyAccounts')return{success:false,error:'Could not connect to YubiKey. Check the device and native host, then try again.'};if(descriptor.responses&&Object.hasOwn(descriptor.responses,msg.type))return descriptor.responses[msg.type];if(msg.type==='unlockKeystore'&&mode==='password-error')return{success:false,error:'Incorrect password. Try again.'};switch(msg.type){
   case'getState':return state;
   case'exportKeystore':return{success:true,keystoreData:JSON.stringify({encrypted:true,publicFixture:true})};
   case'importKeystore':return mode==='restore-error'?{success:false,error:'The backup password is incorrect.'}:{success:true};
   case'rpcRequest':return mode==='send-wait'?new Promise(()=>{}):mode==='send-rejected'?{error:{code:4001,message:'A co-signer declined this transaction.'}}:{result:'0x'+'44'.repeat(32)};

   case'getKeystoreStatus':return{success:true,status:{initialized:mode!=='onboarding',locked:mode==='locked'||mode.startsWith('password-'),wallets:mode==='onboarding'?[]:walletList,activeWallet:mode==='onboarding'?null:wallet}};
   case'getPortfolio':return mode==='error'?{success:false,error:'Balances are unavailable. Check your connection.'}:{success:true,portfolio};
   case'getActivity':return{success:true,activity:mode==='zero'?[]:[{hash:'0xfixture1',to:'0x46b471336610f695c6e3b42ea88dde5cc07f7412',value:'20000000000000000',kind:'Send',status:'confirmed',timestamp:1791108000000},{hash:'0xfixture2',to:address,value:'100000000000000000',kind:'Receive',status:'pending',timestamp:1791107700000},{hash:'0xfixture3',to:address,value:'10000000000000000',kind:'Send',status:'failed',timestamp:1791107000000}]};
   case'deriveAccounts':return{success:true,accounts:[0,1,2].map(account=>({account,addresses:[{chain:state.chain,path:"m/44'/60'/0'/0/0",address:(mode==='send-account-reset'||mode==='hero-reset-account')&&account>0?'0x'+String(account+1).repeat(40):address}]}))};
   case'getWalletCohort':return{success:true,cohort:{walletId:wallet.id,deviceId:'This browser',threshold:2,total:3,participants:['This browser','Desktop','Phone'],curve:'secp256k1',groupPublicKey:state.dkgGroupPublicKey}};
   case'getPendingConnectRequests':return{success:true,requests:mode==='dapp-connect'?[{requestId:'public-connect',origin:'https://app.example.org',blockchain:'ethereum',accounts:[{address,name:'Everyday wallet'},{address:'0x46b471336610f695c6e3b42ea88dde5cc07f7412',name:'Savings account'}],selected:[address]}]:[]};
   case'getPendingSignatureRequests':return{success:true,requests:mode==='dapp-sign'?[{signingId:'public-signature',message:'Sign in to Example app',origin:'https://app.example.org',fromAddress:address}]:[]};
   case'listdevices':return{devices:[]};
   default:return{success:true,wallets:[wallet],accounts:[],contacts:[],allowances:[],pendingImports:[],sessions:[]};
  }}
  window.chrome={runtime:{id:'public-design-fixture',getURL:(p)=>new URL(p,location.href).href,lastError:null,onMessage:event,connect(){return{onMessage:{addListener(fn){window.__fixtureEmit=fn;setTimeout(()=>{fn({type:'initialState',...state});if(mode==='cosign-request')fn({type:'sessionAvailable',session:{...session,session_type:'signing'}});if(mode==='signing-progress')fn({type:'signingProgress',signingId:'public-progress',state:'Waiting for signatures',selectedSigners:session.participants,commitmentsReceived:['This browser','Desktop'],sharesReceived:['This browser']});},30);},removeListener(){}},onDisconnect:event,postMessage(){},disconnect(){}};},sendMessage(msg,callback){if(descriptor.pendingMessages?.includes(msg.type)||(mode==='password-busy'&&msg.type==='unlockKeystore'))return new Promise(()=>{});if(mode==='hero-stale-response'&&msg.type==='getPortfolio')return new Promise(resolve=>window.__fixturePortfolioResolvers.push(resolve));if(window.__fixturePendingPortfolio&&msg.type==='getPortfolio')return new Promise(()=>{});if(mode==='loading'&&msg.type==='getPortfolio')return new Promise(()=>{});const result=response(msg);if(callback)setTimeout(()=>callback(result),0);return Promise.resolve(result);}},storage:{local:{async get(){return data;},async set(values){Object.assign(data,values);},async remove(){}},session:{async get(){return{};},async set(){},async remove(){}},onChanged:event},tabs:{query:async()=>[],create:async()=>{}},alarms:{onAlarm:event,create(){}},notifications:{create(){}},extension:{getViews:()=>[]}};
 },{mode,theme,descriptor});
}
async function capture(name,mode='funded',theme='light',width=380,action){
 if(skippedCases.includes(name)||(selectedCases.length&&!selectedCases.includes(name)))return;
 const page=await browser.newPage({viewport:{width,height:Number(process.env.WALLET_VISUAL_HEIGHT || 900)}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await fixture(page,mode,theme);await page.route('**/*',async route=>{
  if(new URL(route.request().url()).origin===new URL(url).origin)return route.continue();
  if(mode==='nft-gallery'){
   const requestUrl=route.request().url();
   if(requestUrl.includes('fixture.example/metadata/')){
    const id=requestUrl.split('/').at(-1);const art='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs><linearGradient id="g"><stop stop-color="#7664FF"/><stop offset="1" stop-color="#45DBD3"/></linearGradient></defs><rect width="240" height="240" rx="24" fill="url(#g)"/><circle cx="120" cy="112" r="56" fill="none" stroke="white" stroke-width="12"/><path d="M68 184L120 142L172 184" fill="none" stroke="white" stroke-width="12" stroke-linecap="round"/></svg>';
    return route.fulfill({contentType:'application/json',body:JSON.stringify({name:id==='1'?'Orbit study':id==='2'?'Unavailable artwork':'Untitled edition',image:id==='1'?'data:image/svg+xml,'+encodeURIComponent(art):id==='2'?'https://fixture.example/broken.svg':undefined})});
   }
   if(requestUrl.includes('fixture.example/broken.svg'))return route.fulfill({status:404,body:''});
   let body;try{body=route.request().postDataJSON();}catch{return route.abort();}
   const address='0x2fb6ae33558e46ec6baa39c9c98cd00f4b0f7548';
   const result=req=>{
    if(process.env.WALLET_VISUAL_DEBUG)console.log('NFT RPC',req.method,JSON.stringify(req.params));
    if(req.method==='eth_blockNumber')return '0x100';
    if(req.method==='eth_getLogs')return (req.params[0].topics?.[0]==='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')?[1,2,3].map(id=>({address:'0x2222222222222222222222222222222222222222',data:'0x',topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+'00'.repeat(32),'0x'+address.slice(2).padStart(64,'0'),'0x'+id.toString(16).padStart(64,'0')],blockNumber:'0x100',transactionHash:'0x'+'aa'.repeat(32),transactionIndex:'0x0',blockHash:'0x'+'bb'.repeat(32),logIndex:'0x'+id.toString(16),removed:false})):[];
    if(req.method==='eth_call'){
     const data=req.params[0].data;
     if(data.startsWith('0x6352211e'))return encodeAbiParameters([{type:'address'}],[address]);
     if(data.startsWith('0x06fdde03'))return encodeAbiParameters([{type:'string'}],['Starlab gallery']);
     if(data.startsWith('0xc87b56dd'))return encodeAbiParameters([{type:'string'}],['https://fixture.example/metadata/'+BigInt('0x'+data.slice(-64)).toString()]);
    }
    return '0x0';
   };
   const rpc=req=>({jsonrpc:'2.0',id:req.id,result:result(req)});
   return route.fulfill({contentType:'application/json',body:JSON.stringify(Array.isArray(body)?body.map(rpc):rpc(body))});
  }
  if(mode==='fee-review'||mode.startsWith('send-')){
   let body;try{body=route.request().postDataJSON();}catch{return route.abort();}
   const rpc=req=>({jsonrpc:'2.0',id:req.id,result:({eth_estimateGas:'0x5208',eth_maxPriorityFeePerGas:'0x3b9aca00',eth_gasPrice:'0x3b9aca00',eth_chainId:'0x1',eth_getBlockByNumber:{baseFeePerGas:'0x3b9aca00',number:'0x1',hash:'0x'+'11'.repeat(32),parentHash:'0x'+'22'.repeat(32),transactions:[],gasLimit:'0x1c9c380',gasUsed:'0x5208',timestamp:'0x6b1a6000'}})[req.method]??null});
   return route.fulfill({contentType:'application/json',body:JSON.stringify(Array.isArray(body)?body.map(rpc):rpc(body))});
  }
  return route.abort();
 });await page.goto(url);await page.waitForTimeout(900);let presentationEvidence;if(action){try{presentationEvidence=await action(page);}catch(error){errors.push(`Action: ${error.message}; ${await page.locator(".sf-error").allTextContents()}`);}}await page.waitForTimeout(300);if(!/^premium-(hover|pressed)-/.test(name))await page.mouse.move(0,0);const layoutEvidence=await page.evaluate(()=>({viewportHeight:innerHeight,bodyWidth:document.body.getBoundingClientRect().width,bodyHeight:document.body.getBoundingClientRect().height,bodyMinHeight:getComputedStyle(document.body).minHeight,activityCollectiblesGap:document.querySelector('.activity-panel')&&document.querySelector('.collectibles-panel')?document.querySelector('.collectibles-panel').getBoundingClientRect().top-document.querySelector('.activity-panel').getBoundingClientRect().bottom:null,sendDisplay:document.querySelector('.send-form')?getComputedStyle(document.querySelector('.send-form')).display:null,overflow:document.documentElement.scrollWidth>innerWidth,primaryHeight:document.querySelector('.primary-actions button')?.getBoundingClientRect().height}));if(process.env.WALLET_VISUAL_HEIGHT)await page.screenshot({path:resolve(output,name+'-viewport.png'),fullPage:false,timeout:60000});await page.screenshot({path:resolve(output,name+'.png'),fullPage:true,timeout:60000});manifest.push({name,mode,theme,width,layoutEvidence,fixture:true,errors,...(presentationEvidence ? {presentationEvidence} : {})});
 if(name===`settings-populated-${theme}`){
  const cards=page.locator('.card');
  for(let index=0;index<await cards.count();index++){
   const card=cards.nth(index);const sectionTitle=(await card.locator('h2,h3').first().textContent().catch(()=>''))?.trim()??'';
   const sectionName=`settings-section-${sectionTitle.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${theme}`;
   await card.screenshot({path:resolve(output,sectionName+'.png')});manifest.push({name:sectionName,sectionTitle,mode,theme,width,fixture:true,errors:[]});
  }
 }await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2));console.log(`Captured ${name}: ${errors.length} page errors`);await page.close();
}
try {
 await capturePremium(capture);
 for(const theme of ['light','dark']){
  for(const width of [380,1280])await capture(`long-assets-${width}-${theme}`,'long-assets',theme,width,async p=>{return p.locator('.tl-row').evaluateAll(rows=>rows.map(row=>{const [identity,balance,fiat]=[...row.children].map(el=>el.getBoundingClientRect());if(identity.right>balance.left+1||balance.right>fiat.left+1)throw Error('Asset identity and numbers overlap');return {balance:row.children[1].textContent,fullBalance:row.children[1].getAttribute('title'),fiat:row.children[2].textContent,fullFiat:row.children[2].getAttribute('title')};}));});
  await capture(`keyboard-modal-${theme}`,'locked',theme,380,async p=>{await p.getByRole('button',{name:'Unlock wallet',exact:true}).click();const focus=[];for(let i=0;i<8;i++){await p.keyboard.press('Tab');focus.push(await p.evaluate(()=>({text:document.activeElement?.textContent?.trim(),id:document.activeElement?.id,contained:!!document.activeElement?.closest('[role=dialog]')})));}if(focus.some(x=>!x.contained))throw Error('Keyboard focus escaped modal');await p.keyboard.press('Escape');await p.getByRole('dialog').waitFor({state:'hidden'});const restored=await p.getByRole('button',{name:'Unlock wallet',exact:true}).evaluate(el=>el===document.activeElement);if(!restored)throw Error('Modal did not return focus to opener');return {focus,escapeCloses:true,restored};});
  await capture(`settings-sandbox-unavailable-${theme}`,'funded',theme,1280,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:'Enter sandbox',exact:true}).click();await p.getByText('Start the local simulation nodes on your computer, then try again.',{exact:true}).waitFor();});
  await capture(`wallet-add-navigation-${theme}`,'wallet-multiple',theme,380,async p=>{await p.locator('.wallet-selector-button').click();await p.getByRole('button',{name:'+ Add Wallet',exact:true}).click();await p.getByRole('heading',{name:'Create a shared wallet',exact:true}).waitFor();});
  await capture(`wallet-settings-navigation-${theme}`,'wallet-multiple',theme,380,async p=>{await p.locator('.wallet-selector-button').click();await p.getByRole('button',{name:'Wallet settings',exact:true}).click();await p.getByRole('heading',{name:'Settings',exact:true}).waitFor();await p.getByRole('heading',{name:'Manage wallet devices',exact:true}).waitFor();});
  await capture(`wallet-multiple-${theme}`,'wallet-multiple',theme,380,p=>p.locator('.wallet-selector-button').click());
  await capture(`wallet-switched-${theme}`,'wallet-multiple',theme,380,async p=>{await p.locator('.wallet-selector-button').click();await p.locator('.wallet-item').filter({hasText:'Savings wallet'}).click();await p.locator('.wallet-selector-button').filter({hasText:'Savings wallet'}).waitFor();if(await p.locator('.wallet-dropdown').count())throw Error('Wallet picker did not close after selection');});
  await capture(`hardware-discovery-error-${theme}`,'hardware-discovery-error',theme,380,async p=>{await p.getByRole('button',{name:'Add hardware or watch-only account',exact:true}).click();await p.getByRole('button',{name:/^YubiKey/}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();await p.getByRole('button',{name:'Refresh YubiKey',exact:true}).click();await p.getByText('Could not connect to YubiKey. Check the device and native host, then try again.',{exact:true}).waitFor();});
  await capture(`invite-declined-${theme}`,'invite',theme,380,async p=>{await p.getByRole('button',{name:'Decline',exact:true}).click();if(await p.getByRole('button',{name:'Accept & join',exact:true}).count())throw Error('Declined invitation remained visible');});
  await capture(`connected-app-disconnected-${theme}`,'settings-populated',theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:'Disconnect',exact:true}).click();await p.getByText('No dApps connected.',{exact:true}).waitFor();if(await p.getByRole('button',{name:'Disconnect',exact:true}).count())throw Error('Disconnected app remained visible');});
  await capture(`dkg-failed-${theme}`,'dkg-failed',theme,380,async p=>{await p.getByText('Wallet setup failed. Check your devices and try again.',{exact:true}).waitFor();if(await p.getByText('Generating keys — your wallet address will appear when complete.',{exact:true}).count())throw Error('Failed setup displayed generating keys');if(await p.getByText('Ready to sign',{exact:true}).count())throw Error('Failed DKG claimed Ready');});

  await capture(`signing-session-identity-${theme}`,'signing-progress',theme,380,async p=>{await p.getByText('Waiting for signatures',{exact:true}).waitFor();if(await p.getByText('Ready to sign',{exact:true}).count()||await p.getByText('Share setup',{exact:true}).count())throw Error('Wallet creation panel leaked into signing session');});
  for(const chain of ['bitcoin','solana','sui','qr-error'])await capture(`receive-${chain}-${theme}`,`receive-${chain}`,theme,380,p=>p.getByRole('button',{name:'Receive',exact:true}).click());
  for(const mode of ['password-error','password-busy'])await capture(`${mode}-${theme}`,mode,theme,380,async p=>{await p.getByRole('button',{name:'Unlock wallet',exact:true}).click();await p.getByPlaceholder('Enter password',{exact:true}).fill('public-wrong-password');await p.getByRole('button',{name:'Continue',exact:true}).click();if(mode==='password-error')await p.getByText('Incorrect password. Try again.',{exact:true}).waitFor();});
  await capture(`save-validation-${theme}`,'save-wallet',theme,380,async p=>{await p.getByPlaceholder('Password (at least 8 characters)').fill('public-password');await p.getByPlaceholder('Confirm password').fill('different-password');await p.getByRole('button',{name:'Encrypt & save',exact:true}).click();});
  await capture(`create-error-${theme}`,'create-error',theme,380,async p=>{await p.getByRole('button',{name:/Create wallet/}).click();await p.getByRole('button',{name:'Create wallet',exact:true}).last().click();});
  await capture(`sign-validation-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:/Sign message/}).click();await p.getByRole('button',{name:'Review',exact:true}).click();});
  await capture(`sign-preview-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:/Sign message/}).click();await p.getByPlaceholder('Type the message to sign…').fill('Public design review message');await p.getByRole('button',{name:'Review',exact:true}).click();});
  await capture(`hero-missing-prices-${theme}`,'hero-missing-prices',theme,380,async p=>{await p.getByLabel('Fiat value unavailable').waitFor();});
  await capture(`hero-reset-network-${theme}`,'hero-reset-network',theme,380,async p=>{await p.locator('div').filter({hasText:/^\$123$/}).waitFor();await p.evaluate(()=>window.__fixturePendingPortfolio=true);await p.locator('select').first().selectOption('11155111');await p.getByLabel('Fiat value unavailable').waitFor();if(await p.locator('div').filter({hasText:/^\$123$/}).count())throw Error('Old network fiat persisted');});
  await capture(`hero-reset-account-${theme}`,'hero-reset-account',theme,380,async p=>{await p.locator('div').filter({hasText:/^\$123$/}).waitFor();await p.evaluate(()=>window.__fixturePendingPortfolio=true);await p.locator('.acct-btn').click();await p.locator('.acct-item').filter({hasText:'Account 1'}).click();await p.getByLabel('Fiat value unavailable').waitFor();if(await p.locator('div').filter({hasText:/^\$123$/}).count())throw Error('Old account fiat persisted');});
  await capture(`hero-stale-response-${theme}`,'hero-stale-response',theme,380,async p=>{await p.getByLabel('Fiat value unavailable').waitFor();await p.evaluate(()=>{window.__fixtureOldPortfolioResolvers=window.__fixturePortfolioResolvers.splice(0);});await p.locator('select').first().selectOption('11155111');await p.evaluate(()=>{for(const resolve of window.__fixtureOldPortfolioResolvers)resolve({success:true,portfolio:{native:{balance:'1',fiat:999},tokens:[],totalFiat:999}});});await p.waitForTimeout(100);await p.getByLabel('Fiat value unavailable').waitFor();if(await p.locator('div').filter({hasText:/^\$999$/}).count())throw Error('Stale response overwrote network fiat');});
  await capture(`sign-completed-${theme}`,'funded',theme,380,async p=>{await p.evaluate(()=>window.__fixtureEmit({type:'signingCompleted',signingId:'public-design-signature',signature:'11'.repeat(65),messageHex:'44657369676e',blockchain:'ethereum',sessionId:'public-design'}));});
  await capture(`send-chain-reset-${theme}`,'send-chain-reset',theme,380,async p=>{await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByPlaceholder('0x… or name.eth').fill('0x46b471336610f695c6e3b42ea88dde5cc07f7412');await p.getByPlaceholder('0.0',{exact:true}).fill('0.05');await p.getByRole('button',{name:'Review transfer',exact:true}).click();await p.getByRole('button',{name:'Confirm send',exact:true}).waitFor();await p.locator('select[title="EVM network"]').selectOption({index:1});await p.getByRole('button',{name:'Review transfer',exact:true}).waitFor();if(await p.getByRole('button',{name:'Confirm send',exact:true}).count())throw Error('Prepared review survived chain change');});
  await capture(`send-account-reset-${theme}`,'send-account-reset',theme,380,async p=>{await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByPlaceholder('0x… or name.eth').fill('0x46b471336610f695c6e3b42ea88dde5cc07f7412');await p.getByPlaceholder('0.0',{exact:true}).fill('0.05');await p.getByRole('button',{name:'Review transfer',exact:true}).click();await p.getByRole('button',{name:'Confirm send',exact:true}).waitFor();await p.locator(".acct-btn").click();await p.locator(".acct-item").filter({hasText:"Account 1"}).click();await p.getByRole('button',{name:'Send',exact:true}).waitFor();if(!await p.getByRole('button',{name:'Send',exact:true}).isDisabled())throw Error('Unsupported account allowed Send');if(await p.getByRole('button',{name:'Confirm send',exact:true}).count())throw Error('Prepared review survived account change');});

  for(const mode of ['funded','zero','loading','error','offline','locked','onboarding','hardware','watch-only','invite','setup-waiting','setup-primes','setup-keygen','save-wallet','dapp-connect','dapp-sign','cosign-request','signing-progress'])await capture(`home-${mode}-${theme}`,mode,theme);
  await capture(`home-tab-${theme}`,'funded',theme,1280);
  await capture(`collectibles-${theme}`,'nft-gallery',theme,380,async p=>{await p.getByRole('button',{name:'Load collectibles',exact:true}).click();await p.getByText('Orbit study',{exact:true}).waitFor();});
  await capture(`receive-${theme}`,'funded',theme,380,p=>p.getByRole('button',{name:'Receive',exact:true}).click());
  await capture(`send-review-${theme}`,'fee-review',theme,380,async p=>{await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByPlaceholder('0x… or name.eth').fill('0x46b471336610f695c6e3b42ea88dde5cc07f7412');await p.getByPlaceholder('0.0',{exact:true}).fill('0.05');await p.getByRole('button',{name:'Review transfer',exact:true}).click();await p.getByRole('button',{name:'Confirm send',exact:true}).waitFor();});
  for(const mode of ['send-submitted','send-rejected'])await capture(`${mode}-${theme}`,mode,theme,380,async p=>{await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByPlaceholder('0x… or name.eth').fill('0x46b471336610f695c6e3b42ea88dde5cc07f7412');await p.getByPlaceholder('0.0',{exact:true}).fill('0.05');await p.getByRole('button',{name:'Review transfer',exact:true}).click();await p.getByRole('button',{name:'Confirm send',exact:true}).click();});
  await capture(`send-validation-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('button',{name:'Review transfer',exact:true}).click();});
  await capture(`send-${theme}`,'funded',theme,380,p=>p.getByRole('button',{name:'Send',exact:true}).click());
  await capture(`create-${theme}`,'funded',theme,380,p=>p.getByRole('button',{name:/Create wallet/}).click());
  await capture(`sign-${theme}`,'funded',theme,380,p=>p.getByRole('button',{name:/Sign message/}).click());
  await capture(`settings-populated-${theme}`,'settings-populated',theme,380,p=>p.getByRole('button',{name:'Settings',exact:true}).click());
  await capture(`devices-replacement-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:'Replace device',exact:true}).click();});
  await capture(`policy-saved-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:'Save policy',exact:true}).click();});
  await capture(`backup-validation-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByText('I understand this file contains key material',{exact:true}).click();await p.getByRole('button',{name:'Export share backup',exact:true}).click();});
  await capture(`backup-export-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByText('I understand this file contains key material',{exact:true}).click();await p.getByPlaceholder('Backup password (8+ characters)').fill('public-fixture-password');await p.getByPlaceholder('Confirm backup password').fill('public-fixture-password');await p.getByRole('button',{name:'Export share backup',exact:true}).click();});
  for(const mode of ['restore-ready','restore-error','restore-success'])await capture(`${mode}-${theme}`,mode,theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByText('Restore from backup',{exact:true}).click();await p.locator('#restore-files').setInputFiles({name:'public-backup-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({encrypted:true,publicFixture:true}))});await p.getByPlaceholder('Password used to encrypt this backup').fill('public-fixture-password');if(mode!=='restore-ready')await p.getByRole('button',{name:'Restore wallet',exact:true}).click();});
  await capture(`settings-${theme}`,'funded',theme,380,p=>p.getByRole('button',{name:'Settings',exact:true}).click());
  await capture(`account-options-${theme}`,'funded',theme,380,p=>p.getByRole('button',{name:'Add hardware or watch-only account',exact:true}).click());
  await capture(`wallet-picker-${theme}`,'funded',theme,380,p=>p.locator('.wallet-selector-button').click());
  await capture(`account-picker-${theme}`,'funded',theme,380,p=>p.locator('.acct-btn').click());
  await capture(`custom-network-${theme}`,'funded',theme,380,async p=>{await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:'Add custom network',exact:true}).click();});
  await capture(`unlock-${theme}`,'locked',theme,380,p=>p.getByRole('button',{name:'Unlock wallet',exact:true}).click());
 }
 await captureEdgeSettings(capture);
 await captureEdgeApprovals(capture);
} finally {await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2));await browser.close();server.close();}
console.log(JSON.stringify({output,captures:manifest.length,pageErrors:manifest.filter(x=>x.errors.length)}));
