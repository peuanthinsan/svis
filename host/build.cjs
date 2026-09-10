const fs=require('node:fs');const path=require('node:path');
const esbuild=require('esbuild');
const root=path.resolve(__dirname,'..');
const api=path.join(root,'api');
const files=fs.readdirSync(api,{recursive:true}).filter(f=>f.endsWith('.ts')).sort((a,b)=>{
 const dynamicA=(a.match(/\[/g)||[]).length;const dynamicB=(b.match(/\[/g)||[]).length;
 return dynamicA-dynamicB||b.length-a.length||a.localeCompare(b);
});
const entries=files.map((file,index)=>{
 let route='/api/'+file.replace(/\\/g,'/').replace(/\.ts$/,'').replace(/\/index$/,'');
 const params=[];const regex=route.split('/').map(segment=>{
  if(/^\[[^\]]+\]$/.test(segment)){params.push(segment.slice(1,-1));return '([^/]+)';}
  return segment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 }).join('/');
 return `{name:${JSON.stringify(route)},pattern:new RegExp(${JSON.stringify('^'+regex+'$')}),params:${JSON.stringify(params)},module:require(${JSON.stringify('../api/'+file.replace(/\\/g,'/'))})}`;
});
fs.writeFileSync(path.join(__dirname,'routes.generated.cjs'),'module.exports.routes=[\n'+entries.join(',\n')+'\n];\n');
esbuild.build({entryPoints:[path.join(__dirname,'server.cjs')],outfile:path.join(root,'dist/server.cjs'),bundle:true,platform:'node',target:'node24',packages:'external',plugins:[{name:'postgres-adapter',setup(build){
 build.onResolve({filter:/^@neondatabase\/serverless$/},args=>args.importer===path.join(__dirname,'pg-neon.cjs')?{path:args.path,external:true}:{path:path.join(__dirname,'pg-neon.cjs')});
 build.onResolve({filter:/^@sendgrid\/mail$/},args=>args.importer===path.join(__dirname,'mail-after-commit.cjs')?{path:args.path,external:true}:{path:path.join(__dirname,'mail-after-commit.cjs')});
}}]}).then(()=>console.log('Built SVIS Node server with '+entries.length+' API routes')).catch(()=>process.exit(1));
