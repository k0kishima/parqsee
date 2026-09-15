import fs from 'node:fs';
import {launch,dropFile,waitGrid,FIX,OUT,release} from '/Users/k0kishima/work/fuji/parqsee/scripts/qa/e2e/lib.mjs';
import {screenshot} from '/Users/k0kishima/work/fuji/parqsee/scripts/qa/e2e/runner.mjs';
const results=[];
const active=p=>p.locator('div[style*="position: absolute"][style*="display: flex"]');
async function snapshot(h,id,extra={}) {
  await screenshot(h.page,{path:`${OUT}/shots/${id}.png`}).catch(()=>{});
  const r={id,...extra,errors:[...h.page.__errors],text:(await h.page.locator('body').innerText()).slice(0,4000),exitCode:h.bridge.proc.exitCode,signal:h.bridge.proc.signalCode};
  results.push(r);fs.writeFileSync(`${OUT}/exploration.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(r));
}
async function open(h,file='one_row.parquet') {
 await dropFile(h.page,`${FIX}/${file}`);
 await h.page.waitForFunction(()=>document.querySelector('tbody')||document.body.innerText.includes('Unexpected Application Error'),null,{timeout:10000});
 await waitGrid(h.page);
}
for (const [id,settings] of Object.entries({normal:{},density_null:{rowDensity:null},density_unknown:{rowDensity:'dense'},rows_zero:{rowsPerPage:0},rows_negative:{rowsPerPage:-1},rows_string:{rowsPerPage:'50'},language_null:{language:null}})) {
 const h=await launch({localStorage:{'parqsee-settings':JSON.stringify(settings)}});
 try {await open(h);await snapshot(h,id,{settings});}catch(e){await snapshot(h,id,{settings,exception:String(e)});}finally{await h.close();}
}
const h=await launch();
try{
 await open(h,'multi_rowgroup.parquet');
 await active(h.page).getByRole('button',{name:'Query',exact:true}).click();
 const queries=["SELECT 1 AS x, 2 AS x", "SELECT arrow_cast(9223372036854775807, 'Timestamp(Nanosecond, None)') AS edge", "SELECT CAST('not a number' AS BIGINT)", "SELECT 1 / 0 AS division", "SELECT * FROM t WHERE id IN ("+Array.from({length:2000},(_,i)=>i).join(',')+")", "SELECT "+'('.repeat(200)+'1'+')'.repeat(200), "SELECT 42 AS recovered"];
 for(let i=0;i<queries.length;i++){
  await active(h.page).locator('textarea').fill(queries[i]);await active(h.page).getByRole('button',{name:/^Run/}).click();
  await h.page.waitForTimeout(100);await waitGrid(h.page,20000);await snapshot(h,`sql-${i}`,{query:queries[i].slice(0,250)});
 }
 await h.page.evaluate(()=>window.__hold('execute_sql'));
 await active(h.page).locator('textarea').fill('SELECT count(*) AS n FROM t');await active(h.page).getByRole('button',{name:/^Run/}).click();
 await h.page.waitForTimeout(300);await h.page.locator('[title^="Close tab"]').click();await open(h);
 await release(h.page,'execute_sql');await waitGrid(h.page);await snapshot(h,'close-running-query');
 for(let i=0;i<12;i++){
  await open(h, i%2?'numeric.parquet':'nested.parquet');
  await h.page.locator('[title^="Close tab"]').last().click();
 }
 await snapshot(h,'rapid-open-close',{cycles:12});
}catch(e){await snapshot(h,'sql-exception',{exception:String(e)});}finally{await h.close();}
