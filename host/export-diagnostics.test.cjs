const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const {createExportDiagnostics}=require('./export-diagnostics.cjs');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function diagnostics({pathname='/api/dashboard/export',headers={},query=''}={}){
 return createExportDiagnostics(pathname,headers,new URLSearchParams(query));
}

test('export diagnostics are limited to the two export routes and generate fresh IDs',()=>{
 const ids=[];
 for(const pathname of ['/api/dashboard/export','/api/dashboard/export/','/api/dashboard/export-ticket','/api/dashboard/export-ticket/']){
  const result=diagnostics({pathname,headers:{'x-request-id':'caller-controlled-id'}});
  assert.match(result.requestId,UUID);
  ids.push(result.requestId);
 }
 assert.equal(new Set(ids).size,ids.length);
 for(const pathname of ['/api/dashboard','/api/dashboard/exported','/api/dashboard/export/file','/api/dashboard/export-ticket/other','/dashboard/export']){
  assert.equal(diagnostics({pathname}),null);
 }
});

test('origin classification is exact and bounded even for hostile or malformed values',()=>{
 const origins=[
  [undefined,'absent'],['null','null'],
  ['https://svis.songdeegps.com','svis'],['https://songdee-svis.vercel.app','vercel'],
  ['https://svis.songdeegps.com.attacker.invalid','other'],
  ['https://svis.songdeegps.com/','other'],['https://svis.songdeegps.com:443','other'],
  ['https://svis.songdeegps.com@attacker.invalid','other'],
  ['https://attacker.invalid/private-user@example.test','other'],
  ['null\r\nAuthorization: secret','other'],['x'.repeat(100000),'other'],
  [['https://svis.songdeegps.com'],'other'],[null,'other'],['','other'],
 ];
 for(const [origin,expected]of origins){
  const result=diagnostics({headers:{origin}});
  assert.equal(result.originClass,expected);
  assert.ok(JSON.stringify(result).length<180);
 }
});

test('proxy return records only an exact parameter value and has no authority',()=>{
 for(const query of ['_sm_nck=1','downloadTicket=private-ticket&_sm_nck=1','_sm_nck=other&_sm_nck=1']){
  assert.equal(diagnostics({query}).proxyAuthReturn,true);
 }
 for(const query of ['', '_sm_nck=01','_sm_nck=true','_sm_nck=1secret','other=_sm_nck%3D1','_sm_nck=1%0Asecret']){
  assert.equal(diagnostics({query}).proxyAuthReturn,false);
 }
});

test('diagnostics retain credential presence without values, identities, URLs or queries',()=>{
 const headers={
  authorization:'Bearer private-bearer-token',
  cookie:'session=private-cookie',
  origin:'https://private-user@example.test/path?secret=private-origin-value',
  referer:'https://svis.songdeegps.com/?downloadTicket=private-referrer-ticket',
  'x-request-id':'private-caller-request-id',
  'x-user-id':'private-user-id',
 };
 const original={...headers};
 const result=diagnostics({headers,query:'downloadTicket=private-ticket&fleetId=private-fleet&dateStart=private-date&_sm_nck=1'});
 assert.equal(result.authPresent,true);
 assert.deepEqual(Object.keys(result).sort(),['authPresent','originClass','proxyAuthReturn','requestId']);
 assert.doesNotMatch(JSON.stringify(result),/private-|Bearer|session=|https:|downloadTicket|fleetId|dateStart|_sm_nck/);
 assert.deepEqual(headers,original);
 assert.equal(diagnostics().authPresent,false);
 assert.equal(diagnostics({headers:{authorization:''}}).authPresent,false);
 assert.equal(diagnostics({headers:{authorization:'invalid-credential'}}).authPresent,true);
});

