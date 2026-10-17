import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
const host = (p, kind = 'human') => p.locator(`#${kind}`);
const shell = (p, kind = 'human') => host(p, kind).locator('.shell');
const state = (p, value, kind) => expect(shell(p, kind)).toHaveAttribute('data-state', value);
const response = (p, kind = 'human') => p.evaluate(kind => window.demo.sdk.getResponse(window.demo.ids[kind]), kind);
async function mount(p, options = {}, kind = 'human') { await p.evaluate(({options,kind}) => window.demo.mount(kind, options), {options,kind}); }
async function start(p, kind = 'human') { await state(p,'idle',kind); await host(p,kind).getByRole('checkbox').click(); await state(p,'pending',kind); }
const approve = (p, status = 'approved', mode = 'human') => p.evaluate(({status,mode}) => window.demo.setStatus(status,mode),{status,mode});
test.beforeEach(async ({page:p}) => {
  await p.goto('/'); await p.waitForFunction(()=>window.demo); await p.locator('#auto').uncheck();
  await state(p,'idle'); await state(p,'idle','age');
  await p.evaluate(()=>{ window.demo.clear(); window.demo.settings.createDelay=20; });
});
test('public API uses opaque response, real QR and automatic form field', async ({page:p},info)=>{
  await p.evaluate(()=>{const form=document.createElement('form');form.id='test-form';document.body.append(form);form.append(document.getElementById('human'));});
  await mount(p,{action:'signup',cData:'context_1'});
  await state(p,'idle'); const box=await host(p).locator('[id^=bkey-widget]').boundingBox(); expect(box.width).toBe(300);expect(box.height).toBe(65);
  expect(await response(p)).toBe('');
  const request=await p.evaluate(()=>[...window.demo.requests.values()][0]);expect(request.sitekey).toBe('demo-human-sitekey');expect(request.action).toBe('signup');expect(request.cData).toBe('context_1');
  await start(p); await expect.poll(async()=>(await shell(p).boundingBox()).height).toBe(390);
  const png=PNG.sync.read(await host(p).locator('.qr').screenshot());expect(jsQR(new Uint8ClampedArray(png.data),png.width,png.height)?.data).toBe(request.qrPayload);
  await approve(p,'scanned');await state(p,'scanned');expect(await response(p)).toBe('');
  await approve(p);await state(p,'verified');await expect.poll(async()=>(await shell(p).boundingBox()).height).toBe(65);
  await expect.poll(()=>host(p).locator('.mark').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(33, 131, 76)');
  const token=await response(p);expect(token).toMatch(/^demo-response-/);expect(token).not.toBe(request.requestId);
  expect(await p.evaluate(()=>window.demo.events.filter(e=>e.type==='success').map(e=>e.detail))).toEqual([token]);
  expect(await p.evaluate(()=>new FormData(document.querySelector('#test-form')).get('bkey-response'))).toBe(token);
  expect(await p.evaluate(()=>[window.demo.sdk.getResponse(),window.demo.sdk.getResponse('#human'),window.demo.sdk.getResponse(document.getElementById('human'))])).toEqual([token,token,token]);
  await p.screenshot({path:info.outputPath('verified.png'),fullPage:true});
});
for(const [operator,age,label] of [
 ['gte',{operator:'gte',value:16},'Verify I’m 16 or older'],
 ['lte',{operator:'lte',value:12},'Verify I’m 12 or younger'],
 ['eq',{operator:'eq',value:21},'Verify I’m exactly 21'],
 ['range',{operator:'range',min:12,max:18},'Verify age: 12 to 18'],
]) test(`age ${operator}: conditions, labels, matching approval`,async({page:p},info)=>{
 await p.evaluate(age=>window.demo.policies.set('demo-age-sitekey',{mode:'age',age}),age);await mount(p,{},'age');await state(p,'idle','age');await expect(host(p,'age').getByRole('checkbox')).toHaveAccessibleName(label);
 await start(p,'age');expect(await p.evaluate(()=>[...window.demo.requests.values()][0].age)).toEqual(age);
 await approve(p,'approved','age');await state(p,'verified','age');expect(await response(p,'age')).toMatch(/^demo-response-/);
 await p.screenshot({path:info.outputPath(`age-${operator}.png`),fullPage:true});
});
test('adult status has no requested age or locale',async({page:p})=>{
 await p.evaluate(()=>window.demo.policies.set('demo-age-sitekey',{mode:'ageOfMajority'}));await mount(p,{},'age');await start(p,'age');
 const request=await p.evaluate(()=>[...window.demo.requests.values()][0]);expect(request.mode).toBe('ageOfMajority');expect(request.age).toBeUndefined();expect(request.locale).toBeUndefined();
 await approve(p,'approved','ageOfMajority');await state(p,'verified','age');
});
for(const scenario of ['bad-url','bad-create-mode','bad-id','bad-status-mode','unknown','error','missing-response','bad-create-age','bad-status-age']) {
 test(`reject ${scenario}`,async({page:p})=>{
  await p.evaluate(s=>{window.demo.settings.scenario=s;},scenario);
  const age=scenario.includes('-age');const kind=age?'age':'human';
  await mount(p,{},kind);
  if(!['bad-url','bad-create-mode','bad-create-age','error'].includes(scenario)) {await start(p,kind);await approve(p,'approved',age?'age':'human');}
  await state(p,'error',kind);expect(await response(p,kind)).toBe('');
  expect(await p.evaluate(()=>window.demo.events.some(e=>e.type==='success'))).toBe(false);
  await p.evaluate(()=>{window.demo.settings.scenario='normal';});
  await p.evaluate(kind=>window.demo.sdk.reset(window.demo.ids[kind]),kind);await start(p,kind);await approve(p,'approved',age?'age':'human');await state(p,'verified',kind);
 });
}
test('execute mode waits, repeated execute does not overlap',async({page:p})=>{
 await mount(p,{execution:'execute'});await state(p,'idle');expect(await p.evaluate(()=>window.demo.calls.create)).toBe(0);
 await expect(host(p).getByRole('checkbox')).toBeDisabled();
 await p.evaluate(()=>{window.demo.settings.statusDelay=1500;const b=window.demo.sdk,id=window.demo.ids.human;b.execute(id);b.execute(id);b.execute(id);});
 await state(p,'pending');await expect.poll(()=>p.evaluate(()=>window.demo.calls.status),{timeout:9000}).toBeGreaterThanOrEqual(2);
 expect(await p.evaluate(()=>window.demo.calls.create)).toBe(1);expect(await p.evaluate(()=>window.demo.calls.maxActive)).toBe(1);
});
test('reset, form reset, expiry and denied callbacks clear form values',async({page:p})=>{
 await p.clock.install();
 await p.evaluate(()=>{const form=document.createElement('form');form.id='test-form';document.body.append(form);form.append(document.getElementById('human'));window.demo.settings.responseLifetime=6000;});
 await mount(p);await start(p);await approve(p);await state(p,'verified');
 await p.clock.fastForward(6500);expect(await response(p)).toBe('');expect(await p.evaluate(()=>window.demo.sdk.isExpired())).toBe(true);
 expect(await host(p).locator('input').inputValue()).toBe('');expect(await p.evaluate(()=>window.demo.events.filter(e=>e.type==='expired').length)).toBe(1);
 await p.evaluate(()=>window.demo.sdk.reset());await start(p);await approve(p);await state(p,'verified');
 await p.evaluate(()=>document.querySelector('#test-form').reset());await state(p,'idle');expect(await response(p)).toBe('');
 await start(p);await approve(p,'denied');await state(p,'denied');expect(await response(p)).toBe('');
 expect(await p.evaluate(()=>window.demo.events.some(e=>e.type==='denied'))).toBe(true);
});
test('formdata cannot submit a just-expired response before the timer runs',async({page:p})=>{
 await p.clock.install();
 await p.evaluate(()=>{const form=document.createElement('form');form.id='test-form';document.body.append(form);form.append(document.getElementById('human'));});
 await mount(p);await start(p);await approve(p);await state(p,'verified');expect(await host(p).locator('input').inputValue()).not.toBe('');
 await p.clock.setSystemTime(new Date(Date.now()+3600000));
 expect(await p.evaluate(()=>new FormData(document.querySelector('#test-form')).get('bkey-response'))).toBe('');
});
test('independent widgets and custom or disabled response fields',async({page:p})=>{
 await mount(p,{'response-field-name':'cf-turnstile-response'});await mount(p,{'response-field':false},'age');
 await start(p);await start(p,'age');await approve(p,'approved','age');await state(p,'verified','age');expect(await response(p)).toBe('');
 await expect(host(p,'age').locator('input')).toHaveCount(0);await approve(p);await state(p,'verified');await expect(host(p).locator('input[name=cf-turnstile-response]')).toHaveValue(await response(p));
});
test('remove cancels late responses and preserves host content',async({page:p})=>{
 await p.evaluate(()=>{window.demo.settings.scenario='late';window.demo.settings.createDelay=900;document.getElementById('human').append(Object.assign(document.createElement('span'),{textContent:'Keep me'}));});
 await mount(p);await state(p,'loading');await p.evaluate(()=>window.demo.sdk.remove(window.demo.ids.human));
 await p.waitForTimeout(1100);await expect(host(p)).toHaveText('Keep me');await expect(host(p).locator('input')).toHaveCount(0);
 expect(await p.evaluate(()=>window.demo.events.some(e=>e.type==='success'))).toBe(false);
});
test('external host removal disposes request without callbacks',async({page:p})=>{
 await mount(p);await start(p);await p.evaluate(()=>document.getElementById('human').remove());
 await p.waitForTimeout(50);expect(await p.evaluate(()=>{try{window.demo.sdk.getResponse(window.demo.ids.human);return false;}catch{return true;}})).toBe(true);
});
test('invalid config and duplicate render leave no partial widget',async({page:p})=>{
 const errors=await p.evaluate(()=>{
  const bad=[{sitekey:''},{mode:'age',age:{operator:'range',min:25,max:18}},{mode:'age',age:{operator:'eq',value:16.5}},{mode:'ageOfMajority',age:{operator:'gte',value:12}},{size:'compact'},{unsupported:true},{action:123},{cData:123}];
  return bad.map(options=>{try{window.demo.sdk.render('#human',{sitekey:'demo',...options});return false;}catch{return true;}});
 });expect(errors.every(Boolean)).toBe(true);await expect(host(p).locator('[id^=bkey-widget]')).toHaveCount(0);
 await mount(p);expect(await p.evaluate(()=>{try{window.demo.sdk.render('#human',{sitekey:'demo'});return false;}catch{return true;}})).toBe(true);
 await expect(host(p).locator('[id^=bkey-widget]')).toHaveCount(1);
});
for(const scenario of ['hung-create','hung-status']) test(`${scenario} timeout`,async({page:p})=>{
 await p.clock.install();await p.evaluate(s=>{window.demo.settings.scenario=s;},scenario);await mount(p);
 if(scenario==='hung-status'){await start(p);await expect.poll(()=>p.evaluate(()=>window.demo.calls.status)).toBe(1);}else await p.waitForTimeout(100);
 await p.clock.fastForward(16000);await state(p,'error');expect(await response(p)).toBe('');
});
test('dark, keyboard, reduced motion, flexible size and centered checkmark',async({page:p},info)=>{
 await p.emulateMedia({reducedMotion:'reduce'});await mount(p,{theme:'dark',size:'flexible'});await state(p,'idle');
 const checkbox=host(p).getByRole('checkbox');await checkbox.focus();await p.keyboard.press('Space');await state(p,'pending');
 await p.keyboard.press('Tab');await expect(host(p).getByRole('button',{name:'Cancel verification'})).toBeFocused();
 await p.keyboard.press('Escape');await state(p,'idle');await expect(checkbox).toBeFocused();
 await start(p);await expect.poll(()=>shell(p).evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
 expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await p.screenshot({path:info.outputPath('dark-qr.png'),fullPage:true});
 await approve(p);await state(p,'verified');const delta=await host(p).locator('.mark').evaluate(el=>{const a=el.getBoundingClientRect(),b=el.querySelector('.tick svg').getBoundingClientRect();return [b.x+b.width/2-a.x-a.width/2,b.y+b.height/2-a.y-a.height/2];});expect(delta).toEqual([0,0]);
});
test('classic script supports ready, onload, implicit rendering and token callback',async({page:p})=>{
 await p.route('**/fixture',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><form id="form"><div class="bkey-captcha" data-sitekey="test" data-execution="execute" data-callback="approved"></div></form><script>
 window.approved=response=>window.received=response;
 window.setup=()=>bkey.configure({transport:{create:async input=>({requestId:'r1',mode:'human',qrPayload:'bkey://captcha?id=r1',expiresAt:new Date(Date.now()+60000).toISOString(),pollAfterMs:1000}),status:async input=>({requestId:input.requestId,mode:'human',status:'approved',response:'opaque-response',responseExpiresAt:new Date(Date.now()+300000).toISOString()})}});
 </script><script src="/dist/api.js?onload=setup"></script></body></html>`}));
 await p.goto('/fixture');await expect(p.locator('.shell')).toHaveAttribute('data-state','idle');
 await p.evaluate(()=>bkey.execute());await expect.poll(()=>p.evaluate(()=>window.received)).toBe('opaque-response');
 expect(await p.evaluate(()=>new FormData(document.getElementById('form')).get('bkey-response'))).toBe('opaque-response');
 expect(await p.evaluate(()=>typeof window.turnstile)).toBe('undefined');
});

test('execute can mount a container directly with options',async({page:p})=>{
 await p.evaluate(()=>window.demo.sdk.execute('#human',{sitekey:'demo-human-sitekey',callback:token=>window.directToken=token}));
 await state(p,'pending');await approve(p);await state(p,'verified');
 expect(await p.evaluate(()=>window.directToken)).toBe(await p.evaluate(()=>window.demo.sdk.getResponse('#human')));
 expect(await p.evaluate(()=>window.demo.calls.create)).toBe(1);
});


test('browser options cannot select a check; transport inputs omit policy', async ({page:p}, info) => {
 const errors=await p.evaluate(()=>[
  {mode:'human'}, {mode:'age',age:{operator:'gte',value:1}}, {age:{operator:'gte',value:1}}, {check:{mode:'human'}}
 ].map(option=>{try{window.demo.sdk.render('#age',{sitekey:'demo-age-sitekey',...option});return false;}catch{return true;}}));
 expect(errors).toEqual([true,true,true,true]);
 await mount(p,{},'age');await start(p,'age');await approve(p,'approved','age');await state(p,'verified','age');
 const inputs=await p.evaluate(()=>window.demo.inputs);
 expect(inputs.length).toBeGreaterThanOrEqual(2);
 for(const input of inputs){expect(input.sitekey).toBe('demo-age-sitekey');expect(input).not.toHaveProperty('mode');expect(input).not.toHaveProperty('age');expect(input).not.toHaveProperty('check');}
 await info.attach('transport-inputs', {body:JSON.stringify(inputs,null,2),contentType:'application/json'});
});
test('reset reads the new service policy and deferred widgets make no age claim', async ({page:p}) => {
 await mount(p,{execution:'execute'},'age');await expect(host(p,'age').getByRole('checkbox')).toHaveAccessibleName('Verify with bkey');
 await p.evaluate(()=>window.demo.sdk.execute(window.demo.ids.age));await state(p,'pending','age');
 await p.evaluate(()=>{window.demo.policies.set('demo-age-sitekey',{mode:'age',age:{operator:'gte',value:21}});window.demo.sdk.reset(window.demo.ids.age);});
 await expect(host(p,'age').getByRole('checkbox')).toHaveAccessibleName('Verify with bkey');
 await p.evaluate(()=>window.demo.sdk.execute(window.demo.ids.age));await state(p,'pending','age');
 await approve(p,'approved','age');await state(p,'verified','age');await expect(host(p,'age')).toContainText('21 or older');
});
for(const attribute of ['data-mode="human"',`data-age='{"operator":"gte","value":1}'`]) test(`classic script rejects ${attribute}`,async({page:p})=>{
 const errors=[];p.on('pageerror',error=>errors.push(error.message));
 await p.route('**/fixture',route=>route.fulfill({contentType:'text/html',body:`<div class="bkey-captcha" data-sitekey="test" ${attribute}></div><script src="/dist/api.js"></script>`}));
 await p.goto('/fixture');await expect.poll(()=>errors.some(message=>message.includes('configured on the sitekey'))).toBe(true);await expect(p.locator('.shell')).toHaveCount(0);
});
