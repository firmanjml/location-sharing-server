// Optional local Postman CLI smoke check. No requests leave loopback.
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'receiver-smoke-'));
const token = randomBytes(32).toString('hex');
const adminToken = randomBytes(32).toString('hex');
const locationFile = join(directory, 'locations.jsonl');
const child = spawn(process.execPath, ['index.mjs'], {cwd: root,
  env: {...process.env, HOST: '127.0.0.1', PORT: '0', DEMO_TOKEN: token, ADMIN_TOKEN: adminToken,
    LOCATIONS_FILE: locationFile, RESPONSE_INTERVAL_SECONDS: '20'}, stdio: ['ignore','pipe','pipe']});
try {
  const baseUrl = await new Promise((resolveURL, reject) => {
    const timer = setTimeout(() => reject(new Error('Receiver startup timed out')), 10000);
    let output = '';
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', code => {clearTimeout(timer); reject(new Error(`Receiver exited: ${code}`));});
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {clearTimeout(timer); resolveURL(match[0]);}
    });
  });
  const environment = join(directory, 'local.postman_environment.json');
  await writeFile(environment, JSON.stringify({name:'local receiver smoke', values:[
    {key:'base_url',value:baseUrl,enabled:true},{key:'token',value:token,type:'secret',enabled:true},
    {key:'admin_token',value:adminToken,type:'secret',enabled:true}]}), {mode:0o600});
  const uuid = '6b5c48a1-dc93-4fce-8876-825e797b21ea';
  const record = {uuid, timestamp:new Date().toISOString(), coords:{latitude:1.3521,longitude:103.8198,accuracy:8,altitude:null,speed:null,heading:null},extras:{source:'postman-local-test'}};
  const body = JSON.stringify({location:record});
  const run = (method, path, args, script, expectedError = false) => {
    const result = spawnSync('postman', ['request',method,`{{base_url}}${path}`,
      '-e',environment,'--timeout','10000','--no-report-events','--script-post-request',script,...args],
      {encoding:'utf8',timeout:30000});
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    // This CLI version returns 1 for HTTP 401 even when its assertion passes.
    // Accept that expected error only when Postman reports the assertion passed.
    assert.ok(result.status === 0 || expectedError && result.status === 1 && /tests[^\n]*1 passed/.test(result.stdout)
      && !/tests[^\n]*failed/.test(result.stdout), `Postman ${method} ${path} assertions failed`);
  };
  run('GET','/health',[],"pm.test('health is available', () => {pm.response.to.have.status(200);pm.expect(pm.response.json().ok).to.equal(true);});");
  const uploadArgs = ['-H','Authorization:Bearer {{token}}','-H','Content-Type:application/json','-H',`Idempotency-Key:${uuid}`,'--body',body];
  run('POST','/locations',uploadArgs,"pm.test('upload accepted with pacing', () => {pm.response.to.have.status(200);pm.expect(pm.response.json().intervalSeconds).to.equal(20);});");
  run('POST','/locations',uploadArgs,"pm.test('retry acknowledged', () => pm.response.to.have.status(200));");
  run('POST','/locations',['--body',body],"pm.test('missing credentials rejected', () => pm.response.to.have.status(401));",true);
  run('GET','/logs?limit=1',['-H','Authorization:Bearer {{admin_token}}'],"pm.test('saved coordinates returned', () => {pm.response.to.have.status(200);const body=pm.response.json();pm.expect(body.count).to.equal(1);pm.expect(body.locations[0].coords.latitude).to.equal(1.3521);});");
  run('GET','/logs',['-H','Authorization:Bearer {{token}}'],"pm.test('upload token cannot read logs', () => pm.response.to.have.status(401));",true);
  const records = (await readFile(locationFile,'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length,1);
  assert.equal(records[0].coords.latitude,record.coords.latitude);
  console.log('PASS: six real HTTP requests; saved coordinates once after retry; admin log retrieval verified.');
} finally {
  const stopped = new Promise(resolveStop => {if(child.exitCode!==null) resolveStop();else child.once('exit',resolveStop);});
  child.kill('SIGTERM');
  await stopped;
  await rm(directory,{recursive:true,force:true});
}