// Exercise the actual host request handler with in-memory HTTP/database stubs.
// No listening socket, generated routes, runtime credentials, or database is used.
function hostHarness(){
 let handler;
 const logs=[];
 const endpoint=(name)=>({name,pattern:new RegExp('^'+name+'$'),params:[],module:{default(req,res){
  res.status(req.headers.authorization==='Bearer accepted-test-token'?200:401).json({ok:!!req.headers.authorization});
 }}});
 const server={listen(){},close(){}};
 const replacements={
  'node:http':{createServer(callback){handler=callback;return server;}},
  './routes.generated.cjs':{routes:['/api/dashboard/export','/api/dashboard/export-ticket','/api/dashboard/summary'].map(endpoint)},
  './pg-neon.cjs':{closePools(){throw new Error('Unexpected database access');},withRequestTransaction(){throw new Error('Unexpected database access');}},
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'server.cjs'),'utf8'),{
  require(name){return Object.hasOwn(replacements,name)?replacements[name]:require(name);},
  __dirname,
  process:{env:{JWT_SECRET:'test-only-placeholder',DATABASE_URL:'test-only-placeholder'},on(){}},
  console:{log(line){logs.push(JSON.parse(line));},error(line){logs.push(JSON.parse(line));}},
  Buffer,URL,URLSearchParams,
 },{filename:'server.cjs'});
 return async function request(url,headers={},method='GET'){
  const req=Readable.from([]);
  Object.assign(req,{url,method,headers:{host:'svis.songdeegps.com',...headers},socket:{remoteAddress:'127.0.0.1'}});
  const res=new EventEmitter();
  const responseHeaders=new Map();
  Object.assign(res,{
   statusCode:200,headersSent:false,writableEnded:false,
   setHeader(name,value){responseHeaders.set(name.toLowerCase(),value);return this;},
   end(){this.headersSent=true;this.writableEnded=true;this.emit('close');return this;},
   destroy(){this.emit('close');},
  });
  const start=logs.length;
  await handler(req,res);
  return {status:res.statusCode,headers:responseHeaders,logs:logs.slice(start)};
 };
}

test('host returns its own export request ID on a 401 and does not trust proxy flags for auth',async()=>{
 const request=hostHarness();
 const response=await request('/api/dashboard/export?downloadTicket=private-ticket&_sm_nck=1',{
  origin:'null','x-request-id':'private-caller-id',
 });
 assert.equal(response.status,401);
 const id=response.headers.get('x-request-id');
 assert.match(id,UUID);
 assert.equal(response.headers.has('access-control-allow-origin'),false);
 assert.equal(response.logs.length,1);
 const log=response.logs[0];
 assert.deepEqual({...log,ms:0},{event:'request',route:'/api/dashboard/export',method:'GET',status:401,ms:0,requestId:id,authPresent:false,proxyAuthReturn:true,originClass:'null'});
 assert.doesNotMatch(JSON.stringify(response.logs),/private-|downloadTicket|_sm_nck/);
});

test('host preserves exact-origin CORS on both export endpoints, including error responses',async()=>{
 const request=hostHarness();
 for(const endpoint of ['/api/dashboard/export','/api/dashboard/export-ticket']){
  for(const origin of ['https://svis.songdeegps.com','https://songdee-svis.vercel.app']){
   const response=await request(endpoint,{origin});
   assert.equal(response.status,401);
   assert.equal(response.headers.get('access-control-allow-origin'),origin);
   assert.equal(response.headers.get('vary'),'Origin');
   assert.equal(response.headers.get('cache-control'),'no-store');
   assert.match(response.headers.get('x-request-id'),UUID);
  }
  for(const origin of ['null','https://svis.songdeegps.com.attacker.invalid','https://attacker.invalid']){
   const response=await request(endpoint,{origin,authorization:'Bearer accepted-test-token'});
   assert.equal(response.status,200);
   assert.equal(response.headers.has('access-control-allow-origin'),false);
   assert.equal(response.logs[0].authPresent,true);
  }
 }
});

test('host leaves other route logs unchanged and identifies export preflight requests',async()=>{
 const request=hostHarness();
 const ordinary=await request('/api/dashboard/summary?_sm_nck=1',{'x-request-id':'private-caller-id'});
 assert.equal(ordinary.headers.has('x-request-id'),false);
 assert.deepEqual(Object.keys(ordinary.logs[0]).sort(),['event','method','ms','route','status']);
 const preflight=await request('/api/dashboard/export-ticket',{origin:'https://svis.songdeegps.com'},'OPTIONS');
 assert.equal(preflight.status,204);
 assert.equal(preflight.headers.get('access-control-allow-headers'),'Authorization,Content-Type');
 assert.equal(preflight.logs[0].route,'/api/dashboard/export-ticket');
 assert.match(preflight.headers.get('x-request-id'),UUID);
});
