const {randomUUID}=require('node:crypto');

const exportRoutes=new Set(['/api/dashboard/export','/api/dashboard/export-ticket']);

function classifyOrigin(origin){
 if(origin===undefined)return 'absent';
 if(origin==='null')return 'null';
 if(origin==='https://svis.songdeegps.com')return 'svis';
 if(origin==='https://songdee-svis.vercel.app')return 'vercel';
 return 'other';
}

function createExportDiagnostics(pathname,headers,searchParams){
 if(!exportRoutes.has(pathname.replace(/\/$/,'')))return null;
 // These are observations only. Neither proxy parameters nor caller-supplied
 // request IDs authenticate a request, and no credential values enter logs.
 return {
  requestId:randomUUID(),
  authPresent:typeof headers.authorization==='string'&&headers.authorization.length>0,
  proxyAuthReturn:searchParams.getAll('_sm_nck').includes('1'),
  originClass:classifyOrigin(headers.origin),
 };
}

module.exports={createExportDiagnostics};
