import pathlib, subprocess, json, os
root=pathlib.Path('/private/tmp/parqsee-crash-0915')
fixtures=pathlib.Path('/private/tmp/parqsee-crash-0915-fixtures')
bridge='/Users/k0kishima/work/fuji/parqsee/backend/target/debug/examples/bridge'
base=(fixtures/'one_row.parquet').read_bytes()
results=[]
(root/'mutations').mkdir(exist_ok=True)
for n,pos in enumerate(sorted(set([0,3,4,8,16,24,len(base)-1,len(base)-5,len(base)-8]+[int(i*(len(base)-1)/24) for i in range(25)]))):
    data=bytearray(base);data[pos]^=0xff
    path=root/'mutations'/f'flip-{pos}.parquet';path.write_bytes(data)
    commands=[{'id':1,'cmd':'open_parquet_file','args':{'path':str(path)}},{'id':2,'cmd':'read_parquet_data','args':{'path':str(path),'offset':0,'limit':50}},{'id':3,'cmd':'read_parquet_data','args':{'path':str(fixtures/'one_row.parquet'),'offset':0,'limit':50}}]
    try:
        p=subprocess.run([bridge],input=''.join(json.dumps(c)+'\n' for c in commands),text=True,capture_output=True,timeout=8,env={**os.environ,'PARQSEE_DATA_DIR':str(root/'mutation-data'/str(n))})
        responses=[json.loads(l) for l in p.stdout.splitlines()]
        r={'offset':pos,'exit':p.returncode,'responses':responses,'stderr':p.stderr[-1500:],'healthy_read':any(x.get('id')==3 and 'ok' in x for x in responses)}
    except subprocess.TimeoutExpired as e:r={'offset':pos,'timeout':True,'stderr':str(e.stderr)[-1500:]}
    results.append(r)
(root/'mutations.json').write_text(json.dumps(results,indent=2))
print(json.dumps({'cases':len(results),'nonzero':[r['offset'] for r in results if r.get('exit')!=0],'panic':[r['offset'] for r in results if 'panicked' in r.get('stderr','')],'unhealthy':[r['offset'] for r in results if not r.get('healthy_read')],'missing_responses':[r['offset'] for r in results if len(r.get('responses',[]))!=3]}))
