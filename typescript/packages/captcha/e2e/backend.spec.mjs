import {test,expect} from '@playwright/test';
const id='12345678-1234-1234-1234-123456789abc';
const poll='p'.repeat(43);
async function setup(page, invalid=false) {
 await page.goto('/demo/integration-guide.html');
 await page.route('https://api.bkey.id/v1/captcha/requests**',async route=>{
  const req=route.request();
  expect(req.headers().cookie).toBeUndefined();
  if(req.method()==='POST') {
   expect(req.postDataJSON()).toEqual({sitekey:'test-sitekey'});
   await route.fulfill({json:{mode:'human',requestId:id,qrPayload:`https://bkey.id/verify?request_id=${id}`,expiresAt:new Date(Date.now()+60000).toISOString(),pollToken:invalid?'bad':poll}});
  } else {
   expect(req.headers()['x-bkey-poll-token']).toBe(poll);
   expect(req.url()).not.toContain(poll);
   await route.fulfill({json:{mode:'human',requestId:id,status:'approved',token:'result-token',expiresAt:new Date(Date.now()+60000).toISOString()}});
  }
 });
 await page.evaluate(async()=>{
  window.sdk=await import('/dist/index.js');
  document.body.innerHTML='<form><div id="widget"></div></form>';
  window.widget=window.sdk.render('#widget',{sitekey:'test-sitekey',callback:t=>window.result=t});
 });
}
test('default transport creates QR and maps approval without exposing poll token',async({page},info)=>{
 await setup(page);
 await page.getByRole('checkbox').click();
 await expect.poll(()=>page.evaluate(()=>window.result)).toBe('result-token');
 expect(await page.locator('[name="bkey-response"]').inputValue()).toBe('result-token');
 expect(await page.content()).not.toContain(poll);
 expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);
 await page.screenshot({path:info.outputPath('backend-success.png')});
});
test('bad polling credential fails closed',async({page})=>{
 await setup(page,true);
 await expect(page.locator('.shell')).toHaveAttribute('data-state','error');
 expect(await page.evaluate(()=>window.sdk.getResponse())).toBe('');
});
test('unsupported backend context is rejected before creation',async({page})=>{
 await page.goto('/demo/integration-guide.html');
 const error=await page.evaluate(async()=>{
  const sdk=await import('/dist/index.js');const host=document.createElement('div');document.body.append(host);
  try {sdk.render(host,{sitekey:'test',action:'signup'});}catch(e){return e.message;}
 });
 expect(error).toContain('action');
});
