import fs from 'node:fs';
import {launch,dropFile,waitGrid,FIX,OUT} from '/Users/k0kishima/work/fuji/parqsee/scripts/qa/e2e/lib.mjs';
import {screenshot} from '/Users/k0kishima/work/fuji/parqsee/scripts/qa/e2e/runner.mjs';
const saved=[];
const dataDir=`${OUT}/shared-data`;
let h=await launch({dataDir});
await dropFile(h.page,`${FIX}/one_row.parquet`);
await h.page.waitForSelector('tbody');await waitGrid(h.page);
await h.page.waitForFunction(()=>document.querySelector('tbody td')?.textContent==='x');
await h.page.waitForTimeout(400);
let settings=await h.page.evaluate(()=>localStorage.getItem('parqsee-settings'));
saved.push({phase:'baseline',settings,session:JSON.parse(fs.readFileSync(`${dataDir}/bookmarks.json`)),errors:[...h.page.__errors]});
await h.close();
settings=JSON.stringify({...JSON.parse(settings),rowDensity:null});
for(let n=0;n<2;n++){
 h=await launch({dataDir,localStorage:{'parqsee-settings':settings}});
 await h.page.waitForTimeout(500);
 await screenshot(h.page,{path:`${OUT}/shots/restart-${n}.png`});
 saved.push({phase:`restart-${n}`,rootChildren:await h.page.locator('#root').evaluate(el=>el.childElementCount),body:await h.page.locator('body').innerText(),errors:[...h.page.__errors],exitCode:h.bridge.proc.exitCode});
 await h.close();
}
h=await launch({dataDir,localStorage:{'parqsee-settings':JSON.stringify({...JSON.parse(settings),rowDensity:'comfortable'})}});
await h.page.waitForSelector('tbody');await waitGrid(h.page);
saved.push({phase:'repaired-setting-only',body:await h.page.locator('body').innerText(),errors:[...h.page.__errors]});
await screenshot(h.page,{path:`${OUT}/shots/recovered.png`});
await h.close();
fs.writeFileSync(`${OUT}/recheck.json`,JSON.stringify(saved,null,2));console.log(JSON.stringify(saved));
