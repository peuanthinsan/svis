const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {routes}=require('./routes.generated.cjs');
const {closePools,withRequestTransaction}=require('./pg-neon.cjs');
const {normalizeProxyHeaders}=require('./proxy-headers.cjs');
const {blocksWebsite}=require('./host-policy.cjs');
const publicRoot=path.resolve(process.env.SVIS_PUBLIC_DIR||path.join(__dirname,'../public'));
const port=Number(process.env.PORT||8081);
const host=process.env.HOST||'127.0.0.1';
if(!['127.0.0.1','::1'].includes(host))throw new Error('SVIS must listen on loopback behind the HTTPS forwarding service');
if(!process.env.JWT_SECRET||!process.env.DATABASE_URL)throw new Error('Runtime credentials are missing');
const allowedOrigins=new Set(['https://svis.songdeegps.com','https://songdee-svis.vercel.app']);
const mimes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.webp':'image/webp'};
let active=0;let draining=false;const drainWaiters=[];
async function parseBody(req,sizeLimit='4mb'){
 const size=String(sizeLimit).match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i);
 if(!size)throw new Error('Unsupported request size configuration');
 const limit=Number(size[1])*({b:1,kb:1024,mb:1024*1024}[(size[2]||'b').toLowerCase()]);
 let bytes=0;const chunks=[];
 for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){const e=new Error('Body too large');e.status=413;throw e;}chunks.push(chunk);}
 const raw=Buffer.concat(chunks).toString('utf8');
 if(!raw)return {};
 const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
 if(type==='application/json'){try{return JSON.parse(raw);}catch{const e=new Error('Invalid JSON');e.status=400;throw e;}}
 if(type==='application/x-www-form-urlencoded')return Object.fromEntries(new URLSearchParams(raw));
 return raw;
}
function queryObject(search){
 const q=Object.create(null);
 for(const [key,value]of search){if(!Object.hasOwn(q,key))q[key]=value;else q[key]=[].concat(q[key],value);}
 return q;
}
const server=http.createServer(async(req,res)=>{
 const started=Date.now();let routeName='unmatched';
 active++;
 res.once('close',()=>{console.log(JSON.stringify({event:'request',route:routeName,method:req.method,status:res.statusCode,ms:Date.now()-started}));});
 res.status=code=>{res.statusCode=code;return res;};
 res.json=value=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));return res;};
 res.send=value=>{if(typeof value==='object'&&!Buffer.isBuffer(value))return res.json(value);res.end(value);return res;};
 try{
  if(blocksWebsite(req.headers.host))return res.status(404).end();
  const url=new URL(req.url,'http://localhost');
  let pathname;
  try{pathname=decodeURIComponent(url.pathname);}catch{return res.status(400).json({error:'Invalid path'});}
  if(pathname.includes('\\')||pathname.includes('\0'))return res.status(400).json({error:'Invalid path'});
  if(draining)return res.status(503).json({error:'Server restarting'});
  if(pathname.startsWith('/api/')){
   normalizeProxyHeaders(req,process.env.SVIS_PROXY_SECRET);
   const originalSetHeader=res.setHeader.bind(res);
   res.setHeader=(name,value)=>originalSetHeader(name,/^(cache-control|cdn-cache-control|vercel-cdn-cache-control)$/i.test(name)?'no-store':value);
   res.setHeader('Cache-Control','no-store');
   res.setHeader('X-Content-Type-Options','nosniff');
   const origin=req.headers.origin;
   if(origin&&allowedOrigins.has(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
   if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');return res.status(204).end();}
   const normalized=pathname.replace(/\/$/,'');
   const route=routes.find(r=>r.pattern.test(normalized));
   if(!route)return res.status(404).json({error:'Not found'});
   routeName=route.name;
   const match=normalized.match(route.pattern);req.query=queryObject(url.searchParams);
   route.params.forEach((name,index)=>req.query[name]=match[index+1]);
   // Keep raw streams for uploads/import handlers which disable Vercel's parser.
   if(route.module.config?.api?.bodyParser!==false)req.body=await parseBody(req,route.module.config?.api?.bodyParser?.sizeLimit);
   if(route.name==='/api/inspections'&&['POST','PUT','DELETE'].includes(req.method)){
    const end=res.end.bind(res);let responseArgs;
    res.end=(...args)=>{if(responseArgs)throw new Error('Duplicate response');responseArgs=args;return res;};
    try{
     await withRequestTransaction(process.env.DATABASE_URL,async()=>{await route.module.default(req,res);if(!responseArgs)throw new Error('Handler did not complete');},()=>res.statusCode<400);
    }finally{res.end=end;}
    end(...responseArgs);
   }else await route.module.default(req,res);
   if(!res.writableEnded)res.status(500).json({error:'Handler did not complete'});
   return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return res.status(405).end();
  if(pathname==='/'||pathname==='/dashboard'){res.statusCode=302;res.setHeader('Location','/dashboard/');return res.end();}
  if(!pathname.startsWith('/dashboard/'))return res.status(404).end();
  let filename=path.resolve(publicRoot,'.'+pathname);
  if(!filename.startsWith(publicRoot+path.sep))return res.status(404).end();
  if(!fs.existsSync(filename)||!fs.statSync(filename).isFile()){
   if(path.extname(pathname))return res.status(404).end();
   filename=path.join(publicRoot,'dashboard/index.html');
  }
  if(!fs.existsSync(filename))return res.status(503).end('Dashboard build is unavailable');
  routeName='dashboard';res.setHeader('Content-Type',mimes[path.extname(filename)]||'application/octet-stream');
  res.setHeader('Cache-Control',path.extname(filename)==='.html'?'no-cache':'public, max-age=3600');
  res.setHeader('X-Content-Type-Options','nosniff');
  const body=fs.readFileSync(filename);res.setHeader('Content-Length',body.length);res.end(req.method==='HEAD'?undefined:body);
 }catch(error){
  console.error(JSON.stringify({event:'request_failed',route:routeName,code:error.code||error.name}));
  if(!res.headersSent)res.status(error.status||500).json({error:error.status?error.message:'Internal server error'});else res.destroy();
 }finally{
  active--;if(active===0)for(const resolve of drainWaiters.splice(0))resolve();
 }
});
server.headersTimeout=15000;server.requestTimeout=60000;server.keepAliveTimeout=5000;
server.listen(port,host,()=>console.log(JSON.stringify({event:'started',host,port,stage:process.env.SVIS_STAGE||'production',routes:routes.length})));
async function shutdown(){
 if(draining)return;draining=true;
 const socketsClosed=new Promise(resolve=>server.close(resolve));
 if(active>0)await new Promise(resolve=>drainWaiters.push(resolve));
 await socketsClosed;await closePools();process.exit(0);
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
