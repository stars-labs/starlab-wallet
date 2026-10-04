/** Actual production-component material and interaction evidence, public fixtures. */
const send = p => p.getByRole('button', {name:'Send', exact:true});
async function review(p) {
 await send(p).click();
 await p.getByPlaceholder('0x… or name.eth').fill('0x46b471336610f695c6e3b42ea88dde5cc07f7412');
 await p.getByPlaceholder('0.0',{exact:true}).fill('0.05');
 await p.getByRole('button',{name:'Review transfer',exact:true}).click();
 await p.getByRole('button',{name:'Confirm send',exact:true}).waitFor();
}
async function materialEvidence(p) {
 return p.evaluate(()=>{
  const style=selector=>{const s=getComputedStyle(document.querySelector(selector));return {background:s.background,backdropFilter:s.backdropFilter,boxShadow:s.boxShadow};};
  const body=style('body'),hero=style('.hero'),header=style('.wallet-header'),card=style('.card');
  if(card.backdropFilter!=='none')throw Error('Ordinary card has expensive blur');
  if(hero.backdropFilter==='none'||header.backdropFilter==='none')throw Error('Key structural glass blur missing');
  if(!body.background.includes('radial-gradient'))throw Error('Ambient light missing');
  return {body,hero,header,card};
 });
}
export async function capturePremium(capture) {
 for(const theme of ['light','dark']) {
  for(const width of [380,1280]) {
   const size=width===380?'popup':'wide';
   await capture(`premium-home-${size}-${theme}`,'premium-funded',theme,width,materialEvidence);
   await capture(`premium-send-review-${size}-${theme}`,'fee-review',theme,width,review);
   await capture(`premium-settings-${size}-${theme}`,'settings-populated',theme,width,p=>p.getByRole('button',{name:'Settings',exact:true}).click());
   await capture(`premium-modal-${size}-${theme}`,'locked',theme,width,async p=>{
    await p.getByRole('button',{name:'Unlock wallet',exact:true}).click();
    await p.getByRole('dialog').waitFor();
    return p.locator('.modal-panel').evaluate(el=>({animationName:getComputedStyle(el).animationName,background:getComputedStyle(el).background}));
   });
  }
  await capture(`premium-hover-${theme}`,'premium-funded',theme,380,async p=>{
   await send(p).hover();await p.waitForTimeout(180);
   const style=await send(p).evaluate(el=>({transform:getComputedStyle(el).transform,boxShadow:getComputedStyle(el).boxShadow}));
   if(style.transform==='none')throw Error('Hover feedback missing');return style;
  });
  await capture(`premium-pressed-${theme}`,'premium-funded',theme,380,async p=>{
   await send(p).hover();await p.mouse.down();await p.waitForTimeout(180);
   const transform=await send(p).evaluate(el=>getComputedStyle(el).transform);
   if(transform==='none')throw Error('Press feedback missing');return {transform};
  });
  await capture(`premium-focus-${theme}`,'premium-funded',theme,380,async p=>{
   await p.keyboard.press('Tab');await send(p).focus();
   const focus=await send(p).evaluate(el=>({visible:el.matches(':focus-visible'),outline:getComputedStyle(el).outline}));
   if(!focus.visible||focus.outline.includes('none'))throw Error('Keyboard focus missing');return focus;
  });
  await capture(`premium-reduced-motion-${theme}`,'locked',theme,380,async p=>{
   await p.emulateMedia({reducedMotion:'reduce'});
   await p.getByRole('button',{name:'Unlock wallet',exact:true}).click();
   await p.getByRole('dialog').waitFor();
   const motion=await p.locator('.modal-panel').evaluate(el=>({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,animation:getComputedStyle(el).animationName,transition:getComputedStyle(el).transitionDuration}));
   if(!motion.reduced||motion.animation!=='none'||motion.transition!=='0s')throw Error('Reduced motion not honored');return motion;
  });
 }
}
