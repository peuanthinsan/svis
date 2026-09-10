// Preserve the query interface used by SVIS while connecting over PostgreSQL TCP.
const {Pool}=require('pg');
const {neon:neonHttp}=require('@neondatabase/serverless');
const {AsyncLocalStorage}=require('node:async_hooks');
const transactionContext=new AsyncLocalStorage();
const pools=new Map();
function poolFor(connectionString){
 if(!pools.has(connectionString)){
  const u=new URL(connectionString);
  if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!u.hostname.endsWith('.neon.tech'))throw new Error('Unapproved database host');
  const pool=new Pool({connectionString,max:10,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,application_name:'svis-windows-api',options:'-c timezone=UTC'});
  pool.on('error',error=>console.error(JSON.stringify({event:'database_pool_error',code:error.code||'UNKNOWN'})));
  pools.set(connectionString,pool);
 }
 return pools.get(connectionString);
}
class Query {
 constructor(pool,text,values){this.pool=pool;this.text=text;this.values=values;this.promise=null;}
 execute(){if(!this.promise){const context=transactionContext.getStore();const client=context?.pool===this.pool?context.client:this.pool;this.promise=client.query(this.text,this.values).then(r=>r.rows);}return this.promise;}
 then(resolve,reject){return this.execute().then(resolve,reject);}
 catch(reject){return this.execute().catch(reject);}
 finally(callback){return this.execute().finally(callback);}
}
function neon(connectionString){
 // During the API-only transition keep Neon's existing batched HTTP behavior.
 if(new URL(connectionString).hostname.endsWith('.neon.tech'))return neonHttp(connectionString);
 const pool=poolFor(connectionString);
 function sql(strings,...values){
  if(!Array.isArray(strings)||!Object.hasOwn(strings,'raw'))throw new TypeError('Use a tagged template or sql.query');
  const text=strings.reduce((out,part,index)=>out+(index?'$'+index:'')+part,'');
  return new Query(pool,text,values);
 }
 sql.query=(text,values=[])=>new Query(pool,text,values);
 sql.transaction=async queries=>{
  if(typeof queries==='function')queries=queries(sql);
  if(!Array.isArray(queries)||queries.some(q=>!(q instanceof Query)||q.pool!==pool||q.promise))throw new Error('Transaction requires unexecuted queries from this database');
  const parent=transactionContext.getStore();const nested=parent?.pool===pool;
  const client=nested?parent.client:await pool.connect();
  const savepoint=nested?'svis_batch_'+(++parent.savepoint):null;
  try{
   await client.query(nested?'SAVEPOINT '+savepoint:'BEGIN');const results=[];
   for(const query of queries)results.push((await client.query(query.text,query.values)).rows);
   const committed=await client.query(nested?'RELEASE SAVEPOINT '+savepoint:'COMMIT');
   if(!nested&&committed.command!=='COMMIT')throw new Error('Database transaction did not commit');
   return results;
  }catch(error){await client.query(nested?'ROLLBACK TO SAVEPOINT '+savepoint:'ROLLBACK').catch(()=>{});throw error;}finally{if(!nested)client.release();}
 };
 return sql;
}
async function closePools(){await Promise.all([...pools.values()].map(p=>p.end()));pools.clear();}
async function afterCommit(effect){
 const context=transactionContext.getStore();
 if(context){context.afterCommit.push(effect);return;}
 return effect();
}
async function withRequestTransaction(connectionString,fn,shouldCommit=()=>true){
 if(new URL(connectionString).hostname.endsWith('.neon.tech'))return fn();
 const pool=poolFor(connectionString);const client=await pool.connect();
 const effects=[];let result;let committed=false;
 try{
  await client.query('BEGIN');
  result=await transactionContext.run({pool,client,savepoint:0,afterCommit:effects},fn);
  const commit=shouldCommit();const completed=await client.query(commit?'COMMIT':'ROLLBACK');
  if(commit&&completed.command!=='COMMIT')throw new Error('Database transaction did not commit');
  committed=commit;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 // Notification failure must not turn an already committed save into an API error.
 if(committed)for(const effect of effects){
  try{await effect();}catch(error){console.error(JSON.stringify({event:'post_commit_notification_failed',code:error.code||error.name||'UNKNOWN'}));}
 }
 return result;
}
module.exports={neon,closePools,withRequestTransaction,afterCommit};
