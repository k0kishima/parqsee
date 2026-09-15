import fs from 'node:fs';
import {launch,waitGrid,OUT,SAMPLE} from '/Users/k0kishima/work/fuji/parqsee/scripts/qa/e2e/lib.mjs';
import {screenshot} from '/Users/k0kishima/work/fuji/parqsee/scripts/qa/e2e/runner.mjs';
const files=Array.from({length:24},(_,i)=>`${OUT}/batch-${i}.parquet`);
for(const f of files)fs.copyFileSync(SAMPLE,f);
const dataDir=`${OUT}/batch-data`;
const observations=[];
let h=await launch({dataDir});
try{
 await h.page.evaluate(paths=>window.__emit('file-drop',paths),files);
 await h.page.waitForFunction(()=>document.querySelectorAll('[title^="Close tab"]').length===24,null,{timeout:30000});
 await waitGrid(h.page,30000);
 observations.push({phase:'24-file-drop',tabs:await h.page.locator('[title^="Close tab"]').count(),errors:[...h.page.__errors]});
 await h.page.waitForTimeout(400);
 await screenshot(h.page,{path:`${OUT}/shots/24-tabs.png`});
 await h.close();
 h=await launch({dataDir});
 await h.page.waitForFunction(()=>document.querySelectorAll('[title^="Close tab"]').length===24,null,{timeout:30000});await waitGrid(h.page);
 observations.push({phase:'24-tab-restore',tabs:await h.page.locator('[title^="Close tab"]').count(),errors:[...h.page.__errors]});
 for(let i=0;i<24;i++)await h.page.locator('[title^="Close tab"]').last().click();
 await h.page.waitForFunction(()=>document.querySelectorAll('[title^="Close tab"]').length===0);
 await h.page.getByRole('button',{name:/Open the sample file/i}).click();await h.page.waitForSelector('tbody');await waitGrid(h.page);
 observations.push({phase:'close-all-and-open-sample',body:(await h.page.locator('body').innerText()).slice(0,300),tabs:await h.page.locator('[title^="Close tab"]').count(),errors:[...h.page.__errors]});
}catch(e){observations.push({exception:String(e),errors:[...h.page.__errors]});}finally{await h.close();}
fs.writeFileSync(`${OUT}/stress.json`,JSON.stringify(observations,null,2));console.log(JSON.stringify(observations));
